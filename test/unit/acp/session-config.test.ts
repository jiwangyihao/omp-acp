import assert from "node:assert/strict";
import test from "node:test";
import { handleSessionNew } from "../../../src/acp/handlers/session-new.ts";
import type { RuntimeAdapter, RuntimeDiagnostics } from "../../../src/runtime/RuntimeAdapter.ts";
import { SessionManager, type RuntimeFactoryInput } from "../../../src/session/manager.ts";

const CONTROL_STATE = {
  model: { provider: "p", id: "m1", name: "Model One" },
  thinkingLevel: "low",
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  interruptMode: "immediate",
  autoCompactionEnabled: true,
};

const AVAILABLE_MODELS = [{ provider: "p", id: "m1", name: "Model One", thinking: { minLevel: "minimal", maxLevel: "high" } }];

class FakeRuntime implements RuntimeAdapter {
  readonly ready = Promise.resolve();
  readonly diagnostics: RuntimeDiagnostics = { stderr: "" };
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  getStateFailure: unknown;
  closed = false;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "get_state") {
      if (this.getStateFailure !== undefined) throw this.getStateFailure;
      return structuredClone(CONTROL_STATE);
    }
    if (method === "get_available_models") return structuredClone(AVAILABLE_MODELS);
    return undefined;
  }

  send(): Promise<void> { return Promise.resolve(); }
  onEvent(): () => void { return () => {}; }
  async close(): Promise<void> { this.closed = true; }
}

function createHarness(options: { getStateFailure?: unknown } = {}) {
  const runtimes: FakeRuntime[] = [];
  const inputs: RuntimeFactoryInput[] = [];
  let nextId = 1;
  const manager = new SessionManager({
    idGenerator: () => `session-${nextId++}`,
    runtimeFactory(input) {
      inputs.push(input);
      const runtime = new FakeRuntime();
      runtime.getStateFailure = options.getStateFailure;
      runtimes.push(runtime);
      return runtime;
    },
  });
  return { manager, runtimes, inputs };
}

test("handleSessionNew returns setup state before publishing the session", async () => {
  const { manager, runtimes, inputs } = createHarness();

  const response = await handleSessionNew({ cwd: "/workspace/project", mcpServers: [] }, manager);

  assert.equal(response.sessionId, "session-1");
  assert.ok(response.models);
  assert.ok(response.modes);
  assert.ok(response.configOptions?.some((option) => option.id === "model"));
  assert.deepEqual(inputs, [{ cwd: "/workspace/project", mcpServers: [], sessionId: "session-1" }]);
  assert.deepEqual(runtimes[0]?.requests, [
    { method: "get_state", params: undefined },
    { method: "get_available_models", params: undefined },
  ]);
  assert.equal(manager.tryGetSession("session-1")?.runtime, runtimes[0]);
});

test("handleSessionNew does not publish a session when setup state build fails", async () => {
  const { manager, runtimes } = createHarness({ getStateFailure: new Error("state failed") });

  await assert.rejects(handleSessionNew({ cwd: "/workspace/project", mcpServers: [] }, manager), /Runtime failed to become ready/);

  assert.equal(manager.tryGetSession("session-1"), undefined);
  assert.equal(runtimes[0]?.closed, true);
});