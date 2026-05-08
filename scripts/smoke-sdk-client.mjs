import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const adapterEntry = process.env.OMP_ACP_SMOKE_ENTRY ?? resolve(repoRoot, "dist/index.js");
const fixtureEntry = resolve(repoRoot, "src/testing/script-rpc-process.ts");
const timeoutMs = Number.parseInt(process.env.OMP_ACP_SMOKE_TIMEOUT_MS ?? "10000", 10);

const agentDir = await mkdtemp(resolve(tmpdir(), "omp-acp-sdk-smoke-agent-"));
const updates = [];
const acp = startSdkClient(agentDir, updates);

try {
  const initialize = await acp.request("initialize", () => acp.connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: "omp-acp SDK smoke", version: "1.0.0" },
    clientCapabilities: {},
  }));

  assert.equal(initialize.protocolVersion, PROTOCOL_VERSION);
  assert.equal(initialize.agentInfo?.name, "omp-acp");
  assert.equal(initialize.agentCapabilities?.loadSession, true);
  assert.equal(initialize.agentCapabilities?.promptCapabilities?.image, true);
  assert.equal(initialize.agentCapabilities?.promptCapabilities?.audio, false);
  assert.equal(initialize.agentCapabilities?.promptCapabilities?.embeddedContext, true);
  assert.equal(initialize.agentCapabilities?.mcpCapabilities?.http, false);
  assert.equal(initialize.agentCapabilities?.mcpCapabilities?.sse, false);
  assert.deepEqual(initialize.agentCapabilities?.sessionCapabilities?.list, {});
  assert.deepEqual(initialize.agentCapabilities?.sessionCapabilities?.resume, {});
  assert.deepEqual(initialize.agentCapabilities?.sessionCapabilities?.fork, {});
  assert.equal(initialize.agentCapabilities?.sessionCapabilities?.close, undefined);
  assert.equal(initialize.authMethods, undefined);

  const sessionFile = await writeSmokeSession(agentDir, repoRoot, "sdk-smoke-session", [
    { type: "session", id: "sdk-smoke-session", cwd: repoRoot, timestamp: "2026-05-08T01:00:00.000Z", title: "SDK Smoke" },
    { type: "message", role: "user", content: "past question", timestamp: "2026-05-08T01:01:00.000Z" },
    { type: "message", role: "assistant", content: "past answer", timestamp: "2026-05-08T01:02:00.000Z" },
  ]);

  const list = await acp.request("session/list", () => acp.connection.listSessions({ cwd: repoRoot }));
  assert.deepEqual(list, {
    sessions: [
      {
        sessionId: "sdk-smoke-session",
        cwd: repoRoot,
        title: "SDK Smoke",
        updatedAt: "2026-05-08T01:02:00.000Z",
        _meta: { ompSessionPath: sessionFile },
      },
    ],
  });

  const fork = await acp.request("session/fork", () => acp.connection.unstable_forkSession({ sessionId: "sdk-smoke-session", cwd: repoRoot, mcpServers: [] }));
  assert.equal(typeof fork.sessionId, "string");
  assert.notEqual(fork.sessionId, "sdk-smoke-session");
  assertSetupState(fork);

  const forkPrompt = await acp.request("session/prompt after fork", () => acp.connection.prompt({
    sessionId: fork.sessionId,
    prompt: [{ type: "text", text: "after sdk fork" }],
  }));
  assert.deepEqual(forkPrompt, { stopReason: "end_turn" });
  assert.deepEqual(updates.splice(0), [
    expectedTextUpdate(fork.sessionId, "agent_message_chunk", "after sdk fork"),
    expectedTextUpdate(fork.sessionId, "agent_thought_chunk", "thinking"),
  ]);

  const session = await acp.request("session/new", () => acp.connection.newSession({ cwd: repoRoot, mcpServers: [] }));
  assert.equal(typeof session.sessionId, "string");
  assertSetupState(session);

  const setModel = await acp.request("session/set_model", () => acp.connection.unstable_setSessionModel({
    sessionId: session.sessionId,
    modelId: "fixture/model-2",
  }));
  assert.deepEqual(setModel, {});
  assertSingleConfigOptionUpdate(updates.splice(0), session.sessionId, "model", "fixture/model-2");
  await promptAndAssert(acp, updates, session.sessionId, "after sdk model");

  const setConfigOption = await acp.request("session/set_config_option", () => acp.connection.setSessionConfigOption({
    sessionId: session.sessionId,
    configId: "thinking",
    value: "low",
  }));
  assertConfigOptionValue(setConfigOption.configOptions, "thinking", "low");
  assertSingleConfigOptionUpdate(updates.splice(0), session.sessionId, "thinking", "low");
  await promptAndAssert(acp, updates, session.sessionId, "after sdk thinking");

  const setMode = await acp.request("session/set_mode", () => acp.connection.setSessionMode({
    sessionId: session.sessionId,
    modeId: "default",
  }));
  assert.deepEqual(setMode, {});
  assert.deepEqual(updates.splice(0), [expectedModeUpdate(session.sessionId, "default")]);
  await promptAndAssert(acp, updates, session.sessionId, "after sdk mode");

  const prompt = await acp.request("session/prompt", () => acp.connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "sdk smoke" }],
  }));
  assert.deepEqual(prompt, { stopReason: "end_turn" });

  assert.deepEqual(updates.splice(0), [
    expectedTextUpdate(session.sessionId, "agent_message_chunk", "sdk smoke"),
    expectedTextUpdate(session.sessionId, "agent_thought_chunk", "thinking"),
  ]);

  const resumed = await acp.request("session/resume", () => acp.connection.resumeSession({ sessionId: "sdk-smoke-session", cwd: repoRoot, mcpServers: [] }));
  assertSetupState(resumed);
  assert.deepEqual(updates.splice(0), []);

  const resumedPrompt = await acp.request("session/prompt after resume", () => acp.connection.prompt({
    sessionId: "sdk-smoke-session",
    prompt: [{ type: "text", text: "after sdk resume" }],
  }));
  assert.deepEqual(resumedPrompt, { stopReason: "end_turn" });
  assert.deepEqual(updates.splice(0), [
    expectedTextUpdate("sdk-smoke-session", "agent_message_chunk", "after sdk resume"),
    expectedTextUpdate("sdk-smoke-session", "agent_thought_chunk", "thinking"),
  ]);

  await acp.close();
  assert.equal(acp.stderr, "");
  console.log(JSON.stringify({ status: "success", adapterEntry, sessionConfigOptions: "success", sessionSetModel: "success", sessionSetConfigOption: "success", sessionSetMode: "success" }));
} finally {
  await acp.close().catch(() => {});
  await rm(agentDir, { recursive: true, force: true });
}

function startSdkClient(agentDir, updates) {
  const child = spawn(process.execPath, [adapterEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OMP_ACP_AGENT_DIR: agentDir,
      OMP_ACP_RUNTIME_COMMAND: process.execPath,
      OMP_ACP_RUNTIME_ARGS_JSON: JSON.stringify(["--import", "tsx", fixtureEntry, "session-happy"]),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let childClosed = false;
  let protocolError;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("close", () => {
    childClosed = true;
  });

  const stdout = createStrictReadableStream(Readable.toWeb(child.stdout), (error) => {
    protocolError = error;
    child.kill();
  });
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    stdout,
  );

  const connection = new ClientSideConnection(
    () => ({
      async requestPermission() {
        throw new Error("The SDK smoke client does not grant permissions");
      },
      async sessionUpdate(params) {
        updates.push(params);
      },
    }),
    stream,
  );

  return {
    connection,
    get stderr() {
      return stderr;
    },
    request(label, operation) {
      const promise = operation();
      promise.catch(() => {});
      return withTimeout(promise, label, () => child.kill());
    },
    async close() {
      if (child.exitCode === null && !child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end();
      }
      if (!childClosed) {
        const closed = once(child, "close");
        const timeout = new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1000, "timeout"));
        if ((await Promise.race([closed, timeout])) === "timeout") {
          child.kill();
          await closed;
        }
      }
      if (protocolError !== undefined) {
        throw protocolError;
      }
    },
  };
}

async function writeSmokeSession(agentDir, cwd, sessionId, lines) {
  const dir = join(agentDir, "sessions", `--${sessionId}--`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

function expectedTextUpdate(sessionId, sessionUpdate, text) {
  return {
    sessionId,
    update: {
      sessionUpdate,
      content: { type: "text", text },
    },
  };
}

async function promptAndAssert(acp, updates, sessionId, text) {
  const prompt = await acp.request(`session/prompt ${text}`, () => acp.connection.prompt({
    sessionId,
    prompt: [{ type: "text", text }],
  }));
  assert.deepEqual(prompt, { stopReason: "end_turn" });
  assert.deepEqual(updates.splice(0), [
    expectedTextUpdate(sessionId, "agent_message_chunk", text),
    expectedTextUpdate(sessionId, "agent_thought_chunk", "thinking"),
  ]);
}

function assertSetupState(result) {
  assertPlainObject(result.models, "models");
  assertPlainObject(result.modes, "modes");
  assert.ok(Array.isArray(result.configOptions), "configOptions must be an array");
  assertConfigOptionValue(result.configOptions, "model", "fixture/model");
  assertConfigOptionValue(result.configOptions, "thinking", "low");
}

function assertPlainObject(value, label) {
  assert.equal(typeof value, "object", `${label} must be an object`);
  assert.notEqual(value, null, `${label} must not be null`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array`);
}

function assertConfigOptionValue(configOptions, optionId, currentValue) {
  assert.ok(Array.isArray(configOptions), "configOptions must be an array");
  const option = configOptions.find((candidate) => candidate?.id === optionId);
  assert.ok(option, `Missing config option ${optionId}`);
  assert.equal(option.currentValue, currentValue);
}

function assertSingleConfigOptionUpdate(updateBatch, sessionId, optionId, currentValue) {
  assert.equal(updateBatch.length, 1);
  const [message] = updateBatch;
  assert.equal(message.sessionId, sessionId);
  assert.equal(message.update?.sessionUpdate, "config_option_update");
  assertConfigOptionValue(message.update?.configOptions, optionId, currentValue);
}

function expectedModeUpdate(sessionId, currentModeId) {
  return {
    sessionId,
    update: { sessionUpdate: "current_mode_update", currentModeId },
  };
}

function createStrictReadableStream(input, onProtocolError) {
  const decoder = new TextDecoder();
  let buffer = "";

  return new ReadableStream({
    async start(controller) {
      const reader = input.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            validateStdoutRemainder(buffer);
            break;
          }
          if (!value) {
            continue;
          }

          buffer += decoder.decode(value, { stream: true });
          buffer = validateStdoutLines(buffer);
          controller.enqueue(value);
        }
      } catch (error) {
        onProtocolError(error);
        controller.error(error);
        return;
      } finally {
        reader.releaseLock();
      }
      controller.close();
    },
  });
}

function validateStdoutLines(buffer) {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    validateJsonRpcLine(line);
  }
  return remainder;
}

function validateStdoutRemainder(buffer) {
  if (buffer.trim().length > 0) {
    validateJsonRpcLine(buffer);
  }
}

function validateJsonRpcLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    throw new Error(`Adapter stdout contained non-JSON content: ${trimmed}`, { cause });
  }

  if (typeof parsed !== "object" || parsed === null || parsed.jsonrpc !== "2.0") {
    throw new Error(`Adapter stdout contained non-JSON-RPC content: ${trimmed}`);
  }
}

function withTimeout(promise, label, onTimeout) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout();
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}