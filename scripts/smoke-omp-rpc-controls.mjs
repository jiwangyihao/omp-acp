import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const timeoutMs = Number.parseInt(process.env.OMP_ACP_SMOKE_TIMEOUT_MS ?? "30000", 10);

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

async function main() {
  const commandSpec = resolveCommandSpec();
  const requireRealOmp = process.argv.includes("--require-real-omp") || process.env.OMP_ACP_REQUIRE_REAL_OMP === "1";
  const sessionDir = await mkdtemp(join(tmpdir(), "omp-acp-rpc-controls-"));
  let rpc;

  try {
    rpc = startOmpRpc(commandSpec, sessionDir);
    await rpc.ready;

    const initialState = await rpc.request("get_state");
    const setActiveTools = await verifySetActiveToolsRoundTrip(
      initialState,
      (command, params) => rpc.request(command, params),
      () => rpc.request("get_state"),
    );
    const modelsResponse = await rpc.request("get_available_models");
    const models = normalizeModels(modelsResponse);
    const selectedModel = selectCurrentModel(initialState, models);
    const thinkingLevel = selectThinkingLevel(selectedModel);

    const thinking = await rpc.request("set_thinking_level", { level: thinkingLevel });
    const steering = await rpc.request("set_steering_mode", { mode: "all" });
    const followUp = await rpc.request("set_follow_up_mode", { mode: "one-at-a-time" });
    const interrupt = await rpc.request("set_interrupt_mode", { mode: "wait" });
    const autoCompaction = await rpc.request("set_auto_compaction", { enabled: false });
    const finalState = await rpc.request("get_state");

    assertStateValue(finalState, "thinkingLevel", thinkingLevel, "set_thinking_level");
    assertStateValue(finalState, "steeringMode", "all", "set_steering_mode");
    assertStateValue(finalState, "followUpMode", "one-at-a-time", "set_follow_up_mode");
    assertStateValue(finalState, "interruptMode", "wait", "set_interrupt_mode");
    assertStateValue(finalState, "autoCompactionEnabled", false, "set_auto_compaction");

    await rpc.close();
    rpc = undefined;

    const result = {
      skipped: false,
      command: commandSpec.command,
      model: summarizeModel(selectedModel),
      setters: {
        set_thinking_level: { success: true, level: thinkingLevel, response: summarizeResponse(thinking) },
        set_steering_mode: { success: true, mode: "all", response: summarizeResponse(steering) },
        set_follow_up_mode: { success: true, mode: "one-at-a-time", response: summarizeResponse(followUp) },
        set_interrupt_mode: { success: true, mode: "wait", response: summarizeResponse(interrupt) },
        set_auto_compaction: { success: true, enabled: false, response: summarizeResponse(autoCompaction) },
      },
      set_active_tools: setActiveTools,
      finalState: summarizeState(finalState),
    };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = classifySmokeFailure(result, { requireRealOmp }).exitCode;
  } catch (error) {
    if (isSpawnNotFound(error)) {
      const result = { skipped: true, reason: "omp not found" };
      console.log(JSON.stringify(result));
      process.exitCode = classifySmokeFailure(result, { requireRealOmp }).exitCode;
    } else {
      console.error(JSON.stringify({
        skipped: false,
        command: error?.command ?? commandSpec.command,
        error: error instanceof Error ? error.message : String(error),
      }, null, 2));
      process.exitCode = 1;
    }
  } finally {
    await rpc?.close().catch(() => {});
    await rm(sessionDir, { recursive: true, force: true });
  }
}

export function classifySmokeFailure(result, { requireRealOmp } = {}) {
  if (result?.skipped === true && requireRealOmp) {
    return { exitCode: 1, failed: true };
  }
  if (result?.set_active_tools?.skipped === true && requireRealOmp) {
    return { exitCode: 1, failed: true };
  }
  if (result?.skipped === true) {
    return { exitCode: 0, failed: false };
  }
  if (result?.success === false) {
    return { exitCode: 1, failed: true };
  }
  return { exitCode: 0, failed: false };
}


function resolveCommandSpec() {
  const configured = process.env.OMP_ACP_OMP_COMMAND;
  if (configured !== undefined && configured.trim().length > 0) {
    const parts = splitCommandLine(configured);
    return { command: parts[0], args: parts.slice(1), fromEnv: true };
  }
  return { command: "omp", args: [], fromEnv: false };
}

export function startOmpRpc(commandSpec, sessionDir) {
  const args = [
    ...commandSpec.args,
    "--mode", "rpc",
    "--session-dir", sessionDir,
    "--no-title",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
  ];
  const child = spawn(commandSpec.command, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let stdoutBuffer = "";
  let nextId = 1;
  let closed = false;
  let spawnError;
  const messages = [];
  const waiters = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      acceptLine(line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("error", (error) => {
    spawnError = error;
    rejectAll(error);
  });
  const closedPromise = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      flushStdoutBuffer();
      if (waiters.length > 0) {
        rejectAll(new Error(`OMP RPC process closed before response (code ${code}, signal ${signal}, stderr ${stderr.trim()})`));
      }
      resolve({ code, signal });
    });
  });

  const ready = waitFor((message) => message.type === "ready", "ready frame");

  function acceptLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (cause) {
      rejectAll(new Error(`OMP RPC stdout contained non-JSON content: ${trimmed}`, { cause }));
      return;
    }
    messages.push(parsed);
    drainWaiters();
  }

  function flushStdoutBuffer() {
    const trimmed = stdoutBuffer.trim();
    stdoutBuffer = "";
    if (trimmed.length > 0) {
      acceptLine(trimmed);
    }
  }

  function drainWaiters() {
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index];
      const matchIndex = messages.findIndex(waiter.matches);
      if (matchIndex === -1) {
        continue;
      }
      const [message] = messages.splice(matchIndex, 1);
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      index -= 1;
    }
  }

  function rejectAll(error) {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  function waitFor(matches, label) {
    const existingIndex = messages.findIndex(matches);
    if (existingIndex !== -1) {
      const [existing] = messages.splice(existingIndex, 1);
      return Promise.resolve(existing);
    }
    if (spawnError !== undefined) {
      return Promise.reject(spawnError);
    }
    if (closed) {
      return Promise.reject(new Error(`OMP RPC process closed before ${label}; stderr ${stderr.trim()}`));
    }
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve, reject, timer: undefined };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) {
          waiters.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for OMP RPC ${label}; stderr ${stderr.trim()}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  return {
    ready,
    async request(command, params = {}) {
      const id = nextId;
      nextId += 1;
      child.stdin.write(`${JSON.stringify({ id, type: command, ...params })}\n`);
      const response = await waitFor((message) => message.id === id, `${command} response`);
      if (response.type !== "response" || response.command !== command) {
        const error = new Error(`Unexpected OMP RPC response for ${command}: ${JSON.stringify(response)}`);
        error.command = command;
        throw error;
      }
      if (response.success !== true) {
        const error = new Error(String(response.error ?? `OMP RPC command failed: ${command}`));
        error.command = command;
        throw error;
      }
      return response.data;
    },
    async close() {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end();
      }
      if (!closed) {
        child.kill();
      }
      await Promise.race([
        closedPromise,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
  };
}

function normalizeModels(value) {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asRecord(value);
  if (Array.isArray(record?.models)) {
    return record.models;
  }
  return value;
}

function selectCurrentModel(state, models) {
  assert.equal(Array.isArray(models), true, "get_available_models must return an array or { models: [...] }");
  const stateModel = asRecord(state)?.model;
  const provider = asRecord(stateModel)?.provider;
  const id = asRecord(stateModel)?.id;
  const match = models.find((model) => {
    const record = asRecord(model);
    return record?.provider === provider && record?.id === id;
  });
  return asRecord(match) ?? asRecord(models[0]) ?? asRecord(stateModel) ?? {};
}

function selectThinkingLevel(model) {
  const supported = supportedThinkingLevels(model);
  if (supported.includes("low")) {
    return "low";
  }
  return supported.find((level) => level !== "off") ?? "off";
}

function supportedThinkingLevels(model) {
  const order = ["minimal", "low", "medium", "high", "xhigh"];
  const thinking = asRecord(model.thinking);
  const min = typeof thinking?.minLevel === "string" ? order.indexOf(thinking.minLevel) : -1;
  const max = typeof thinking?.maxLevel === "string" ? order.indexOf(thinking.maxLevel) : -1;
  if (min === -1 || max === -1 || min > max) {
    return ["off"];
  }
  return ["off", ...order.slice(min, max + 1)];
}

export async function verifySetActiveToolsRoundTrip(initialState, request, rereadState) {
  const originalToolNames = extractDumpToolNames(initialState);
  if (originalToolNames === undefined) {
    return { skipped: true, reason: "dumpTools unavailable" };
  }
  if (!originalToolNames.includes("ask")) {
    return { skipped: true, reason: "active tools do not include ask; skipping to avoid disturbing user tools" };
  }

  const withoutAsk = originalToolNames.filter((name) => name !== "ask");
  await request("set_active_tools", { toolNames: withoutAsk });
  try {
    const removedState = await rereadState();
    const removedToolNames = extractDumpToolNames(removedState);
    assert.notEqual(removedToolNames, undefined, "set_active_tools verification requires dumpTools after removing ask");
    assert.equal(removedToolNames.includes("ask"), false, "set_active_tools did not remove ask");
    for (const toolName of withoutAsk) {
      assert.equal(removedToolNames.includes(toolName), true, `set_active_tools unexpectedly removed ${toolName}`);
    }
  } finally {
    await request("set_active_tools", { toolNames: originalToolNames });
  }

  const restoredState = await rereadState();
  const restoredToolNames = extractDumpToolNames(restoredState);
  assert.notEqual(restoredToolNames, undefined, "set_active_tools verification requires dumpTools after restoring tools");
  assert.deepEqual(new Set(restoredToolNames), new Set(originalToolNames), "set_active_tools did not restore original tools");

  return { skipped: false, removedAsk: true, restored: true, activeToolCount: originalToolNames.length };
}

function extractDumpToolNames(state) {
  const dumpTools = asRecord(state)?.dumpTools;
  if (!Array.isArray(dumpTools)) {
    return undefined;
  }
  const names = [];
  for (const tool of dumpTools) {
    const name = typeof tool === "string" ? tool : asRecord(tool)?.name;
    if (typeof name !== "string" || name.length === 0) {
      return undefined;
    }
    names.push(name);
  }
  return names;
}

function assertStateValue(state, key, expected, command) {
  const record = asRecord(state);
  assert.notEqual(record, undefined, `${command} get_state response must be an object`);
  if (expected === "off") {
    assert.equal(record[key] === "off" || record[key] === undefined || record[key] === null, true, `${command} did not persist off thinking state`);
    return;
  }
  assert.equal(record[key], expected, `${command} did not persist expected state`);
}

function summarizeModel(model) {
  return {
    provider: typeof model.provider === "string" ? model.provider : undefined,
    id: typeof model.id === "string" ? model.id : undefined,
    name: typeof model.name === "string" ? model.name : undefined,
  };
}

function summarizeState(state) {
  const record = asRecord(state) ?? {};
  return {
    model: summarizeModel(asRecord(record.model) ?? {}),
    thinkingLevel: typeof record.thinkingLevel === "string" ? record.thinkingLevel : record.thinkingLevel ?? null,
    steeringMode: typeof record.steeringMode === "string" ? record.steeringMode : undefined,
    followUpMode: typeof record.followUpMode === "string" ? record.followUpMode : undefined,
    interruptMode: typeof record.interruptMode === "string" ? record.interruptMode : undefined,
    autoCompactionEnabled: typeof record.autoCompactionEnabled === "boolean" ? record.autoCompactionEnabled : undefined,
  };
}

function summarizeResponse(response) {
  if (response === undefined || response === null) {
    return response;
  }
  const record = asRecord(response);
  if (record === undefined) {
    return response;
  }
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !/api|key|token|secret|url|config/i.test(key)),
  );
}

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function isSpawnNotFound(error) {
  return error?.code === "ENOENT";
}

function splitCommandLine(value) {
  const parts = [];
  let current = "";
  let quote;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && quote === undefined) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (/\s/.test(char) && quote === undefined) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    parts.push(current);
  }
  if (parts.length === 0) {
    return ["omp"];
  }
  return parts;
}