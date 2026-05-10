import { mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { contentItemsToToolCallContent, sanitizeContentBlock } from "../../translate/content.ts";
import { messageToSessionUpdates as sharedMessageToSessionUpdates } from "../../translate/messages.ts";
import { isPrivateAcpVisibleKey, parseToolInput, sanitizeTextForAcp, sanitizeToolInput } from "../../translate/safety.ts";
import { toolExecutionEndToAdditionalUpdates, toolExecutionEndToUpdate, toolExecutionStartToUpdate } from "../../translate/tools.ts";
import { todoPhasesToPlanUpdate } from "../../translate/todos.ts";

export type OmpSessionInfo = {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt: string;
  path: string;
};

export type OmpSessionDiagnostic = {
  path: string;
  reason: string;
};

export type ListOmpSessionsOptions = {
  cwd?: string;
  agentDir?: string;
};

export type ListOmpSessionsResult = {
  sessions: OmpSessionInfo[];
  diagnostics: {
    skipped: OmpSessionDiagnostic[];
  };
};

export type ForkOmpSessionOptions = {
  sourcePath: string;
  sourceSessionId: string;
  forkSessionId: string;
  cwd: string;
  agentDir?: string;
  now?: () => Date;
};

export type ForkOmpSessionResult = {
  sessionId: string;
  path: string;
};

export class OmpSessionForkSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OmpSessionForkSourceError";
  }
}

type OmpSessionHeader = {
  type: "session";
  id: string;
  cwd: string;
  timestamp?: string;
  title?: string;
};

export function encodeOmpSessionCwd(cwd: string): string {
  return `--${cwd.replace(/^\/+/, "").replace(/[\\/:]/g, "-")}--`;
}

export async function listOmpSessions(options: ListOmpSessionsOptions = {}): Promise<ListOmpSessionsResult> {
  const sessionsRoot = join(resolveAgentDir(options.agentDir), "sessions");
  const diagnostics: OmpSessionDiagnostic[] = [];
  const paths = await findJsonlFiles(sessionsRoot);
  const sessions: OmpSessionInfo[] = [];

  for (const path of paths) {
    const parsed = await parseSessionFileMetadata(path);
    if (!parsed.header) {
      diagnostics.push({ path, reason: parsed.reason });
      continue;
    }
    if (options.cwd !== undefined && parsed.header.cwd !== options.cwd) {
      continue;
    }
    const session: OmpSessionInfo = {
      sessionId: parsed.header.id,
      cwd: parsed.header.cwd,
      updatedAt: parsed.updatedAt,
      path,
    };
    if (parsed.header.title !== undefined) {
      session.title = parsed.header.title;
    }
    sessions.push(session);
  }

  sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.path.localeCompare(right.path));
  return { sessions, diagnostics: { skipped: diagnostics } };
}

export async function findOmpSessionById(
  sessionId: string,
  options: ListOmpSessionsOptions = {},
): Promise<OmpSessionInfo | undefined> {
  const result = await listOmpSessions(options);
  return result.sessions.find((session) => session.sessionId === sessionId);
}

export async function forkOmpSessionFile(options: ForkOmpSessionOptions): Promise<ForkOmpSessionResult> {
  const targetDir = join(resolveAgentDir(options.agentDir), "sessions", encodeOmpSessionCwd(options.cwd));
  const targetPath = join(targetDir, `${options.forkSessionId}.jsonl`);
  const sourceContent = await readFile(options.sourcePath, "utf8");
  const lines = buildForkSessionLines(sourceContent, options);

  await mkdir(targetDir, { recursive: true });
  let file;
  try {
    file = await open(targetPath, "wx");
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`OMP fork session file already exists: ${targetPath}`, { cause: error });
    }
    throw error;
  }

  try {
    await file.writeFile(`${lines.join("\n")}\n`, "utf8");
  } finally {
    await file.close();
  }

  return { sessionId: options.forkSessionId, path: targetPath };
}

export async function loadOmpSessionHistory(path: string): Promise<SessionUpdate[]> {
  const lines = (await readFile(path, "utf8")).split(/\r?\n/);
  const updates: SessionUpdate[] = [];

  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    const entry = parseJsonLine(line, path, index + 1);
    if (!isRecord(entry)) {
      continue;
    }
    if (entry.type !== "message") {
      updates.push(...topLevelHistoryEntryToUpdates(entry));
      continue;
    }

    const message = isRecord(entry.message) ? entry.message : entry;
    updates.push(...messageToSessionUpdates(message, path, index + 1));
  }

  return updates;
}

async function parseSessionFileMetadata(path: string): Promise<
  | { header: OmpSessionHeader; updatedAt: string }
  | { header: undefined; reason: string }
> {
  const content = await readFile(path, "utf8");
  const lines = content.split(/\r?\n/);
  let firstValidObject: Record<string, unknown> | undefined;
  let lastTimestamp: string | undefined;

  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    firstValidObject ??= parsed;
    if (typeof parsed.timestamp === "string") {
      lastTimestamp = parsed.timestamp;
    }
  }

  if (firstValidObject === undefined) {
    return { header: undefined, reason: "missing valid JSON object" };
  }
  if (!isSessionHeader(firstValidObject)) {
    return { header: undefined, reason: "missing session header" };
  }

  return {
    header: firstValidObject,
    updatedAt: lastTimestamp ?? firstValidObject.timestamp ?? (await stat(path)).mtime.toISOString(),
  };
}

function buildForkSessionLines(sourceContent: string, options: ForkOmpSessionOptions): string[] {
  const sourceLines = sourceContent.split(/\r?\n/);
  const { header, headerIndex } = parseForkSourceHeader(sourceLines, options);
  const forkHeader: Record<string, unknown> = {
    type: "session",
    id: options.forkSessionId,
    cwd: options.cwd,
    timestamp: (options.now ?? (() => new Date()))().toISOString(),
    parentSession: options.sourceSessionId,
  };
  if (typeof header.title === "string" && header.title.length > 0) {
    forkHeader.title = `${header.title} (fork)`;
  }

  const forkLines = [JSON.stringify(forkHeader)];
  for (const line of sourceLines.slice(headerIndex + 1)) {
    if (line.trim().length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      forkLines.push(line);
      continue;
    }

    if (!isRecord(parsed)) {
      forkLines.push(line);
      continue;
    }

    forkLines.push(JSON.stringify(rewriteForkEntrySessionIds(parsed, options.sourceSessionId, options.forkSessionId)));
  }

  return forkLines;
}

function parseForkSourceHeader(
  lines: string[],
  options: ForkOmpSessionOptions,
): { header: OmpSessionHeader; headerIndex: number } {
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isRecord(parsed)) {
      continue;
    }

    if (!isSessionHeader(parsed)) {
      throw new OmpSessionForkSourceError("OMP fork source first JSON object is not a session header");
    }
    if (parsed.id !== options.sourceSessionId) {
      throw new OmpSessionForkSourceError(`OMP fork source session id mismatch: ${parsed.id}`);
    }
    if (parsed.cwd !== options.cwd) {
      throw new OmpSessionForkSourceError(`OMP fork source cwd mismatch: ${parsed.cwd}`);
    }

    return { header: parsed, headerIndex: index };
  }

  throw new OmpSessionForkSourceError("OMP fork source missing session header");
}

function rewriteForkEntrySessionIds(
  entry: Record<string, unknown>,
  sourceSessionId: string,
  forkSessionId: string,
): Record<string, unknown> {
  const rewritten = { ...entry };
  if (rewritten.sessionId === sourceSessionId) {
    rewritten.sessionId = forkSessionId;
  }
  if (rewritten.sessionID === sourceSessionId) {
    rewritten.sessionID = forkSessionId;
  }

  if (isRecord(rewritten.message)) {
    const message = { ...rewritten.message };
    if (message.sessionId === sourceSessionId) {
      message.sessionId = forkSessionId;
    }
    if (message.sessionID === sourceSessionId) {
      message.sessionID = forkSessionId;
    }
    rewritten.message = message;
  }

  return rewritten;
}

async function findJsonlFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findJsonlFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

function topLevelHistoryEntryToUpdates(entry: Record<string, unknown>): SessionUpdate[] {
  switch (entry.type) {
    case "session":
      return toUpdates(sessionHeaderToUpdate(entry));
    case "model_change":
      return [thoughtUpdate(`[model_change]\nmodel: ${sanitizeTextForAcp(typeof entry.model === "string" ? entry.model : "unknown")}`)];
    case "thinking_level_change":
      return [thoughtUpdate(`[thinking_level_change]\nthinking: ${sanitizeTextForAcp(typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : "unknown")}`)];
    case "branch_summary":
      return typeof entry.summary === "string" && entry.summary.length > 0 ? [thoughtUpdate(`[branch_summary]\n${sanitizeTextForAcp(entry.summary)}`)] : [];
    case "compaction":
      return typeof entry.summary === "string" && entry.summary.length > 0 ? [thoughtUpdate(`[compaction]\n${sanitizeTextForAcp(entry.summary)}`)] : [];
    case "service_tier_change":
      return [thoughtUpdate(`[service_tier_change]\nservice tier: ${sanitizeTextForAcp(typeof entry.serviceTier === "string" ? entry.serviceTier : "default")}`)];
    case "mode_change":
      return [thoughtUpdate(`[mode_change]\nmode: ${sanitizeTextForAcp(typeof entry.mode === "string" ? entry.mode : "unknown")}`)];
    case "custom_message":
      return customMessageToUpdates(entry);
    case "toolResult":
    case "tool_result":
      return replayToolResult(entry);
    default:
      return [];
  }
}

function sessionHeaderToUpdate(entry: Record<string, unknown>): SessionUpdate | undefined {
  const update: Record<string, unknown> = { sessionUpdate: "session_info_update" };
  if (typeof entry.title === "string" && entry.title.length > 0) {
    update.title = sanitizeTextForAcp(entry.title);
  }
  if (typeof entry.timestamp === "string" && entry.timestamp.length > 0) {
    update.updatedAt = entry.timestamp;
  }
  return Object.keys(update).length > 1 ? update as SessionUpdate : undefined;
}

function customMessageToUpdates(entry: Record<string, unknown>): SessionUpdate[] {
  if (entry.display !== true) {
    return [];
  }
  const customType = sanitizeTextForAcp(typeof entry.customType === "string" && entry.customType.length > 0 ? entry.customType : "custom_message");
  if (typeof entry.content === "string") {
    return entry.content.length > 0 ? [thoughtUpdate(sanitizeTextForAcp(`[${customType}]\n${entry.content}`))] : [];
  }

  const updates: SessionUpdate[] = [];
  for (const item of normalizeContentItems(entry.content, "custom_message", 0)) {
    const updatesForItem = sharedMessageToSessionUpdates({ role: "assistant", content: [item] }, { unknownText: "summarize", includeToolCalls: false });
    for (const update of updatesForItem) {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        updates.push(thoughtUpdate(`[${customType}]\n${update.content.text}`));
        continue;
      }
      updates.push({ ...update, sessionUpdate: "agent_thought_chunk" } as SessionUpdate);
    }
  }
  return updates;
}

function toUpdates(update: SessionUpdate | undefined): SessionUpdate[] {
  return update === undefined ? [] : [update];
}

function thoughtUpdate(text: string): SessionUpdate {
  return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } } as SessionUpdate;
}

function messageToSessionUpdates(message: Record<string, unknown>, path: string, line: number): SessionUpdate[] {
  if (message.role === "user" || message.role === "assistant") {
    return replayAssistantOrUserMessage(message.role, message, path, line);
  }
  if (message.role === "toolResult") {
    return replayToolResult(message);
  }
  const planUpdate = todoLikeMessageToPlanUpdate(message);
  if (planUpdate !== undefined) {
    return [planUpdate];
  }
  const thoughtUpdate = compatibleNonChatMessageToThoughtUpdate(message);
  return thoughtUpdate === undefined ? [] : [thoughtUpdate];
}

function replayAssistantOrUserMessage(role: "user" | "assistant", message: Record<string, unknown>, path: string, line: number): SessionUpdate[] {
  const chunks = normalizeContentItems(message.content, path, line);
  const updates: SessionUpdate[] = [];

  for (const chunk of chunks) {
    if (role === "assistant" && isRecord(chunk) && chunk.type === "toolCall") {
      const update = replayToolCall(chunk);
      if (update !== undefined) updates.push(update);
      continue;
    }
    updates.push(...historyContentItemToUpdates(role, chunk));
  }

  const errorUpdate = assistantErrorToUpdate(role, message);
  if (errorUpdate !== undefined) {
    updates.push(errorUpdate);
  }
  return updates;
}

function assistantErrorToUpdate(role: "user" | "assistant", message: Record<string, unknown>): SessionUpdate | undefined {
  if (role !== "assistant" || message.stopReason !== "error") {
    return undefined;
  }
  const errorMessage = firstNonEmptyString(message.errorMessage, message.error);
  return errorMessage === undefined ? undefined : thoughtUpdate(sanitizeTextForAcp(`[assistant_error]\n${errorMessage}`));
}

function historyContentItemToUpdates(role: "user" | "assistant", item: unknown): SessionUpdate[] {
  if (isRecord(item)) {
    const block = sanitizeContentBlock(item);
    if (block !== undefined) return [{ sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk", content: block } as SessionUpdate];

    const summary = summarizeHistoryUnknownContentBlock(item);
    if (summary !== undefined) {
      return [{ sessionUpdate: role === "assistant" ? "agent_thought_chunk" : "user_message_chunk", content: { type: "text", text: sanitizeTextForAcp(summary) } } as SessionUpdate];
    }
  }

  return sharedMessageToSessionUpdates({ role, content: [item] }, { unknownText: "drop", includeToolCalls: false });
}

function compatibleNonChatMessageToThoughtUpdate(message: Record<string, unknown>): SessionUpdate | undefined {
  const role = firstNonEmptyString(message.role);
  if (role === undefined) {
    return undefined;
  }
  if (role !== "fileMention" && role !== "tool") {
    return undefined;
  }
  if (hasPrivateAcpVisibleKey(message) || isPrivateHistoryContentType(message.type) || hasPrivateHistoryMarker(message)) {
    return undefined;
  }
  const text = nonChatMessageText(role, message);
  if (text === undefined) {
    return undefined;
  }
  return thoughtUpdate(`[${sanitizeTextForAcp(role)}]\n${sanitizeTextForAcp(text)}`);
}

function nonChatMessageText(role: string, message: Record<string, unknown>): string | undefined {
  if (role === "fileMention") {
    return fileMentionText(message.files);
  }
  return firstNonEmptyString(message.content, message.text, message.summary, message.message);
}

function fileMentionText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const files = value
    .map((item) => {
      if (typeof item === "string") return item;
      if (isRecord(item)) return firstNonEmptyString(item.path, item.uri, item.name);
      return undefined;
    })
    .filter((item): item is string => item !== undefined && item.length > 0);
  return files.length === 0 ? undefined : files.join("\n");
}

function todoLikeMessageToPlanUpdate(message: Record<string, unknown>): SessionUpdate | undefined {
  const role = message.role;
  if (role !== "todo" && role !== "todo_write" && role !== "plan") {
    return undefined;
  }
  return todoPhasesToPlanUpdate(message.phases ?? message.todoPhases ?? message.content ?? message.todos ?? message.tasks);
}


function summarizeHistoryUnknownContentBlock(block: Record<string, unknown>): string | undefined {
  if (hasPrivateAcpVisibleKey(block) || isPrivateHistoryContentType(block.type)) return undefined;
  const type = typeof block.type === "string" && block.type.length > 0 ? block.type : "unknown";
  const title = firstNonEmptyString(block.title, block.name, block.label);
  const text = firstNonEmptyString(block.text, block.summary, block.message, block.content);
  if (text === undefined) return undefined;
  return title === undefined ? `[${type}]\n${sanitizeTextForAcp(text)}` : `[${type}] ${title}\n${sanitizeTextForAcp(text)}`;
}

function hasPrivateAcpVisibleKey(value: Record<string, unknown>): boolean {
  return Object.keys(value).some(isPrivateAcpVisibleKey);
}

function isPrivateHistoryContentType(value: unknown): boolean {
  return typeof value === "string" && isPrivateAcpVisibleKey(value);
}

function hasPrivateHistoryMarker(value: Record<string, unknown>): boolean {
  return [value.private, value.raw, value.hidden, value.internal].some((marker) => marker === true)
    || [value.visibility, value.scope, value.kind].some((marker) => marker === "private" || marker === "raw" || marker === "internal");
}



function replayToolCall(block: Record<string, unknown>): SessionUpdate | undefined {
  const toolCallId = firstNonEmptyString(block.id, block.toolCallId, block.callId);
  if (toolCallId === undefined) {
    return undefined;
  }
  const name = firstNonEmptyString(block.name, block.toolName) ?? toolCallId;
  const rawInput = sanitizeToolInput(parseToolInput(block.arguments ?? block.args ?? block.input ?? block.rawInput));
  return toolExecutionStartToUpdate({
    type: "tool_execution_start",
    toolCallId,
    toolName: name,
    args: rawInput,
    status: block.status,
    ...(typeof block.title === "string" ? { title: block.title } : {}),
    ...(typeof block.kind === "string" ? { kind: block.kind } : {}),
    ...(typeof block.path === "string" ? { path: block.path } : {}),
    ...(typeof block.line === "number" ? { line: block.line } : {}),
  });
}

function replayToolResult(message: Record<string, unknown>): SessionUpdate[] {
  const toolCallId = firstNonEmptyString(message.toolCallId, message.id, message.callId);
  if (toolCallId === undefined) {
    return [];
  }
  const payload = buildToolResultPayload(message);
  const event = {
    type: "tool_execution_end",
    toolCallId,
    toolName: firstNonEmptyString(message.toolName, message.name),
    status: message.isError === true ? "failed" : "completed",
    ...payload,
    ...(typeof message.path === "string" ? { path: message.path } : {}),
    ...(typeof message.line === "number" ? { line: message.line } : {}),
  };
  const additionalUpdates = toolExecutionEndToAdditionalUpdates(event);
  const directTodoUpdate = todoPhasesToPlanUpdate(extractToolResultTodoPhases(message));
  return [
    toolExecutionEndToUpdate(event),
    ...(directTodoUpdate === undefined || additionalUpdates.some((update) => update.sessionUpdate === "plan") ? additionalUpdates : [directTodoUpdate, ...additionalUpdates]),
  ];
}

function extractToolResultTodoPhases(message: Record<string, unknown>): unknown {
  const toolName = firstNonEmptyString(message.toolName, message.name);
  if (toolName !== "todo_write") {
    return undefined;
  }
  const directDetails = isRecord(message.details) ? message.details : undefined;
  if (directDetails?.phases !== undefined) {
    return directDetails.phases;
  }
  const resultDetails = isRecord(message.result) && isRecord(message.result.details) ? message.result.details : undefined;
  if (resultDetails?.phases !== undefined) {
    return resultDetails.phases;
  }
  const rawOutputDetails = isRecord(message.rawOutput) && isRecord(message.rawOutput.details) ? message.rawOutput.details : undefined;
  if (rawOutputDetails?.phases !== undefined) {
    return rawOutputDetails.phases;
  }
  const outputDetails = isRecord(message.output) && isRecord(message.output.details) ? message.output.details : undefined;
  return outputDetails?.phases;
}

function normalizeContentItems(content: unknown, path: string, line: number): unknown[] {
  if (typeof content === "string") {
    return [content];
  }
  if (Array.isArray(content)) {
    return content;
  }
  if (isRecord(content)) {
    return [content];
  }
  if (content === undefined || content === null) {
    return [];
  }
  throw new Error(`Unsupported OMP message content in ${path}:${line}`);
}


function buildToolResultPayload(message: Record<string, unknown>): Record<string, unknown> {
  const content = contentItemsToToolCallContent(message.content, { unknownText: "summarize" }).map((item) => item.content);
  const result: Record<string, unknown> = {};
  if (message.rawOutput !== undefined) {
    result.rawOutput = mergeExplicitContentIntoResult(message.rawOutput, content);
  } else if (message.output !== undefined) {
    result.output = mergeExplicitContentIntoResult(message.output, content);
  } else if (message.result !== undefined) {
    result.result = mergeExplicitContentIntoResult(message.result, content);
  } else {
    const fallbackResult: Record<string, unknown> = { content };
    if (isRecord(message.details)) {
      const sanitizedDetails = sanitizeToolInput(message.details);
      if (sanitizedDetails !== undefined) fallbackResult.details = sanitizedDetails;
    }
    result.result = fallbackResult;
  }
  if (content.length > 0 && (typeof message.rawOutput === "string" || typeof message.output === "string" || typeof message.result === "string")) result.content = content;
  return result;
}

function mergeExplicitContentIntoResult(value: unknown, content: unknown[]): unknown {
  if (content.length === 0) return value;
  if (!isRecord(value)) return value;
  if (value.content !== undefined) return mergeOrReplaceContent(value, content);
  return { ...value, content };
}

function mergeOrReplaceContent(value: Record<string, unknown>, explicitContent: unknown[]): unknown {
  const existingContent = contentItemsToToolCallContent(value.content, { unknownText: "drop" }).map((item) => item.content);
  const mergedContent = existingContent.length > 0 ? existingContent : explicitContent;
  return mergedContent.length > 0 ? { ...value, content: mergedContent } : value;
}


function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function parseJsonLine(line: string, path: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Malformed OMP session JSON in ${path}:${lineNumber}`, { cause: error });
  }
}

function isSessionHeader(value: Record<string, unknown>): value is OmpSessionHeader {
  return value.type === "session" && typeof value.id === "string" && typeof value.cwd === "string"
    && (value.timestamp === undefined || typeof value.timestamp === "string")
    && (value.title === undefined || typeof value.title === "string");
}

function resolveAgentDir(agentDir: string | undefined): string {
  return agentDir ?? join(homedir(), ".omp", "agent");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}