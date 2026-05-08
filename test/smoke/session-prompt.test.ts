import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nodeTest from "node:test";

const repoRoot = join(import.meta.dirname, "../..");
const fixturePath = join(repoRoot, "src/testing/script-rpc-process.ts");
const subprocessArgs = ["--import", "tsx", "src/index.ts"];

let previousSmokeTest: Promise<unknown> = Promise.resolve();

function serialSmokeTest(name: string, run: () => Promise<void>) {
  nodeTest(name, async () => {
    const current = previousSmokeTest.then(run);
    previousSmokeTest = current.catch(() => undefined);
    await current;
  });
}

type JsonRpcObject = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type RunningAcp = {
  child: ChildProcessWithoutNullStreams;
  stderr: string;
  messages: JsonRpcObject[];
  send(request: string | Record<string, unknown>): void;
  nextMessage(): Promise<JsonRpcObject>;
  nextResponse(id: string | number): Promise<JsonRpcObject>;
  close(): Promise<void>;
};

function startAcpSubprocess(scenario: string, extraEnv: NodeJS.ProcessEnv = {}): RunningAcp {
  const child = spawn(process.execPath, subprocessArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      OMP_ACP_RUNTIME_COMMAND: process.execPath,
      OMP_ACP_RUNTIME_ARGS_JSON: JSON.stringify(["--import", "tsx", fixturePath, scenario]),
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderr = "";
  let protocolError: Error | undefined;
  let childClosed = false;
  const messages: JsonRpcObject[] = [];
  const waiters: Array<{
    resolve: (message: JsonRpcObject) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];

  function rejectAll(error: Error) {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  function rememberProtocolError(error: Error) {
    protocolError ??= error;
    rejectAll(protocolError);
  }

  function parseStdoutMessage(trimmed: string): JsonRpcObject | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      rememberProtocolError(new Error(`stdout contained non-JSON-RPC content: ${trimmed}; parse error: ${String(error)}`));
      return undefined;
    }

    if (typeof parsed !== "object" || parsed === null) {
      rememberProtocolError(new Error(`stdout contained non-object JSON-RPC content: ${trimmed}`));
      return undefined;
    }

    const message = parsed as JsonRpcObject;
    if (message.jsonrpc !== "2.0") {
      rememberProtocolError(new Error(`stdout contained non-JSON-RPC message: ${trimmed}`));
      return undefined;
    }

    return message;
  }

  function enqueueMessage(message: JsonRpcObject) {
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
      return;
    }
    messages.push(message);
  }

  function checkRemainingStdoutBuffer() {
    const trimmed = stdoutBuffer.trim();
    stdoutBuffer = "";
    if (trimmed.length === 0) {
      return;
    }

    const message = parseStdoutMessage(trimmed);
    if (message) {
      enqueueMessage(message);
    }
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      const message = parseStdoutMessage(trimmed);
      if (!message) {
        return;
      }
      enqueueMessage(message);
    }
  });

  child.stdout.once("close", () => {
    checkRemainingStdoutBuffer();
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.once("error", (error) => rejectAll(error));
  child.once("close", (code, signal) => {
    childClosed = true;
    checkRemainingStdoutBuffer();
    if (protocolError) {
      rejectAll(protocolError);
      return;
    }
    rejectAll(new Error(`ACP subprocess closed before response: code=${code} signal=${signal}`));
  });

  function waitForIncomingMessage(): Promise<JsonRpcObject> {
    if (protocolError) {
      return Promise.reject(protocolError);
    }

    return new Promise<JsonRpcObject>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) {
          waiters.splice(index, 1);
        }
        child.kill();
        reject(new Error("Timed out waiting for ACP message"));
      }, 10_000);
      waiters.push({ resolve, reject, timeout });
    });
  }

  return {
    child,
    get stderr() {
      return stderr;
    },
    messages,
    send(request) {
      const line = typeof request === "string" ? request : JSON.stringify(request);
      child.stdin.write(`${line}\n`);
    },
    nextMessage() {
      if (protocolError) {
        return Promise.reject(protocolError);
      }
      const message = messages.shift();
      if (message) {
        return Promise.resolve(message);
      }

      return waitForIncomingMessage();
    },
    async nextResponse(id) {
      while (true) {
        const queuedIndex = messages.findIndex((message) => message.id === id);
        if (queuedIndex >= 0) {
          const message = messages[queuedIndex];
          messages.splice(queuedIndex, 1);
          if (message === undefined) {
            throw new Error(`Missing queued response for id ${String(id)}`);
          }
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
      rejectAll(new Error("ACP subprocess closed by test"));
      if (child.exitCode === null && !child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.end();
      }
      if (!childClosed) {
        const closed = once(child, "close");
        const timeout = new Promise((resolve) => setTimeout(resolve, 1_000, "timeout"));
        if ((await Promise.race([closed, timeout])) === "timeout") {
          child.kill();
          await closed;
        }
      }
      checkRemainingStdoutBuffer();
      if (protocolError) {
        throw protocolError;
      }
    },
  };
}

async function withAcpSubprocess<T>(scenario: string, run: (acp: RunningAcp) => Promise<T>, extraEnv: NodeJS.ProcessEnv = {}): Promise<T> {
  const acp = startAcpSubprocess(scenario, extraEnv);
  try {
    return await run(acp);
  } finally {
    await acp.close();
  }
}

function initializeRequest(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: 1, clientCapabilities: {} },
  };
}

async function initializeAndCreateSession(
  acp: RunningAcp,
  initializeId: number,
  sessionRequestId: number,
  cwd = repoRoot,
): Promise<string> {
  acp.send(initializeRequest(initializeId));
  const initializeResponse = await acp.nextResponse(initializeId);
  assert.equal(initializeResponse.error, undefined);

  acp.send({
    jsonrpc: "2.0",
    id: sessionRequestId,
    method: "session/new",
    params: { cwd, mcpServers: [] },
  });
  const sessionResponse = await acp.nextResponse(sessionRequestId);
  assert.equal(sessionResponse.error, undefined);
  assert.equal(typeof sessionResponse.result, "object");
  assert.notEqual(sessionResponse.result, null);
  return (sessionResponse.result as { sessionId: string }).sessionId;
}

function textFromUpdate(message: JsonRpcObject): string | undefined {
  const update = (message.params as { update?: { content?: { text?: string } } } | undefined)?.update;
  return update?.content?.text;
}

function updateKind(message: JsonRpcObject): string | undefined {
  return (message.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate;
}

function sessionUpdate(message: JsonRpcObject): Record<string, unknown> | undefined {
  return (message.params as { update?: Record<string, unknown> } | undefined)?.update;
}

async function writeSmokeSession(agentDir: string, cwd: string, sessionId: string, lines: unknown[]) {
  const dir = join(agentDir, "sessions", `--${sessionId}--`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

serialSmokeTest("session/prompt unknown session returns explicit not-found error", async () => {
  await withAcpSubprocess("session-happy", async (acp) => {
    acp.send(initializeRequest(34));
    await acp.nextResponse(34);

    acp.send({
      jsonrpc: "2.0",
      id: 35,
      method: "session/prompt",
      params: { sessionId: "session-does-not-exist", prompt: [{ type: "text", text: "hello" }] },
    });
    const promptResponse = await acp.nextResponse(35);

    assert.equal(promptResponse.result, undefined);
    assert.equal(promptResponse.error?.code, -32002);
    assert.match(promptResponse.error?.message ?? "", /not found/i);
  });
});

serialSmokeTest("session/list and session/load use OMP agent dir and keep stdout JSON-RPC only", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-acp-smoke-agent-"));
  const cwd = repoRoot;
  const sessionPath = await writeSmokeSession(agentDir, cwd, "smoke-session", [
    { type: "session", id: "smoke-session", cwd, timestamp: "2026-05-08T01:00:00.000Z", title: "Smoke" },
    { type: "message", role: "user", content: "past question", timestamp: "2026-05-08T01:01:00.000Z" },
    { type: "message", role: "assistant", content: "past answer", timestamp: "2026-05-08T01:02:00.000Z" },
  ]);

  await withAcpSubprocess("session-happy", async (acp) => {
    acp.send(initializeRequest(30));
    await acp.nextResponse(30);

    acp.send({ jsonrpc: "2.0", id: 31, method: "session/list", params: { cwd } });
    const listResponse = await acp.nextResponse(31);
    assert.deepEqual(listResponse.result, {
      sessions: [{ sessionId: "smoke-session", cwd, title: "Smoke", updatedAt: "2026-05-08T01:02:00.000Z", _meta: { ompSessionPath: sessionPath } }],
    });

    acp.send({ jsonrpc: "2.0", id: 32, method: "session/load", params: { sessionId: "smoke-session", cwd, mcpServers: [] } });
    const userUpdate = await acp.nextMessage();
    const assistantUpdate = await acp.nextMessage();
    const loadResponse = await acp.nextResponse(32);
    assert.deepEqual(loadResponse.result, {});
    assert.equal(updateKind(userUpdate), "user_message_chunk");
    assert.equal(textFromUpdate(userUpdate), "past question");
    assert.equal(updateKind(assistantUpdate), "agent_message_chunk");
    assert.equal(textFromUpdate(assistantUpdate), "past answer");

    acp.send({ jsonrpc: "2.0", id: 33, method: "session/prompt", params: { sessionId: "smoke-session", prompt: [{ type: "text", text: "after load" }] } });
    const promptUpdate = await acp.nextMessage();
    const promptResponse = await acp.nextResponse(33);
    assert.equal(updateKind(promptUpdate), "agent_message_chunk");
    assert.equal(textFromUpdate(promptUpdate), "after load");
    assert.deepEqual(promptResponse.result, { stopReason: "end_turn" });
    assert.equal(acp.stderr, "");
  }, { OMP_ACP_AGENT_DIR: agentDir });
});

serialSmokeTest("session/resume switches to an existing OMP session without replay and permits the next prompt", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-acp-smoke-resume-agent-"));
  const cwd = repoRoot;
  await writeSmokeSession(agentDir, cwd, "resume-smoke", [
    { type: "session", id: "resume-smoke", cwd, timestamp: "2026-05-08T01:00:00.000Z", title: "Resume" },
    { type: "message", role: "user", content: "not replayed", timestamp: "2026-05-08T01:01:00.000Z" },
  ]);

  await withAcpSubprocess("session-happy", async (acp) => {
    acp.send(initializeRequest(37));
    await acp.nextResponse(37);

    acp.send({ jsonrpc: "2.0", id: 38, method: "session/resume", params: { sessionId: "resume-smoke", cwd, mcpServers: [] } });
    const resumeResponse = await acp.nextResponse(38);
    assert.deepEqual(resumeResponse.result, {});
    assert.equal(acp.messages.some((message) => message.method === "session/update"), false);

    acp.send({ jsonrpc: "2.0", id: 39, method: "session/prompt", params: { sessionId: "resume-smoke", prompt: [{ type: "text", text: "after resume" }] } });
    const promptUpdate = await acp.nextMessage();
    const promptResponse = await acp.nextResponse(39);
    assert.equal(updateKind(promptUpdate), "agent_message_chunk");
    assert.equal(textFromUpdate(promptUpdate), "after resume");
    assert.deepEqual(promptResponse.result, { stopReason: "end_turn" });
    assert.equal(acp.stderr, "");
  }, { OMP_ACP_AGENT_DIR: agentDir });
});

serialSmokeTest("session/prompt forwards image blocks to runtime without adding them to prompt text", async () => {
  await withAcpSubprocess("session-images", async (acp) => {
    const sessionId = await initializeAndCreateSession(acp, 40, 41);

    acp.send({
      jsonrpc: "2.0",
      id: 42,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [
          { type: "text", text: "look" },
          { type: "image", data: "abc", mimeType: "image/png", uri: "file:///image.png" },
        ],
      },
    });

    const update = await acp.nextMessage();
    const response = await acp.nextResponse(42);
    assert.equal(updateKind(update), "agent_message_chunk");
    assert.deepEqual(JSON.parse(textFromUpdate(update) ?? ""), {
      prompt: "look",
      images: [{ type: "image", data: "abc", mimeType: "image/png", uri: "file:///image.png" }],
    });
    assert.deepEqual(response.result, { stopReason: "end_turn" });
    assert.equal(acp.stderr, "");
  });
});

serialSmokeTest("runtime extension_ui_request fails session/prompt without assistant message notification", async () => {
  await withAcpSubprocess("extension-ui-request", async (acp) => {
    const sessionId = await initializeAndCreateSession(acp, 34, 35);

    acp.send({
      jsonrpc: "2.0",
      id: 36,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "show ui" }] },
    });

    const response = await acp.nextResponse(36);

    assert.equal(response.result, undefined);
    assert.match(String(response.error?.data && typeof response.error.data === "object" && "details" in response.error.data ? response.error.data.details : response.error?.message), /extension_ui_request/);
    assert.equal(
      acp.messages.some((message) => message.method === "session/update" && updateKind(message) === "agent_message_chunk"),
      false,
    );
  });
});
serialSmokeTest("session/prompt streams message and thought updates before returning", async () => {
  await withAcpSubprocess("session-happy", async (acp) => {
    const sessionId = await initializeAndCreateSession(acp, 1, 2);
    const expectedPrompt = "hello\n\n[Resource: Design Spec] file:///repo/spec.md\nUse this as context.";

    acp.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [
          { type: "text", text: "hello" },
          {
            type: "resource_link",
            uri: "file:///repo/spec.md",
            name: "spec.md",
            title: "Design Spec",
            description: "Use this as context.",
          },
        ],
      },
    });

    const messageUpdate = await acp.nextMessage();
    const thoughtUpdate = await acp.nextMessage();
    const promptResponse = await acp.nextMessage();

    assert.equal(messageUpdate.method, "session/update");
    assert.equal(updateKind(messageUpdate), "agent_message_chunk");
    assert.equal(textFromUpdate(messageUpdate), expectedPrompt);
    assert.equal(thoughtUpdate.method, "session/update");
    assert.equal(updateKind(thoughtUpdate), "agent_thought_chunk");
    assert.equal(textFromUpdate(thoughtUpdate), "thinking");
    assert.equal(promptResponse.id, 3);
    assert.deepEqual(promptResponse.result, { stopReason: "end_turn" });
    assert.equal(acp.stderr, "");
  });
});

serialSmokeTest("session/new starts runtime in requested cwd", async () => {
  await withAcpSubprocess("session-cwd", async (acp) => {
    const sessionCwd = join(repoRoot, "src");
    const sessionId = await initializeAndCreateSession(acp, 10, 11, sessionCwd);

    acp.send({
      jsonrpc: "2.0",
      id: 12,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "cwd" }] },
    });

    const update = await acp.nextMessage();
    const response = await acp.nextResponse(12);

    assert.equal(update.method, "session/update");
    assert.equal(textFromUpdate(update), sessionCwd);
    assert.deepEqual(response.result, { stopReason: "end_turn" });
  });
});

serialSmokeTest("runtime extension_error fails session/prompt without assistant message notification", async () => {
  await withAcpSubprocess("session-error", async (acp) => {
    const sessionId = await initializeAndCreateSession(acp, 4, 5);

    acp.send({
      jsonrpc: "2.0",
      id: 6,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "fail" }] },
    });

    const response = await acp.nextResponse(6);

    assert.equal(response.result, undefined);
    assert.equal(typeof response.error?.code, "number");
    assert.equal(typeof response.error?.message, "string");
    assert.equal(
      acp.messages.some((message) => message.method === "session/update" && updateKind(message) === "agent_message_chunk"),
      false,
    );
  });
});

serialSmokeTest("session/cancel returns cancelled and suppresses late normal chunks", async () => {
  await withAcpSubprocess("session-cancel", async (acp) => {
    const sessionId = await initializeAndCreateSession(acp, 7, 8);

    acp.send({
      jsonrpc: "2.0",
      id: 9,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "cancel me" }] },
    });
    acp.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });

    const response = await acp.nextResponse(9);
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.deepEqual(response.result, { stopReason: "cancelled" });
    assert.equal(
      acp.messages.some((message) => message.method === "session/update" && textFromUpdate(message) === "late message"),
      false,
    );
  });
});

serialSmokeTest("session/prompt forwards runtime tool execution updates before response", async () => {
  await withAcpSubprocess("session-tool-events", async (acp) => {
    const sessionId = await initializeAndCreateSession(acp, 20, 21);

    acp.send({
      jsonrpc: "2.0",
      id: 22,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "use tool" }] },
    });

    const start = await acp.nextMessage();
    const textUpdate = await acp.nextMessage();
    const diffUpdate = await acp.nextMessage();
    const endUpdate = await acp.nextMessage();
    const response = await acp.nextMessage();

    assert.equal(start.method, "session/update");
    assert.deepEqual(sessionUpdate(start), {
      sessionUpdate: "tool_call",
      toolCallId: "tool_smoke_1",
      title: "Read config",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "config.json" },
      locations: [{ path: "config.json", line: 3 }],
    });
    assert.equal(updateKind(textUpdate), "tool_call_update");
    assert.deepEqual(sessionUpdate(textUpdate)?.content, [{ type: "content", content: { type: "text", text: "reading config" } }]);
    assert.equal(updateKind(diffUpdate), "tool_call_update");
    assert.deepEqual(sessionUpdate(diffUpdate)?.content, [
      { type: "diff", path: "config.json", oldText: "old", newText: "new" },
    ]);
    assert.deepEqual(sessionUpdate(endUpdate), {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool_smoke_1",
      status: "completed",
      rawOutput: "done",
      content: [{ type: "content", content: { type: "text", text: "done" } }],
    });
    assert.equal(response.id, 22);
    assert.deepEqual(response.result, { stopReason: "end_turn" });
    assert.equal(acp.stderr, "");
  });
});

serialSmokeTest("session/prompt sends raw host tool result for unregistered runtime host tool", async () => {
  await withAcpSubprocess("session-host-tool-unregistered", async (acp) => {
    const sessionId = await initializeAndCreateSession(acp, 23, 24);

    acp.send({
      jsonrpc: "2.0",
      id: 25,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "host tool" }] },
    });

    const pending = await acp.nextMessage();
    const failed = await acp.nextMessage();
    const response = await acp.nextMessage();

    assert.deepEqual(sessionUpdate(pending), {
      sessionUpdate: "tool_call",
      toolCallId: "host_tool_smoke_1",
      title: "missing_tool",
      kind: "other",
      status: "pending",
      rawInput: { value: 1 },
    });
    assert.deepEqual(sessionUpdate(failed), {
      sessionUpdate: "tool_call_update",
      toolCallId: "host_tool_smoke_1",
      status: "failed",
      rawOutput: { error: "Unsupported host tool: missing_tool" },
    });
    assert.equal(response.id, 25);
    assert.deepEqual(response.result, { stopReason: "end_turn" });
    assert.equal(acp.stderr, "");
  });
});

serialSmokeTest("invalid runtime args env fails on stderr without stdout", async () => {
  const child = spawn(process.execPath, subprocessArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      OMP_ACP_RUNTIME_COMMAND: process.execPath,
      OMP_ACP_RUNTIME_ARGS_JSON: JSON.stringify(["--import", 3, fixturePath]),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const [code] = (await once(child, "close")) as [number | null];

  assert.notEqual(code, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /OMP_ACP_RUNTIME_ARGS_JSON/);
});
