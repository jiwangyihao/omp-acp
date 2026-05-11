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

async function runSubprocess(args: readonly string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [...subprocessArgs, ...args], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
  return { code, signal, stdout, stderr };
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

test("initialize returns implemented capabilities over stdio", async () => {
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
        sessionCapabilities?: { list?: unknown; resume?: unknown; fork?: unknown };
      };
    };

    assert.equal(result.protocolVersion, 1);
    assert.equal(result.agentInfo?.name, "omp-acp");
    assert.equal(result.agentCapabilities?.loadSession, true);
    assert.equal(result.agentCapabilities?.mcpCapabilities?.http, false);
    assert.equal(result.agentCapabilities?.mcpCapabilities?.sse, false);
    assert.equal(result.agentCapabilities?.promptCapabilities?.image, true);
    assert.equal(result.agentCapabilities?.promptCapabilities?.audio, false);
    assert.equal(result.agentCapabilities?.promptCapabilities?.embeddedContext, true);
    assert.equal(typeof result.agentCapabilities?.sessionCapabilities?.list, "object");
    assert.equal(typeof result.agentCapabilities?.sessionCapabilities?.resume, "object");
    assert.equal(typeof result.agentCapabilities?.sessionCapabilities?.fork, "object");
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

test("authenticate accepts setup method and rejects unknown methods over stdio", async () => {
  await withAcpSubprocess(async (acp) => {
    acp.send({
      jsonrpc: "2.0",
      id: 5,
      method: "authenticate",
      params: { methodId: "omp-setup" },
    });

    const setupResponse = await acp.nextResponse();

    assert.equal(setupResponse.id, 5);
    assert.deepEqual(setupResponse.result, {});
    assert.equal(setupResponse.error, undefined);

    acp.send({
      jsonrpc: "2.0",
      id: 6,
      method: "authenticate",
      params: { methodId: "unknown" },
    });

    const unknownResponse = await acp.nextResponse();

    assert.equal(unknownResponse.id, 6);
    assert.equal(unknownResponse.result, undefined);
    assert.equal(typeof unknownResponse.error?.code, "number");
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

test("Registry-style initialize advertises terminal setup auth over stdio", async () => {
  await withAcpSubprocess(async (acp) => {
    acp.send({
      jsonrpc: "2.0",
      id: 7,
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

    const response = await acp.nextResponse();

    assert.equal(response.id, 7);
    assert.equal(response.error, undefined);
    assert.equal(typeof response.result, "object");
    assert.notEqual(response.result, null);

    const result = response.result as {
      authMethods?: Array<{ id?: string; type?: string; args?: string[] }>;
    };
    assert.equal(result.authMethods?.[0]?.id, "omp-setup");
    assert.equal(result.authMethods?.[0]?.type, "terminal");
    assert.deepEqual(result.authMethods?.[0]?.args, ["--setup"]);
    assert.equal(acp.stderr, "");
  });
});

test("help and version exit without starting the ACP stdio server", async () => {
  const help = await runSubprocess(["--help"]);

  assert.equal(help.code, 0);
  assert.equal(help.signal, null);
  assert.match(help.stdout, /Usage: omp-acp/);
  assert.equal(help.stderr, "");
  assert.throws(() => JSON.parse(help.stdout));

  const version = await runSubprocess(["--version"]);

  assert.equal(version.code, 0);
  assert.equal(version.signal, null);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
  assert.equal(version.stderr, "");
  assert.throws(() => JSON.parse(version.stdout));
});