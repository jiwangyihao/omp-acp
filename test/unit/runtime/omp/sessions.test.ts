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
  it("converts user and assistant string and text-block messages to ACP chunks in file order", async () => {
    const agentDir = await tempAgentDir();
    const path = await writeSessionFile(agentDir, "history", "history.jsonl", [
      { type: "session", id: "history", cwd: "/project" },
      { type: "message", role: "user", content: "hello" },
      { type: "message", role: "assistant", content: [{ type: "text", text: "hi" }] },
      { type: "message", role: "user", content: [{ type: "text", text: "again" }, { type: "image", url: "ignored-by-error-test" }] },
    ]);

    await assert.rejects(loadOmpSessionHistory(path), /Unsupported OMP message content/);

    await writeFile(
      path,
      [
        { type: "session", id: "history", cwd: "/project" },
        { type: "message", message: { role: "user", content: "hello" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "again" }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    );

    assert.deepEqual(await loadOmpSessionHistory(path), [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "again" } },
    ]);
  });

  it("throws for unsupported message roles and content instead of silently dropping history", async () => {
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
    await assert.rejects(loadOmpSessionHistory(unsupportedContentPath), /Unsupported OMP message content/);
  });
});