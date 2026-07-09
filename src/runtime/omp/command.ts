import { fileURLToPath } from "node:url";

export type OmpRpcCommand = {
  command: string;
  args: string[];
};

export type OmpRpcCommandOptions = {
  executable?: string;
  extraArgs?: readonly string[];
};

const DISABLE_ASK_EXTENSION_PATH = fileURLToPath(new URL("./disable-ask-extension.mjs", import.meta.url));
const ADDITIONAL_DIRECTORIES_EXTENSION_PATH = fileURLToPath(new URL("./additional-directories-extension.mjs", import.meta.url));

export const OMP_ACP_ADDITIONAL_DIRS_ENV = "OMP_ACP_ADDITIONAL_DIRS_JSON";

export function buildAdditionalDirectoriesEnv(additionalDirectories: readonly string[]): NodeJS.ProcessEnv {
  if (additionalDirectories.length === 0) {
    return {};
  }
  return { [OMP_ACP_ADDITIONAL_DIRS_ENV]: JSON.stringify(additionalDirectories) };
}

export function buildOmpRpcCommand(options: OmpRpcCommandOptions = {}): OmpRpcCommand {
  return {
    command: options.executable?.trim() || "omp",
    args: [
      "--mode",
      "rpc",
      "--extension",
      DISABLE_ASK_EXTENSION_PATH,
      "--extension",
      ADDITIONAL_DIRECTORIES_EXTENSION_PATH,
      ...(options.extraArgs ?? []),
    ],
  };
}

export function resolveOmpRpcCommandFromEnv(env: NodeJS.ProcessEnv): OmpRpcCommand | undefined {
  const command = env.OMP_ACP_RUNTIME_COMMAND;
  const argsOverride = env.OMP_ACP_RUNTIME_ARGS_JSON;
  if ((command === undefined || command.length === 0) && (argsOverride === undefined || argsOverride.length === 0)) {
    return undefined;
  }

  if (argsOverride !== undefined && argsOverride.length > 0) {
    return {
      command: command?.trim() || "omp",
      args: parseRuntimeArgsEnv(argsOverride),
    };
  }

  return buildOmpRpcCommand(command !== undefined && command.length > 0 ? { executable: command } : {});
}

function parseRuntimeArgsEnv(value: string): string[] {
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