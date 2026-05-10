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

class ReadyRuntimeAdapter implements RuntimeAdapter {
  readonly diagnostics: RuntimeDiagnostics = { stderr: "" };
  readonly ready = Promise.resolve();
  readonly requests: Array<{ method: string; params?: unknown }> = [];

  constructor(private readonly state: unknown) {}

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "get_state") return structuredClone(this.state);
    if (method === "set_active_tools") return { toolNames: (params as { toolNames: string[] }).toolNames };
    throw new Error(`Unexpected method ${method}`);
  }

  send(_frame: Record<string, unknown>): Promise<void> {
    return Promise.resolve(undefined);
  }

  onEvent(_listener: (event: RuntimeEvent) => void): () => void {
    return () => {};
  }

  close(): Promise<void> {
    return Promise.resolve(undefined);
  }
}

class SequencedRuntimeAdapter implements RuntimeAdapter {
  readonly diagnostics: RuntimeDiagnostics = { stderr: "" };
  readonly ready = Promise.resolve();
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  closeCalls = 0;

  constructor(
    private readonly states: unknown[],
    private readonly options: { failSetActiveTools?: boolean } = {},
  ) {}

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "get_state") return structuredClone(this.states.shift() ?? {});
    if (method === "set_active_tools") {
      if (this.options.failSetActiveTools === true) {
        throw new Error("set_active_tools failed");
      }
      return { toolNames: (params as { toolNames: string[] }).toolNames };
    }
    if (method === "switch_session") return undefined;
    throw new Error(`Unexpected method ${method}`);
  }

  send(_frame: Record<string, unknown>): Promise<void> {
    return Promise.resolve(undefined);
  }

  onEvent(_listener: (event: RuntimeEvent) => void): () => void {
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

test("createSession disables only OMP ask while preserving other active tools", async () => {
  const runtimes: ReadyRuntimeAdapter[] = [];
  const manager = new SessionManager({
    idGenerator: () => "session-1",
    runtimeFactory() {
      const runtime = new ReadyRuntimeAdapter({
        dumpTools: [
          { name: "read" },
          { name: "ask" },
          { name: "plugin_tool" },
          { name: "mcp__server__tool" },
        ],
      });
      runtimes.push(runtime);
      return runtime;
    },
  });

  await manager.createSession(newSessionRequest());

  assert.deepEqual(runtimes[0]!.requests, [
    { method: "get_state", params: undefined },
    { method: "set_active_tools", params: { toolNames: ["read", "plugin_tool", "mcp__server__tool"] } },
  ]);
});

test("createSession does not mutate active tools when ask is already absent", async () => {
  const runtimes: ReadyRuntimeAdapter[] = [];
  const manager = new SessionManager({
    idGenerator: () => "session-1",
    runtimeFactory() {
      const runtime = new ReadyRuntimeAdapter({
        dumpTools: [{ name: "read" }, { name: "plugin_tool" }],
      });
      runtimes.push(runtime);
      return runtime;
    },
  });

  await manager.createSession(newSessionRequest());

  assert.deepEqual(runtimes[0]!.requests, [
    { method: "get_state", params: undefined },
  ]);
});

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

test("createSessionWithId rejects duplicate pending session ids", async () => {
  const { manager, runtimes } = createManager();

  const firstCreate = manager.createSessionWithId("fixed-session", newSessionRequest());
  assert.equal(runtimes.length, 1);

  const secondCreate = manager.createSessionWithId("fixed-session", newSessionRequest());
  assert.equal(runtimes.length, 1);
  await assert.rejects(secondCreate, SessionManagerError);

  runtimes[0]!.readyDeferred.resolve();
  await firstCreate;
});

test("abandoned session creation cannot clear a later pending reservation", async () => {
  const { manager, runtimes } = createManager();

  const abandonedCreate = manager.createSessionWithId("fixed-session", newSessionRequest());
  assert.equal(runtimes.length, 1);
  await manager.closeAll();

  const laterCreate = manager.createSessionWithId("fixed-session", newSessionRequest());
  assert.equal(runtimes.length, 2);

  runtimes[0]!.readyDeferred.resolve();
  await assert.rejects(abandonedCreate, SessionManagerError);

  const duplicateLaterCreate = manager.createSessionWithId("fixed-session", newSessionRequest());
  assert.equal(runtimes.length, 2);
  await assert.rejects(duplicateLaterCreate, SessionManagerError);

  runtimes[1]!.readyDeferred.resolve();
  await laterCreate;
});

test("createSessionWithId rejects a final runtime session id reserved by another pending session", async () => {
  const { manager, runtimes } = createManager();
  let releaseB!: () => void;

  const pendingB = manager.createSessionWithId("session-b", newSessionRequest(), async () => {
    await new Promise<void>((resolve) => {
      releaseB = resolve;
    });
  });
  assert.equal(runtimes.length, 1);
  runtimes[0]!.readyDeferred.resolve();

  const pendingA = manager.createSessionWithId("session-a", newSessionRequest(), {
    afterGuard: async () => ({ sessionId: "session-b" }),
  });
  assert.equal(runtimes.length, 2);
  runtimes[1]!.readyDeferred.resolve();

  await assert.rejects(pendingA, /Session already exists: session-b/);
  assert.equal(runtimes[1]!.closeCalls, 1);

  releaseB();
  await pendingB;
  assert.equal(manager.tryGetSession("session-b")?.sessionId, "session-b");
});

test("createSessionWithId closes runtime when final runtime session id already exists", async () => {
  const { manager, runtimes } = createManager();

  const existingCreate = manager.createSessionWithId("existing", newSessionRequest());
  runtimes[0]!.readyDeferred.resolve();
  await existingCreate;

  const duplicateCreate = manager.createSessionWithId("new-id", newSessionRequest(), {
    afterGuard: async () => ({ sessionId: "existing" }),
  });
  assert.equal(runtimes.length, 2);
  runtimes[1]!.readyDeferred.resolve();

  await assert.rejects(duplicateCreate, /Session already exists: existing/);
  assert.equal(runtimes[1]!.closeCalls, 1);
  assert.equal(manager.tryGetSession("existing")?.sessionId, "existing");
});

test("createSessionWithId runs ask guard after beforeGuard", async () => {
  const runtime = new SequencedRuntimeAdapter([
    { dumpTools: [{ name: "ask" }, { name: "bash" }] },
  ]);
  const manager = new SessionManager({ runtimeFactory: () => runtime });

  await manager.createSessionWithId("session-1", newSessionRequest(), {
    beforeGuard: async (guardedRuntime) => {
      await guardedRuntime.request("switch_session", { sessionPath: "target-session" });
      return { sessionId: "session-1" };
    },
  });

  assert.deepEqual(runtime.requests, [
    { method: "switch_session", params: { sessionPath: "target-session" } },
    { method: "get_state", params: undefined },
    { method: "set_active_tools", params: { toolNames: ["bash"] } },
  ]);
});

test("createSessionWithId does not publish when post-switch ask disable fails", async () => {
  const runtime = new SequencedRuntimeAdapter([{ dumpTools: [{ name: "ask" }] }], { failSetActiveTools: true });
  const manager = new SessionManager({ runtimeFactory: () => runtime });

  await assert.rejects(
    manager.createSessionWithId("session-1", newSessionRequest(), {
      beforeGuard: async () => ({ sessionId: "session-1" }),
      afterGuard: async () => undefined,
    }),
    /Runtime failed to become ready for session session-1/,
  );

  assert.equal(runtime.closeCalls, 1);
  assert.equal(manager.tryGetSession("session-1"), undefined);

  const retryCreate = manager.createSessionWithId("session-1", newSessionRequest());
  assert.equal(manager.tryGetSession("session-1"), undefined);
  await retryCreate;
  assert.equal(manager.tryGetSession("session-1")?.sessionId, "session-1");
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

test("cancelPrompt marks the active prompt cancelled and requests runtime abort", async () => {
  const { manager, runtimes } = createManager();
  const createPromise = manager.createSession(newSessionRequest());
  runtimes[0]!.readyDeferred.resolve();
  await createPromise;
  const active = manager.beginPrompt("session-1");

  await manager.cancelPrompt("session-1");

  assert.equal(active.cancellation.isCancelled, true);
  assert.deepEqual(runtimes[0]!.requests, [{ method: "get_state", params: undefined }, { method: "abort", params: undefined }]);
});

test("cancelPrompt ignores runtime cancel request failures", async () => {
  const { manager, runtimes } = createManager();
  const createPromise = manager.createSession(newSessionRequest());
  runtimes[0]!.readyDeferred.resolve();
  await createPromise;
  const active = manager.beginPrompt("session-1");
  runtimes[0]!.requestFailure = new Error("abort failed");

  await manager.cancelPrompt("session-1");

  assert.equal(active.cancellation.isCancelled, true);
  assert.deepEqual(runtimes[0]!.requests, [{ method: "get_state", params: undefined }, { method: "abort", params: undefined }]);
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