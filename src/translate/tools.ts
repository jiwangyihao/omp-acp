import type { SessionUpdate, ToolCallLocation, ToolCallStatus, ToolKind } from "@agentclientprotocol/sdk";
import { contentItemsToToolCallContent } from "./content.ts";
import { isUnsupportedDiffResult, translateDiffPayloadToToolCallContent } from "./diffs.ts";
import { parseToolInput, sanitizeTextForAcp, sanitizeToolInput, sanitizeToolOutputForAcp } from "./safety.ts";

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
  const title = typeof raw.title === "string" ? sanitizeTextForAcp(raw.title) : buildToolTitle(name, rawInput);
  const update: SessionUpdate = {
    sessionUpdate: "tool_call",
    toolCallId,
    title: title.length > 0 ? title : buildToolTitle(name, rawInput),
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
  const output = normalizedOutputCandidate(raw);
  const rawOutput = output.rawOutput;
  const status = normalizeToolStatus(raw.status, eventType);
  const content = extractContent(raw, output);

  if (raw.diff !== undefined) {
    const diff = translateDiffPayloadToToolCallContent(raw.diff);
    if (isUnsupportedDiffResult(diff)) {
      const rawOutput = sanitizeToolOutputForAcp(diff.rawOutput) ?? { error: "Unsupported diff payload" };
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: extractToolCallId(raw),
        status: "failed",
        rawOutput,
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

function normalizedOutputCandidate(raw: Record<string, unknown>): { rawOutput: unknown; text?: string; source?: "rawOutput" | "output" | "partialResult" | "result" | "content" } {
  if (raw.status === "cancelled" || raw.status === "canceled") {
    return { rawOutput: sanitizeToolOutputForAcp({ cancelled: true }) };
  }
  if (raw.error !== undefined) {
    return { rawOutput: sanitizeToolOutputForAcp({ error: raw.error }) };
  }
  const source = firstDefinedOutputSource(raw);
  if (source === undefined) return { rawOutput: undefined };

  const sanitized = sanitizeRawOutputCandidate(raw[source]);
  return typeof sanitized === "string" ? { rawOutput: sanitized, text: sanitized, source } : { rawOutput: sanitized, source };
}

function firstDefinedOutputSource(raw: Record<string, unknown>): "rawOutput" | "output" | "partialResult" | "result" | "content" | undefined {
  if (raw.rawOutput !== undefined) return "rawOutput";
  if (raw.output !== undefined) return "output";
  if (raw.partialResult !== undefined) return "partialResult";
  if (raw.result !== undefined) return "result";
  if (raw.content !== undefined) return "content";
  return undefined;
}

function sanitizeRawOutputCandidate(value: unknown): unknown {
  const sanitized = sanitizeToolOutputForAcp(value);
  if (!isRecord(sanitized) || sanitized.content === undefined) {
    return sanitized;
  }

  const content = contentItemsToToolCallContent(sanitized.content, { unknownText: "drop" }).map((item) => item.content);
  if (content.length === 0) {
    const { content: _content, ...rest } = sanitized;
    return Object.keys(rest).length > 0 ? rest : undefined;
  }
  return { ...sanitized, content };
}

function extractContent(raw: Record<string, unknown>, output: { rawOutput: unknown; text?: string; source?: string }): NonNullable<Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>["content"]> {
  const content: NonNullable<Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>["content"]> = [];
  if (output.text !== undefined) {
    content.push(textToolContent(output.text));
  }
  const directContent = output.source === "content" ? [] : extractToolResultContent(output.rawOutput);
  if (directContent.length > 0) {
    content.push(...directContent);
  } else if (output.text !== undefined && output.source !== "content") {
    content.push(...extractToolResultContent(sanitizeRawOutputCandidate(raw.content)));
  } else if (output.text === undefined) {
    const text = safeTextOutput(raw.content) ?? safeTextOutput(raw.output) ?? safeTextOutput(raw.rawOutput);
    if (text !== undefined) {
      content.push(textToolContent(text));
    }
  }
  if (!(output.source === "partialResult")) {
    content.push(...extractToolResultContent(sanitizeRawOutputCandidate(raw.partialResult)));
  }
  if (!(output.source === "result")) {
    content.push(...extractToolResultContent(sanitizeRawOutputCandidate(raw.result)));
  }
  return content;
}

function safeTextOutput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return sanitizeTextForAcp(value);
}


function extractRawInput(raw: Record<string, unknown>): unknown {
  return sanitizeToolInput(parseToolInput(raw.rawInput ?? raw.input ?? raw.args));
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
  if (Array.isArray(value)) {
    return contentItemsToToolCallContent(value, { unknownText: "drop" });
  }
  if (!isRecord(value)) {
    return [];
  }
  return contentItemsToToolCallContent(value.content, { unknownText: "drop" });
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

