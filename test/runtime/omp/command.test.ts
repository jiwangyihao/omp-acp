import assert from "node:assert/strict";
import test from "node:test";

import { buildOmpRpcCommand } from "../../../src/runtime/omp/command.ts";

test("buildOmpRpcCommand launches omp in rpc mode by default", () => {
  assert.deepEqual(buildOmpRpcCommand(), {
    command: "omp",
    args: ["--mode", "rpc"],
  });
});

test("buildOmpRpcCommand respects an explicit executable and appends extra args", () => {
  assert.deepEqual(
    buildOmpRpcCommand({ executable: "C:/tools/omp.cmd", extraArgs: ["--debug"] }),
    {
      command: "C:/tools/omp.cmd",
      args: ["--mode", "rpc", "--debug"],
    },
  );
});