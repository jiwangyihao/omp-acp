import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  OmpRpcClient,
  OmpRpcClientError,
  OmpRpcResponseError,
} from "../../../src/runtime/omp/rpc-client.ts";
import { OmpRpcFrameParseError } from "../../../src/runtime/omp/frames.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixturePath = join(repoRoot, "src", "testing", "script-rpc-process.ts");

async function waitForDiagnostic(client: OmpRpcClient, text: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!client.diagnostics.stderr.includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for stderr diagnostic: ${text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function startFixture(scenario: string): OmpRpcClient {
  return new OmpRpcClient({
    command: process.execPath,
    args: ["--import", "tsx", fixturePath, scenario],
    readyTimeoutMs: 30_000,
  });
}

async function withClient<T>(scenario: string, run: (client: OmpRpcClient) => Promise<T>): Promise<T> {
  const client = startFixture(scenario);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

test("request before ready fails clearly", async () => {
  await withClient("delayed-ready", async (client) => {
    await assert.rejects(client.request("echo"), /not ready/i);
    await client.ready;
  });
});

test("request resolves matching response", async () => {
  await withClient("normal", async (client) => {
    await client.ready;

    const result = await client.request("echo", { value: 1 });

    assert.deepEqual(result, { method: "echo", params: { value: 1 } });
  });
});

test("concurrent requests resolve by exact response id when responses are out of order", async () => {
  await withClient("normal", async (client) => {
    await client.ready;

    const slow = client.request("slowEcho", { value: "slow" });
    const fast = client.request("fastEcho", { value: "fast" });

    const [slowResult, fastResult] = await Promise.all([slow, fast]);

    assert.deepEqual(slowResult, { method: "slowEcho", params: { value: "slow" } });
    assert.deepEqual(fastResult, { method: "fastEcho", params: { value: "fast" } });
  });
});

test("events can interleave before response", async () => {
  await withClient("normal", async (client) => {
    await client.ready;
    const order: string[] = [];
    client.onEvent((event) => order.push(`event:${event.eventType}`));

    const response = client.request("eventThenResponse").then((result) => {
      order.push("response");
      return result;
    });

    const result = await response;

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(order, ["event:message_update", "response"]);
  });
});

test("malformed stdout frame rejects pending request", async () => {
  await withClient("malformed-on-request", async (client) => {
    await client.ready;

    await assert.rejects(client.request("echo"), (error: unknown) => {
      assert.ok(error instanceof OmpRpcClientError);
      assert.match(error.message, /Failed to parse OMP RPC frame/);
      assert.ok(error.cause instanceof OmpRpcFrameParseError);
      assert.match(error.cause.message, /malformed JSON/);
      return true;
    });
  });
});

test("process exit rejects pending request", async () => {
  await withClient("exit-on-request", async (client) => {
    await client.ready;

    await assert.rejects(client.request("echo"), OmpRpcClientError);
  });
});

test("stderr is captured in diagnostics", async () => {
  await withClient("stderr", async (client) => {
    await client.ready;
    await waitForDiagnostic(client, "fixture warning");

    const result = await client.request("echo");

    assert.deepEqual(result, { method: "echo" });
    assert.match(client.diagnostics.stderr, /fixture warning/);
  });
});

test("response error rejects with OmpRpcResponseError", async () => {
  await withClient("normal", async (client) => {
    await client.ready;

    await assert.rejects(
      client.request("fail"),
      (error: unknown) => error instanceof OmpRpcResponseError && error.responseError === "fixture failure",
    );
  });
});