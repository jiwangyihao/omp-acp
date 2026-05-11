import assert from "node:assert/strict";
import test from "node:test";
import { runSetupCli } from "../../../src/cli/setup.ts";

function createIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

function createRuntime(models: unknown, options: { readyReject?: Error } = {}) {
  let closed = false;
  return {
    get closed() { return closed; },
    runtime: {
      ready: options.readyReject === undefined ? Promise.resolve() : Promise.reject(options.readyReject),
      request: async (method: string) => {
        if (method === "get_state") return { sessionId: "setup-test" };
        if (method === "get_available_models") return models;
        throw new Error(`unexpected method: ${method}`);
      },
      close: async () => { closed = true; },
    },
  };
}

test("runSetupCli exits 0 when OMP RPC is reachable and models are available", async () => {
  const io = createIo();
  const fixture = createRuntime([{ provider: "fixture", id: "model", name: "Fixture" }]);

  const exitCode = await runSetupCli({
    env: {},
    cwd: process.cwd(),
    io: io.io,
    startRuntime: () => fixture.runtime,
  });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /Oh My Pi setup/);
  assert.match(io.stdout, /models available/i);
  assert.equal(io.stderr, "");
  assert.equal(fixture.closed, true);
});

test("runSetupCli normalizes object model responses", async () => {
  const io = createIo();
  const fixture = createRuntime({ models: [{ provider: "fixture", id: "model", name: "Fixture" }] });

  const exitCode = await runSetupCli({
    env: {},
    cwd: process.cwd(),
    io: io.io,
    startRuntime: () => fixture.runtime,
  });

  assert.equal(exitCode, 0);
  assert.match(io.stdout, /1 models available/i);
  assert.equal(fixture.closed, true);
});

test("runSetupCli exits 2 when no models are available", async () => {
  const io = createIo();
  const fixture = createRuntime([]);

  const exitCode = await runSetupCli({ env: {}, cwd: process.cwd(), io: io.io, startRuntime: () => fixture.runtime });

  assert.equal(exitCode, 2);
  assert.match(io.stdout, /No available OMP models/i);
  assert.match(io.stdout, /ANTHROPIC_API_KEY/);
  assert.match(io.stdout, /OPENAI_API_KEY/);
  assert.match(io.stdout, /GEMINI_API_KEY/);
  assert.equal(fixture.closed, true);
});

test("runSetupCli exits 1 when OMP runtime cannot start", async () => {
  const io = createIo();
  const fixture = createRuntime([], { readyReject: Object.assign(new Error("spawn omp ENOENT"), { code: "ENOENT" }) });

  const exitCode = await runSetupCli({ env: {}, cwd: process.cwd(), io: io.io, startRuntime: () => fixture.runtime });

  assert.equal(exitCode, 1);
  assert.match(io.stderr, /Could not start OMP/);
  assert.match(io.stderr, /OMP_ACP_RUNTIME_COMMAND/);
  assert.equal(fixture.closed, true);
});

test("runSetupCli never prints environment secret values", async () => {
  const io = createIo();
  const fixture = createRuntime([]);

  await runSetupCli({
    env: { ANTHROPIC_API_KEY: "sk-ant-sensitive-value" },
    cwd: process.cwd(),
    io: io.io,
    startRuntime: () => fixture.runtime,
  });

  assert.equal(io.stdout.includes("sk-ant-sensitive-value"), false);
  assert.equal(io.stderr.includes("sk-ant-sensitive-value"), false);
});
