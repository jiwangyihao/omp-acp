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

function waitForRawObservedFrame(client: OmpRpcClient): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for raw_frame_observed event"));
    }, 1_000);
    const unsubscribe = client.onEvent((event) => {
      if (event.eventType === "raw_frame_observed") {
        clearTimeout(timeout);
        unsubscribe();
        const frame = event.raw.frame;
        if (typeof frame === "object" && frame !== null && !Array.isArray(frame)) {
          resolve(frame as Record<string, unknown>);
          return;
        }
        reject(new Error("raw_frame_observed event did not include a frame object"));
      }
    });
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
    await assert.rejects(client.request("get_state"), /not ready/i);
    await client.ready;
  });
});

test("request resolves matching response", async () => {
  await withClient("normal", async (client) => {
    await client.ready;

    const result = await client.request("switch_session", { sessionPath: "sessions/one" });

    assert.deepEqual(result, { ok: true, sessionPath: "sessions/one" });
  });
});

test("request serializes real OMP command frames without legacy method or params fields", async () => {
  await withClient("raw-frame-observer", async (client) => {
    await client.ready;

    const cases: Array<{
      method: string;
      params?: unknown;
      expected: Record<string, unknown>;
    }> = [
      {
        method: "prompt",
        params: { message: "hello", images: [{ type: "path", path: "a.png" }] },
        expected: { type: "prompt", message: "hello", images: [{ type: "path", path: "a.png" }] },
      },
      {
        method: "switch_session",
        params: { sessionPath: "sessions/one" },
        expected: { type: "switch_session", sessionPath: "sessions/one" },
      },
      { method: "get_state", expected: { type: "get_state" } },
      { method: "get_available_models", expected: { type: "get_available_models" } },
      {
        method: "set_model",
        params: { provider: "p", modelId: "m" },
        expected: { type: "set_model", provider: "p", modelId: "m" },
      },
      {
        method: "set_thinking_level",
        params: { level: "low" },
        expected: { type: "set_thinking_level", level: "low" },
      },
      {
        method: "set_steering_mode",
        params: { mode: "off" },
        expected: { type: "set_steering_mode", mode: "off" },
      },
      {
        method: "set_follow_up_mode",
        params: { mode: "auto" },
        expected: { type: "set_follow_up_mode", mode: "auto" },
      },
      {
        method: "set_interrupt_mode",
        params: { mode: "immediate" },
        expected: { type: "set_interrupt_mode", mode: "immediate" },
      },
      {
        method: "set_auto_compaction",
        params: { enabled: false },
        expected: { type: "set_auto_compaction", enabled: false },
      },
    ];

    for (const { method, params, expected } of cases) {
      const observed = waitForRawObservedFrame(client);
      await client.request(method, params);
      const frame = await observed;

      assert.equal(typeof frame.id === "number" || typeof frame.id === "string", true);
      assert.equal(Object.hasOwn(frame, "method"), false);
      assert.equal(Object.hasOwn(frame, "params"), false);
      assert.deepEqual(omitId(frame), expected);
    }
  });
});

test("prompt request rejects legacy prompt params before writing to OMP", async () => {
  await withClient("raw-frame-observer", async (client) => {
    await client.ready;

    await assert.rejects(client.request("prompt", { sessionId: "session-1", prompt: "legacy" }), (error: unknown) => {
      assert.ok(error instanceof OmpRpcClientError);
      assert.match(error.message, /params\.message must be a string/);
      return true;
    });
  });
});

test("request rejects unsupported OMP RPC methods", async () => {
  await withClient("raw-frame-observer", async (client) => {
    await client.ready;

    await assert.rejects(client.request("unknown_command", { value: 1 }), (error: unknown) => {
      assert.ok(error instanceof OmpRpcClientError);
      assert.match(error.message, /Unsupported OMP RPC method: unknown_command/);
      return true;
    });
  });
});

test("successful real responses resolve data or undefined", async () => {
  await withClient("normal", async (client) => {
    await client.ready;

    assert.deepEqual(await client.request("switch_session", { sessionPath: "sessions/two" }), { ok: true, sessionPath: "sessions/two" });
    assertControlState(await client.request("get_state"));
  });
});

test("concurrent requests resolve by exact response id when responses are out of order", async () => {
  await withClient("normal", async (client) => {
    await client.ready;

    const slow = client.request("set_steering_mode", { mode: "slow" });
    const fast = client.request("set_follow_up_mode", { mode: "fast" });

    const [slowResult, fastResult] = await Promise.all([slow, fast]);

    assert.deepEqual(slowResult, { mode: "slow" });
    assert.deepEqual(fastResult, { mode: "fast" });
  });
});

test("events can interleave before response", async () => {
  await withClient("event-before-response", async (client) => {
    await client.ready;
    const order: string[] = [];
    client.onEvent((event) => order.push(`event:${event.eventType}`));

    const response = client.request("get_state").then((result) => {
      order.push("response");
      return result;
    });

    const result = await response;

    assertControlState(result);
    assert.deepEqual(order, ["event:message_update", "response"]);
  });
});

test("malformed stdout frame rejects pending request", async () => {
  await withClient("malformed-on-request", async (client) => {
    await client.ready;

    await assert.rejects(client.request("get_state"), (error: unknown) => {
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

    await assert.rejects(client.request("get_state"), OmpRpcClientError);
  });
});

test("stderr is captured in diagnostics", async () => {
  await withClient("stderr", async (client) => {
    await client.ready;
    await waitForDiagnostic(client, "fixture warning");


    const result = await client.request("get_state");

    assertControlState(result);
    assert.match(client.diagnostics.stderr, /fixture warning/);
  });
});

function assertControlState(result: unknown): void {
  assert.equal(typeof result, "object");
  assert.notEqual(result, null);
  assert.equal((result as { model?: { provider?: string } }).model?.provider, "fixture");
  assert.equal((result as { autoCompactionEnabled?: boolean }).autoCompactionEnabled, true);
}

function omitId(frame: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...withoutId } = frame;
  return withoutId;
}

test("response error rejects with OmpRpcResponseError", async () => {
  await withClient("normal", async (client) => {
    await client.ready;

    await assert.rejects(client.request("set_model", { provider: "fail", modelId: "m" }), (error: unknown) => {
      assert.ok(error instanceof OmpRpcResponseError);
      assert.equal(error.command, "set_model");
      assert.equal(error.responseError, "fixture failure");
      return true;
    });
  });
});