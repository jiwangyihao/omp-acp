import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

import { buildOmpRpcCommand } from "./command.ts";

export type StartOmpRpcProcessOptions = {
  command?: string;
  args?: readonly string[];
  executable?: string;
  extraArgs?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function startOmpRpcProcess(options: StartOmpRpcProcessOptions = {}): ChildProcessWithoutNullStreams {
  const command = options.command === undefined
    ? buildOmpRpcCommand({
      ...(options.executable !== undefined ? { executable: options.executable } : {}),
      ...(options.extraArgs !== undefined ? { extraArgs: options.extraArgs } : {}),
    })
    : { command: options.command, args: [...(options.args ?? [])] };
  const spawnOptions: SpawnOptionsWithoutStdio = {
    env: { ...process.env, ...options.env },
    windowsHide: true,
  };

  if (options.cwd !== undefined) {
    spawnOptions.cwd = options.cwd;
  }

  return spawn(command.command, command.args, {
    ...spawnOptions,
    stdio: ["pipe", "pipe", "pipe"],
  });
}