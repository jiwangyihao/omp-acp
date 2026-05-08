import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";

const repoRoot = join(import.meta.dirname, "../..");
const fixturePath = "src/testing/script-rpc-process.ts";
const subprocessArgs = ["--import", "tsx", "src/index.ts"];

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

function startAcpSubprocess(scenario: string): RunningAcp {
  const child = spawn(process.execPath, subprocessArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      OMP_ACP_RUNTIME_COMMAND: process.execPath,
      OMP_ACP_RUNTIME_ARGS_JSON: JSON.stringify(["--import", "tsx", fixturePath, scenario]),
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

        const message = await this.nextMessage();
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

async function withAcpSubprocess<T>(scenario: string, run: (acp: RunningAcp) => Promise<T>): Promise<T> {
  const acp = startAcpSubprocess(scenario);
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

async function initializeAndCreateSession(acp: RunningAcp, initializeId: number, sessionId: number): Promise<string> {
  acp.send(initializeRequest(initializeId));
  const initializeResponse = await acp.nextResponse(initializeId);
  assert.equal(initializeResponse.error, undefined);

  acp.send({
    jsonrpc: "2.0",
    id: sessionId,
    method: "session/new",
    params: { cwd: repoRoot, mcpServers: [] },
  });
  const sessionResponse = await acp.nextResponse(sessionId);
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

test("session/prompt streams message and thought updates before returning", async () => {
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

test("runtime extension_error fails session/prompt without assistant message notification", async () => {
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

test("session/cancel returns cancelled and suppresses late normal chunks", async () => {
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

test("invalid runtime args env fails on stderr without stdout", async () => {
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
