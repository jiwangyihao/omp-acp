import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";

const repoRoot = join(import.meta.dirname, "../..");
const subprocessArgs = ["--import", "tsx", "src/index.ts"];

type JsonRpcObject = {
  jsonrpc: "2.0";
  id?: string | number | null;
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
  responses: JsonRpcObject[];
  send(request: string | Record<string, unknown>): void;
  nextResponse(): Promise<JsonRpcObject>;
  close(): Promise<void>;
};

function startAcpSubprocess(): RunningAcp {
  const child = spawn(process.execPath, subprocessArgs, {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderr = "";
  let protocolError: Error | undefined;
  let childClosed = false;
  const responses: JsonRpcObject[] = [];
  const waiters: Array<{
    resolve: (response: JsonRpcObject) => void;
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
      rememberProtocolError(
        new Error(
          `stdout contained non-JSON-RPC content: ${trimmed}; parse error: ${String(error)}`,
        ),
      );
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

  function checkRemainingStdoutBuffer() {
    const trimmed = stdoutBuffer.trim();
    stdoutBuffer = "";
    if (trimmed.length === 0) {
      return;
    }

    const message = parseStdoutMessage(trimmed);
    if (message) {
      enqueueResponse(message);
    }
  }

  function enqueueResponse(response: JsonRpcObject) {
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timeout);
      waiter.resolve(response);
      return;
    }
    responses.push(response);
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
      enqueueResponse(message);
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
    responses,
    send(request) {
      const line = typeof request === "string" ? request : JSON.stringify(request);
      child.stdin.write(`${line}\n`);
    },
    nextResponse() {
      if (protocolError) {
        return Promise.reject(protocolError);
      }
      const response = responses.shift();
      if (response) {
        return Promise.resolve(response);
      }

      return new Promise<JsonRpcObject>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          child.kill();
          reject(new Error("Timed out waiting for ACP response"));
        }, 10_000);
        waiters.push({ resolve, reject, timeout });
      });
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
    }
  };
}

async function withAcpSubprocess<T>(run: (acp: RunningAcp) => Promise<T>): Promise<T> {
  const acp = startAcpSubprocess();
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
    params: {
      protocolVersion: 1,
      clientCapabilities: {},
    },
  };
}

test("initialize returns conservative phase 1 capabilities over stdio", async () => {
  await withAcpSubprocess(async (acp) => {
    acp.send(initializeRequest(1));

    const response = await acp.nextResponse();

    assert.equal(response.id, 1);
    assert.equal(response.error, undefined);
    assert.equal(typeof response.result, "object");
    assert.notEqual(response.result, null);

    const result = response.result as {
      protocolVersion?: number;
      agentInfo?: { name?: string };
      agentCapabilities?: {
        loadSession?: boolean;
        mcpCapabilities?: { http?: boolean; sse?: boolean };
        promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
      };
    };

    assert.equal(result.protocolVersion, 1);
    assert.equal(result.agentInfo?.name, "omp-acp");
    assert.equal(result.agentCapabilities?.loadSession, false);
    assert.equal(result.agentCapabilities?.mcpCapabilities?.http, false);
    assert.equal(result.agentCapabilities?.mcpCapabilities?.sse, false);
    assert.equal(result.agentCapabilities?.promptCapabilities?.image, false);
    assert.equal(result.agentCapabilities?.promptCapabilities?.audio, false);
    assert.equal(result.agentCapabilities?.promptCapabilities?.embeddedContext, false);
    assert.equal(acp.stderr, "");
  });
});

test("unknown methods return JSON-RPC method-not-found errors", async () => {
  await withAcpSubprocess(async (acp) => {
    acp.send({ jsonrpc: "2.0", id: 2, method: "unknown/method", params: {} });

    const response = await acp.nextResponse();

    assert.equal(response.id, 2);
    assert.equal(response.result, undefined);
    assert.equal(response.error?.code, -32601);
  });
});

test("session/new returns a JSON-RPC error during phase 1", async () => {
  await withAcpSubprocess(async (acp) => {
    acp.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/new",
      params: { cwd: process.cwd(), mcpServers: [] },
    });

    const response = await acp.nextResponse();

    assert.equal(response.id, 3);
    assert.equal(response.result, undefined);
    assert.equal(typeof response.error?.code, "number");
  });
});

test("session/prompt returns a JSON-RPC error during phase 1", async () => {
  await withAcpSubprocess(async (acp) => {
    acp.send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: { sessionId: "phase1", prompt: [{ type: "text", text: "hello" }] },
    });

    const response = await acp.nextResponse();

    assert.equal(response.id, 4);
    assert.equal(response.result, undefined);
    assert.equal(typeof response.error?.code, "number");
  });
});

test("authenticate returns a JSON-RPC error during phase 1", async () => {
  await withAcpSubprocess(async (acp) => {
    acp.send({
      jsonrpc: "2.0",
      id: 5,
      method: "authenticate",
      params: { methodId: "none" },
    });

    const response = await acp.nextResponse();

    assert.equal(response.id, 5);
    assert.equal(response.result, undefined);
    assert.equal(typeof response.error?.code, "number");
  });
});

test("malformed JSON does not pollute stdout and connection still handles initialize", async () => {
  await withAcpSubprocess(async (acp) => {
    acp.send("{not json");
    acp.send(initializeRequest(6));

    const response = await acp.nextResponse();

    assert.equal(response.id, 6);
    assert.equal(response.error, undefined);
    assert.equal(typeof response.result, "object");
    assert.notEqual(response.result, null);
    assert.equal((response.result as { protocolVersion?: number }).protocolVersion, 1);
  });
});