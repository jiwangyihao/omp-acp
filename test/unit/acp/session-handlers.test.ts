import assert from "node:assert/strict";
import test from "node:test";
import type { NewSessionRequest, PromptRequest, RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
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
  rejectNextPromptAsBusy = false;
  rejectNextSteerAsBusy = false;
  holdAbortAndPrompt = false;
  holdSteer = false;
  readonly steerDeferreds: Array<Deferred<unknown>> = [];
  readonly abortAndPromptDeferreds: Array<Deferred<unknown>> = [];
  state: Record<string, unknown> = { ...structuredClone(CONTROL_STATE), isStreaming: false };
  resolvePromptWhenRejectingBusy = false;
  emitRecoveredAgentEndWithAbortAndPromptAck = false;


  request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "get_state") {
      return Promise.resolve(structuredClone(this.state));
    }
    if (method === "get_available_models") {
      return Promise.resolve(structuredClone(AVAILABLE_MODELS));
    }
    if (method === "prompt") {
      if (this.rejectNextPromptAsBusy) {
        this.rejectNextPromptAsBusy = false;
        if (this.resolvePromptWhenRejectingBusy) {
          const deferred = new Deferred<unknown>();
          deferred.resolve({});
          this.promptDeferreds.push(deferred);
        }
        return Promise.reject(new Error("OMP RPC prompt response error: Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion."));
      }
      const deferred = new Deferred<unknown>();
      this.promptDeferreds.push(deferred);
      return deferred.promise;
    }
    if (method === "follow_up") {
      return Promise.resolve({ ok: true });
    }
    if (method === "steer") {
      if (this.rejectNextSteerAsBusy) {
        this.rejectNextSteerAsBusy = false;
        return Promise.reject(new Error("OMP RPC steer response error: Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion."));
      }
      if (this.holdSteer) {
        const deferred = new Deferred<unknown>();
        this.steerDeferreds.push(deferred);
        return deferred.promise;
      }
      return Promise.resolve({ ok: true });
    }
    if (method === "abort_and_prompt") {
      if (this.holdAbortAndPrompt) {
        const deferred = new Deferred<unknown>();
        this.abortAndPromptDeferreds.push(deferred);
        return deferred.promise;
      }
      return Promise.resolve({ ok: true }).then((result) => {
        if (this.emitRecoveredAgentEndWithAbortAndPromptAck) {
          queueMicrotask(() => {
            queueMicrotask(() => {
              this.emit({ type: "event", eventType: "agent_end", raw: {} });
            });
          });
        }
        return result;
      });
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
  readonly permissionRequests: RequestPermissionRequest[] = [];
  readonly permissionDeferreds: Deferred<RequestPermissionResponse>[] = [];


  sessionUpdate(params: { sessionId: string; update: SessionUpdate }): Promise<void> {
    this.updates.push(params);
    const deferred = new Deferred<void>();
    this.updateDeferreds.push(deferred);
    return deferred.promise;
  }

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.permissionRequests.push(params);
    const deferred = new Deferred<RequestPermissionResponse>();
    this.permissionDeferreds.push(deferred);
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
  assert.deepEqual(inputs, [{ cwd: "/tmp/project", mcpServers: [], sessionId: "session-1", additionalDirectories: [] }]);
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

test("prompt waits for runtime idle state after agent_end before returning end_turn", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.state.isStreaming = true;
  let settled = false;
  promptPromise.then(() => {
    settled = true;
  });

  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(runtime.listeners.size, 1);

  runtime.state.isStreaming = false;
  await waitForCondition(() => runtime.requests.filter((request) => request.method === "get_state").length >= 2);
  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
});

test("concurrent prompt during runtime idle wait starts after owner cleanup", async () => {
  const { manager, connection, runtime } = await createSession();

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.state.isStreaming = true;
  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.requests.some((request) => request.method === "abort_and_prompt"), false);
  assert.equal(runtime.promptDeferreds.length, 1, "second prompt must wait for owner cleanup while old turn is ending");

  runtime.state.isStreaming = false;
  assert.deepEqual(await firstPrompt, { stopReason: "end_turn" });
  await waitForCondition(() => runtime.promptDeferreds.length === 2);
  assert.equal(manager.requireSession("session-1").activePrompt !== undefined, true);

  runtime.promptDeferreds[1]!.resolve({});
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  assert.deepEqual(await secondPrompt, { stopReason: "end_turn" });
});

test("concurrent prompt steers active turn and echoes ACP messageId", async () => {
  const { manager, connection, runtime } = await createSession();
  const messageId = "11111111-1111-4111-8111-111111111111";
  const secondMessageId = "22222222-2222-4222-8222-222222222222";

  const firstPrompt = handleSessionPrompt(promptRequest({ messageId }), { manager, connection });
  const secondPrompt = handleSessionPrompt(
    promptRequest({ messageId: secondMessageId, prompt: [{ type: "text", text: "second" }] }),
    { manager, connection },
  );

  await waitForCondition(() => runtime.requests.some((request) => request.method === "steer"));

  assert.equal(runtime.promptDeferreds.length, 1, "steer must not start a competing prompt request");
  assert.deepEqual(runtime.requests.at(-1), { method: "steer", params: { message: "second" } });
  assert.equal(runtime.requests.some((request) => request.method === "abort_and_prompt"), false);

  assert.deepEqual(await secondPrompt, { stopReason: "end_turn", userMessageId: secondMessageId });

  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  assert.deepEqual(await firstPrompt, { stopReason: "end_turn", userMessageId: messageId });
});

test("concurrent steer keeps owning prompt active until agent_end", async () => {
  const { manager, connection, runtime } = await createSession();
  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });
  let firstSettled = false;
  firstPrompt.then(() => {
    firstSettled = true;
  });

  await waitForCondition(() => runtime.requests.some((request) => request.method === "steer"));
  assert.deepEqual(await secondPrompt, { stopReason: "end_turn" });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstSettled, false, "steered owner prompt must remain active until runtime agent_end");
  assert.equal(manager.requireSession("session-1").activePrompt !== undefined, true);

  runtime.state.isStreaming = false;
  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  assert.deepEqual(await firstPrompt, { stopReason: "end_turn" });
  assert.equal(runtime.listeners.size, 0);
  assert.equal(manager.requireSession("session-1").activePrompt, undefined);
});

test("cancelled prompt echoes ACP messageId in cancelled response", async () => {
  const { manager, connection, runtime } = await createSession();
  const messageId = "33333333-3333-4333-8333-333333333333";

  const promptPromise = handleSessionPrompt(promptRequest({ messageId }), { manager, connection });
  await handleSessionCancel({ sessionId: "session-1" }, manager);

  assert.deepEqual(await promptPromise, { stopReason: "cancelled", userMessageId: messageId });
  finishRuntimePrompt(runtime, 0);
});

test("concurrent text prompt steers the active OMP turn", async () => {
  const { manager, connection, runtime } = await createSession();

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });

  await waitForCondition(() => runtime.requests.some((request) => request.method === "steer"));

  assert.equal(runtime.promptDeferreds.length, 1, "steer must keep the active lifecycle owned by the first prompt");
  assert.deepEqual(runtime.requests.at(-1), { method: "steer", params: { message: "second" } });
  assert.equal(runtime.requests.some((request) => request.method === "abort_and_prompt"), false);

  assert.deepEqual(await secondPrompt, { stopReason: "end_turn" });

  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  assert.deepEqual(await firstPrompt, { stopReason: "end_turn" });
});

test("concurrent prompt after prompt ACK steers owner and releases on agent_end", async () => {
  const { manager, connection, runtime } = await createSession();
  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.promptDeferreds[0]!.resolve({});
  await new Promise<void>((resolve) => setImmediate(resolve));

  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });
  await waitForCondition(() => runtime.requests.some((request) => request.method === "steer"));
  assert.deepEqual(runtime.requests.at(-1), { method: "steer", params: { message: "second" } });
  assert.deepEqual(await secondPrompt, { stopReason: "end_turn" });

  runtime.state.isStreaming = false;
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  assert.deepEqual(await firstPrompt, { stopReason: "end_turn" });
  assert.equal(runtime.listeners.size, 0);
  assert.equal(manager.requireSession("session-1").activePrompt, undefined);
});

test("concurrent steer prompt returns cancelled if owner is cancelled before steer ACK", async () => {
  const { manager, connection, runtime } = await createSession();
  runtime.holdSteer = true;

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });

  await waitForCondition(() => runtime.steerDeferreds.length === 1);
  await handleSessionCancel({ sessionId: "session-1" }, manager);

  assert.deepEqual(await secondPrompt, { stopReason: "cancelled" });

  runtime.promptDeferreds[0]!.resolve({});
  assert.deepEqual(await firstPrompt, { stopReason: "cancelled" });
});

test("concurrent steer prompt propagates owner failure before steer ACK", async () => {
  const { manager, connection, runtime } = await createSession();
  runtime.holdSteer = true;

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });

  await waitForCondition(() => runtime.steerDeferreds.length === 1);
  runtime.emit({ type: "event", eventType: "extension_error", raw: { message: "boom" } });

  await assert.rejects(secondPrompt, /Runtime extension error: boom/);
  await assert.rejects(firstPrompt, /Runtime extension error: boom/);
});

test("concurrent steer prompt propagates owner busy-looking failure before steer ACK", async () => {
  const { manager, connection, runtime } = await createSession();
  runtime.holdSteer = true;

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });

  await waitForCondition(() => runtime.steerDeferreds.length === 1);
  runtime.emit({
    type: "event",
    eventType: "extension_error",
    raw: { message: "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion." },
  });

  await assert.rejects(secondPrompt, /Agent is already processing/);
  await assert.rejects(firstPrompt, /Agent is already processing/);
  assert.equal(runtime.requests.some((request) => request.method === "abort_and_prompt"), false);
});

test("concurrent steer prompt retries after owner completes before steer ACK", async () => {
  const { manager, connection, runtime } = await createSession();
  runtime.holdSteer = true;

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });

  await waitForCondition(() => runtime.steerDeferreds.length === 1);
  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });

  assert.deepEqual(await firstPrompt, { stopReason: "end_turn" });
  await waitForCondition(() => runtime.promptDeferreds.length === 2);
  assert.deepEqual(runtime.requests.at(-1), { method: "prompt", params: { message: "second" } });

  runtime.promptDeferreds[1]!.resolve({});
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  assert.deepEqual(await secondPrompt, { stopReason: "end_turn" });
});

test("busy fallback handles abort_and_prompt ACK with recovered agent_end in same turn", async () => {
  const { manager, connection, runtime } = await createSession();
  runtime.rejectNextPromptAsBusy = true;
  runtime.resolvePromptWhenRejectingBusy = true;
  runtime.emitRecoveredAgentEndWithAbortAndPromptAck = true;

  const promptPromise = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "recovered" }] }), { manager, connection });

  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
  assert.equal(runtime.requests.some((request) => request.method === "abort_and_prompt"), true);
  assert.equal(runtime.listeners.size, 0);
  assert.equal(manager.requireSession("session-1").activePrompt, undefined);
});

test("steer busy fallback cancellation releases owner cleanup", async () => {
  const { manager, connection, runtime } = await createSession();
  runtime.rejectNextSteerAsBusy = true;
  runtime.holdAbortAndPrompt = true;

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });

  await waitForCondition(() => runtime.abortAndPromptDeferreds.length === 1);
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const cancelPromise = handleSessionCancel({ sessionId: "session-1" }, manager);
  assert.deepEqual(await secondPrompt, { stopReason: "cancelled" });
  await cancelPromise;

  runtime.promptDeferreds[0]!.resolve({});

  assert.deepEqual(await firstPrompt, { stopReason: "cancelled" });
  await waitForCondition(() => runtime.listeners.size === 0);
  assert.equal(runtime.listeners.size, 0);
});

test("steer busy fallback propagates owner failure before abort_and_prompt ACK", async () => {
  const { manager, connection, runtime } = await createSession();
  runtime.rejectNextSteerAsBusy = true;
  runtime.holdAbortAndPrompt = true;

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });

  await waitForCondition(() => runtime.abortAndPromptDeferreds.length === 1);
  runtime.emit({ type: "event", eventType: "extension_error", raw: { message: "boom" } });

  await assert.rejects(secondPrompt, /Runtime extension error: boom/);
  await assert.rejects(firstPrompt, /Runtime extension error: boom/);

  runtime.abortAndPromptDeferreds[0]!.resolve({ ok: true });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(runtime.listeners.size, 0);
  assert.equal(manager.requireSession("session-1").activePrompt, undefined);
});

test("steer busy fallback returns cancelled without waiting for stuck abort_and_prompt", async () => {
  const { manager, connection, runtime } = await createSession();
  runtime.rejectNextSteerAsBusy = true;
  runtime.holdAbortAndPrompt = true;

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });

  await waitForCondition(() => runtime.abortAndPromptDeferreds.length === 1);
  const cancelPromise = handleSessionCancel({ sessionId: "session-1" }, manager);

  assert.deepEqual(await secondPrompt, { stopReason: "cancelled" });

  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  await cancelPromise;

  assert.deepEqual(await firstPrompt, { stopReason: "cancelled" });
});

test("busy fallback waits for recovered turn after stale agent_end", async () => {
  const { manager, connection, runtime } = await createSession();
  runtime.rejectNextPromptAsBusy = true;
  runtime.resolvePromptWhenRejectingBusy = true;
  runtime.holdAbortAndPrompt = true;

  const promptPromise = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "recovered" }] }), { manager, connection });
  let settled = false;
  promptPromise.then(() => {
    settled = true;
  });

  await waitForCondition(() => runtime.abortAndPromptDeferreds.length === 1);
  runtime.state.isStreaming = true;
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(runtime.requests.at(-1)?.method, "abort_and_prompt");
  await assert.rejects(
    handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "third" }] }), { manager, connection }),
    /active prompt/,
  );

  runtime.abortAndPromptDeferreds[0]!.resolve({ ok: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "stale agent_end must not complete before recovered agent_end");

  runtime.state.isStreaming = false;
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  await waitForCondition(() => settled);
  assert.equal(settled, true, "recovered agent_end releases the ACP request");
});

test("busy fallback releases active prompt after recovered turn ends", async () => {
  const { manager, connection, runtime } = await createSession();
  runtime.rejectNextPromptAsBusy = true;
  runtime.resolvePromptWhenRejectingBusy = true;
  runtime.holdAbortAndPrompt = true;

  const promptPromise = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "recover" }] }), { manager, connection });
  await waitForCondition(() => runtime.abortAndPromptDeferreds.length === 1);

  runtime.abortAndPromptDeferreds[0]!.resolve({ ok: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  runtime.state.isStreaming = false;
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });

  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
  assert.equal(runtime.listeners.size, 0);
  assert.equal(manager.requireSession("session-1").activePrompt, undefined);
});

test("busy fallback ignores stale idle agent_end after abort_and_prompt ACK", async () => {
  const { manager, connection, runtime } = await createSession();
  runtime.rejectNextPromptAsBusy = true;
  runtime.resolvePromptWhenRejectingBusy = true;
  runtime.holdAbortAndPrompt = true;

  const promptPromise = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "recover" }] }), { manager, connection });
  let settled = false;
  promptPromise.then(() => {
    settled = true;
  });

  await waitForCondition(() => runtime.abortAndPromptDeferreds.length === 1);
  runtime.abortAndPromptDeferreds[0]!.resolve({ ok: true });
  await new Promise<void>((resolve) => setImmediate(resolve));

  runtime.state.isStreaming = false;
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });

  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
  assert.equal(runtime.listeners.size, 0);
  assert.equal(manager.requireSession("session-1").activePrompt, undefined);
});

test("busy fallback completes after stale agent_end before abort_and_prompt ACK", async () => {
  const { manager, connection, runtime } = await createSession();
  runtime.rejectNextPromptAsBusy = true;
  runtime.resolvePromptWhenRejectingBusy = true;
  runtime.holdAbortAndPrompt = true;

  const promptPromise = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "recover" }] }), { manager, connection });
  let settled = false;
  promptPromise.then(() => {
    settled = true;
  });

  await waitForCondition(() => runtime.abortAndPromptDeferreds.length === 1);
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "pre-ACK stale agent_end must not complete recovered turn");

  runtime.abortAndPromptDeferreds[0]!.resolve({ ok: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });

  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
  assert.equal(runtime.listeners.size, 0);
  assert.equal(manager.requireSession("session-1").activePrompt, undefined);
});

test("prompt during update drain waits for cleanup before starting a new prompt", async () => {
  const { manager, connection, runtime } = await createSession();

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "first" } });
  finishRuntimePrompt(runtime, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(runtime.requests.some((request) => request.method === "abort_and_prompt"), false);
  assert.equal(runtime.promptDeferreds.length, 1, "second prompt must wait while prior updates drain");

  connection.resolveAllUpdates();
  assert.deepEqual(await firstPrompt, { stopReason: "end_turn" });
  await waitForCondition(() => runtime.promptDeferreds.length === 2);
  finishRuntimePrompt(runtime, 1);
  assert.deepEqual(await secondPrompt, { stopReason: "end_turn" });
});

test("prompt bridges confirm permission and stays active until agent_end", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  assert.deepEqual(runtime.requests.at(-1), { method: "prompt", params: { message: "hello" } });
  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({
    type: "event",
    eventType: "extension_ui_request",
    raw: { method: "confirm", id: "ui-1", title: "Approve", message: "Allow action?" },
  });

  await waitForCondition(() => connection.permissionRequests.length === 1);
  await assert.rejects(
    handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection }),
    /active prompt/,
  );

  connection.permissionDeferreds[0]!.resolve({ outcome: { outcome: "selected", optionId: "allow" } });
  await waitForCondition(() => runtime.sentFrames.length === 1);
  assert.deepEqual(runtime.sentFrames[0], { type: "extension_ui_response", id: "ui-1", confirmed: true });

  let settled = false;
  promptPromise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  connection.resolveAllUpdates();
  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
});

test("confirm permission continues blocking queued prompts after streamed updates", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({
    type: "event",
    eventType: "extension_ui_request",
    raw: { method: "confirm", id: "ui-1", title: "Approve", message: "Allow action?" },
  });
  await waitForCondition(() => connection.permissionRequests.length === 1);

  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "still waiting" } });
  await assert.rejects(
    handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection }),
    /active prompt/,
  );
  assert.equal(runtime.requests.some((request) => request.method === "follow_up"), false);

  connection.permissionDeferreds[0]!.resolve({ outcome: { outcome: "selected", optionId: "allow" } });
  await waitForCondition(() => runtime.sentFrames.length === 1);
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  connection.resolveAllUpdates();
  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
});

test("prompt fails when confirm permission request rejects", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({
    type: "event",
    eventType: "extension_ui_request",
    raw: { method: "confirm", id: "ui-1", title: "Approve", message: "Allow?" },
  });

  await waitForCondition(() => connection.permissionDeferreds.length === 1);
  connection.permissionDeferreds[0]!.reject(new Error("permission failed"));

  await assert.rejects(promptPromise, /permission failed/);
});

test("prompt fails when confirm response send rejects", async () => {
  const { manager, connection, runtime } = await createSession();
  runtime.nextSendError = new Error("stdin closed");

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({
    type: "event",
    eventType: "extension_ui_request",
    raw: { method: "confirm", id: "ui-1", title: "Approve", message: "Allow?" },
  });

  await waitForCondition(() => connection.permissionDeferreds.length === 1);
  connection.permissionDeferreds[0]!.resolve({ outcome: { outcome: "selected", optionId: "allow" } });

  await assert.rejects(promptPromise, /stdin closed/);
});

test("prompt drains setWidget thought update before returning", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({
    type: "event",
    eventType: "extension_ui_request",
    raw: { method: "setWidget", id: "w1", widgetKey: "research", widgetLines: ["Working"] },
  });
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });

  await waitForCondition(() => connection.updates.length === 1);
  assert.deepEqual(connection.updates[0], {
    sessionId: "session-1",
    update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[research]\nWorking" } },
  });

  let settled = false;
  promptPromise.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  connection.resolveAllUpdates();
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

test("real OMP text_delta drains before end_turn", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({
    type: "event",
    eventType: "message_update",
    raw: {
      message: { role: "assistant", content: [{ type: "text", text: "final" }], responseId: "r1", timestamp: 1 },
      assistantMessageEvent: { type: "text_delta", delta: "hello", contentIndex: 0 },
    },
  });
  assert.deepEqual(connection.updates, [
    {
      sessionId: "session-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
    },
  ]);

  let settled = false;
  promptPromise.then(() => {
    settled = true;
  });
  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  connection.resolveAllUpdates();
  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
});

test("agent_end.messages fallback emits only unstreamed assistant content", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({
    type: "event",
    eventType: "message_update",
    raw: {
      message: { role: "assistant", responseId: "streamed", timestamp: 1, content: [{ type: "text", text: "streamed final" }] },
      assistantMessageEvent: { type: "text_delta", delta: "streamed delta", contentIndex: 0 },
    },
  });
  runtime.emit({
    type: "event",
    eventType: "message_update",
    raw: {
      message: {
        role: "assistant",
        responseId: "partial",
        timestamp: 2,
        content: [
          { type: "text", text: "partial streamed final" },
          { type: "text", text: "partial fallback final" },
        ],
      },
      assistantMessageEvent: { type: "text_delta", delta: "partial delta", contentIndex: 0 },
    },
  });
  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({
    type: "event",
    eventType: "agent_end",
    raw: {
      messages: [
        { role: "user", content: [{ type: "text", text: "user final" }] },
        { role: "toolResult", content: [{ type: "text", text: "tool result final" }] },
        { role: "assistant", responseId: "streamed", timestamp: 1, content: [{ type: "text", text: "streamed final" }] },
        { role: "assistant", responseId: "fallback", timestamp: 3, content: [{ type: "text", text: "fallback final" }] },
        {
          role: "assistant",
          responseId: "partial",
          timestamp: 2,
          content: [
            { type: "text", text: "partial streamed final" },
            { type: "text", text: "partial fallback final" },
          ],
        },
      ],
    },
  });

  assert.deepEqual(
    connection.updates.map((entry) => entry.update),
    [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "streamed delta" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial delta" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fallback final" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial fallback final" } },
    ],
  );

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

test("cancelled prompt suppresses late agent_end messages fallback and still cleans up", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  await handleSessionCancel({ sessionId: "session-1" }, manager);

  assert.deepEqual(await promptPromise, { stopReason: "cancelled" });
  assert.deepEqual(runtime.requests.at(-1), { method: "abort", params: undefined });
  let messagesRead = 0;
  const lateRaw = {
    get messages() {
      messagesRead += 1;
      return [{ role: "assistant", content: ["too late fallback"] }];
    },
  };

  runtime.emit({ type: "event", eventType: "agent_end", raw: lateRaw });
  assert.equal(messagesRead, 0);

  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
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

test("user cancel still waits for runtime idle cleanup before starting the next prompt", async () => {
  const { manager, connection, runtime } = await createSession();

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  await handleSessionCancel({ sessionId: "session-1" }, manager);

  assert.deepEqual(await firstPrompt, { stopReason: "cancelled" });

  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });
  await Promise.resolve();
  assert.equal(runtime.promptDeferreds.length, 1, "second prompt must wait for cancelled prompt cleanup");

  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "too late" } });
  assert.deepEqual(connection.updates, []);

  runtime.state.isStreaming = true;
  finishRuntimePrompt(runtime, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.promptDeferreds.length, 1, "second prompt must wait until cancelled runtime reports idle");

  runtime.state.isStreaming = false;
  await waitForCondition(() => runtime.promptDeferreds.length === 2);

  finishRuntimePrompt(runtime, 1);
  assert.deepEqual(await secondPrompt, { stopReason: "end_turn" });
});

test("user cancel waits for agent_end after prompt command rejects before starting the next prompt", async () => {
  const { manager, connection, runtime } = await createSession();

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  await handleSessionCancel({ sessionId: "session-1" }, manager);
  assert.deepEqual(await firstPrompt, { stopReason: "cancelled" });

  runtime.promptDeferreds[0]!.reject(new Error("late prompt failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection });
  await Promise.resolve();
  assert.equal(runtime.promptDeferreds.length, 1, "second prompt must wait for cancelled prompt cleanup");

  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  await waitForCondition(() => runtime.promptDeferreds.length === 2);

  finishRuntimePrompt(runtime, 1);
  assert.deepEqual(await secondPrompt, { stopReason: "end_turn" });
});

test("internally cancelled prompt waits for cleanup before starting a new prompt", async () => {
  const { manager, connection, runtime } = await createSession();

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  await waitForCondition(() => manager.requireSession("session-1").activePrompt !== undefined);
  manager.requireSession("session-1").activePrompt!.cancellation.cancel();
  assert.deepEqual(await firstPrompt, { stopReason: "cancelled" });

  const secondPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "replacement" }] }), { manager, connection });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.promptDeferreds.length, 1, "replacement prompt must wait for cancelled prompt cleanup");

  finishRuntimePrompt(runtime, 0);
  await waitForCondition(() => runtime.promptDeferreds.length === 2);

  finishRuntimePrompt(runtime, 1);
  assert.deepEqual(await secondPrompt, { stopReason: "end_turn" });
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

test("cancel during update drain waits for cleanup before releasing next prompt", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), {
    manager,
    connection,
    cancelledPromptCleanupTimeoutMs: 1,
  });
  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "first" } });
  finishRuntimePrompt(runtime, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  await handleSessionCancel({ sessionId: "session-1" }, manager);

  assert.deepEqual(await promptPromise, { stopReason: "cancelled" });

  const nextPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "next" }] }), { manager, connection });
  await assert.rejects(nextPrompt, /Timed out waiting for cancelled OMP prompt cleanup/);
  assert.equal(runtime.promptDeferreds.length, 1, "next prompt must not start after cancelled cleanup failure");
  assert.throws(() => manager.requireSession("session-1"), /Unknown session/);

  connection.updateDeferreds[0]!.resolve();
});

test("prompt after cancelled update drain waits for cleanup before starting", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "first" } });
  finishRuntimePrompt(runtime, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await handleSessionCancel({ sessionId: "session-1" }, manager);
  assert.deepEqual(await promptPromise, { stopReason: "cancelled" });

  connection.updateDeferreds[0]!.resolve();
  await waitForCondition(() => manager.requireSession("session-1").activePrompt === undefined);

  const nextPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "next" }] }), { manager, connection });
  await waitForCondition(() => runtime.promptDeferreds.length === 2);
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

test("concurrent steer prompt returns after steer accepts", async () => {
  const { manager, connection, runtime } = await createSession();

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  const steeredPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "queued" }] }), { manager, connection });
  let steeredSettled = false;
  steeredPrompt.then(() => {
    steeredSettled = true;
  });

  await waitForCondition(() => runtime.requests.some((request) => request.method === "steer"));
  assert.equal(runtime.promptDeferreds.length, 1);

  assert.deepEqual(await steeredPrompt, { stopReason: "end_turn" });
  assert.equal(steeredSettled, true);
  assert.equal(runtime.promptDeferreds.length, 1, "steer must not start a new prompt request");

  runtime.promptDeferreds[0]!.resolve({});
  runtime.emit({ type: "event", eventType: "agent_end", raw: {} });
  assert.deepEqual(await firstPrompt, { stopReason: "end_turn" });
});

test("event failure suppresses late duplicate agent_end messages fallback and preserves rejection", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "first" } });
  finishRuntimePrompt(runtime, 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  let messagesRead = 0;
  const lateRaw = {
    get messages() {
      messagesRead += 1;
      return [{ role: "assistant", content: ["should not fallback"] }];
    },
  };

  runtime.emit({ type: "event", eventType: "extension_error", raw: { message: "boom" } });
  runtime.emit({ type: "event", eventType: "agent_end", raw: lateRaw });
  assert.equal(messagesRead, 0);
  connection.updateDeferreds[0]!.resolve();
  await assert.rejects(promptPromise, /Runtime extension error: boom/);
  assert.deepEqual(connection.updates, [
    { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first" } } },
  ]);
  assert.equal(runtime.listeners.size, 0);
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

test("todo_write tool result emits ACP plan update before prompt returns", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({
    type: "event",
    eventType: "tool_execution_end",
    raw: {
      type: "tool_execution_end",
      toolCallId: "todo_1",
      toolName: "todo_write",
      status: "completed",
      result: { content: [{ type: "text", text: "updated" }], details: { phases: [{ name: "Work", tasks: [{ content: "Fix bug", status: "in_progress" }, { content: "Run tests", status: "completed" }] }] } },
    },
  });

  await waitForCondition(() => connection.updates.length === 2);
  finishRuntimePrompt(runtime, 0);
  connection.resolveAllUpdates();

  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
  assert.deepEqual(connection.updates.map((entry) => entry.update), [
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "todo_1",
      status: "completed",
      rawOutput: { content: [{ type: "text", text: "updated" }], details: { phases: [{ name: "Work", tasks: [{ content: "Fix bug", status: "in_progress" }, { content: "Run tests", status: "completed" }] }] } },
      content: [{ type: "content", content: { type: "text", text: "updated" } }],
    },
    {
      sessionUpdate: "plan",
      entries: [
        { content: "Fix bug", priority: "medium", status: "in_progress" },
        { content: "Run tests", priority: "medium", status: "completed" },
      ],
    },
  ]);
});

test("todo_write empty result clears ACP plan before prompt returns", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({
    type: "event",
    eventType: "tool_execution_end",
    raw: {
      type: "tool_execution_end",
      toolCallId: "todo_empty",
      toolName: "todo_write",
      status: "completed",
      result: { content: [{ type: "text", text: "cleared" }], details: { phases: [] } },
    },
  });

  await waitForCondition(() => connection.updates.length === 2);
  finishRuntimePrompt(runtime, 0);
  connection.resolveAllUpdates();

  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
  assert.deepEqual(connection.updates[1]?.update, { sessionUpdate: "plan", entries: [] });
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

test("busy runtime prompt response falls back to abort_and_prompt", async () => {
  const { manager, connection, runtime } = await createSession();
  runtime.rejectNextPromptAsBusy = true;

  const promptPromise = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "recover" }] }), { manager, connection });

  await waitForCondition(() => runtime.requests.some((request) => request.method === "abort_and_prompt"));

  assert.deepEqual(runtime.requests.slice(-2), [
    { method: "prompt", params: { message: "recover" } },
    { method: "abort_and_prompt", params: { message: "recover" } },
  ]);

  promptPromise.catch(() => undefined);
});