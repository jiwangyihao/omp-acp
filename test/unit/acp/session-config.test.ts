import assert from "node:assert/strict";
import test from "node:test";
import { createOmpAcpAgent } from "../../../src/acp/server.ts";
import { handleSessionNew } from "../../../src/acp/handlers/session-new.ts";
import { toPublicSessionSetupState } from "../../../src/acp/session-controls.ts";
import type { RuntimeAdapter, RuntimeDiagnostics } from "../../../src/runtime/RuntimeAdapter.ts";
import { SessionManager, type RuntimeFactoryInput } from "../../../src/session/manager.ts";
import type { Agent, SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";

const CONTROL_STATE = {
  model: { provider: "p", id: "m1", name: "Model One" },
  thinkingLevel: "low",
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  interruptMode: "immediate",
  autoCompactionEnabled: true,
  sessionId: "omp-runtime-session",
  dumpTools: [{ name: "read" }, { name: "ask" }, { name: "plugin_tool" }],
};
const AVAILABLE_MODELS = [
  { provider: "p", id: "m1", name: "Model One", thinking: { minLevel: "minimal", maxLevel: "high" } },
  { provider: "p", id: "m2", name: "Model Two", thinking: { minLevel: "minimal", maxLevel: "medium" } },
];

class FakeRuntime implements RuntimeAdapter {
  readonly ready = Promise.resolve();
  readonly diagnostics: RuntimeDiagnostics = { stderr: "" };
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  getStateFailure: unknown;
  closed = false;
  state = structuredClone(CONTROL_STATE);
  models = structuredClone(AVAILABLE_MODELS);

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "get_state") {
      if (this.getStateFailure !== undefined) throw this.getStateFailure;
      return structuredClone(this.state);
    }
    if (method === "get_available_models") return structuredClone(this.models);
    if (method === "set_model") {
      const request = params as { provider?: string; modelId?: string };
      const model = this.models.find((candidate) => candidate.provider === request.provider && candidate.id === request.modelId);
      assert.ok(model, `unknown model ${request.provider}/${request.modelId}`);
      this.state.model = { provider: model.provider, id: model.id, name: model.name };
      return undefined;
    }
    if (method === "set_thinking_level") {
      this.state.thinkingLevel = (params as { level: string }).level;
      return undefined;
    }
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

type ConfigAgent = Agent & Required<Pick<Agent, "setSessionMode" | "unstable_setSessionModel" | "setSessionConfigOption">>;

class FakeConnection {
  readonly updates: Array<{ sessionId: string; update: SessionUpdate }> = [];

  async sessionUpdate(params: { sessionId: string; update: SessionUpdate }): Promise<void> {
    this.updates.push(params);
  }
}

async function createAgentHarness(options: { getStateFailure?: unknown } = {}) {
  const harness = createHarness(options);
  const connection = new FakeConnection();
  const agent = createOmpAcpAgent(connection as never, harness.manager) as ConfigAgent;
  const session = await agent.newSession({ cwd: "/workspace/project", mcpServers: [] });
  return { ...harness, agent, connection, session };
}

test("handleSessionNew disables ask before building setup state and publishes runtime session id", async () => {
  const { manager, runtimes, inputs } = createHarness();

  const response = await handleSessionNew({ cwd: "/workspace/project", mcpServers: [] }, manager);

  assert.equal(response.sessionId, "omp-runtime-session");
  assert.ok(response.models);
  assert.ok(response.modes);
  assert.ok(response.configOptions?.some((option) => option.id === "model"));
  assert.equal(Object.hasOwn(response, "runtimeSessionId"), false);
  assert.deepEqual(inputs, [{ cwd: "/workspace/project", mcpServers: [], sessionId: "session-1", additionalDirectories: [] }]);
  assert.deepEqual(runtimes[0]?.requests, [
    { method: "get_state", params: undefined },
    { method: "set_active_tools", params: { toolNames: ["read", "plugin_tool"] } },
    { method: "get_state", params: undefined },
    { method: "get_available_models", params: undefined },
  ]);
  assert.equal(manager.tryGetSession("session-1"), undefined);
  assert.equal(manager.tryGetSession("omp-runtime-session")?.runtime, runtimes[0]);
});

test("handleSessionNew does not publish a session when setup state build fails", async () => {
  const { manager, runtimes } = createHarness({ getStateFailure: new Error("state failed") });

  await assert.rejects(handleSessionNew({ cwd: "/workspace/project", mcpServers: [] }, manager), /Runtime failed to become ready/);

  assert.equal(manager.tryGetSession("session-1"), undefined);
  assert.equal(runtimes[0]?.closed, true);
});

test("toPublicSessionSetupState removes internal runtime session id", () => {
  const response = toPublicSessionSetupState({
    models: { availableModels: [{ modelId: "p/m1", name: "Model One" }], currentModelId: "p/m1" },
    modes: { availableModes: [{ id: "default", name: "Default" }], currentModeId: "default" },
    configOptions: [],
    runtimeSessionId: "internal",
  });

  assert.deepEqual(response, {
    models: { availableModels: [{ modelId: "p/m1", name: "Model One" }], currentModelId: "p/m1" },
    modes: { availableModes: [{ id: "default", name: "Default" }], currentModeId: "default" },
    configOptions: [],
  });
  assert.equal(Object.hasOwn(response, "runtimeSessionId"), false);
});

test("setSessionModel updates runtime model and emits config options", async () => {
  const { agent, connection, runtimes, session } = await createAgentHarness();

  assert.ok(agent.unstable_setSessionModel, "agent must expose session/set_model");
  const response = await agent.unstable_setSessionModel({ sessionId: session.sessionId, modelId: "p/m2" });

  assert.deepEqual(response, {});
  assert.ok(runtimes[0]?.requests.some((request) => request.method === "set_model" && (request.params as { modelId?: string }).modelId === "m2"));
  const update = connection.updates.at(-1);
  assert.equal(update?.sessionId, session.sessionId);
  assert.equal(update?.update.sessionUpdate, "config_option_update");
  assert.ok(
    update?.update.sessionUpdate === "config_option_update" &&
      update.update.configOptions.some((option) => option.id === "model" && option.type === "select" && option.currentValue === "p/m2"),
  );
});

test("setSessionConfigOption updates thinking and returns current options", async () => {
  const { agent, connection, runtimes, session } = await createAgentHarness();

  assert.ok(agent.setSessionConfigOption, "agent must expose session/set_config_option");
  const response = await agent.setSessionConfigOption({ sessionId: session.sessionId, configId: "thinking", value: "medium" });

  assert.ok(response.configOptions.some((option: SessionConfigOption) => option.id === "thinking" && option.type === "select" && option.currentValue === "medium"));
  assert.ok(runtimes[0]?.requests.some((request) => request.method === "set_thinking_level" && (request.params as { level?: string }).level === "medium"));
  assert.equal(connection.updates.at(-1)?.update.sessionUpdate, "config_option_update");
});

test("setSessionMode only accepts default and emits current mode update", async () => {
  const { agent, connection, session } = await createAgentHarness();

  assert.ok(agent.setSessionMode, "agent must expose session/set_mode");
  const response = await agent.setSessionMode({ sessionId: session.sessionId, modeId: "default" });

  assert.deepEqual(response, {});
  assert.deepEqual(connection.updates.at(-1), {
    sessionId: session.sessionId,
    update: { sessionUpdate: "current_mode_update", currentModeId: "default" },
  });
  await assert.rejects(agent.setSessionMode({ sessionId: session.sessionId, modeId: "other" }), /Unsupported session mode/);
});

test("session control setters reject while a prompt is active", async () => {
  const { agent, manager, runtimes, session } = await createAgentHarness();
  const prompt = manager.beginPrompt(session.sessionId);
  const beforeRequestCount = runtimes[0]!.requests.length;

  try {
    await assert.rejects(agent.unstable_setSessionModel({ sessionId: session.sessionId, modelId: "p/m2" }), /Cannot change session controls during an active prompt/);
    await assert.rejects(agent.setSessionConfigOption({ sessionId: session.sessionId, configId: "thinking", value: "medium" }), /Cannot change session controls during an active prompt/);
    await assert.rejects(agent.setSessionMode({ sessionId: session.sessionId, modeId: "default" }), /Cannot change session controls during an active prompt/);
    assert.equal(runtimes[0]!.requests.length, beforeRequestCount);
  } finally {
    prompt.finish();
  }
});