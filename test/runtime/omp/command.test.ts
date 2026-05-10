import assert from "node:assert/strict";
import test from "node:test";

import { buildOmpRpcCommand, resolveOmpRpcCommandFromEnv } from "../../../src/runtime/omp/command.ts";

test("buildOmpRpcCommand launches OMP RPC without a static tool allowlist", () => {
  const command = buildOmpRpcCommand();

  assert.equal(command.command, "omp");
  assert.equal(command.args[0], "--mode");
  assert.equal(command.args[1], "rpc");
  assert.equal(command.args.includes("--tools"), false);
});

test("buildOmpRpcCommand respects an explicit executable and appends extra args", () => {
  const command = buildOmpRpcCommand({ executable: "C:/tools/omp.cmd", extraArgs: ["--debug"] });

  assert.equal(command.command, "C:/tools/omp.cmd");
  assert.equal(command.args[0], "--mode");
  assert.equal(command.args[1], "rpc");
  assert.equal(command.args.includes("--tools"), false);
  assert.equal(command.args.at(-1), "--debug");
});

test("buildOmpRpcCommand injects an ACP extension instead of a static tool allowlist", () => {
  const command = buildOmpRpcCommand({ extraArgs: ["--debug"] });

  assert.equal(command.args.includes("--tools"), false);
  const extensionIndex = command.args.indexOf("--extension");
  assert.notEqual(extensionIndex, -1);
  const extensionPath = command.args[extensionIndex + 1];
  assert.equal(typeof extensionPath, "string");
  assert.match(extensionPath!, /disable-ask-extension\.mjs$/);
  assert.equal(command.args.at(-1), "--debug");
});

test("resolveOmpRpcCommandFromEnv uses default RPC args when only executable is overridden", () => {
  const command = resolveOmpRpcCommandFromEnv({ OMP_ACP_RUNTIME_COMMAND: "C:/tools/omp.exe" });

  assert.notEqual(command, undefined);
  assert.equal(command?.command, "C:/tools/omp.exe");
  assert.equal(command?.args[0], "--mode");
  assert.equal(command?.args[1], "rpc");
  assert.equal(command?.args.includes("--tools"), false);
  const extensionIndex = command?.args.indexOf("--extension") ?? -1;
  assert.notEqual(extensionIndex, -1);
  assert.match(command?.args[extensionIndex + 1] ?? "", /disable-ask-extension\.mjs$/);
});

test("resolveOmpRpcCommandFromEnv uses explicit args as a complete runtime override", () => {
  const command = resolveOmpRpcCommandFromEnv({
    OMP_ACP_RUNTIME_COMMAND: "node",
    OMP_ACP_RUNTIME_ARGS_JSON: JSON.stringify(["--import", "tsx", "fixture.ts"]),
  });

  assert.deepEqual(command, { command: "node", args: ["--import", "tsx", "fixture.ts"] });
});

test("resolveOmpRpcCommandFromEnv can override args while keeping the default executable", () => {
  const command = resolveOmpRpcCommandFromEnv({
    OMP_ACP_RUNTIME_ARGS_JSON: JSON.stringify(["--mode", "rpc", "--debug"]),
  });

  assert.deepEqual(command, { command: "omp", args: ["--mode", "rpc", "--debug"] });
});

test("resolveOmpRpcCommandFromEnv returns undefined when no runtime env override is set", () => {
  assert.equal(resolveOmpRpcCommandFromEnv({}), undefined);
});

test("resolveOmpRpcCommandFromEnv rejects invalid args JSON", () => {
  assert.throws(
    () => resolveOmpRpcCommandFromEnv({ OMP_ACP_RUNTIME_ARGS_JSON: JSON.stringify(["--mode", 3]) }),
    /OMP_ACP_RUNTIME_ARGS_JSON must be a JSON array of strings/,
  );
});