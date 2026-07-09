import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { Agent, ResumeSessionRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import { createOmpAcpAgent } from "../../../src/acp/server.ts";
import type { RuntimeAdapter } from "../../../src/runtime/RuntimeAdapter.ts";
import type { RuntimeEvent } from "../../../src/runtime/RuntimeEvents.ts";
import { SessionManager, type RuntimeFactoryInput } from "../../../src/session/manager.ts";

const CONTROL_STATE = {
  model: { provider: "p", id: "m1", name: "Model One" },
  thinkingLevel: "low",
  sessionId: "omp-runtime-session",
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  interruptMode: "immediate",
  autoCompactionEnabled: true,
};

const AVAILABLE_MODELS = [{ provider: "p", id: "m1", name: "Model One", thinking: { minLevel: "minimal", maxLevel: "high" } }];

class FakeRuntime implements RuntimeAdapter {
  readonly ready = Promise.resolve();
  readonly diagnostics = { stderr: "" };
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  closed = false;
  readonly listeners = new Set<(event: RuntimeEvent) => void>();
  getStateFailure: unknown;
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

  async send(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

type TestAgent = Agent & Required<Pick<Agent, "resumeSession">>;

async function makeAgent(options: { getStateFailure?: unknown } = {}) {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-acp-resume-agent-"));
  const runtimes: FakeRuntime[] = [];
  const inputs: RuntimeFactoryInput[] = [];
  const manager = new SessionManager({
    runtimeFactory: (input) => {
      inputs.push(input);
      const runtime = new FakeRuntime();
      runtime.getStateFailure = options.getStateFailure;
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
  return { agent, agentDir, manager, runtimes, inputs, updates };
}

async function writeSession(agentDir: string, cwd: string, sessionId: string, lines: unknown[]) {
  const dir = join(agentDir, "sessions", `--${sessionId}--`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

test("resumeSession switches runtime to OMP session path, publishes same session id, and does not replay history", async () => {
  const { agent, agentDir, runtimes, inputs, updates } = await makeAgent();
  const cwd = join(tmpdir(), "resume-project");
  const sessionPath = await writeSession(agentDir, cwd, "resume-me", [
    { type: "session", id: "resume-me", cwd, timestamp: "2026-05-08T01:00:00.000Z" },
    { type: "message", role: "user", content: "old question" },
    { type: "message", role: "assistant", content: "old answer" },
  ]);

  const response = await agent.resumeSession({ sessionId: "resume-me", cwd, mcpServers: [] } as ResumeSessionRequest);

  assert.ok(response.models);
  assert.ok(response.modes);
  assert.ok(response.configOptions?.some((option: { id: string }) => option.id === "model"));
  assert.equal(Object.hasOwn(response, "runtimeSessionId"), false);
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0], { sessionId: "resume-me", cwd, mcpServers: [], additionalDirectories: [] });
  assert.deepEqual(runtimes[0]?.requests, [
    { method: "switch_session", params: { sessionPath } },
    { method: "get_state", params: undefined },
    { method: "set_active_tools", params: { toolNames: ["bash"] } },
    { method: "get_state", params: undefined },
    { method: "get_available_models", params: undefined },
  ]);
  assert.deepEqual(updates, []);

  await agent.prompt({ sessionId: "resume-me", prompt: [{ type: "text", text: "after resume" }] });
  assert.deepEqual(runtimes[0]?.requests.slice(-2), [
    { method: "prompt", params: { message: "after resume" } },
    { method: "get_state", params: undefined },
  ]);
});

test("resumeSession fails clearly for unknown sessions", async () => {
  const { agent } = await makeAgent();
  const cwd = join(tmpdir(), "resume-missing");

  await assert.rejects(
    agent.resumeSession({ sessionId: "missing", cwd, mcpServers: [] } as ResumeSessionRequest),
    /Unknown OMP session: missing/,
  );
});

test("resumeSession does not publish when setup state build fails", async () => {
  const { agent, agentDir, manager } = await makeAgent({ getStateFailure: new Error("state failed") });
  const cwd = join(tmpdir(), "resume-state-fails");
  await writeSession(agentDir, cwd, "resume-state-fails", [
    { type: "session", id: "resume-state-fails", cwd, timestamp: "2026-05-08T01:00:00.000Z" },
  ]);

  await assert.rejects(
    agent.resumeSession({ sessionId: "resume-state-fails", cwd, mcpServers: [] } as ResumeSessionRequest),
    /Runtime failed to become ready/,
  );
  assert.equal(manager.tryGetSession("resume-state-fails"), undefined);
});