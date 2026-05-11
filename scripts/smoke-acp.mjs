import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const adapterEntry = process.env.OMP_ACP_SMOKE_ENTRY ?? resolve(repoRoot, "dist/index.js");
const fixtureEntry = resolve(repoRoot, "src/testing/script-rpc-process.ts");
const timeoutMs = Number.parseInt(process.env.OMP_ACP_SMOKE_TIMEOUT_MS ?? "10000", 10);

const agentDir = await mkdtemp(resolve(tmpdir(), "omp-acp-smoke-agent-"));
const acp = startAcpSubprocess(agentDir);

try {
  acp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
  const initialize = await acp.nextResponse(1);
  assert.equal(initialize.error, undefined);
  assert.equal(initialize.result?.protocolVersion, 1);
  assert.equal(initialize.result?.agentInfo?.name, "omp-acp");
  assert.equal(initialize.result?.agentCapabilities?.loadSession, true);
  assert.equal(initialize.result?.agentCapabilities?.promptCapabilities?.image, true);
  assert.equal(initialize.result?.agentCapabilities?.promptCapabilities?.audio, false);
  assert.equal(initialize.result?.agentCapabilities?.promptCapabilities?.embeddedContext, true);
  assert.equal(initialize.result?.agentCapabilities?.mcpCapabilities?.http, false);
  assert.equal(initialize.result?.agentCapabilities?.mcpCapabilities?.sse, false);
  assert.equal(typeof initialize.result?.agentCapabilities?.sessionCapabilities?.list, "object");
  assert.equal(typeof initialize.result?.agentCapabilities?.sessionCapabilities?.resume, "object");
  assert.equal(typeof initialize.result?.agentCapabilities?.sessionCapabilities?.fork, "object");
  assert.equal(initialize.result?.agentCapabilities?.sessionCapabilities?.close, undefined);
  assert.equal(initialize.result?.authMethods, undefined);

  acp.send({
    jsonrpc: "2.0",
    id: 10,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        terminal: true,
        fs: { readTextFile: true, writeTextFile: true },
        _meta: { "terminal-auth": true },
      },
    },
  });
  const registryInitialize = await acp.nextResponse(10);
  assert.equal(registryInitialize.error, undefined);
  assert.equal(registryInitialize.result?.authMethods?.[0]?.type, "terminal");
  assert.equal(registryInitialize.result?.authMethods?.[0]?.id, "omp-setup");
  assert.deepEqual(registryInitialize.result?.authMethods?.[0]?.args, ["--setup"]);

  acp.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: repoRoot, mcpServers: [] } });
  const sessionNew = await acp.nextResponse(2);
  assert.equal(sessionNew.error, undefined);
  assert.equal(typeof sessionNew.result?.sessionId, "string");
  assertSetupState(sessionNew.result);
  const sessionId = sessionNew.result.sessionId;

  acp.send({
    jsonrpc: "2.0",
    id: 30,
    method: "session/set_model",
    params: { sessionId, modelId: "fixture/model-2" },
  });
  const setModel = await acp.nextResponse(30);
  assertSuccessEmptyResult(setModel);
  assertConfigOptionUpdate(await acp.nextMessage(), sessionId, "model", "fixture/model-2");
  await promptAndAssert(acp, 31, sessionId, "after model");

  acp.send({
    jsonrpc: "2.0",
    id: 32,
    method: "session/set_config_option",
    params: { sessionId, configId: "thinking", value: "low" },
  });
  const setConfigOption = await acp.nextResponse(32);
  assert.equal(setConfigOption.error, undefined);
  assertConfigOptionValue(setConfigOption.result?.configOptions, "thinking", "low");
  assertConfigOptionUpdate(await acp.nextMessage(), sessionId, "thinking", "low");
  await promptAndAssert(acp, 33, sessionId, "after thinking");

  acp.send({
    jsonrpc: "2.0",
    id: 34,
    method: "session/set_mode",
    params: { sessionId, modeId: "default" },
  });
  const setMode = await acp.nextResponse(34);
  assertSuccessEmptyResult(setMode);
  assertCurrentModeUpdate(await acp.nextMessage(), sessionId, "default");
  await promptAndAssert(acp, 35, sessionId, "after mode");

  acp.send({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "smoke" }] },
  });
  const update = await acp.nextMessage();
  assert.equal(update.method, "session/update");
  assert.equal(update.params?.sessionId, sessionId);
  assert.equal(update.params?.update?.sessionUpdate, "agent_message_chunk");
  assert.equal(update.params?.update?.content?.text, "smoke");

  const prompt = await acp.nextResponse(3);
  assert.equal(prompt.error, undefined);
  assert.deepEqual(prompt.result, { stopReason: "end_turn" });

  const thoughtUpdate = await acp.nextMessage();
  assert.equal(thoughtUpdate.method, "session/update");
  assert.equal(thoughtUpdate.params?.sessionId, sessionId);
  assert.equal(thoughtUpdate.params?.update?.sessionUpdate, "agent_thought_chunk");

  const sourceSessionId = "raw-fork-source";
  const sourceSessionDir = resolve(agentDir, "sessions", sourceSessionId);
  await mkdir(sourceSessionDir, { recursive: true });
  await writeFile(
    resolve(sourceSessionDir, `${sourceSessionId}.jsonl`),
    `${JSON.stringify({ type: "session", id: sourceSessionId, cwd: repoRoot, timestamp: "2026-05-08T00:00:00.000Z", title: "Raw fork source" })}\n${JSON.stringify({ type: "message", role: "user", content: "before fork", sessionId: sourceSessionId })}\n`,
    "utf8",
  );

  acp.send({ jsonrpc: "2.0", id: 4, method: "session/fork", params: { sessionId: sourceSessionId, cwd: repoRoot, mcpServers: [] } });
  const fork = await acp.nextResponse(4);
  assert.equal(fork.error, undefined);
  assert.equal(typeof fork.result?.sessionId, "string");
  assert.notEqual(fork.result.sessionId, sourceSessionId);

  acp.send({
    jsonrpc: "2.0",
    id: 5,
    method: "session/prompt",
    params: { sessionId: fork.result.sessionId, prompt: [{ type: "text", text: "fork smoke" }] },
  });
  const forkUpdate = await acp.nextMessage();
  assert.equal(forkUpdate.method, "session/update");
  assert.equal(forkUpdate.params?.sessionId, fork.result.sessionId);
  assert.equal(forkUpdate.params?.update?.sessionUpdate, "agent_message_chunk");
  assert.equal(forkUpdate.params?.update?.content?.text, "fork smoke");

  const forkPrompt = await acp.nextResponse(5);
  assert.equal(forkPrompt.error, undefined);
  assert.deepEqual(forkPrompt.result, { stopReason: "end_turn" });

  await acp.close();
  assert.equal(acp.stderr, "");
  console.log(JSON.stringify({
    status: "success",
    adapterEntry,
    sessionConfigOptions: "success",
    sessionSetModel: "success",
    sessionSetConfigOption: "success",
    sessionSetMode: "success",
  }));
} finally {
  await acp.close().catch(() => {});
  await rm(agentDir, { recursive: true, force: true });
}

async function promptAndAssert(acp, id, sessionId, text) {
  acp.send({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text }] },
  });
  const update = await acp.nextMessage();
  assert.equal(update.method, "session/update");
  assert.equal(update.params?.sessionId, sessionId);
  assert.equal(update.params?.update?.sessionUpdate, "agent_message_chunk");
  assert.equal(update.params?.update?.content?.text, text);

  const prompt = await acp.nextResponse(id);
  assert.equal(prompt.error, undefined);
  assert.deepEqual(prompt.result, { stopReason: "end_turn" });

  const thoughtUpdate = await acp.nextMessage();
  assert.equal(thoughtUpdate.method, "session/update");
  assert.equal(thoughtUpdate.params?.sessionId, sessionId);
  assert.equal(thoughtUpdate.params?.update?.sessionUpdate, "agent_thought_chunk");
}

function assertSetupState(result) {
  assert.equal(typeof result?.sessionId, "string");
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

function assertSuccessEmptyResult(response) {
  assert.equal(response.error, undefined);
  assertPlainObject(response.result, "result");
  assert.deepEqual(Object.keys(response.result), []);
}

function assertConfigOptionUpdate(message, sessionId, optionId, currentValue) {
  assert.equal(message.method, "session/update");
  assert.equal(message.params?.sessionId, sessionId);
  assert.equal(message.params?.update?.sessionUpdate, "config_option_update");
  assertConfigOptionValue(message.params?.update?.configOptions, optionId, currentValue);
}

function assertConfigOptionValue(configOptions, optionId, currentValue) {
  assert.ok(Array.isArray(configOptions), "configOptions must be an array");
  const option = configOptions.find((candidate) => candidate?.id === optionId);
  assert.ok(option, `Missing config option ${optionId}`);
  assert.equal(option.currentValue, currentValue);
}

function assertCurrentModeUpdate(message, sessionId, currentModeId) {
  assert.equal(message.method, "session/update");
  assert.equal(message.params?.sessionId, sessionId);
  assert.deepEqual(message.params?.update, { sessionUpdate: "current_mode_update", currentModeId });
}

function startAcpSubprocess(agentDir) {
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
  let stdoutBuffer = "";
  let childClosed = false;
  let protocolError;
  const messages = [];
  const waiters = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        const message = parseJsonRpc(trimmed);
        if (message !== undefined) {
          enqueueMessage(message);
        }
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("close", () => {
    childClosed = true;
    flushStdoutBuffer();
    rejectAll(new Error("ACP subprocess closed before expected response"));
  });
  child.once("error", rejectAll);

  function parseJsonRpc(line) {
    if (protocolError !== undefined) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || parsed.jsonrpc !== "2.0") {
        throw new Error(`stdout contained non-JSON-RPC object: ${line}`);
      }
      return parsed;
    } catch (cause) {
      protocolError = new Error(`stdout contained non-JSON-RPC content: ${line}`, { cause });
      rejectAll(protocolError);
      return undefined;
    }
  }

  function flushStdoutBuffer() {
    const trimmed = stdoutBuffer.trim();
    stdoutBuffer = "";
    if (trimmed.length > 0) {
      const message = parseJsonRpc(trimmed);
      if (message !== undefined) {
        enqueueMessage(message);
      }
    }
  }

  function enqueueMessage(message) {
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
      return;
    }
    messages.push(message);
  }

  function rejectAll(error) {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  function waitForIncomingMessage() {
    if (protocolError !== undefined) {
      return Promise.reject(protocolError);
    }
    return new Promise((resolveMessage, reject) => {
      const timeout = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolveMessage);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        child.kill();
        reject(new Error("Timed out waiting for ACP message"));
      }, timeoutMs);
      waiters.push({ resolve: resolveMessage, reject, timeout });
    });
  }

  return {
    get stderr() {
      return stderr;
    },
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    nextMessage() {
      const queued = messages.shift();
      return queued === undefined ? waitForIncomingMessage() : Promise.resolve(queued);
    },
    async nextResponse(id) {
      while (true) {
        const queuedIndex = messages.findIndex((message) => message.id === id);
        if (queuedIndex >= 0) {
          const [message] = messages.splice(queuedIndex, 1);
          return message;
        }
        const message = await waitForIncomingMessage();
        if (message.id === id) {
          return message;
        }
        messages.push(message);
      }
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