#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await discoverTestFiles(repoRoot);
  if (files.length === 0) {
    console.error("No test files discovered");
    process.exit(1);
  }
  try {
    await runDiscoveredTests(files);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export async function discoverTestFiles(root = repoRoot) {
  const normalizedRoot = root instanceof URL ? fileURLToPath(root) : root;
  const absoluteRoot = resolve(normalizedRoot);
  const testRoot = resolve(absoluteRoot, "test");
  const files = [];
  await walk(testRoot, files);
  return files
    .filter((file) => /\.test\.(ts|mjs)$/.test(file))
    .sort()
    .map((file) => relative(absoluteRoot, file).split(sep).join("/"));
}

async function walk(dir, files) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, files);
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
}

async function runDiscoveredTests(files) {
  const tsFiles = files.filter((file) => file.endsWith(".test.ts"));
  const mjsFiles = files.filter((file) => file.endsWith(".test.mjs"));
  if (tsFiles.length > 0) {
    await run(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...tsFiles]);
  }
  if (mjsFiles.length > 0) {
    await run(process.execPath, ["--test", ...mjsFiles]);
  }
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}`));
      }
    });
  });
}