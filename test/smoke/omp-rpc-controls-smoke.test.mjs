import assert from "node:assert/strict";
import { test } from "node:test";

import { classifySmokeFailure, startOmpRpc, verifySetActiveToolsRoundTrip } from "../../scripts/smoke-omp-rpc-controls.mjs";

test("required real OMP smoke treats skipped result as failure", () => {
  assert.deepEqual(
    classifySmokeFailure({ skipped: true, reason: "omp not found" }, { requireRealOmp: true }),
    { exitCode: 1, failed: true },
  );
});

test("optional real OMP smoke allows skipped result", () => {
  assert.deepEqual(
    classifySmokeFailure({ skipped: true, reason: "omp not found" }, { requireRealOmp: false }),
    { exitCode: 0, failed: false },
  );
});

test("required real OMP smoke treats skipped set_active_tools verification as failure", () => {
  assert.deepEqual(
    classifySmokeFailure(
      { skipped: false, set_active_tools: { skipped: true, reason: "dumpTools not available" } },
      { requireRealOmp: true },
    ),
    { exitCode: 1, failed: true },
  );
});

test("verifySetActiveToolsRoundTrip skips when dumpTools is unavailable without calling request", async () => {
  const request = async () => {
    throw new Error("request must not be called");
  };

  const result = await verifySetActiveToolsRoundTrip({}, request, async () => ({}));

  assert.equal(result.skipped, true);
  assert.match(result.reason, /dumpTools unavailable/);
});

test("verifySetActiveToolsRoundTrip removes ask, verifies, restores original tools, and verifies restore", async () => {
  const calls = [];
  const rereadStates = [
    { dumpTools: [{ name: "bash" }, { name: "read" }] },
    { dumpTools: [{ name: "ask" }, { name: "bash" }, { name: "read" }] },
  ];

  const result = await verifySetActiveToolsRoundTrip(
    { dumpTools: [{ name: "ask" }, { name: "bash" }, { name: "read" }] },
    async (command, params) => {
      calls.push({ command, params });
      return { ok: true };
    },
    async () => rereadStates.shift(),
  );

  assert.deepEqual(calls, [
    { command: "set_active_tools", params: { toolNames: ["bash", "read"] } },
    { command: "set_active_tools", params: { toolNames: ["ask", "bash", "read"] } },
  ]);
  assert.deepEqual(result, { skipped: false, removedAsk: true, restored: true, activeToolCount: 3 });
});

test("verifySetActiveToolsRoundTrip propagates set_active_tools request failures", async () => {
  await assert.rejects(
    verifySetActiveToolsRoundTrip(
      { dumpTools: [{ name: "ask" }, { name: "bash" }] },
      async () => {
        throw new Error("set_active_tools failed");
      },
      async () => ({ dumpTools: [{ name: "bash" }] }),
    ),
    /set_active_tools failed/,
  );
});

test("startOmpRpc close waits for a non-ready child to exit", async () => {
  const rpc = startOmpRpc({ command: process.execPath, args: ["-e", "process.argv.splice(1); setInterval(() => {}, 1000)"] }, "unused-session-dir");

  await Promise.race([rpc.ready.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 50))]);
  await rpc.close();
});