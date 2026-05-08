import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const adapterEntry = process.env.OMP_ACP_SMOKE_ENTRY ?? resolve(repoRoot, "dist/index.js");
const fixtureEntry = resolve(repoRoot, "src/testing/script-rpc-process.ts");
const timeoutMs = Number.parseInt(process.env.OMP_ACP_SMOKE_TIMEOUT_MS ?? "10000", 10);

const methodProbes = [
  "session/list",
  "session/fork",
  "session/resume",
  "session/stop",
  "session/set_model",
];

const agentDir = await mkdtemp(resolve(tmpdir(), "omp-acp-registry-probe-agent-"));
const acp = startAcpSubprocess(agentDir);

try {
  const resumeSessionId = "registry-resume-session";
  const resumeSessionPath = await writeProbeSession(agentDir, repoRoot, resumeSessionId);

  const initialize = await acp.request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "ACP Registry Protocol Matrix", version: "0.1.0" },
    clientCapabilities: {
      terminal: true,
      fs: { readTextFile: true, writeTextFile: true },
      _meta: { terminal_output: true, "terminal-auth": true },
    },
  });
  assert.equal(initialize.outcome.status, "success");

  const initResult = initialize.message.result;
  const capabilities = extractCapabilities(initResult);
  assert.deepEqual(capabilities, {
    loadSession: true,
    sessionList: true,
    sessionFork: true,
    sessionResume: true,
    sessionStop: false,
    setModel: false,
  });
  assert.deepEqual(authTypes(initResult.authMethods), []);

  const sessionNew = await acp.request("session/new", { cwd: repoRoot, mcpServers: [] });
  assert.equal(sessionNew.outcome.status, "success");
  const sessionId = sessionNew.message.result.sessionId;
  assert.equal(typeof sessionId, "string");

  const probes = {};
  for (const method of methodProbes) {
    probes[method] = await acp.request(method, probeParamsForMethod(method, sessionId, resumeSessionId));
  }

  assert.equal(probes["session/list"].outcome.status, "success");
  assert.equal(probes["session/fork"].outcome.status, "success");
  assert.equal(typeof probes["session/fork"].message.result.sessionId, "string");
  const forkedSessionId = probes["session/fork"].message.result.sessionId;
  assert.equal(typeof forkedSessionId, "string");
  assert.notEqual(forkedSessionId, sessionId);

  const forkPrompt = await acp.request("session/prompt", {
    sessionId: forkedSessionId,
    prompt: [{ type: "text", text: "registry fork prompt" }],
  });
  assert.equal(forkPrompt.outcome.status, "success");
  assert.deepEqual(forkPrompt.message.result, { stopReason: "end_turn" });
  const forkUpdate = await acp.waitForMessage("fork prompt update", (candidate) =>
    candidate.method === "session/update" &&
    candidate.params?.sessionId === forkedSessionId &&
    candidate.params?.update?.sessionUpdate === "agent_message_chunk"
  );
  assert.equal(forkUpdate.params.update.content?.text, "registry fork prompt");
  assert.equal(probes["session/resume"].outcome.status, "success");
  assert.equal(probes["session/stop"].outcome.status, "method_not_found");
  assert.equal(probes["session/set_model"].outcome.status, "method_not_found");

  await acp.close();

  const summary = {
    initialize: initialize.outcome.status,
    authMethods: [],
    sessionNew: sessionNew.outcome.status,
    capabilities,
    resumeSessionPath,
    forkPrompt: forkPrompt.outcome.status,
    probes: Object.fromEntries(
      Object.entries(probes).map(([method, result]) => [method, result.outcome]),
    ),
  };
  console.log(`ACP registry-style probe passed using ${adapterEntry}`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await acp.close().catch(() => {});
  await rm(agentDir, { recursive: true, force: true });
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
  let nextId = 1;
  const messages = [];
  const waiters = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      acceptStdoutLine(line);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("close", () => {
    childClosed = true;
    flushStdoutBuffer();
    rejectAll(new Error("ACP subprocess closed before expected registry probe response"));
  });
  child.once("error", rejectAll);

  function acceptStdoutLine(line) {
    if (protocolError !== undefined) {
      return;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (cause) {
      protocolError = new Error(`Adapter stdout contained non-JSON content: ${trimmed}`, { cause });
      rejectAll(protocolError);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || parsed.jsonrpc !== "2.0") {
      protocolError = new Error(`Adapter stdout contained non-JSON-RPC content: ${trimmed}`);
      rejectAll(protocolError);
      return;
    }
    enqueueMessage(parsed);
  }

  function flushStdoutBuffer() {
    const trimmed = stdoutBuffer.trim();
    stdoutBuffer = "";
    if (trimmed.length > 0) {
      acceptStdoutLine(trimmed);
    }
  }

  function enqueueMessage(message) {
    messages.push(message);
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index];
      const matchIndex = messages.findIndex((candidate) => waiter.matches(candidate));
      if (matchIndex !== -1) {
        const [matched] = messages.splice(matchIndex, 1);
        waiters.splice(index, 1);
        waiter.resolve(matched);
        index -= 1;
      }
    }
  }

  function rejectAll(error) {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter.reject(error);
    }
  }

  function waitFor(matches, label) {
    const existingIndex = messages.findIndex(matches);
    if (existingIndex !== -1) {
      const [existing] = messages.splice(existingIndex, 1);
      return Promise.resolve(existing);
    }
    if (protocolError !== undefined) {
      return Promise.reject(protocolError);
    }
    if (childClosed) {
      return Promise.reject(new Error(`ACP subprocess closed before ${label}`));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        matches,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex !== -1) {
          waiters.splice(waiterIndex, 1);
        }
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  return {
    get stderr() {
      return stderr;
    },
    async request(method, params) {
      const id = nextId;
      nextId += 1;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      const message = await waitFor((candidate) => candidate.id === id, `${method} response`);
      return { message, outcome: classifyResponse(message) };
    },
    async waitForMessage(label, matches) {
      return await waitFor(matches, label);
    },
    async close() {
      if (!childClosed) {
        child.stdin.end();
        child.kill();
        await once(child, "close").catch(() => {});
      }
      flushStdoutBuffer();
      if (protocolError !== undefined) {
        throw protocolError;
      }
    },
  };
}

function classifyResponse(message) {
  if (message.result !== undefined) {
    return { status: "success" };
  }
  const code = message.error?.code;
  if (code === -32601) {
    return { status: "method_not_found", code };
  }
  if (code === -32602) {
    return { status: "invalid_params", code };
  }
  if (code === -32002 || /not found/i.test(String(message.error?.message ?? ""))) {
    return { status: "resource_not_found", code };
  }
  if (code === -32001 || /auth/i.test(String(message.error?.message ?? ""))) {
    return { status: "auth_required", code };
  }
  return { status: "error", code, message: message.error?.message ?? "unknown error" };
}

function capabilityPresent(value) {
  return value !== undefined && value !== null;
}

function extractCapabilities(initializeResult) {
  const agentCapabilities = initializeResult.agentCapabilities ?? {};
  const sessionCapabilities = agentCapabilities.sessionCapabilities ?? {};
  return {
    loadSession: agentCapabilities.loadSession === true,
    sessionList: capabilityPresent(sessionCapabilities.list),
    sessionFork: capabilityPresent(sessionCapabilities.fork),
    sessionResume: capabilityPresent(sessionCapabilities.resume),
    sessionStop: capabilityPresent(sessionCapabilities.stop),
    setModel: capabilityPresent(sessionCapabilities.setModel),
  };
}

function authTypes(authMethodsValue) {
  if (!Array.isArray(authMethodsValue)) {
    return [];
  }
  return authMethodsValue
    .map((method) => method?.type)
    .filter((type) => typeof type === "string");
}

function probeParamsForMethod(method, sessionId, resumeSessionId) {
  switch (method) {
    case "session/list":
      return { cwd: repoRoot };
    case "session/resume":
      return { sessionId: resumeSessionId, cwd: repoRoot, mcpServers: [] };
    case "session/fork":
      return { sessionId: resumeSessionId, cwd: repoRoot, mcpServers: [] };
    case "session/stop":
      return { sessionId };
    case "session/set_model":
      return { sessionId, modelId: "registry-probe-model" };
    default:
      throw new Error(`Unhandled method probe: ${method}`);
  }
}

async function writeProbeSession(baseAgentDir, cwd, sessionId) {
  const sessionDir = join(baseAgentDir, "sessions", sessionId.slice(0, 2));
  await mkdir(sessionDir, { recursive: true });
  const filePath = join(sessionDir, `${sessionId}.jsonl`);
  await writeFile(
    filePath,
    `${JSON.stringify({ type: "session", id: sessionId, cwd, title: "Registry probe session" })}\n`,
    "utf8",
  );
  return filePath;
}