import assert from "node:assert/strict";
import test from "node:test";
import { RequestError, type SetSessionConfigOptionRequest } from "@agentclientprotocol/sdk";
import {
  buildDefaultModeState,
  buildSessionSetupState,
  setSessionConfigControl,
  setSessionModelControl,
} from "../../../src/acp/session-controls.ts";
import type { RuntimeAdapter, RuntimeDiagnostics } from "../../../src/runtime/RuntimeAdapter.ts";
import type { RuntimeEvent } from "../../../src/runtime/RuntimeEvents.ts";

type FakeModel = {
  provider: string;
  id: string;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  thinking?: { minLevel: string; maxLevel: string };
};

type FakeState = {
  model: FakeModel;
  thinkingLevel: string | null | undefined;
  steeringMode: string;
  followUpMode: string;
  interruptMode: string;
  autoCompactionEnabled: boolean;
};

class FakeRuntime implements RuntimeAdapter {
  readonly ready = Promise.resolve();
  readonly diagnostics: RuntimeDiagnostics = { stderr: "" };
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  state: FakeState = {
    model: { provider: "p", id: "m1", name: "Model One", baseUrl: "secret-url" },
    thinkingLevel: "high" as string | null | undefined,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    interruptMode: "immediate",
    autoCompactionEnabled: true,
  };
  models: FakeModel[] = [
    { provider: "p", id: "m1", name: "Model One", baseUrl: "secret-url", thinking: { minLevel: "minimal", maxLevel: "high" } },
    { provider: "p", id: "m2", name: "Model Two", apiKey: "secret-key", thinking: { minLevel: "low", maxLevel: "xhigh" } },
  ];
  staleAfterSet: Partial<Record<string, boolean>> = {};
  wrapAvailableModels = false;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "get_state") return structuredClone(this.state);
    if (method === "get_available_models") {
      const models = structuredClone(this.models);
      return this.wrapAvailableModels ? { models } : models;
    }
    if (method === "set_model") {
      const input = params as { provider: string; modelId: string };
      if (!this.staleAfterSet.set_model) {
        const next = this.models.find((model) => model.provider === input.provider && model.id === input.modelId);
        this.state.model = structuredClone(next ?? { provider: input.provider, id: input.modelId, name: `${input.provider}/${input.modelId}` });
      }
      return undefined;
    }
    if (method === "set_thinking_level") {
      if (!this.staleAfterSet.set_thinking_level) this.state.thinkingLevel = (params as { level: string }).level;
      return undefined;
    }
    if (method === "set_steering_mode") {
      if (!this.staleAfterSet.set_steering_mode) this.state.steeringMode = (params as { mode: string }).mode;
      return undefined;
    }
    if (method === "set_follow_up_mode") {
      if (!this.staleAfterSet.set_follow_up_mode) this.state.followUpMode = (params as { mode: string }).mode;
      return undefined;
    }
    if (method === "set_interrupt_mode") {
      if (!this.staleAfterSet.set_interrupt_mode) this.state.interruptMode = (params as { mode: string }).mode;
      return undefined;
    }
    if (method === "set_auto_compaction") {
      if (!this.staleAfterSet.set_auto_compaction) this.state.autoCompactionEnabled = (params as { enabled: boolean }).enabled;
      return undefined;
    }
    throw new Error(`Unexpected method ${method}`);
  }

  send(): Promise<void> { return Promise.resolve(); }
  onEvent(_listener: (event: RuntimeEvent) => void): () => void { return () => {}; }
  close(): Promise<void> { return Promise.resolve(); }
}

function selectOption(state: Awaited<ReturnType<typeof buildSessionSetupState>>, id: string) {
  const option = state.configOptions?.find((candidate) => candidate.id === id);
  assert.ok(option, `missing option ${id}`);
  assert.equal(option.type, "select");
  return option;
}

function flatOptions(option: ReturnType<typeof selectOption>): Array<{ value: string; name: string; description?: string | null }> {
  assert.ok(option.options.every((entry) => "value" in entry), "expected flat select options");
  return option.options as Array<{ value: string; name: string; description?: string | null }>;
}


async function assertInvalidParams(promise: Promise<unknown>, messagePattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof RequestError, true);
    assert.equal((error as { code?: number }).code, -32602);
    assert.match((error as Error).message, messagePattern);
    return true;
  });
}

function setRequest(configId: string, value: string | boolean): SetSessionConfigOptionRequest {
  if (typeof value === "boolean") {
    return { sessionId: "s1", configId, type: "boolean", value };
  }
  return { sessionId: "s1", configId, value };
}

test("buildSessionSetupState returns safe model state and model config option", async () => {
  const runtime = new FakeRuntime();

  const state = await buildSessionSetupState(runtime);

  assert.equal(state.models?.currentModelId, "p/m1");
  assert.deepEqual(state.models?.availableModels.map((model) => model.modelId), ["p/m1", "p/m2"]);
  assert.deepEqual(flatOptions(selectOption(state, "model")).map((option) => option.value), ["p/m1", "p/m2"]);
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes("secret-url"));
  assert.ok(!serialized.includes("secret-key"));
  assert.ok(!serialized.includes("baseUrl"));
  assert.ok(!serialized.includes("apiKey"));
});

test("buildSessionSetupState accepts OMP get_available_models wrapper object", async () => {
  const runtime = new FakeRuntime();
  runtime.wrapAvailableModels = true;

  const state = await buildSessionSetupState(runtime);

  assert.equal(state.models?.currentModelId, "p/m1");
  assert.deepEqual(state.models?.availableModels.map((model) => model.modelId), ["p/m1", "p/m2"]);
  assert.deepEqual(flatOptions(selectOption(state, "model")).map((option) => option.value), ["p/m1", "p/m2"]);
});

test("buildDefaultModeState exposes only the default mode", () => {
  assert.deepEqual(buildDefaultModeState(), {
    availableModes: [{ id: "default", name: "Default", description: "Standard OMP ACP mode" }],
    currentModeId: "default",
  });
});

test("buildSessionSetupState returns only visible model and thinking controls", async () => {
  const runtime = new FakeRuntime();
  runtime.state.steeringMode = "experimental";
  delete (runtime.state as Partial<FakeState>).autoCompactionEnabled;

  const state = await buildSessionSetupState(runtime);

  assert.deepEqual(state.configOptions?.map((option) => option.id), ["model", "thinking"]);
  assert.equal(selectOption(state, "model").category, "model");
  assert.equal(selectOption(state, "thinking").category, "thought_level");
});

test("thinking options are clipped to the current model metadata", async () => {
  const runtime = new FakeRuntime();

  let state = await buildSessionSetupState(runtime);
  assert.deepEqual(flatOptions(selectOption(state, "thinking")).map((option) => option.value), ["off", "minimal", "low", "medium", "high"]);

  runtime.state.model = runtime.models[1]!;
  runtime.state.thinkingLevel = "xhigh";
  state = await buildSessionSetupState(runtime);
  assert.deepEqual(flatOptions(selectOption(state, "thinking")).map((option) => option.value), ["off", "low", "medium", "high", "xhigh"]);
});

test("thinking current value outside model metadata is represented as current-only", async () => {
  const runtime = new FakeRuntime();
  runtime.state.thinkingLevel = "xhigh";

  const state = await buildSessionSetupState(runtime);

  const thinking = selectOption(state, "thinking");
  assert.equal(thinking.currentValue, "xhigh");
  assert.ok(flatOptions(thinking).some((option) => option.value === "xhigh" && /当前 runtime 值；不在当前模型 metadata 支持范围内/.test(option.description ?? "")));
});

test("current model missing from available models is appended as current-only", async () => {
  const runtime = new FakeRuntime();
  runtime.state.model = { provider: "p", id: "missing", name: "Missing", baseUrl: "secret-url" };

  const state = await buildSessionSetupState(runtime);

  assert.equal(state.models?.currentModelId, "p/missing");
  assert.ok(state.models?.availableModels.some((model) => model.modelId === "p/missing" && /当前 runtime model/.test(model.description ?? "")));
  assert.ok(flatOptions(selectOption(state, "model")).some((option) => option.value === "p/missing" && /当前 runtime model/.test(option.description ?? "")));
});

test("unknown model id is invalid params and does not call set_model", async () => {
  const runtime = new FakeRuntime();

  await assertInvalidParams(setSessionModelControl(runtime, "p/missing"), /Unknown model/);

  assert.equal(runtime.requests.some((request) => request.method === "set_model"), false);
});

test("invalid model id shape is invalid params and does not call set_model", async () => {
  const runtime = new FakeRuntime();

  await assertInvalidParams(setSessionModelControl(runtime, "missing-slash"), /Invalid modelId/);

  assert.equal(runtime.requests.some((request) => request.method === "set_model"), false);
});

test("unsupported thinking value is invalid params and does not call set_thinking_level", async () => {
  const runtime = new FakeRuntime();

  await assertInvalidParams(setSessionConfigControl(runtime, setRequest("thinking", "xhigh")), /Unsupported thinking/);

  assert.equal(runtime.requests.some((request) => request.method === "set_thinking_level"), false);
});

test("thinking setter calls RPC and verifies reread currentValue", async () => {
  const runtime = new FakeRuntime();

  const state = await setSessionConfigControl(runtime, setRequest("thinking", "low"));

  assert.ok(runtime.requests.some((request) => request.method === "set_thinking_level" && assert.deepEqual(request.params, { level: "low" }) === undefined));
  assert.equal(selectOption(state, "thinking").currentValue, "low");
});

test("hidden OMP-specific config ids are rejected and do not call runtime setters", async () => {
  const runtime = new FakeRuntime();

  await assertInvalidParams(setSessionConfigControl(runtime, setRequest("_omp.steeringMode", "one-at-a-time")), /Unknown configId/);
  await assertInvalidParams(setSessionConfigControl(runtime, setRequest("_omp.followUpMode", "all")), /Unknown configId/);
  await assertInvalidParams(setSessionConfigControl(runtime, setRequest("_omp.interruptMode", "wait")), /Unknown configId/);
  await assertInvalidParams(setSessionConfigControl(runtime, setRequest("_omp.autoCompaction", false)), /Unknown configId/);

  assert.equal(runtime.requests.some((request) => request.method.startsWith("set_")), false);
});

test("invalid config control values are rejected before RPC", async () => {
  const runtime = new FakeRuntime();

  await assertInvalidParams(setSessionConfigControl(runtime, setRequest("unknown", "value")), /Unknown configId/);

  assert.equal(runtime.requests.some((request) => request.method.startsWith("set_")), false);
});

test("setter success with stale reread state throws a clear error instead of fake success", async () => {
  const runtime = new FakeRuntime();
  runtime.staleAfterSet.set_thinking_level = true;

  await assert.rejects(setSessionConfigControl(runtime, setRequest("thinking", "low")), /set_thinking_level succeeded but reread thinking currentValue was high, expected low/);
});
