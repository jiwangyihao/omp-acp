import assert from "node:assert/strict";
import test from "node:test";
import type { NewSessionRequest } from "@agentclientprotocol/sdk";
import { PromptCancellation } from "../../../src/session/cancellation.ts";
import { SessionManager, SessionManagerError, type RuntimeFactoryInput } from "../../../src/session/manager.ts";
import type { RuntimeAdapter, RuntimeDiagnostics } from "../../../src/runtime/RuntimeAdapter.ts";
import type { RuntimeEvent } from "../../../src/runtime/RuntimeEvents.ts";

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
  readonly readyDeferred = new Deferred<void>();
  readonly ready = this.readyDeferred.promise;
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  readonly listeners: Array<(event: RuntimeEvent) => void> = [];
  closeCalls = 0;
  requestFailure: unknown;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (this.requestFailure !== undefined) {
      throw this.requestFailure;
    }
    return undefined;
  }

  send(_frame: Record<string, unknown>): Promise<void> {
    return Promise.resolve(undefined);
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {};
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function newSessionRequest(overrides: Partial<NewSessionRequest> = {}): NewSessionRequest {
  return {
    cwd: "/workspace/project",
    mcpServers: [],
    ...overrides,
  };
}

function createManager() {
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

  return { manager, runtimes, inputs };
}

test("createSession awaits runtime readiness and stores the runtime", async () => {
  const { manager, runtimes, inputs } = createManager();

  const mcpServers = [{ name: "fixture", command: "server", args: [], env: [] }];
  const createPromise = manager.createSession(newSessionRequest({ cwd: "/tmp/work", mcpServers }));
  assert.equal(runtimes.length, 1);
  assert.deepEqual(inputs, [{ cwd: "/tmp/work", mcpServers, sessionId: "session-1" }]);

  runtimes[0]!.readyDeferred.resolve();
  assert.deepEqual(await createPromise, { sessionId: "session-1" });

  const record = manager.requireSession("session-1");
  assert.equal(record.sessionId, "session-1");
  assert.equal(record.runtime, runtimes[0]);
  assert.equal(record.cwd, "/tmp/work");
  assert.deepEqual(record.mcpServers, mcpServers);
});

test("createSession closes runtime and rejects with SessionManagerError when ready fails", async () => {
  const { manager, runtimes } = createManager();
  const cause = new Error("boot failed");

  const createPromise = manager.createSession(newSessionRequest());
  runtimes[0]!.readyDeferred.reject(cause);

  await assert.rejects(createPromise, (error) => {
    assert.equal(error instanceof SessionManagerError, true);
    assert.equal((error as Error).cause, cause);
    return true;
  });
  assert.equal(runtimes[0]!.closeCalls, 1);
  assert.throws(() => manager.requireSession("session-1"), SessionManagerError);
});

test("closeAll closes pending runtime and prevents later session publish", async () => {
  const { manager, runtimes } = createManager();

  const createPromise = manager.createSession(newSessionRequest());
  assert.equal(runtimes.length, 1);

  await manager.closeAll();
  assert.equal(runtimes[0]!.closeCalls, 1);

  runtimes[0]!.readyDeferred.resolve();
  await assert.rejects(createPromise, SessionManagerError);
  assert.throws(() => manager.requireSession("session-1"), SessionManagerError);
});

test("requireSession throws SessionManagerError for unknown sessions", () => {
  const { manager } = createManager();

  assert.throws(() => manager.requireSession("missing"), SessionManagerError);
});

test("beginPrompt rejects a concurrent prompt", async () => {
  const { manager, runtimes } = createManager();
  const createPromise = manager.createSession(newSessionRequest());
  runtimes[0]!.readyDeferred.resolve();
  await createPromise;

  const active = manager.beginPrompt("session-1");

  assert.throws(() => manager.beginPrompt("session-1"), SessionManagerError);
  active.finish();
});

test("finish clears only the active prompt it owns", async () => {
  const { manager, runtimes } = createManager();
  const createPromise = manager.createSession(newSessionRequest());
  runtimes[0]!.readyDeferred.resolve();
  await createPromise;

  const first = manager.beginPrompt("session-1");
  assert.equal(first.session.activePrompt?.cancellation, first.cancellation);
  first.finish();
  assert.equal(first.session.activePrompt, undefined);

  const second = manager.beginPrompt("session-1");
  first.finish();
  assert.equal(second.session.activePrompt?.cancellation, second.cancellation);
  second.finish();
  assert.equal(second.session.activePrompt, undefined);
});

test("cancelPrompt marks the active prompt cancelled and requests runtime cancellation", async () => {
  const { manager, runtimes } = createManager();
  const createPromise = manager.createSession(newSessionRequest());
  runtimes[0]!.readyDeferred.resolve();
  await createPromise;
  const active = manager.beginPrompt("session-1");

  await manager.cancelPrompt("session-1");

  assert.equal(active.cancellation.isCancelled, true);
  assert.deepEqual(runtimes[0]!.requests, [{ method: "cancel", params: { sessionId: "session-1" } }]);
});

test("cancelPrompt ignores runtime cancel request failures", async () => {
  const { manager, runtimes } = createManager();
  const createPromise = manager.createSession(newSessionRequest());
  runtimes[0]!.readyDeferred.resolve();
  await createPromise;
  const active = manager.beginPrompt("session-1");
  runtimes[0]!.requestFailure = new Error("cancel failed");

  await manager.cancelPrompt("session-1");

  assert.equal(active.cancellation.isCancelled, true);
  assert.deepEqual(runtimes[0]!.requests, [{ method: "cancel", params: { sessionId: "session-1" } }]);
});

test("closeAll cancels active prompts, closes runtimes, and clears sessions", async () => {
  const { manager, runtimes } = createManager();
  const firstCreate = manager.createSession(newSessionRequest());
  runtimes[0]!.readyDeferred.resolve();
  await firstCreate;
  const secondCreate = manager.createSession(newSessionRequest({ cwd: "/tmp/second" }));
  runtimes[1]!.readyDeferred.resolve();
  await secondCreate;
  const active = manager.beginPrompt("session-1");

  await manager.closeAll();
  await manager.closeAll();

  assert.equal(active.cancellation.isCancelled, true);
  assert.equal(runtimes[0]!.closeCalls, 1);
  assert.equal(runtimes[1]!.closeCalls, 1);
  assert.throws(() => manager.requireSession("session-1"), SessionManagerError);
  assert.throws(() => manager.requireSession("session-2"), SessionManagerError);
});

test("PromptCancellation exposes cancellation state and throws when cancelled", () => {
  const cancellation = new PromptCancellation();

  assert.equal(cancellation.isCancelled, false);
  assert.doesNotThrow(() => cancellation.throwIfCancelled());

  cancellation.cancel();

  assert.equal(cancellation.isCancelled, true);
  assert.throws(() => cancellation.throwIfCancelled(), /cancelled/i);
});