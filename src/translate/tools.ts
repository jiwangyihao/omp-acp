import type { SessionUpdate, ToolCallLocation, ToolCallStatus, ToolKind } from "@agentclientprotocol/sdk";
import { isUnsupportedDiffResult, translateDiffPayloadToToolCallContent } from "./diffs.ts";

type ToolEventKind = "tool_execution_start" | "tool_execution_update" | "tool_execution_end";

const ACP_TOOL_KINDS = new Set<ToolKind>([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

export function normalizeToolStatus(status: unknown, eventType: ToolEventKind): ToolCallStatus {
  if (status === undefined && eventType === "tool_execution_end") {
    return "completed";
  }

  switch (status) {
    case "pending":
    case "queued":
      return "pending";
    case "running":
    case "in_progress":
    case "started":
      return "in_progress";
    case "success":
    case "succeeded":
    case "complete":
    case "completed":
      return "completed";
    case "failed":
    case "error":
    case "cancelled":
    case "canceled":
      return "failed";
    default:
      return eventType === "tool_execution_start" ? "pending" : "in_progress";
  }
}

export function normalizeToolKind(kind: unknown): ToolKind {
  if (typeof kind !== "string") {
    return "other";
  }
  if (ACP_TOOL_KINDS.has(kind as ToolKind)) {
    return kind as ToolKind;
  }

  switch (kind) {
    case "read_file":
      return "read";
    case "write":
    case "patch":
      return "edit";
    case "grep":
      return "search";
    case "bash":
    case "shell":
      return "execute";
    default:
      return "other";
  }
}

export function toolExecutionStartToUpdate(raw: Record<string, unknown>): SessionUpdate {
  const toolCallId = extractToolCallId(raw);
  const name = typeof raw.toolName === "string" ? raw.toolName : typeof raw.name === "string" ? raw.name : toolCallId;

  return omitUndefined({
    sessionUpdate: "tool_call" as const,
    toolCallId,
    title: typeof raw.title === "string" ? raw.title : name,
    kind: normalizeToolKind(raw.kind ?? raw.name ?? raw.toolName),
    status: normalizeToolStatus(raw.status, "tool_execution_start"),
    rawInput: raw.rawInput ?? raw.input,
    locations: extractLocations(raw),
  });
}

export function toolExecutionUpdateToUpdate(raw: Record<string, unknown>): SessionUpdate {
  return toolExecutionProgressToUpdate(raw, "tool_execution_update");
}

export function toolExecutionEndToUpdate(raw: Record<string, unknown>): SessionUpdate {
  return toolExecutionProgressToUpdate(raw, "tool_execution_end");
}

function toolExecutionProgressToUpdate(raw: Record<string, unknown>, eventType: "tool_execution_update" | "tool_execution_end"): SessionUpdate {
  const rawOutput = normalizeRawOutput(raw);
  const status = normalizeToolStatus(raw.status, eventType);
  const content = extractContent(raw);

  if (raw.diff !== undefined) {
    const diff = translateDiffPayloadToToolCallContent(raw.diff);
    if (isUnsupportedDiffResult(diff)) {
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: extractToolCallId(raw),
        status: "failed",
        rawOutput: diff.rawOutput,
      };
    }
    content.push(...diff);
  }

  return omitUndefined({
    sessionUpdate: "tool_call_update" as const,
    toolCallId: extractToolCallId(raw),
    status,
    rawOutput,
    content: content.length > 0 ? content : undefined,
    locations: extractLocations(raw),
  });
}

function extractToolCallId(raw: Record<string, unknown>): string {
  if (typeof raw.toolCallId === "string" && raw.toolCallId.length > 0) {
    return raw.toolCallId;
  }
  if (typeof raw.id === "string" && raw.id.length > 0) {
    return raw.id;
  }
  return "unknown-tool-call";
}

function extractLocations(raw: Record<string, unknown>): Array<ToolCallLocation> | undefined {
  if (typeof raw.path !== "string") {
    return undefined;
  }

  const location: ToolCallLocation = { path: raw.path };
  if (typeof raw.line === "number") {
    location.line = raw.line;
  }
  return [location];
}

function normalizeRawOutput(raw: Record<string, unknown>): unknown {
  if (raw.status === "cancelled" || raw.status === "canceled") {
    return { cancelled: true };
  }
  if (raw.error !== undefined) {
    return { error: raw.error };
  }
  if (raw.rawOutput !== undefined) {
    return raw.rawOutput;
  }
  if (raw.output !== undefined) {
    return raw.output;
  }
  if (raw.content !== undefined) {
    return raw.content;
  }
  return undefined;
}

function extractContent(raw: Record<string, unknown>): NonNullable<Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>["content"]> {
  const text = firstString(raw.content, raw.output, raw.rawOutput);
  return text === undefined ? [] : [{ type: "content", content: { type: "text", text } }];
}

function firstString(...values: Array<unknown>): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}
