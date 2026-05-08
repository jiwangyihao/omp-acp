import assert from "node:assert/strict";
import test from "node:test";
import type { NewSessionRequest, PromptRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import { handleSessionCancel } from "../../../src/acp/handlers/session-cancel.ts";
import { handleSessionNew } from "../../../src/acp/handlers/session-new.ts";
import { handleSessionPrompt } from "../../../src/acp/handlers/session-prompt.ts";
import type { RuntimeAdapter, RuntimeDiagnostics } from "../../../src/runtime/RuntimeAdapter.ts";
import type { RuntimeEvent } from "../../../src/runtime/RuntimeEvents.ts";
import { SessionManager, type RuntimeFactoryInput } from "../../../src/session/manager.ts";
import type { HostToolExecutor } from "../../../src/runtime/omp/host-tools.ts";

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

const CONTROL_STATE = {
  model: { provider: "p", id: "m1", name: "Model One" },
  thinkingLevel: "low",
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  interruptMode: "immediate",
  autoCompactionEnabled: true,
};

const AVAILABLE_MODELS = [{ provider: "p", id: "m1", name: "Model One", thinking: { minLevel: "minimal", maxLevel: "high" } }];

class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly diagnostics: RuntimeDiagnostics = { stderr: "" };
  readonly ready = Promise.resolve();
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  readonly listeners = new Set<(event: RuntimeEvent) => void>();
  readonly promptDeferreds: Array<Deferred<unknown>> = [];
  closeCalls = 0;
  readonly sentFrames: Record<string, unknown>[] = [];
  nextSendError: Error | undefined;

  request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "get_state") {
      return Promise.resolve(structuredClone(CONTROL_STATE));
    }
    if (method === "get_available_models") {
      return Promise.resolve(structuredClone(AVAILABLE_MODELS));
    }
    if (method === "prompt") {
      const deferred = new Deferred<unknown>();
      this.promptDeferreds.push(deferred);
      return deferred.promise;
    }
    return Promise.resolve(undefined);
  }

  send(frame: Record<string, unknown>): Promise<void> {
    this.sentFrames.push(frame);
    if (this.nextSendError !== undefined) {
      const error = this.nextSendError;
      this.nextSendError = undefined;
      return Promise.reject(error);
    }
    return Promise.resolve(undefined);
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

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeConnection {
  readonly updates: Array<{ sessionId: string; update: SessionUpdate }> = [];
  readonly updateDeferreds: Deferred<void>[] = [];

  sessionUpdate(params: { sessionId: string; update: SessionUpdate }): Promise<void> {
    this.updates.push(params);
    const deferred = new Deferred<void>();
    this.updateDeferreds.push(deferred);
    return deferred.promise;
  }

  resolveAllUpdates(): void {
    for (const deferred of this.updateDeferreds) {
      deferred.resolve();
    }
  }
}

function newSessionRequest(overrides: Partial<NewSessionRequest> = {}): NewSessionRequest {
  return {
    cwd: "/workspace/project",
    mcpServers: [],
    ...overrides,
  };
}

function promptRequest(overrides: Partial<PromptRequest> = {}): PromptRequest {
  return {
    sessionId: "session-1",
    prompt: [{ type: "text", text: "hello" }],
    ...overrides,
  };
}

function createHarness() {
  const runtimes: FakeRuntimeAdapter[] = [];
  const inputs: RuntimeFactoryInput[] = [];
  let nextId = 1;
  const manager = new SessionManager({
    idGenerator: () => `session-${nextId++}`,
    runtimeFactory(input) {
      inputs.push(input);
      const runtime = new FakeRuntimeAdapter();
      runtimes.push(runtime);
      return runtime;
    },
  });
  const connection = new FakeConnection();

  return { manager, connection, runtimes, inputs };
}

async function createSession(harness = createHarness()) {
  const response = await handleSessionNew(newSessionRequest(), harness.manager);
  return { ...harness, response, runtime: harness.runtimes[0]! };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(predicate(), true);
}

function finishRuntimePrompt(runtime: FakeRuntimeAdapter, index = runtime.promptDeferreds.length - 1): void {
  runtime.promptDeferreds[index]!.resolve({});
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
}

test("session/new returns the created session id", async () => {
  const { manager, runtimes, inputs } = createHarness();

  const response = await handleSessionNew(newSessionRequest({ cwd: "/tmp/project" }), manager);

  assert.equal(response.sessionId, "session-1");
  assert.ok(response.models);
  assert.ok(response.modes);
  assert.ok(response.configOptions?.some((option) => option.id === "model"));
  assert.equal(runtimes.length, 1);
  assert.deepEqual(inputs, [{ cwd: "/tmp/project", mcpServers: [], sessionId: "session-1" }]);
});

test("prompt stays active until runtime emits agent_end", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  let settled = false;
  promptPromise.then(() => {
    settled = true;
  });

  runtime.promptDeferreds[0]!.resolve({});
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(runtime.listeners.size, 1);

  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
});

test("text prompt sends agent_message_chunk before returning end_turn", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  assert.deepEqual(runtime.requests.at(-1), { method: "prompt", params: { message: "hello" } });

  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "assistant text" } });
  assert.deepEqual(connection.updates, [
    {
      sessionId: "session-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "assistant text" } },
    },
  ]);

  let settled = false;
  promptPromise.then(() => {
    settled = true;
  });
  finishRuntimePrompt(runtime, 0);
  await Promise.resolve();
  assert.equal(settled, false);

  connection.resolveAllUpdates();
  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
});

test("thought event sends agent_thought_chunk", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({ type: "event", eventType: "message_update", raw: { kind: "thought", content: "reasoning" } });
  finishRuntimePrompt(runtime, 0);
  connection.resolveAllUpdates();

  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
  assert.deepEqual(connection.updates, [
    {
      sessionId: "session-1",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reasoning" } },
    },
  ]);
});

test("extension_error rejects and does not send assistant message", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({ type: "event", eventType: "extension_error", raw: { message: "boom" } });

  await assert.rejects(promptPromise, /Runtime extension error: boom/);
  assert.deepEqual(connection.updates, []);
  assert.equal(runtime.listeners.size, 0);
});

test("cancel while prompt pending returns cancelled, requests runtime abort, suppresses late message, and ignores late success", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  await handleSessionCancel({ sessionId: "session-1" }, manager);

  assert.deepEqual(await promptPromise, { stopReason: "cancelled" });
  assert.deepEqual(runtime.requests.at(-1), { method: "abort", params: undefined });

  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "too late" } });
  finishRuntimePrompt(runtime, 0);
  await waitForCondition(() => runtime.listeners.size === 0);

  assert.deepEqual(connection.updates, []);
  assert.equal(runtime.listeners.size, 0);
});

test("cancelled prompt cleanup is bounded when runtime prompt never settles", async () => {
  const { manager, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), {
    manager,
    connection: new FakeConnection(),
    cancelledPromptCleanupTimeoutMs: 1,
  });
  await handleSessionCancel({ sessionId: "session-1" }, manager);

  assert.deepEqual(await promptPromise, { stopReason: "cancelled" });
  await waitForCondition(() => runtime.listeners.size === 0);

  assert.equal(runtime.closeCalls, 1);
  assert.equal(runtime.listeners.size, 0);
  assert.throws(() => manager.requireSession("session-1"), /Unknown session/);
});

test("cancelled prompt retains ownership until runtime prompt settles", async () => {
  const { manager, connection, runtime } = await createSession();

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  await handleSessionCancel({ sessionId: "session-1" }, manager);

  assert.deepEqual(await firstPrompt, { stopReason: "cancelled" });

  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });
  await Promise.resolve();
  assert.equal(runtime.promptDeferreds.length, 1, "second prompt must be rejected before reaching runtime");
  await assert.rejects(secondPrompt, /active prompt/);

  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "too late" } });
  assert.deepEqual(connection.updates, []);

  finishRuntimePrompt(runtime, 0);
  await waitForCondition(() => runtime.listeners.size === 0);

  const thirdPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "third" }] }), { manager, connection });
  assert.equal(runtime.promptDeferreds.length, 2);
  finishRuntimePrompt(runtime, 1);
  assert.deepEqual(await thirdPrompt, { stopReason: "end_turn" });
});

test("cancelled prompt waits for agent_end when prompt command later rejects", async () => {
  const { manager, connection, runtime } = await createSession();

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  await handleSessionCancel({ sessionId: "session-1" }, manager);
  assert.deepEqual(await firstPrompt, { stopReason: "cancelled" });

  runtime.promptDeferreds[0]!.reject(new Error("late prompt failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });
  await Promise.resolve();
  assert.equal(runtime.promptDeferreds.length, 1, "second prompt must be rejected before reaching runtime");
  await assert.rejects(secondPrompt, /active prompt/);

  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  await waitForCondition(() => runtime.listeners.size === 0);

  const thirdPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "third" }] }), { manager, connection });
  assert.equal(runtime.promptDeferreds.length, 2);
  finishRuntimePrompt(runtime, 1);
  assert.deepEqual(await thirdPrompt, { stopReason: "end_turn" });
});

test("normal prompt drains updates appended while earlier deliveries are pending", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "first" } });
  finishRuntimePrompt(runtime, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "second" } });

  let settled = false;
  promptPromise.then(() => {
    settled = true;
  });

  connection.updateDeferreds[0]!.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  connection.updateDeferreds[1]!.resolve();
  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
  assert.deepEqual(
    connection.updates.map((entry) => entry.update),
    [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second" } },
    ],
  );
});

test("cancel during update drain returns cancelled and releases prompt", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "first" } });
  finishRuntimePrompt(runtime, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  await handleSessionCancel({ sessionId: "session-1" }, manager);

  assert.deepEqual(await promptPromise, { stopReason: "cancelled" });
  assert.equal(runtime.listeners.size, 0);

  connection.updateDeferreds[0]!.resolve();
  const nextPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "next" }] }), { manager, connection });
  assert.equal(runtime.promptDeferreds.length, 2);
  finishRuntimePrompt(runtime, 1);
  assert.deepEqual(await nextPrompt, { stopReason: "end_turn" });
});

test("runtime event failure during update drain rejects prompt", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "first" } });
  finishRuntimePrompt(runtime, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  runtime.emit({ type: "event", eventType: "extension_error", raw: { message: "boom" } });
  connection.updateDeferreds[0]!.resolve();

  await assert.rejects(promptPromise, /Runtime extension error: boom/);
  assert.equal(runtime.listeners.size, 0);
});

test("event translation failure stops accepting same-turn assistant updates", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({ type: "event", eventType: "extension_error", raw: { message: "boom" } });
  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "should not forward" } });

  await assert.rejects(promptPromise, /Runtime extension error: boom/);
  assert.deepEqual(connection.updates, []);
});


test("unregistered host tool call emits ACP failure and raw error result before prompt returns", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  let settled = false;
  promptPromise.then(() => {
    settled = true;
  });

  runtime.emit({
    type: "event",
    eventType: "host_tool_call",
    raw: { type: "host_tool_call", id: "host_1", toolCallId: "tc_1", toolName: "missing", arguments: { value: 1 } },
  });
  await waitForCondition(() => connection.updates.length === 1);
  finishRuntimePrompt(runtime, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assert.deepEqual(connection.updates[0], {
    sessionId: "session-1",
    update: { sessionUpdate: "tool_call", toolCallId: "tc_1", title: "missing", kind: "other", status: "pending", rawInput: { value: 1 } },
  });

  connection.updateDeferreds[0]!.resolve();
  await waitForCondition(() => connection.updates.length === 2);
  assert.equal(settled, false);
  assert.deepEqual(connection.updates[1], {
    sessionId: "session-1",
    update: { sessionUpdate: "tool_call_update", toolCallId: "tc_1", status: "failed", rawOutput: { error: "Unsupported host tool: missing" } },
  });

  connection.updateDeferreds[1]!.resolve();
  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
  assert.deepEqual(runtime.sentFrames, [
    {
      type: "host_tool_result",
      id: "host_1",
      isError: true,
      result: { content: [{ type: "text", text: "Unsupported host tool: missing" }] },
    },
  ]);
});

test("registered host tool call uses registry and sends raw success result", async () => {
  const { manager, connection, runtime } = await createSession();
  const calls: Array<{ input: unknown; aborted: boolean }> = [];
  const registry: Record<string, HostToolExecutor> = {
    lookup: ({ arguments: input, signal }) => {
      calls.push({ input, aborted: signal.aborted });
      assert.equal(signal instanceof AbortSignal, true);
      return { ok: true, input };
    },
  };

  const context = { manager, connection, hostToolRegistry: registry };
  const promptPromise = handleSessionPrompt(promptRequest(), context);

  runtime.emit({
    type: "event",
    eventType: "host_tool_call",
    raw: { type: "host_tool_call", id: "host_2", toolCallId: "tc_2", toolName: "lookup", arguments: { query: "abc" } },
  });

  await waitForCondition(() => connection.updates.length === 1);
  connection.updateDeferreds[0]!.resolve();
  await waitForCondition(() => connection.updates.length === 2);
  finishRuntimePrompt(runtime, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  connection.updateDeferreds[1]!.resolve();
  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
  assert.deepEqual(calls, [{ input: { query: "abc" }, aborted: false }]);
  assert.deepEqual(
    connection.updates.map((entry) => entry.update),
    [
      { sessionUpdate: "tool_call", toolCallId: "tc_2", title: "lookup", kind: "other", status: "pending", rawInput: { query: "abc" } },
      { sessionUpdate: "tool_call_update", toolCallId: "tc_2", status: "completed", rawOutput: { ok: true, input: { query: "abc" } } },
    ],
  );
  assert.deepEqual(runtime.sentFrames, [{ type: "host_tool_result", id: "host_2", result: { ok: true, input: { query: "abc" } } }]);
});

test("host tool raw frame send failure rejects prompt", async () => {
  const { manager, connection, runtime } = await createSession();
  runtime.nextSendError = new Error("stdin closed");

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  const expectedRejection = assert.rejects(promptPromise, /stdin closed/);
  runtime.emit({
    type: "event",
    eventType: "host_tool_call",
    raw: { type: "host_tool_call", id: "host_3", toolName: "missing" },
  });

  await waitForCondition(() => connection.updates.length === 2);
  connection.resolveAllUpdates();
  runtime.promptDeferreds[0]!.resolve({});

  await expectedRejection;
  assert.equal(runtime.listeners.size, 0);
});

test("late host tool events after cancel are suppressed", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  await handleSessionCancel({ sessionId: "session-1" }, manager);
  assert.deepEqual(await promptPromise, { stopReason: "cancelled" });

  runtime.emit({
    type: "event",
    eventType: "host_tool_call",
    raw: { type: "host_tool_call", id: "host_4", toolName: "missing" },
  });
  runtime.emit({ type: "event", eventType: "host_tool_cancel", raw: { type: "host_tool_cancel", targetId: "host_4" } });
  finishRuntimePrompt(runtime, 0);
  await waitForCondition(() => runtime.listeners.size === 0);

  assert.deepEqual(connection.updates, []);
  assert.deepEqual(runtime.sentFrames, []);
});
test("concurrent prompt rejects", async () => {
  const { manager, connection, runtime } = await createSession();

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  await assert.rejects(handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection }), /active prompt/);

  finishRuntimePrompt(runtime, 0);
  assert.deepEqual(await firstPrompt, { stopReason: "end_turn" });
});