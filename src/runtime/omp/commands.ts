import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  configSourcePriority,
  discoverConfigRoots,
  type OmpConfigScope,
  type OmpConfigSource,
} from "./config.ts";

export type OmpBuiltinSlashCommand = {
  kind: "builtin";
  name: string;
  supported: false;
};

export type OmpFileSlashCommand = {
  kind: "file";
  name: string;
  path: string;
  source: OmpConfigSource;
  scope: OmpConfigScope;
  supported: false;
};

export type OmpSkillSlashCommand = {
  kind: "skill";
  name: string;
  path: string;
  source: ".omp";
  scope: OmpConfigScope;
  supported: false;
};

export type OmpExtensionSlashCommand = {
  kind: "extension";
  name: string;
  path: string;
  manifestPath: string;
  manifestKey: "omp.extensions" | "pi.extensions";
  supported: false;
};

export type OmpSlashCommand =
  | OmpBuiltinSlashCommand
  | OmpFileSlashCommand
  | OmpSkillSlashCommand
  | OmpExtensionSlashCommand;

export type DiscoverSlashCommandsOptions = {
  cwd: string;
  home: string;
};

const BUILTIN_COMMANDS: OmpBuiltinSlashCommand[] = [{ kind: "builtin", name: "clear", supported: false }];

export async function discoverSlashCommands(options: DiscoverSlashCommandsOptions): Promise<OmpSlashCommand[]> {
  const roots = discoverConfigRoots(options);
  const fileCommands = dedupeFileCommands((await Promise.all(roots.map(readFileCommands))).flat());
  const skillCommands = (await Promise.all(roots.map(readSkillCommands))).flat();
  const extensionCommands = (await Promise.all(roots.map(readExtensionCommands))).flat();

  return [...BUILTIN_COMMANDS, ...fileCommands, ...skillCommands, ...extensionCommands];
}

async function readFileCommands(root: ReturnType<typeof discoverConfigRoots>[number]): Promise<OmpFileSlashCommand[]> {
  const commandDir = path.join(root.path, "commands");
  const entries = await sortedDirents(commandDir);
  const commands: OmpFileSlashCommand[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name) !== ".md") {
      continue;
    }
    commands.push({
      kind: "file",
      name: path.basename(entry.name, ".md"),
      path: path.join(commandDir, entry.name),
      source: root.source,
      scope: root.scope,
      supported: false,
    });
  }

  return commands;
}

function dedupeFileCommands(commands: OmpFileSlashCommand[]): OmpFileSlashCommand[] {
  const sorted = [...commands].sort(compareFileCommands);
  const byName = new Map<string, OmpFileSlashCommand>();

  for (const command of sorted) {
    if (!byName.has(command.name)) {
      byName.set(command.name, command);
    }
  }

  return [...byName.values()];
}

function compareFileCommands(left: OmpFileSlashCommand, right: OmpFileSlashCommand): number {
  return (
    configSourcePriority(left.source) - configSourcePriority(right.source) ||
    scopePriority(left.scope) - scopePriority(right.scope) ||
    left.path.localeCompare(right.path)
  );
}

function scopePriority(scope: OmpConfigScope): number {
  return scope === "project" ? 0 : 1;
}

async function readSkillCommands(root: ReturnType<typeof discoverConfigRoots>[number]): Promise<OmpSkillSlashCommand[]> {
  if (root.source !== ".omp") {
    return [];
  }

  const skillsDir = path.join(root.path, "skills");
  const entries = await sortedDirents(skillsDir);
  const commands: OmpSkillSlashCommand[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (await existsFile(skillPath)) {
      commands.push({
        kind: "skill",
        name: entry.name,
        path: skillPath,
        source: ".omp",
        scope: root.scope,
        supported: false,
      });
    }
  }

  return commands;
}

async function readExtensionCommands(root: ReturnType<typeof discoverConfigRoots>[number]): Promise<OmpExtensionSlashCommand[]> {
  const manifestPath = path.join(root.path, "package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) {
      return [];
    }
    throw error;
  }

  const manifestObject = asRecord(manifest);
  const ompExtensions = stringArray(asRecord(manifestObject?.omp)?.extensions);
  const piExtensions = stringArray(asRecord(manifestObject?.pi)?.extensions);
  const manifestKey = ompExtensions === undefined ? (piExtensions === undefined ? undefined : "pi.extensions") : "omp.extensions";
  const extensions = ompExtensions ?? piExtensions;
  if (manifestKey === undefined || extensions === undefined) {
    return [];
  }

  return extensions.map((extensionPath) => {
    const resolvedPath = path.resolve(root.path, extensionPath);
    return {
      kind: "extension",
      name: path.basename(extensionPath),
      path: resolvedPath,
      manifestPath,
      manifestKey,
      supported: false,
    };
  });
}

async function sortedDirents(dirPath: string) {
  try {
    return (await readdir(dirPath, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

async function existsFile(filePath: string): Promise<boolean> {
  try {
    const handle = await readFile(filePath);
    void handle;
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}