import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverConfigRoots } from "../../../../src/runtime/omp/config.ts";

test("discoverConfigRoots returns user roots before project roots with source and scope metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-acp-config-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");

  assert.deepEqual(discoverConfigRoots({ cwd, home }), [
    { path: path.join(home, ".omp", "agent"), source: ".omp", scope: "user" },
    { path: path.join(home, ".claude"), source: ".claude", scope: "user" },
    { path: path.join(home, ".codex"), source: ".codex", scope: "user" },
    { path: path.join(home, ".gemini"), source: ".gemini", scope: "user" },
    { path: path.join(cwd, ".omp"), source: ".omp", scope: "project" },
    { path: path.join(cwd, ".claude"), source: ".claude", scope: "project" },
    { path: path.join(cwd, ".codex"), source: ".codex", scope: "project" },
    { path: path.join(cwd, ".gemini"), source: ".gemini", scope: "project" },
  ]);
});