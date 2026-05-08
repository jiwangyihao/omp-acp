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
  const rawInput = extractRawInput(raw);
  const locations = extractLocations(raw);
  const update: SessionUpdate = {
    sessionUpdate: "tool_call",
    toolCallId,
    title: typeof raw.title === "string" ? raw.title : buildToolTitle(name, rawInput),
    kind: normalizeToolKind(raw.kind ?? raw.name ?? raw.toolName),
    status: normalizeToolStatus(raw.status, "tool_execution_start"),
  };
  if (rawInput !== undefined) {
    update.rawInput = rawInput;
  }
  const startContent = buildToolStartContent(name, rawInput);
  if (startContent.length > 0) {
    update.content = startContent;
  }
  if (locations !== undefined) {
    update.locations = locations;
  }
  return update;
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

  const update: SessionUpdate = {
    sessionUpdate: "tool_call_update",
    toolCallId: extractToolCallId(raw),
    status,
  };
  if (rawOutput !== undefined) {
    update.rawOutput = rawOutput;
  }
  if (content.length > 0) {
    update.content = content;
  }
  const locations = extractLocations(raw);
  if (locations !== undefined) {
    update.locations = locations;
  }
  return update;
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
  if (raw.partialResult !== undefined) {
    return raw.partialResult;
  }
  if (raw.result !== undefined) {
    return raw.result;
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
  const content: NonNullable<Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>["content"]> = [];
  const text = firstString(raw.content, raw.output, raw.rawOutput);
  if (text !== undefined) {
    content.push(textToolContent(text));
  }
  content.push(...extractToolResultContent(raw.partialResult));
  content.push(...extractToolResultContent(raw.result));
  return content;
}

function extractRawInput(raw: Record<string, unknown>): unknown {
  return raw.rawInput ?? raw.input ?? raw.args;
}

function buildToolTitle(name: string, rawInput: unknown): string {
  const label = formatToolLabel(name);
  const summary = summarizeToolInput(name, rawInput);
  return summary === undefined ? label : `${label}: ${summary}`;
}

function formatToolLabel(name: string): string {
  switch (name) {
    case "bash":
    case "shell":
      return "Bash";
    case "read":
    case "read_file":
      return "Read";
    case "write":
    case "patch":
    case "edit":
      return "Edit";
    case "grep":
    case "search":
      return "Search";
    default:
      return name;
  }
}

function summarizeToolInput(name: string, rawInput: unknown): string | undefined {
  if (!isRecord(rawInput)) {
    return undefined;
  }

  if ((name === "bash" || name === "shell") && typeof rawInput.command === "string") {
    return compactOneLine(rawInput.command);
  }

  for (const key of ["path", "file", "uri", "url", "query", "pattern", "command", "message"]) {
    const value = rawInput[key];
    if (typeof value === "string" && value.length > 0) {
      return compactOneLine(value);
    }
  }

  return undefined;
}

function buildToolStartContent(name: string, rawInput: unknown): NonNullable<Extract<SessionUpdate, { sessionUpdate: "tool_call" }>["content"]> {
  if (!isRecord(rawInput)) {
    return [];
  }
  if ((name === "bash" || name === "shell") && typeof rawInput.command === "string") {
    return [textToolContent(`$ ${rawInput.command}`)];
  }
  return [];
}

function extractToolResultContent(value: unknown): NonNullable<Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>["content"]> {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return [];
  }

  const content: NonNullable<Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>["content"]> = [];
  for (const item of value.content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      content.push(textToolContent(item.text));
    }
  }
  return content;
}

function textToolContent(text: string): NonNullable<Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>["content"]>[number] {
  return { type: "content", content: { type: "text", text } };
}

function compactOneLine(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: Array<unknown>): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

