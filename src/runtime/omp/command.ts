export type OmpRpcCommand = {
  command: string;
  args: string[];
};

export type OmpRpcCommandOptions = {
  executable?: string;
  extraArgs?: readonly string[];
};

export function buildOmpRpcCommand(options: OmpRpcCommandOptions = {}): OmpRpcCommand {
  return {
    command: options.executable?.trim() || "omp",
    args: ["--mode", "rpc", ...(options.extraArgs ?? [])],
  };
}