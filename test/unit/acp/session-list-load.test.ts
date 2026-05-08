import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { LoadSessionRequest, ListSessionsRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import { createOmpAcpAgent } from "../../../src/acp/server.ts";
import type { RuntimeAdapter } from "../../../src/runtime/RuntimeAdapter.ts";
import { SessionManager, type RuntimeFactoryInput } from "../../../src/session/manager.ts";

class FakeRuntime implements RuntimeAdapter {
  readonly ready = Promise.resolve();
  readonly diagnostics = [];
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  readonly sent: unknown[] = [];
  closed = false;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return { ok: true };
  }

  onEvent(): () => void {
    return () => {};
  }

  async send(frame: unknown): Promise<void> {
    this.sent.push(frame);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

type TestAgent = ReturnType<typeof createOmpAcpAgent>;

async function makeAgent() {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-acp-agent-"));
  const runtimes: FakeRuntime[] = [];
  const inputs: RuntimeFactoryInput[] = [];
  const manager = new SessionManager({
    runtimeFactory: (input) => {
      inputs.push(input);
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return runtime;
    },
  });
  const updates: Array<{ sessionId: string; update: SessionUpdate }> = [];
  const connection = {
    sessionUpdate: async (params: { sessionId: string; update: SessionUpdate }) => {
      updates.push(params);
    },
  };
  const agent = createOmpAcpAgent(connection as never, manager, {}, { agentDir }) as TestAgent;
  return { agent, agentDir, runtimes, inputs, updates };
}

async function writeSession(agentDir: string, cwd: string, sessionId: string, lines: unknown[]) {
  const dir = join(agentDir, "sessions", `--${sessionId}--`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

test("unstable_listSessions returns OMP session info filtered by cwd", async () => {
  const { agent, agentDir } = await makeAgent();
  const projectCwd = join(tmpdir(), "project-a");
  const otherCwd = join(tmpdir(), "project-b");
  const firstPath = await writeSession(agentDir, projectCwd, "session-a", [
    { type: "session", id: "session-a", cwd: projectCwd, timestamp: "2026-05-08T01:00:00.000Z", title: "Alpha" },
    { type: "message", role: "user", content: "hello", timestamp: "2026-05-08T02:00:00.000Z" },
  ]);
  await writeSession(agentDir, otherCwd, "session-b", [
    { type: "session", id: "session-b", cwd: otherCwd, timestamp: "2026-05-08T03:00:00.000Z" },
  ]);

  const response = await agent.unstable_listSessions({ cwd: projectCwd } as ListSessionsRequest);

  assert.deepEqual(response, {
    sessions: [
      {
        sessionId: "session-a",
        cwd: projectCwd,
        title: "Alpha",
        updatedAt: "2026-05-08T02:00:00.000Z",
        _meta: { ompSessionPath: firstPath },
      },
    ],
  });
});

test("loadSession switches runtime to OMP session path, replays text history, and publishes session", async () => {
  const { agent, agentDir, runtimes, inputs, updates } = await makeAgent();
  const cwd = join(tmpdir(), "load-project");
  const sessionPath = await writeSession(agentDir, cwd, "load-me", [
    { type: "session", id: "load-me", cwd, timestamp: "2026-05-08T01:00:00.000Z" },
    { type: "message", role: "user", content: "question" },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
  ]);

  const response = await agent.loadSession({ sessionId: "load-me", cwd, mcpServers: [] } as LoadSessionRequest);

  assert.deepEqual(response, {});
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0], { sessionId: "load-me", cwd, mcpServers: [] });
  assert.deepEqual(runtimes[0]?.requests, [{ method: "switch_session", params: { sessionPath } }]);
  assert.deepEqual(updates, [
    { sessionId: "load-me", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "question" } } },
    { sessionId: "load-me", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } },
  ]);

  await agent.prompt({ sessionId: "load-me", prompt: [{ type: "text", text: "next" }] });
  assert.equal(runtimes[0]?.requests.at(-1)?.method, "prompt");
});

test("loadSession fails clearly for unknown sessions and unsupported history", async () => {
  const { agent, agentDir } = await makeAgent();
  const cwd = join(tmpdir(), "load-fails");

  await assert.rejects(
    agent.loadSession({ sessionId: "missing", cwd, mcpServers: [] } as LoadSessionRequest),
    /Unknown OMP session: missing/,
  );

  await writeSession(agentDir, cwd, "bad-history", [
    { type: "session", id: "bad-history", cwd, timestamp: "2026-05-08T01:00:00.000Z" },
    { type: "message", role: "tool", content: "unsupported" },
  ]);

  await assert.rejects(
    agent.loadSession({ sessionId: "bad-history", cwd, mcpServers: [] } as LoadSessionRequest),
    /Unsupported OMP message role/,
  );
});