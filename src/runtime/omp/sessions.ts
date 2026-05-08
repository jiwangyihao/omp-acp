import { mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

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
    if (!isRecord(entry) || entry.type !== "message") {
      continue;
    }

    const message = isRecord(entry.message) ? entry.message : entry;
    if (message.role !== "user" && message.role !== "assistant") {
      throw new Error(`Unsupported OMP message role in ${path}:${index + 1}`);
    }

    updates.push({
      sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
      content: { type: "text", text: extractMessageText(message.content, path, index + 1) },
    } as SessionUpdate);
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

function extractMessageText(content: unknown, path: string, line: number): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content) && content.length > 0 && content.every(isTextContentBlock)) {
    return content.map((block) => block.text).join("");
  }
  if (isTextContentBlock(content)) {
    return content.text;
  }
  throw new Error(`Unsupported OMP message content in ${path}:${line}`);
}

function isTextContentBlock(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
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