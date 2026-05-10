#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { startAcpServer } from "./acp/server.ts";
import { createStdioAcpStream } from "./acp/transport/stdio.ts";
import { startOmpRpcClient } from "./runtime/omp/rpc-client.ts";
import { resolveOmpRpcCommandFromEnv } from "./runtime/omp/command.ts";
import type { RuntimeFactory } from "./session/manager.ts";

const stdoutWritable = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const stdinReadable = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

const runtimeFactory = createRuntimeFactoryFromEnv(process.env);

const stream = createStdioAcpStream(stdoutWritable, stdinReadable);
const connection = startAcpServer({
  stream,
  ...(runtimeFactory !== undefined ? { runtimeFactory } : {}),
  ...(process.env.OMP_ACP_AGENT_DIR !== undefined && process.env.OMP_ACP_AGENT_DIR.length > 0 ? { agentDir: process.env.OMP_ACP_AGENT_DIR } : {}),
});

await connection.closed;

function createRuntimeFactoryFromEnv(env: NodeJS.ProcessEnv): RuntimeFactory | undefined {
  const command = resolveOmpRpcCommandFromEnv(env);
  if (command === undefined) {
    return undefined;
  }

  return (input) => startOmpRpcClient({ command: command.command, args: command.args, cwd: input.cwd });
}