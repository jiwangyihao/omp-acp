import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { Agent, LoadSessionRequest, ListSessionsRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import { createOmpAcpAgent } from "../../../src/acp/server.ts";
import type { RuntimeAdapter } from "../../../src/runtime/RuntimeAdapter.ts";
import type { RuntimeEvent } from "../../../src/runtime/RuntimeEvents.ts";
import { SessionManager, type RuntimeFactoryInput } from "../../../src/session/manager.ts";

const CONTROL_STATE = {
  model: { provider: "p", id: "m1", name: "Model One" },
  thinkingLevel: "low",
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  interruptMode: "immediate",
  autoCompactionEnabled: true,
  sessionId: "omp-runtime-session",
};

const AVAILABLE_MODELS = [{ provider: "p", id: "m1", name: "Model One", thinking: { minLevel: "minimal", maxLevel: "high" } }];

class FakeRuntime implements RuntimeAdapter {
  readonly ready = Promise.resolve();
  readonly diagnostics = { stderr: "" };
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  readonly sent: unknown[] = [];
  closed = false;
  readonly listeners = new Set<(event: RuntimeEvent) => void>();
  getStateFailure: unknown;
  closeFailure: unknown;
  activeToolNames = ["bash"];

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "switch_session") {
      this.activeToolNames = ["ask", "bash"];
      return { ok: true };
    }
    if (method === "set_active_tools") {
      this.activeToolNames = (params as { toolNames: string[] }).toolNames;
      return { ok: true };
    }
    if (method === "get_state") {
      if (this.getStateFailure !== undefined) throw this.getStateFailure;
      return {
        ...structuredClone(CONTROL_STATE),
        dumpTools: this.activeToolNames.map((name) => ({ name })),
      };
    }
    if (method === "get_available_models") return structuredClone(AVAILABLE_MODELS);
    if (method === "prompt") {
      queueMicrotask(() => this.emit({ type: "event", eventType: "agent_end", raw: {} }));
    }
    return { ok: true };
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: RuntimeEvent): void {
    for (const listener of Array.from(this.listeners)) {
      listener(event);
    }
  }

  async send(frame: unknown): Promise<void> {
    this.sent.push(frame);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.closeFailure !== undefined) throw this.closeFailure;
  }
}

type TestAgent = Agent & Required<Pick<Agent, "loadSession" | "listSessions">>;

async function makeAgent(options: { getStateFailure?: unknown; sessionUpdateFailure?: Error; closeFailure?: Error } = {}) {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-acp-agent-"));
  const runtimes: FakeRuntime[] = [];
  const inputs: RuntimeFactoryInput[] = [];
  const manager = new SessionManager({
    runtimeFactory: (input) => {
      inputs.push(input);
      const runtime = new FakeRuntime();
      runtime.getStateFailure = options.getStateFailure;
      runtimes.push(runtime);
      runtime.closeFailure = options.closeFailure;
      return runtime;
    },
  });
  const updates: Array<{ sessionId: string; update: SessionUpdate }> = [];
  const connection = {
    sessionUpdate: async (params: { sessionId: string; update: SessionUpdate }) => {
      if (options.sessionUpdateFailure !== undefined) throw options.sessionUpdateFailure;
      updates.push(params);
    },
  };
  const agent = createOmpAcpAgent(connection as never, manager, {}, { agentDir }) as TestAgent;
  return { agent, agentDir, manager, runtimes, inputs, updates };
}

async function writeSession(agentDir: string, cwd: string, sessionId: string, lines: unknown[]) {
  const dir = join(agentDir, "sessions", `--${sessionId}--`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

test("listSessions returns OMP session info filtered by cwd", async () => {
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

  const response = await agent.listSessions({ cwd: projectCwd } as ListSessionsRequest);

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

  assert.ok(response.models);
  assert.ok(response.modes);
  assert.ok(response.configOptions?.some((option: { id: string }) => option.id === "model"));
  assert.equal(Object.hasOwn(response, "runtimeSessionId"), false);
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0], { sessionId: "load-me", cwd, mcpServers: [] });
  assert.deepEqual(runtimes[0]?.requests, [
    { method: "switch_session", params: { sessionPath } },
    { method: "get_state", params: undefined },
    { method: "set_active_tools", params: { toolNames: ["bash"] } },
    { method: "get_state", params: undefined },
    { method: "get_available_models", params: undefined },
  ]);
  assert.deepEqual(updates, [
    { sessionId: "load-me", update: { sessionUpdate: "session_info_update", updatedAt: "2026-05-08T01:00:00.000Z" } },
    { sessionId: "load-me", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "question" } } },
    { sessionId: "load-me", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } },
  ]);

  await agent.prompt({ sessionId: "load-me", prompt: [{ type: "text", text: "next" }] });
  assert.deepEqual(runtimes[0]?.requests.slice(-2), [
    { method: "prompt", params: { message: "next" } },
    { method: "get_state", params: undefined },
  ]);
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

test("loadSession does not publish when setup state build fails", async () => {
  const { agent, agentDir, manager } = await makeAgent({ getStateFailure: new Error("state failed") });
  const cwd = join(tmpdir(), "load-state-fails");
  await writeSession(agentDir, cwd, "load-state-fails", [
    { type: "session", id: "load-state-fails", cwd, timestamp: "2026-05-08T01:00:00.000Z" },
  ]);

  await assert.rejects(
    agent.loadSession({ sessionId: "load-state-fails", cwd, mcpServers: [] } as LoadSessionRequest),
    /Runtime failed to become ready/,
  );
  assert.equal(manager.tryGetSession("load-state-fails"), undefined);
});

test("loadSession closes and unpublishes when history replay fails", async () => {
  const { agent, agentDir, manager, runtimes } = await makeAgent({ sessionUpdateFailure: new Error("replay failed") });
  const cwd = join(tmpdir(), "load-replay-fails");
  await writeSession(agentDir, cwd, "load-replay-fails", [
    { type: "session", id: "load-replay-fails", cwd, timestamp: "2026-05-08T01:00:00.000Z" },
    { type: "message", role: "assistant", content: "answer" },
  ]);

  await assert.rejects(
    agent.loadSession({ sessionId: "load-replay-fails", cwd, mcpServers: [] } as LoadSessionRequest),
    /replay failed/,
  );
  assert.equal(manager.tryGetSession("load-replay-fails"), undefined);
  assert.equal(runtimes[0]?.closed, true);
});

test("loadSession preserves replay failure when rollback close also fails", async () => {
  const { agent, agentDir, manager, runtimes } = await makeAgent({
    sessionUpdateFailure: new Error("replay failed"),
    closeFailure: new Error("close failed"),
  });
  const cwd = join(tmpdir(), "load-replay-close-fails");
  await writeSession(agentDir, cwd, "load-replay-close-fails", [
    { type: "session", id: "load-replay-close-fails", cwd, timestamp: "2026-05-08T01:00:00.000Z" },
    { type: "message", role: "assistant", content: "answer" },
  ]);

  await assert.rejects(
    agent.loadSession({ sessionId: "load-replay-close-fails", cwd, mcpServers: [] } as LoadSessionRequest),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /session\/load history replay failed and rollback cleanup failed/);
      assert.equal(error.errors.length, 2);
      assert.match(String(error.errors[0]), /replay failed/);
      assert.match(String(error.errors[1]), /close failed/);
      return true;
    },
  );
  assert.equal(manager.tryGetSession("load-replay-close-fails"), undefined);
  assert.equal(runtimes[0]?.closed, true);
});