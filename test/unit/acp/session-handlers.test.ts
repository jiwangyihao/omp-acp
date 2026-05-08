import assert from "node:assert/strict";
import test from "node:test";
import type { NewSessionRequest, PromptRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import { handleSessionCancel } from "../../../src/acp/handlers/session-cancel.ts";
import { handleSessionNew } from "../../../src/acp/handlers/session-new.ts";
import { handleSessionPrompt } from "../../../src/acp/handlers/session-prompt.ts";
import type { RuntimeAdapter, RuntimeDiagnostics } from "../../../src/runtime/RuntimeAdapter.ts";
import type { RuntimeEvent } from "../../../src/runtime/RuntimeEvents.ts";
import { SessionManager, type RuntimeFactoryInput } from "../../../src/session/manager.ts";

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

class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly diagnostics: RuntimeDiagnostics = { stderr: "" };
  readonly ready = Promise.resolve();
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  readonly listeners = new Set<(event: RuntimeEvent) => void>();
  readonly promptDeferreds: Array<Deferred<unknown>> = [];
  closeCalls = 0;

  request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "prompt") {
      const deferred = new Deferred<unknown>();
      this.promptDeferreds.push(deferred);
      return deferred.promise;
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

test("session/new returns the created session id", async () => {
  const { manager, runtimes, inputs } = createHarness();

  const response = await handleSessionNew(newSessionRequest({ cwd: "/tmp/project" }), manager);

  assert.deepEqual(response, { sessionId: "session-1" });
  assert.equal(runtimes.length, 1);
  assert.deepEqual(inputs, [{ cwd: "/tmp/project", mcpServers: [], sessionId: "session-1" }]);
});

test("text prompt sends agent_message_chunk before returning end_turn", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  assert.deepEqual(runtime.requests[0], { method: "prompt", params: { sessionId: "session-1", prompt: "hello" } });

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
  runtime.promptDeferreds[0]!.resolve({});
  await Promise.resolve();
  assert.equal(settled, false);

  connection.resolveAllUpdates();
  assert.deepEqual(await promptPromise, { stopReason: "end_turn" });
});

test("thought event sends agent_thought_chunk", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({ type: "event", eventType: "message_update", raw: { kind: "thought", content: "reasoning" } });
  runtime.promptDeferreds[0]!.resolve({});
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

test("cancel while prompt pending returns cancelled, requests runtime cancel, suppresses late message, and ignores late success", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  await handleSessionCancel({ sessionId: "session-1" }, manager);

  assert.deepEqual(await promptPromise, { stopReason: "cancelled" });
  assert.deepEqual(runtime.requests[1], { method: "cancel", params: { sessionId: "session-1" } });

  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "too late" } });
  runtime.promptDeferreds[0]!.resolve({});
  await waitForCondition(() => runtime.listeners.size === 0);

  assert.deepEqual(connection.updates, []);
  assert.equal(runtime.listeners.size, 0);
});

test("cancelled prompt cleanup is bounded when runtime prompt never settles", async () => {
  const { manager, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection: new FakeConnection() });
  await handleSessionCancel({ sessionId: "session-1" }, manager);

  assert.deepEqual(await promptPromise, { stopReason: "cancelled" });
  await waitForCondition(() => runtime.listeners.size === 0);

  assert.equal(runtime.closeCalls, 1);
  assert.equal(runtime.listeners.size, 0);
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

  runtime.promptDeferreds[0]!.resolve({});
  await waitForCondition(() => runtime.listeners.size === 0);

  const thirdPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "third" }] }), { manager, connection });
  assert.equal(runtime.promptDeferreds.length, 2);
  runtime.promptDeferreds[1]!.resolve({});
  assert.deepEqual(await thirdPrompt, { stopReason: "end_turn" });
});

test("normal prompt drains updates appended while earlier deliveries are pending", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "first" } });
  runtime.promptDeferreds[0]!.resolve({});
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
  runtime.promptDeferreds[0]!.resolve({});
  await new Promise<void>((resolve) => setImmediate(resolve));

  await handleSessionCancel({ sessionId: "session-1" }, manager);

  assert.deepEqual(await promptPromise, { stopReason: "cancelled" });
  assert.equal(runtime.listeners.size, 0);

  connection.updateDeferreds[0]!.resolve();
  const nextPrompt = handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "next" }] }), { manager, connection });
  assert.equal(runtime.promptDeferreds.length, 2);
  runtime.promptDeferreds[1]!.resolve({});
  assert.deepEqual(await nextPrompt, { stopReason: "end_turn" });
});

test("event translation failure stops accepting same-turn assistant updates", async () => {
  const { manager, connection, runtime } = await createSession();

  const promptPromise = handleSessionPrompt(promptRequest(), { manager, connection });
  runtime.emit({ type: "event", eventType: "extension_error", raw: { message: "boom" } });
  runtime.emit({ type: "event", eventType: "message_update", raw: { content: "should not forward" } });

  await assert.rejects(promptPromise, /Runtime extension error: boom/);
  assert.deepEqual(connection.updates, []);
});

test("concurrent prompt rejects", async () => {
  const { manager, connection, runtime } = await createSession();

  const firstPrompt = handleSessionPrompt(promptRequest(), { manager, connection });
  await assert.rejects(handleSessionPrompt(promptRequest({ prompt: [{ type: "text", text: "second" }] }), { manager, connection }), /active prompt/);

  runtime.promptDeferreds[0]!.resolve({});
  assert.deepEqual(await firstPrompt, { stopReason: "end_turn" });
});