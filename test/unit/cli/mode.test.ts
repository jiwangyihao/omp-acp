import assert from "node:assert/strict";
import test from "node:test";
import { parseCliMode } from "../../../src/cli/mode.ts";

test("parseCliMode defaults to ACP mode", () => {
  assert.deepEqual(parseCliMode([]), { kind: "acp" });
});

test("parseCliMode recognizes setup help and version", () => {
  assert.deepEqual(parseCliMode(["--setup"]), { kind: "setup" });
  assert.deepEqual(parseCliMode(["--help"]), { kind: "help" });
  assert.deepEqual(parseCliMode(["-h"]), { kind: "help" });
  assert.deepEqual(parseCliMode(["--version"]), { kind: "version" });
  assert.deepEqual(parseCliMode(["-v"]), { kind: "version" });
});

test("parseCliMode rejects unknown adapter arguments", () => {
  const mode = parseCliMode(["--model", "opus"]);

  assert.equal(mode.kind, "error");
  assert.match(mode.kind === "error" ? mode.message : "", /Unknown omp-acp argument: --model/);
});
