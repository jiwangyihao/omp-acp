import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import {
  encodeOmpSessionCwd,
  forkOmpSessionFile,
  findOmpSessionById,
  OmpSessionForkSourceError,
  listOmpSessions,
  loadOmpSessionHistory,
} from "../../../../src/runtime/omp/sessions.ts";

async function tempAgentDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-acp-sessions-"));
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  return agentDir;
}

async function writeSessionFile(
  agentDir: string,
  dirName: string,
  fileName: string,
  entries: unknown[],
): Promise<string> {
  const dir = join(agentDir, "sessions", dirName);
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return path;
}

describe("encodeOmpSessionCwd", () => {
  it("encodes POSIX and Windows cwd strings as fixture directory names", () => {
    assert.equal(encodeOmpSessionCwd("/source/repos/project"), "--source-repos-project--");
    assert.equal(encodeOmpSessionCwd("C:\\Users\\me\\project"), "--C--Users-me-project--");
  });
});

describe("listOmpSessions", () => {
  it("scans all session directories, filters by header cwd, reports skipped files, and sorts by updatedAt source", async () => {
    const agentDir = await tempAgentDir();
    const wantedCwd = "/workspace/project";
    const otherCwd = "/workspace/other";

    const byEntryPath = await writeSessionFile(agentDir, "not-the-cwd-encoding", "entry.jsonl", [
      { type: "session", id: "by-entry", cwd: wantedCwd, timestamp: "2026-05-01T00:00:00.000Z", title: "Entry wins" },
      { type: "message", role: "user", content: "hi", timestamp: "2026-05-03T00:00:00.000Z" },
      { type: "message", role: "assistant", content: "there", timestamp: "2026-05-04T00:00:00.000Z" },
    ]);
    const byHeaderPath = await writeSessionFile(agentDir, encodeOmpSessionCwd(wantedCwd), "header.jsonl", [
      { type: "session", id: "by-header", cwd: wantedCwd, timestamp: "2026-05-02T00:00:00.000Z", title: "Header wins" },
      { type: "message", role: "assistant", content: "no timestamp" },
    ]);
    const byMtimePath = await writeSessionFile(agentDir, "mtime-only", "mtime.jsonl", [
      { type: "session", id: "by-mtime", cwd: wantedCwd, title: "Mtime wins" },
      { type: "message", role: "assistant", content: "no timestamp" },
    ]);
    await utimes(byMtimePath, new Date("2026-05-01T00:00:00.000Z"), new Date("2026-05-01T00:00:00.000Z"));
    await writeSessionFile(agentDir, "other-cwd", "other.jsonl", [
      { type: "session", id: "other", cwd: otherCwd, timestamp: "2026-05-05T00:00:00.000Z" },
    ]);
    const missingHeaderPath = await writeSessionFile(agentDir, "bad", "missing-header.jsonl", [
      { type: "message", role: "user", content: "not a header" },
    ]);
    const malformedPath = join(agentDir, "sessions", "bad", "malformed.jsonl");
    await writeFile(malformedPath, "not json\n", "utf8");

    const result = await listOmpSessions({ cwd: wantedCwd, agentDir });

    const mtimeIso = (await stat(byMtimePath)).mtime.toISOString();
    assert.deepEqual(
      result.sessions.map((session) => ({ id: session.sessionId, cwd: session.cwd, title: session.title, updatedAt: session.updatedAt, path: session.path })),
      [
        { id: "by-entry", cwd: wantedCwd, title: "Entry wins", updatedAt: "2026-05-04T00:00:00.000Z", path: byEntryPath },
        { id: "by-header", cwd: wantedCwd, title: "Header wins", updatedAt: "2026-05-02T00:00:00.000Z", path: byHeaderPath },
        { id: "by-mtime", cwd: wantedCwd, title: "Mtime wins", updatedAt: mtimeIso, path: byMtimePath },
      ],
    );
    assert.equal(result.diagnostics.skipped.length, 2);
    assert.deepEqual(
      result.diagnostics.skipped.map((diagnostic) => diagnostic.path).sort(),
      [malformedPath, missingHeaderPath].sort(),
    );
  });
});

describe("findOmpSessionById", () => {
  it("finds sessions by header id and optional cwd filter", async () => {
    const agentDir = await tempAgentDir();
    await writeSessionFile(agentDir, "encoded-a", "a.jsonl", [
      { type: "session", id: "target", cwd: "/project/a", timestamp: "2026-05-01T00:00:00.000Z" },
    ]);

    const found = await findOmpSessionById("target", { cwd: "/project/a", agentDir });
    assert.equal(found?.sessionId, "target");
    assert.equal(found?.cwd, "/project/a");
    assert.equal(await findOmpSessionById("target", { cwd: "/project/b", agentDir }), undefined);
    assert.equal(await findOmpSessionById("missing", { agentDir }), undefined);
  });
});

describe("forkOmpSessionFile", () => {
  it("clones a session at head with parentSession metadata", async () => {
    const agentDir = await tempAgentDir();
    const sourcePath = await writeSessionFile(agentDir, "source", "source.jsonl", [
      { type: "session", id: "source-session", cwd: "/project", timestamp: "2026-05-08T00:00:00.000Z", title: "Source" },
      { type: "message", role: "user", content: "hello", sessionId: "source-session", sessionID: "other-session", unknown: "source-session" },
      { type: "message", message: { role: "assistant", content: "world", sessionId: "source-session", sessionID: "source-session" } },
    ]);

    const result = await forkOmpSessionFile({
      sourcePath,
      sourceSessionId: "source-session",
      forkSessionId: "fork-session",
      cwd: "/project",
      agentDir,
      now: () => new Date("2026-05-08T01:00:00.000Z"),
    });

    const expectedPath = join(agentDir, "sessions", encodeOmpSessionCwd("/project"), "fork-session.jsonl");
    assert.deepEqual(result, { sessionId: "fork-session", path: expectedPath });

    const lines = (await readFile(result.path, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      {
        type: "session",
        id: "fork-session",
        cwd: "/project",
        timestamp: "2026-05-08T01:00:00.000Z",
        parentSession: "source-session",
        title: "Source (fork)",
      },
      { type: "message", role: "user", content: "hello", sessionId: "fork-session", sessionID: "other-session", unknown: "source-session" },
      { type: "message", message: { role: "assistant", content: "world", sessionId: "fork-session", sessionID: "fork-session" } },
    ]);
  });

  it("rejects invalid source headers", async (t) => {
    const cases = [
      { name: "missing header", entries: [{ type: "message", role: "user", content: "no header" }] },
      { name: "non-session header", entries: [{ type: "metadata", id: "source-session", cwd: "/project" }] },
      { name: "mismatched id", entries: [{ type: "session", id: "other-session", cwd: "/project" }] },
      { name: "mismatched cwd", entries: [{ type: "session", id: "source-session", cwd: "/other" }] },
    ];

    for (const testCase of cases) {
      await t.test(testCase.name, async () => {
        const agentDir = await tempAgentDir();
        const sourcePath = await writeSessionFile(agentDir, "source", "source.jsonl", testCase.entries);

        await assert.rejects(
          forkOmpSessionFile({
            sourcePath,
            sourceSessionId: "source-session",
            forkSessionId: "fork-session",
            cwd: "/project",
            agentDir,
          }),
          OmpSessionForkSourceError,
        );
      });
    }
  });

  it("uses exclusive creation and does not overwrite existing fork files", async () => {
    const agentDir = await tempAgentDir();
    const sourcePath = await writeSessionFile(agentDir, encodeOmpSessionCwd("/project"), "source.jsonl", [
      { type: "session", id: "source-session", cwd: "/project" },
      { type: "message", role: "user", content: "hello" },
    ]);
    const existingPath = await writeSessionFile(agentDir, encodeOmpSessionCwd("/project"), "fork-session.jsonl", [
      { type: "session", id: "fork-session", cwd: "/project", title: "Existing" },
    ]);

    await assert.rejects(
      forkOmpSessionFile({
        sourcePath,
        sourceSessionId: "source-session",
        forkSessionId: "fork-session",
        cwd: "/project",
        agentDir,
      }),
      /already exists/,
    );
    assert.match(await readFile(existingPath, "utf8"), /Existing/);
  });

  it("preserves fork metadata only as private file content", async () => {
    const agentDir = await tempAgentDir();
    const sourcePath = await writeSessionFile(agentDir, encodeOmpSessionCwd("/project"), "source.jsonl", [
      { type: "session", id: "source-session", cwd: "/project", title: "Source" },
      { type: "message", role: "user", content: "hello" },
    ]);

    const result = await forkOmpSessionFile({
      sourcePath,
      sourceSessionId: "source-session",
      forkSessionId: "fork-session",
      cwd: "/project",
      agentDir,
      now: () => new Date("2026-05-08T01:00:00.000Z"),
    });

    const [headerLine] = (await readFile(result.path, "utf8")).split(/\r?\n/);
    assert.ok(headerLine);
    assert.equal(JSON.parse(headerLine).parentSession, "source-session");

    const listed = await listOmpSessions({ cwd: "/project", agentDir });
    const fork = listed.sessions.find((session) => session.sessionId === "fork-session");
    assert.deepEqual(fork, {
      sessionId: "fork-session",
      cwd: "/project",
      title: "Source (fork)",
      updatedAt: "2026-05-08T01:00:00.000Z",
      path: result.path,
    });
    assert.equal(Object.hasOwn(fork ?? {}, "parentSession"), false);
  });
});

describe("loadOmpSessionHistory", () => {
  it("replays rich OMP message history in ACP-renderable order", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "history", "history.jsonl", [
      { type: "session", id: "history", cwd: "/project" },
      { type: "message", role: "user", content: "hello" },
      {
        type: "message",
        role: "user",
        content: [
          { type: "text", text: "see image" },
          { type: "image", data: "aW1n", mimeType: "image/png", uri: "file:///image.png", providerPayload: { apiKey: "secret" } },
          { type: "resource_link", uri: "file:///spec.md", name: "spec.md", title: "Spec", headers: { authorization: "secret" } },
          { type: "resource", resource: { uri: "file:///notes.txt", text: "notes", mimeType: "text/plain", providerPayload: { secret: true } } },
        ],
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "safe reasoning", thinkingSignature: "secret-signature" },
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test", providerApiKey: "secret", accessKey: "secret", "api-key": "secret", plain_key: "secret", key: "secret", config: { mode: "private", baseURL: "https://secret.example", token: "secret" }, runtimeConfig: { retries: 3 } }, intent: "running tests" },
            { type: "text", text: "done", textSignature: "private-signature" },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "tests passed" }, { type: "image", data: "b3V0", mimeType: "image/png", providerPayload: { token: "secret" } }],
          providerPayload: { apiKey: "secret" },
        },
      },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "see image" } },
      { sessionUpdate: "user_message_chunk", content: { type: "image", data: "aW1n", mimeType: "image/png", uri: "file:///image.png" } },
      { sessionUpdate: "user_message_chunk", content: { type: "resource_link", uri: "file:///spec.md", name: "spec.md", title: "Spec" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "safe reasoning" } },
      {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Bash: npm test",
        kind: "execute",
        status: "pending",
        rawInput: { command: "npm test" },
        content: [{ type: "content", content: { type: "text", text: "$ npm test" } }],
      },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        rawOutput: { content: [{ type: "text", text: "tests passed" }, { type: "image", data: "b3V0", mimeType: "image/png" }] },
        content: [
          { type: "content", content: { type: "text", text: "tests passed" } },
          { type: "content", content: { type: "image", data: "b3V0", mimeType: "image/png" } },
        ],
      },
    ]);
  });

  it("reuses live tool translation semantics for replayed tool calls and results", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "live-tool-parity", "history.jsonl", [
      { type: "session", id: "live-tool-parity", cwd: "/project" },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-bash",
            name: "bash",
            arguments: JSON.stringify({ command: "npm run check", cwd: "/repo", token: "secret" }),
          },
        ],
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-bash",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "check passed" }],
          details: { exitCode: 0 },
        },
      },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      {
        sessionUpdate: "tool_call",
        toolCallId: "call-bash",
        title: "Bash: npm run check",
        kind: "execute",
        status: "pending",
        rawInput: { command: "npm run check", cwd: "/repo" },
        content: [{ type: "content", content: { type: "text", text: "$ npm run check" } }],
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-bash",
        status: "completed",
        rawOutput: { content: [{ type: "text", text: "check passed" }], details: { exitCode: 0 } },
        content: [{ type: "content", content: { type: "text", text: "check passed" } }],
      },
    ]);
  });

  it("sanitizes replayed tool result rawOutput content and details with shared safety rules", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "tool-result-safety", "history.jsonl", [
      { type: "session", id: "tool-result-safety", cwd: "/project" },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-safe",
          toolName: "bash",
          isError: false,
          content: [
            { type: "text", text: "safe result", providerPayload: { secret: "secret" }, token: "secret" },
          ],
          details: {
            exitCode: 0,
            config: { baseURL: "https://secret.example", token: "secret" },
            providerPayload: { token: "secret" },
          },
        },
      },
    ]);

    const updates = await loadOmpSessionHistory(path);

    assert.deepEqual(updates, [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-safe",
        status: "completed",
        rawOutput: { content: [{ type: "text", text: "safe result" }], details: { exitCode: 0 } },
        content: [{ type: "content", content: { type: "text", text: "safe result" } }],
      },
    ]);
    const serialized = JSON.stringify(updates);
    for (const forbidden of ["secret", "baseURL", "providerPayload", "token", "config"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });

  it("keeps replayed sensitive JSON string tool output as redacted text", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "json-output", "history.jsonl", [
      { type: "session", id: "json-output", cwd: "/project" },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "bash",
          isError: false,
          rawOutput: '{"token":"secret-token","ok":true,"config":{"baseURL":"https://private"}}',
        },
      },
    ]);

    const updates = await loadOmpSessionHistory(path);
    const result = updates.find((update) => update.sessionUpdate === "tool_call_update");
    assert.ok(result);
    assert.equal(typeof result.rawOutput, "string");
    assert.equal(JSON.stringify(result).includes("secret-token"), false);
    assert.equal(JSON.stringify(result).includes("https://private"), false);
    assert.equal(JSON.stringify(result).includes("token"), false);
    assert.equal(JSON.stringify(result).includes("baseURL"), false);
    assert.equal(JSON.stringify(result).includes("config"), false);
    assert.equal(result.content?.[0]?.type, "content");
    assert.equal((result.content?.[0] as { content: { text?: string } }).content.text, result.rawOutput);
  });

  it("redacts nested JSON strings in replayed structured tool output", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "nested-json-output", "history.jsonl", [
      { type: "session", id: "nested-json-output", cwd: "/project" },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tool-nested",
          toolName: "bash",
          isError: false,
          rawOutput: {
            stdout: '{"token":"secret-token","ok":true}',
            content: [{ type: "text", text: '{"apiKey":"secret-key","ok":true}' }],
          },
        },
      },
    ]);

    const updates = await loadOmpSessionHistory(path);
    const result = updates.find((update) => update.sessionUpdate === "tool_call_update");
    assert.ok(result);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("secret-token"), false);
    assert.equal(serialized.includes("secret-key"), false);
    assert.equal(serialized.includes("token"), false);
    assert.equal(serialized.includes("apiKey"), false);
  });

  it("replays top-level toolResult entries through shared tool result conversion", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "top-level-tool-result", "history.jsonl", [
      { type: "session", id: "top-level-tool-result", cwd: "/project" },
      { type: "toolResult", toolCallId: "top-level-call", toolName: "bash", rawOutput: '{"ok":true}' },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "top-level-call",
        status: "completed",
        rawOutput: '{"ok":true}',
        content: [{ type: "content", content: { type: "text", text: '{"ok":true}' } }],
      },
    ]);
  });

  it("preserves replayed toolResult content alongside raw output", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "raw-with-content", "history.jsonl", [
      { type: "session", id: "raw-with-content", cwd: "/project" },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-raw-with-content",
          toolName: "lookup",
          rawOutput: { data: { value: 1 } },
          content: [{ type: "text", text: "visible output" }],
        },
      },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-raw-with-content",
        status: "completed",
        rawOutput: { data: { value: 1 }, content: [{ type: "text", text: "visible output" }] },
        content: [{ type: "content", content: { type: "text", text: "visible output" } }],
      },
    ]);
  });

  it("preserves explicit toolResult content when raw output content sanitizes away", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "raw-with-private-content", "history.jsonl", [
      { type: "session", id: "raw-with-private-content", cwd: "/project" },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-private-raw-content",
          toolName: "lookup",
          rawOutput: { data: { value: 1 }, content: [{ type: "provider_payload", text: "hidden" }] },
          content: [{ type: "text", text: "visible output" }],
        },
      },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-private-raw-content",
        status: "completed",
        rawOutput: { data: { value: 1 }, content: [{ type: "text", text: "visible output" }] },
        content: [{ type: "content", content: { type: "text", text: "visible output" } }],
      },
    ]);
  });

  it("preserves explicit toolResult content alongside string raw output", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "string-raw-with-content", "history.jsonl", [
      { type: "session", id: "string-raw-with-content", cwd: "/project" },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-string-raw-content",
          toolName: "lookup",
          rawOutput: '{"ok":true}',
          content: [{ type: "text", text: "visible output" }],
        },
      },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-string-raw-content",
        status: "completed",
        rawOutput: '{"ok":true}',
        content: [
          { type: "content", content: { type: "text", text: '{"ok":true}' } },
          { type: "content", content: { type: "text", text: "visible output" } },
        ],
      },
    ]);
  });

  it("preserves sanitized replayed tool result rawOutput output and result payloads", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "tool-result-payloads", "history.jsonl", [
      { type: "session", id: "tool-result-payloads", cwd: "/project" },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-raw",
          toolName: "lookup",
          rawOutput: JSON.stringify({ data: { value: 1 }, token: "secret", config: { baseURL: "https://secret.example" } }),
          content: [{ type: "text", text: "visible safe text" }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-output",
          toolName: "lookup",
          output: { data: { value: 2 }, token: "secret", config: { baseURL: "https://secret.example" } },
          result: { data: { value: "lower-priority" } },
          content: [{ type: "text", text: "output safe text" }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-result",
          toolName: "lookup",
          result: { data: { value: 3 }, token: "secret", config: { baseURL: "https://secret.example" } },
          content: [{ type: "text", text: "result safe text" }],
        },
      },
    ]);

    const updates = await loadOmpSessionHistory(path);

    assert.deepEqual(updates, [
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-raw",
        status: "completed",
        rawOutput: '{"data":{"value":1}}',
        content: [
          { type: "content", content: { type: "text", text: '{"data":{"value":1}}' } },
          { type: "content", content: { type: "text", text: "visible safe text" } },
        ],
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-output",
        status: "completed",
        rawOutput: { data: { value: 2 }, content: [{ type: "text", text: "output safe text" }] },
        content: [{ type: "content", content: { type: "text", text: "output safe text" } }],
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-result",
        status: "completed",
        rawOutput: { data: { value: 3 }, content: [{ type: "text", text: "result safe text" }] },
        content: [{ type: "content", content: { type: "text", text: "result safe text" } }],
      },
    ]);
    const serialized = JSON.stringify(updates);
    for (const forbidden of ["secret", "baseURL", "token", "config"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });

  it("replays assistant and user messages through shared content sanitization", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "message-safety", "history.jsonl", [
      { type: "session", id: "message-safety", cwd: "/project" },
      {
        type: "message",
        role: "user",
        content: [
          { type: "text", text: "safe user", providerPayload: { token: "secret" } },
          { type: "image", data: "aW1n", mimeType: "image/png", uri: "file:///safe.png", config: { token: "secret" } },
          { type: "resource_link", uri: "file:///safe.md", name: "safe.md", title: "Safe", signature: "secret" },
          { type: "resource", resource: { uri: "file:///safe.txt", text: "safe resource", mimeType: "text/plain" }, encrypted: "secret" },
          { type: "note", title: "Safe note", text: "safe summary" },
          { type: "provider_private", text: "secret" },
        ],
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "safe assistant", providerPayload: { token: "secret" } },
            { type: "thinking", thinking: "safe thought", signature: "secret" },
            { type: "resource", resource: { uri: "file:///assistant.txt", text: "assistant resource", mimeType: "text/plain" } },
            { type: "analysis_note", title: "Checked", text: "safe assistant summary" },
            { type: "signature", text: "secret" },
            { type: "encrypted", text: "secret" },
          ],
        },
      },
    ]);

    const updates = await loadOmpSessionHistory(path);

    assert.deepEqual(updates, [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "safe user" } },
      { sessionUpdate: "user_message_chunk", content: { type: "image", data: "aW1n", mimeType: "image/png", uri: "file:///safe.png" } },
      { sessionUpdate: "user_message_chunk", content: { type: "resource_link", uri: "file:///safe.md", name: "safe.md", title: "Safe" } },
      { sessionUpdate: "user_message_chunk", content: { type: "resource", resource: { uri: "file:///safe.txt", text: "safe resource", mimeType: "text/plain" } } },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "[note] Safe note\nsafe summary" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "safe assistant" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "safe thought" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "resource", resource: { uri: "file:///assistant.txt", text: "assistant resource", mimeType: "text/plain" } } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[analysis_note] Checked\nsafe assistant summary" } },
    ]);
    const serialized = JSON.stringify(updates);
    for (const forbidden of ["secret", "provider_private", "signature", "encrypted", "token", "config"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });

  it("redacts sensitive JSON string message history", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "string-message-safety", "history.jsonl", [
      { type: "session", id: "string-message-safety", cwd: "/project" },
      { type: "message", role: "assistant", content: '{"token":"secret-token","ok":true}' },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: '{"ok":true}' } },
    ]);
  });

  it("redacts sensitive session header titles", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "session-title-safety", "history.jsonl", [
      { type: "session", id: "session-title-safety", cwd: "/project", title: '{"token":"secret-token","ok":true}' },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      { sessionUpdate: "session_info_update", title: '{"ok":true}' },
    ]);
  });

  it("redacts sensitive image mime types in message history", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "image-mime-safety", "history.jsonl", [
      { type: "session", id: "image-mime-safety", cwd: "/project" },
      { type: "message", role: "assistant", content: [{ type: "image", data: "aW1n", mimeType: '{"apiKey":"secret-key","ok":true}' }] },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "aW1n", mimeType: '{"ok":true}' } },
    ]);
  });

  it("redacts sensitive JSON string custom message history", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "custom-message-safety", "history.jsonl", [
      { type: "session", id: "custom-message-safety", cwd: "/project" },
      { type: "custom_message", display: true, customType: "note", content: '{"token":"secret-token","ok":true}' },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[redacted]" } },
    ]);
  });

  it("redacts sensitive JSON string unknown history summaries", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "unknown-summary-safety", "history.jsonl", [
      { type: "session", id: "unknown-summary-safety", cwd: "/project" },
      { type: "message", role: "assistant", content: [{ type: "note", text: '{"apiKey":"secret-key","ok":true}' }] },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[note]\n{\"ok\":true}" } },
    ]);
  });

  it("redacts sensitive resource link names in message history", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "resource-link-name-safety", "history.jsonl", [
      { type: "session", id: "resource-link-name-safety", cwd: "/project" },
      { type: "message", role: "assistant", content: [{ type: "resource_link", uri: "file:///safe", name: '{"apiKey":"secret-key","ok":true}' }] },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      { sessionUpdate: "agent_message_chunk", content: { type: "resource_link", uri: "file:///safe", name: '{"ok":true}' } },
    ]);
  });

  it("redacts sensitive JSON string top-level history summaries", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "top-level-summary-safety", "history.jsonl", [
      { type: "session", id: "top-level-summary-safety", cwd: "/project" },
      { type: "branch_summary", summary: '{"token":"secret-token","ok":true}' },
      { type: "compaction", summary: '{"apiKey":"secret-key","ok":true}' },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[branch_summary]\n{\"ok\":true}" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[compaction]\n{\"ok\":true}" } },
    ]);
  });

  it("redacts sensitive custom message prefixes", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "custom-prefix-safety", "history.jsonl", [
      { type: "session", id: "custom-prefix-safety", cwd: "/project" },
      { type: "custom_message", display: true, customType: '{"token":"secret-token","ok":true}', content: [{ type: "text", text: "safe" }] },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: '[{"ok":true}]\nsafe' } },
    ]);
  });

  it("redacts sensitive top-level history event fields", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "top-level-field-safety", "history.jsonl", [
      { type: "session", id: "top-level-field-safety", cwd: "/project" },
      { type: "model_change", model: '{"token":"secret-token","ok":true}' },
      { type: "thinking_level_change", thinkingLevel: '{"apiKey":"secret-key","ok":true}' },
      { type: "service_tier_change", serviceTier: '{"accessKey":"secret-access-key","ok":true}' },
      { type: "mode_change", mode: '{"key":"secret-key","ok":true}' },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: '[model_change]\nmodel: {"ok":true}' } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: '[thinking_level_change]\nthinking: {"ok":true}' } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: '[service_tier_change]\nservice tier: {"ok":true}' } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: '[mode_change]\nmode: {"ok":true}' } },
    ]);
  });

  it("summarizes unknown safe history blocks without leaking provider-private fields", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "unknown", "unknown.jsonl", [
      { type: "session", id: "unknown", cwd: "/project" },
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", itemId: "rs-1", thinkingSignature: "encrypted-private" },
          { type: "analysis_note", title: "Checked", text: "safe note" },
          { type: "provider_payload", encrypted_content: "ciphertext", text: "should not leak" },
        ],
      },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[analysis_note] Checked\nsafe note" } },
    ]);
  });

  it("marks errored assistant and tool history as visible failed updates", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "errors", "errors.jsonl", [
      { type: "session", id: "errors", cwd: "/project" },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        stopReason: "error",
        errorMessage: "model failed",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { total: 0.1234 } },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-error",
          toolName: "read",
          isError: true,
          content: [{ type: "text", text: "file missing" }],
        },
      },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[assistant_error]\nmodel failed" } },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-error",
        status: "failed",
        rawOutput: { content: [{ type: "text", text: "file missing" }] },
        content: [{ type: "content", content: { type: "text", text: "file missing" } }],
      },
    ]);
  });

  it("replays safe top-level history events without surfacing hidden custom messages", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "events", "events.jsonl", [
      { type: "session", id: "events", cwd: "/project", title: "Loaded title", timestamp: "2026-05-09T01:00:00.000Z" },
      { type: "model_change", model: "provider/model", timestamp: "2026-05-09T01:01:00.000Z", providerPayload: { apiKey: "secret" } },
      { type: "thinking_level_change", thinkingLevel: "high", timestamp: "2026-05-09T01:02:00.000Z" },
      { type: "custom_message", customType: "visible-note", content: "show this", display: true },
      { type: "custom_message", customType: "visible-array", content: [{ type: "text", text: "array text", textSignature: "private" }, { type: "image", data: "YQ==", mimeType: "image/png", providerPayload: { secret: true } }], display: true },
      { type: "custom_message", customType: "hidden-note", content: "hide this", display: false },
      { type: "custom_message", customType: "implicit-hidden", content: "also hide this" },
      { type: "branch_summary", summary: "checkpoint summary" },
      { type: "compaction", summary: "compacted context", tokensBefore: 1000 },
      { type: "service_tier_change", serviceTier: "flex" },
      { type: "mode_change", mode: "plan" },
    ]);

    assert.deepEqual(await loadOmpSessionHistory(path), [
      { sessionUpdate: "session_info_update", title: "Loaded title", updatedAt: "2026-05-09T01:00:00.000Z" },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[model_change]\nmodel: provider/model" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[thinking_level_change]\nthinking: high" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[visible-note]\nshow this" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[visible-array]\narray text" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "image", data: "YQ==", mimeType: "image/png" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[branch_summary]\ncheckpoint summary" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[compaction]\ncompacted context" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[service_tier_change]\nservice tier: flex" } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[mode_change]\nmode: plan" } },
    ]);
  });

  it("throws for unsupported message roles and skips messages without any text fallback", async () => {
    const agentDir = await tempAgentDir();
    const unsupportedRolePath = await writeSessionFile(agentDir, "unsupported-role", "role.jsonl", [
      { type: "session", id: "role", cwd: "/project" },
      { type: "message", role: "tool", content: "tool output" },
    ]);
    const unsupportedContentPath = await writeSessionFile(agentDir, "unsupported-content", "content.jsonl", [
      { type: "session", id: "content", cwd: "/project" },
      { type: "message", role: "user", content: [{ type: "image", url: "file:///image.png" }] },
    ]);

    await assert.rejects(loadOmpSessionHistory(unsupportedRolePath), /Unsupported OMP message role/);
    assert.deepEqual(await loadOmpSessionHistory(unsupportedContentPath), []);
  });
});