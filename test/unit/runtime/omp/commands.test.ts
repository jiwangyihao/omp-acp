import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverSlashCommands } from "../../../../src/runtime/omp/commands.ts";

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

test("discoverSlashCommands deduplicates file commands by source priority before scope", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-acp-commands-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  await writeText(path.join(home, ".claude", "commands", "foo.md"), "user claude foo");
  await writeText(path.join(cwd, ".omp", "commands", "foo.md"), "project omp foo");
  await writeText(path.join(home, ".gemini", "commands", "bar.md"), "user gemini bar");

  const commands = await discoverSlashCommands({ cwd, home });

  assert.deepEqual(commands.filter((command) => command.kind === "builtin"), [
    { kind: "builtin", name: "clear", supported: false },
  ]);
  assert.deepEqual(
    commands.filter((command) => command.kind === "file"),
    [
      {
        kind: "file",
        name: "foo",
        path: path.join(cwd, ".omp", "commands", "foo.md"),
        source: ".omp",
        scope: "project",
        supported: false,
      },
      {
        kind: "file",
        name: "bar",
        path: path.join(home, ".gemini", "commands", "bar.md"),
        source: ".gemini",
        scope: "user",
        supported: false,
      },
    ],
  );
});

test("discoverSlashCommands includes skills as unsupported metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-acp-skills-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  await writeText(path.join(cwd, ".omp", "skills", "review", "SKILL.md"), "# Review");

  const commands = await discoverSlashCommands({ cwd, home });

  assert.deepEqual(commands.filter((command) => command.kind === "skill"), [
    {
      kind: "skill",
      name: "review",
      path: path.join(cwd, ".omp", "skills", "review", "SKILL.md"),
      source: ".omp",
      scope: "project",
      supported: false,
    },
  ]);
});

test("discoverSlashCommands prefers omp extension manifests over pi manifests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-acp-extensions-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const manifestPath = path.join(cwd, ".omp", "package.json");
  await writeText(
    manifestPath,
    JSON.stringify({ omp: { extensions: ["./extensions/one.js"] }, pi: { extensions: ["./legacy.js"] } }),
  );

  const commands = await discoverSlashCommands({ cwd, home });

  assert.deepEqual(commands.filter((command) => command.kind === "extension"), [
    {
      kind: "extension",
      name: "one.js",
      path: path.join(cwd, ".omp", "extensions", "one.js"),
      manifestPath,
      manifestKey: "omp.extensions",
      supported: false,
    },
  ]);
});

test("discoverSlashCommands supports legacy pi extension manifests and ignores non-string arrays", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-acp-legacy-extensions-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const validManifestPath = path.join(home, ".claude", "package.json");
  await writeText(validManifestPath, JSON.stringify({ pi: { extensions: ["legacy.ts"] } }));
  await writeText(path.join(cwd, ".omp", "package.json"), JSON.stringify({ omp: { extensions: ["valid.js", 42] } }));
  await writeText(path.join(cwd, ".codex", "package.json"), JSON.stringify({ pi: { extensions: [false] } }));

  const commands = await discoverSlashCommands({ cwd, home });

  assert.deepEqual(commands.filter((command) => command.kind === "extension"), [
    {
      kind: "extension",
      name: "legacy.ts",
      path: path.join(home, ".claude", "legacy.ts"),
      manifestPath: validManifestPath,
      manifestKey: "pi.extensions",
      supported: false,
    },
  ]);
});