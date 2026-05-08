import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { OmpRpcClient, OmpRpcClientError } from "../../../src/runtime/omp/rpc-client.ts";
import type { RuntimeEvent } from "../../../src/runtime/RuntimeEvents.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixturePath = join(repoRoot, "src", "testing", "script-rpc-process.ts");

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

function waitForEvent(client: OmpRpcClient, predicate: (event: RuntimeEvent) => boolean): Promise<RuntimeEvent> {
  return new Promise((resolve) => {
    const unsubscribe = client.onEvent((event) => {
      if (predicate(event)) {
        unsubscribe();
        resolve(event);
      }
    });
  });
}

test("raw send writes JSONL frame without creating a pending request", async () => {
  await withClient("raw-frame-observer", async (client) => {
    await client.ready;
    const observed = waitForEvent(client, (event) => event.eventType === "raw_frame_observed");

    await client.send({ type: "host_tool_result", id: "host_1", result: { ok: true } });

    assert.deepEqual((await observed).raw, {
      type: "raw_frame_observed",
      frame: { type: "host_tool_result", id: "host_1", result: { ok: true } },
    });
    const state = await client.request("get_state");
    assert.equal((state as { model?: { provider?: string } }).model?.provider, "fixture");
  });
});

test("raw send after close rejects clearly", async () => {
  const client = startFixture("normal");
  await client.ready;
  await client.close();

  await assert.rejects(
    client.send({ type: "host_tool_result", id: "host_closed", result: { ok: true } }),
    (error: unknown) => error instanceof OmpRpcClientError && /not ready|closed/i.test(error.message),
  );
});