import assert from "node:assert/strict";
import { test } from "node:test";

import { discoverTestFiles } from "../../scripts/run-tests.mjs";

test("discoverTestFiles includes TypeScript and mjs tests", async () => {
  const files = await discoverTestFiles(new URL("../..", import.meta.url));

  assert.ok(files.some((file) => file.endsWith("test/unit/translate/tools.test.ts")));
  assert.ok(files.some((file) => file.endsWith("test/smoke/omp-rpc-controls-smoke.test.mjs")));
});