import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RequestError, type ForkSessionRequest } from "@agentclientprotocol/sdk";
import { handleSessionFork } from "../../../src/acp/handlers/session-fork.ts";
import type { RuntimeAdapter, RuntimeDiagnostics } from "../../../src/runtime/RuntimeAdapter.ts";
import { findOmpSessionById, OmpSessionForkSourceError } from "../../../src/runtime/omp/sessions.ts";
import { SessionManager, SessionManagerError, type RuntimeFactoryInput } from "../../../src/session/manager.ts";

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

class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly diagnostics: RuntimeDiagnostics = { stderr: "" };
  readonly ready = Promise.resolve();
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  switchSessionFailure: unknown;
  getStateFailure: unknown;
  getAvailableModelsFailure: unknown;
  setActiveToolsFailure: unknown;
  onSwitchSession: (() => void) | undefined;
  closeCalls = 0;
  #switchedToForkSession = false;
  #activeToolNames: string[] | undefined;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "switch_session") {
      this.onSwitchSession?.();
      if (this.switchSessionFailure !== undefined) {
        throw this.switchSessionFailure;
      }
      this.#switchedToForkSession = true;
      return { ok: true };
    }
    if (method === "get_state") {
      if (this.getStateFailure !== undefined) throw this.getStateFailure;
      return structuredClone({ ...CONTROL_STATE, dumpTools: this.#dumpTools() });
    }
    if (method === "get_available_models") {
      if (this.getAvailableModelsFailure !== undefined) throw this.getAvailableModelsFailure;
      return structuredClone(AVAILABLE_MODELS);
    }
    if (method === "set_active_tools") {
      if (this.setActiveToolsFailure !== undefined) throw this.setActiveToolsFailure;
      const toolNames = typeof params === "object" && params !== null ? (params as { toolNames?: unknown }).toolNames : undefined;
      this.#activeToolNames = Array.isArray(toolNames) ? toolNames.filter((name): name is string => typeof name === "string") : [];
      return { ok: true };
    }
    return undefined;
  }

  #dumpTools(): Array<{ name: string }> {
    const names = this.#switchedToForkSession ? (this.#activeToolNames ?? ["ask", "bash"]) : ["bash"];
    return names.map((name) => ({ name }));
  }

  async send(): Promise<void> {}

  onEvent(): () => void {
    return () => {};
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function createHarness(
  options: {
    switchSessionFailure?: unknown;
    getStateFailure?: unknown;
    getAvailableModelsFailure?: unknown;
    setActiveToolsFailure?: unknown;
    onSwitchSession?: () => void;
  } = {},
) {
  const runtimes: FakeRuntimeAdapter[] = [];
  const inputs: RuntimeFactoryInput[] = [];
  const ids = ["fork-session"];
  const manager = new SessionManager({
    idGenerator: () => ids.shift() ?? "unexpected-session",
    runtimeFactory(input) {
      inputs.push(input);
      const runtime = new FakeRuntimeAdapter();
      runtime.switchSessionFailure = options.switchSessionFailure;
      runtime.getStateFailure = options.getStateFailure;
      runtime.getAvailableModelsFailure = options.getAvailableModelsFailure;
      runtime.setActiveToolsFailure = options.setActiveToolsFailure;
      runtimes.push(runtime);
      runtime.onSwitchSession = options.onSwitchSession;
      return runtime;
    },
  });

  return { manager, runtimes, inputs };
}

function forkRequest(cwd: string, overrides: Partial<ForkSessionRequest> = {}): ForkSessionRequest {
  return {
    sessionId: "source-session",
    cwd,
    mcpServers: [],
    ...overrides,
  };
}

async function tempAgentDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "omp-acp-fork-agent-"));
}

async function writeSession(agentDir: string, cwd: string, sessionId: string, entries: unknown[]): Promise<string> {
  const dir = join(agentDir, "sessions", `--${cwd.replace(/^\/+/, "").replace(/[\\/:]/g, "-")}--`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return path;
}

async function assertRequestError(errorPromise: Promise<unknown>, code: number, messagePattern: RegExp): Promise<void> {
  await assert.rejects(errorPromise, (error) => {
    assert.equal(error instanceof RequestError, true);
    assert.equal((error as { code?: number }).code, code);
    assert.match((error as Error).message, messagePattern);
    return true;
  });
}

test("forkSession creates an OMP fork file, switches runtime before publishing, and returns the fork id", async () => {
  const agentDir = await tempAgentDir();
  const cwd = join(tmpdir(), "fork-project");
  const sourcePath = await writeSession(agentDir, cwd, "source-session", [
    { type: "session", id: "source-session", cwd, timestamp: "2026-05-08T01:00:00.000Z", title: "Source" },
    { type: "message", role: "user", content: "hello", sessionId: "source-session" },
  ]);
  const { manager, runtimes, inputs } = createHarness({
    onSwitchSession: () => {
      assert.equal(manager.tryGetSession("fork-session"), undefined, "session must not be published before switch_session");
    },
  });

  const response = await handleSessionFork(forkRequest(cwd), manager, { agentDir });

  assert.equal(response.sessionId, "fork-session");
  assert.ok(response.models);
  assert.ok(response.modes);
  assert.ok(response.configOptions?.some((option) => option.id === "model"));
  assert.equal(Object.hasOwn(response, "runtimeSessionId"), false);
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0], { sessionId: "fork-session", cwd, mcpServers: [], additionalDirectories: [] });
  assert.equal(runtimes.length, 1);
  const requests = runtimes[0]?.requests ?? [];
  const switchRequest = requests.find((request) => request.method === "switch_session");
  assert.ok(switchRequest);
  const forkPath = (switchRequest.params as { sessionPath: string }).sessionPath;
  assert.deepEqual(requests, [
    { method: "switch_session", params: { sessionPath: forkPath } },
    { method: "get_state", params: undefined },
    { method: "set_active_tools", params: { toolNames: ["bash"] } },
    { method: "get_state", params: undefined },
    { method: "get_available_models", params: undefined },
  ]);
  assert.notEqual(forkPath, sourcePath);
  const forkHeader = JSON.parse((await readFile(forkPath, "utf8")).split(/\r?\n/)[0]!);
  assert.equal(forkHeader.parentSession, "source-session");
  const session = manager.requireSession("fork-session");
  assert.equal(session.runtime, runtimes[0]);
  assert.equal(session.sessionId, "fork-session");
});

test("forkSession rejects unknown source session clearly", async () => {
  const agentDir = await tempAgentDir();
  const cwd = join(tmpdir(), "fork-missing");
  const { manager } = createHarness();

  await assertRequestError(handleSessionFork(forkRequest(cwd), manager, { agentDir }), -32002, /source-session/);
});

test("forkSession rejects active source prompts", async () => {
  const agentDir = await tempAgentDir();
  const cwd = join(tmpdir(), "fork-active");
  await writeSession(agentDir, cwd, "source-session", [{ type: "session", id: "source-session", cwd }]);
  const { manager } = createHarness();
  await manager.createSessionWithId("source-session", forkRequest(cwd));
  const active = manager.beginPrompt("source-session");

  await assertRequestError(
    handleSessionFork(forkRequest(cwd), manager, { agentDir }),
    -32602,
    /Cannot fork a session with an active prompt/,
  );
  assert.equal(await findOmpSessionById("fork-session", { agentDir }), undefined);
  active.finish();
});

test("forkSession rejects prompt that races with source fork guard", async () => {
  const cwd = join(tmpdir(), "fork-guard");
  const { manager } = createHarness();

  const guard = manager.beginForkSource("source-session");
  await manager.createSessionWithId("source-session", forkRequest(cwd));
  assert.throws(() => manager.beginPrompt("source-session"), SessionManagerError);
  guard.finish();
  const active = manager.beginPrompt("source-session");
  active.finish();
});

test("forkSession maps source helper errors to not found", async () => {
  const agentDir = await tempAgentDir();
  const cwd = join(tmpdir(), "fork-helper-error");
  await writeSession(agentDir, cwd, "source-session", [{ type: "session", id: "source-session", cwd }]);
  const { manager } = createHarness();

  await assertRequestError(
    handleSessionFork(forkRequest(cwd), manager, {
      agentDir,
      forkSessionFile: async () => {
        throw new OmpSessionForkSourceError("bad source");
      },
    }),
    -32002,
    /source-session/,
  );
});

test("forkSession does not publish a fork and removes fork file when switch_session fails", async () => {
  const agentDir = await tempAgentDir();
  const cwd = join(tmpdir(), "fork-switch-failure");
  await writeSession(agentDir, cwd, "source-session", [{ type: "session", id: "source-session", cwd }]);
  const { manager } = createHarness({ switchSessionFailure: new Error("switch failed") });

  await assert.rejects(handleSessionFork(forkRequest(cwd), manager, { agentDir }), /Runtime failed to become ready/);
  assert.throws(() => manager.requireSession("fork-session"), /Unknown session/);
  assert.equal(await findOmpSessionById("fork-session", { agentDir }), undefined);
});

test("forkSession does not publish a fork and removes fork file when ask guard fails", async () => {
  const agentDir = await tempAgentDir();
  const cwd = join(tmpdir(), "fork-ask-failure");
  await writeSession(agentDir, cwd, "source-session", [{ type: "session", id: "source-session", cwd }]);
  const { manager } = createHarness({ setActiveToolsFailure: new Error("set active failed") });

  await assert.rejects(handleSessionFork(forkRequest(cwd), manager, { agentDir }), /Runtime failed to become ready/);
  assert.throws(() => manager.requireSession("fork-session"), /Unknown session/);
  assert.equal(await findOmpSessionById("fork-session", { agentDir }), undefined);
});

test("forkSession does not publish a fork and removes fork file when setup state build fails", async () => {
  const agentDir = await tempAgentDir();
  const cwd = join(tmpdir(), "fork-state-failure");
  await writeSession(agentDir, cwd, "source-session", [{ type: "session", id: "source-session", cwd }]);
  const { manager, runtimes } = createHarness({ getAvailableModelsFailure: new Error("state failed") });

  await assert.rejects(handleSessionFork(forkRequest(cwd), manager, { agentDir }), /Runtime failed to become ready/);
  const requests = runtimes[0]?.requests ?? [];
  const setActiveToolsIndex = requests.findIndex((request) => request.method === "set_active_tools");
  const getAvailableModelsIndex = requests.findIndex((request) => request.method === "get_available_models");
  assert.notEqual(setActiveToolsIndex, -1);
  assert.notEqual(getAvailableModelsIndex, -1);
  assert.ok(setActiveToolsIndex < getAvailableModelsIndex);
  assert.throws(() => manager.requireSession("fork-session"), /Unknown session/);
  assert.equal(await findOmpSessionById("fork-session", { agentDir }), undefined);
});

test("forkSession preserves fork failure details when cleanup fails", async () => {
  const agentDir = await tempAgentDir();
  const cwd = join(tmpdir(), "fork-cleanup-failure");
  await writeSession(agentDir, cwd, "source-session", [{ type: "session", id: "source-session", cwd }]);
  const { manager } = createHarness({ switchSessionFailure: new Error("switch failed") });

  await assert.rejects(
    handleSessionFork(forkRequest(cwd), manager, {
      agentDir,
      removeForkFile: async () => {
        throw new Error("cleanup failed");
      },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      const aggregate = error as AggregateError;
      assert.match(aggregate.message, /Fork session failed and cleanup failed for/);
      assert.deepEqual(
        aggregate.errors.map((nestedError) => (nestedError as Error).message),
        ["Runtime failed to become ready for session fork-session", "cleanup failed"],
      );
      assert.match(((aggregate.errors[0] as Error).cause as Error).message, /switch failed/);
      return true;
    },
  );
  assert.throws(() => manager.requireSession("fork-session"), /Unknown session/);
});

test("forkSession preserves setup state failure details when cleanup also fails", async () => {
  const agentDir = await tempAgentDir();
  const cwd = join(tmpdir(), "fork-state-cleanup-failure");
  await writeSession(agentDir, cwd, "source-session", [{ type: "session", id: "source-session", cwd }]);
  const { manager } = createHarness({ getAvailableModelsFailure: new Error("state failed") });

  await assert.rejects(
    handleSessionFork(forkRequest(cwd), manager, {
      agentDir,
      removeForkFile: async () => {
        throw new Error("cleanup failed");
      },
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      const aggregate = error as AggregateError;
      assert.match(aggregate.message, /Fork session failed and cleanup failed for/);
      assert.deepEqual(
        aggregate.errors.map((nestedError) => (nestedError as Error).message),
        ["Runtime failed to become ready for session fork-session", "cleanup failed"],
      );
      assert.match(((aggregate.errors[0] as Error).cause as Error).message, /state failed/);
      return true;
    },
  );
  assert.throws(() => manager.requireSession("fork-session"), /Unknown session/);
});