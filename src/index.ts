import { Readable, Writable } from "node:stream";
import { startAcpServer } from "./acp/server.ts";
import { createStdioAcpStream } from "./acp/transport/stdio.ts";
import { startOmpRpcClient } from "./runtime/omp/rpc-client.ts";
import type { RuntimeFactory } from "./session/manager.ts";

const stdoutWritable = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const stdinReadable = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

const runtimeFactory = createRuntimeFactoryFromEnv(process.env);

const stream = createStdioAcpStream(stdoutWritable, stdinReadable);
const connection = startAcpServer({
  stream,
  ...(runtimeFactory !== undefined ? { runtimeFactory } : {}),
});

await connection.closed;

function createRuntimeFactoryFromEnv(env: NodeJS.ProcessEnv): RuntimeFactory | undefined {
  const command = env.OMP_ACP_RUNTIME_COMMAND;
  if (command === undefined || command.length === 0) {
    return undefined;
  }

  const args = parseRuntimeArgsEnv(env.OMP_ACP_RUNTIME_ARGS_JSON);
  return () => startOmpRpcClient({ command, args });
}

function parseRuntimeArgsEnv(value: string | undefined): string[] {
  if (value === undefined || value.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error("OMP_ACP_RUNTIME_ARGS_JSON must be a JSON array of strings", { cause });
  }

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("OMP_ACP_RUNTIME_ARGS_JSON must be a JSON array of strings");
  }

  return parsed;
}