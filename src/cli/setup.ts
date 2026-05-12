import { readFileSync } from "node:fs";
import { buildOmpRpcCommand } from "../runtime/omp/command.ts";
import { startOmpRpcClient } from "../runtime/omp/rpc-client.ts";

export type SetupRuntime = {
  readonly ready: Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
};

export type SetupCliIO = {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
};

export type SetupRuntimeOptions = {
  command: string;
  args: string[];
  cwd: string;
  readyTimeoutMs?: number;
};

export type SetupCliOptions = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  io: SetupCliIO;
  startRuntime?: (options: SetupRuntimeOptions) => SetupRuntime;
  readyTimeoutMs?: number;
};

const DEFAULT_READY_TIMEOUT_MS = 10_000;

export async function runSetupCli(options: SetupCliOptions): Promise<number> {
  options.io.stdout.write("Oh My Pi setup for omp-acp\n\n");
  options.io.stdout.write("Checking that the Oh My Pi runtime can start and expose available models.\n");

  const executable = options.env.OMP_ACP_RUNTIME_COMMAND?.trim() || "omp";
  const command = buildOmpRpcCommand({ executable });
  const readyTimeoutMs = options.readyTimeoutMs ?? readReadyTimeoutMs(options.env);
  const runtimeOptions: SetupRuntimeOptions = {
    command: command.command,
    args: command.args,
    cwd: options.cwd,
    ...(readyTimeoutMs !== undefined ? { readyTimeoutMs } : {}),
  };

  let runtime: SetupRuntime | undefined;
  try {
    runtime = (options.startRuntime ?? startOmpRpcClient)(runtimeOptions);
    await runtime.ready;
    await runtime.request("get_state");
    const models = normalizeModels(await runtime.request("get_available_models"));

    if (models.length === 0) {
      writeNoModels(options.io.stdout);
      return 2;
    }

    options.io.stdout.write("OMP RPC is reachable.\n");
    options.io.stdout.write(`${models.length} models available.\n`);
    options.io.stdout.write("Restart or reload your ACP client after setup.\n");
    return 0;
  } catch {
    options.io.stderr.write("Could not start OMP for setup.\n");
    options.io.stderr.write("Ensure omp is on PATH or set OMP_ACP_RUNTIME_COMMAND to the Oh My Pi executable.\n");
    return 1;
  } finally {
    if (runtime !== undefined) {
      await runtime.close().catch(() => undefined);
    }
  }
}

export function writeHelp(stdout: { write(chunk: string): unknown }): void {
  stdout.write(`Usage: omp-acp [--setup | --help | --version]\n\n`);
  stdout.write("Run without arguments to start the ACP stdio server.\n");
  stdout.write("\nOptions:\n");
  stdout.write("  --setup       Check and guide Oh My Pi credential/model setup.\n");
  stdout.write("  --help, -h    Show this help text.\n");
  stdout.write("  --version, -v Show the omp-acp version.\n");
}

export function writeVersion(stdout: { write(chunk: string): unknown }): void {
  stdout.write(`${readPackageVersion()}\n`);
}

function writeNoModels(stdout: { write(chunk: string): unknown }): void {
  stdout.write("No available OMP models were found.\n");
  stdout.write("Configure Oh My Pi credentials and models, then run this check again.\n");
  stdout.write("Common provider environment variable names: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY.\n");
  stdout.write("You can also create or edit ~/.omp/agent/models.yml for Oh My Pi model configuration.\n");
}

function normalizeModels(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (isRecord(value) && Array.isArray(value.models)) {
    return value.models;
  }

  return [];
}


function readReadyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OMP_ACP_SETUP_READY_TIMEOUT_MS;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_READY_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_READY_TIMEOUT_MS;
  }

  return parsed;
}
function readPackageVersion(): string {
  for (const url of [new URL("../../package.json", import.meta.url), new URL("../package.json", import.meta.url)]) {
    try {
      const packageJson = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
      if (typeof packageJson.version === "string" && packageJson.version.length > 0) {
        return packageJson.version;
      }
    } catch {
      // Try the next package.json location. Source execution and bundled execution use different depths.
    }
  }

  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
