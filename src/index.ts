#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { parseCliMode } from "./cli/mode.ts";
import { runSetupCli, writeHelp, writeVersion } from "./cli/setup.ts";
import { startAcpServer } from "./acp/server.ts";
import { createStdioAcpStream } from "./acp/transport/stdio.ts";
import { startOmpRpcClient } from "./runtime/omp/rpc-client.ts";
import { buildAdditionalDirectoriesEnv, resolveOmpRpcCommandFromEnv } from "./runtime/omp/command.ts";
import type { RuntimeFactory } from "./session/manager.ts";

process.exitCode = await main();

async function main(): Promise<number> {
  const cliMode = parseCliMode(process.argv.slice(2));

  if (cliMode.kind === "help") {
    writeHelp(process.stdout);
    return 0;
  }

  if (cliMode.kind === "version") {
    writeVersion(process.stdout);
    return 0;
  }

  if (cliMode.kind === "setup") {
    return await runSetupCli({
      env: process.env,
      cwd: process.cwd(),
      io: { stdout: process.stdout, stderr: process.stderr },
    });
  }

  if (cliMode.kind === "error") {
    process.stderr.write(`${cliMode.message}\nRun omp-acp --help for usage.\n`);
    return 2;
  }

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
  return 0;
}

function createRuntimeFactoryFromEnv(env: NodeJS.ProcessEnv): RuntimeFactory | undefined {
  const command = resolveOmpRpcCommandFromEnv(env);
  if (command === undefined) {
    return undefined;
  }

  return (input) => startOmpRpcClient({
    command: command.command,
    args: command.args,
    cwd: input.cwd,
    env: buildAdditionalDirectoriesEnv(input.additionalDirectories),
  });
}