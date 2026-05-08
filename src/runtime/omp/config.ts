import path from "node:path";

export type OmpConfigSource = ".omp" | ".claude" | ".codex" | ".gemini";
export type OmpConfigScope = "user" | "project";

export type OmpConfigRoot = {
  path: string;
  source: OmpConfigSource;
  scope: OmpConfigScope;
};

export type DiscoverConfigRootsOptions = {
  cwd: string;
  home: string;
};

const SOURCES: OmpConfigSource[] = [".omp", ".claude", ".codex", ".gemini"];

export function discoverConfigRoots(options: DiscoverConfigRootsOptions): OmpConfigRoot[] {
  const userRoots: OmpConfigRoot[] = SOURCES.map((source) => ({
    path: source === ".omp" ? path.join(options.home, source, "agent") : path.join(options.home, source),
    source,
    scope: "user",
  }));
  const projectRoots: OmpConfigRoot[] = SOURCES.map((source) => ({
    path: path.join(options.cwd, source),
    source,
    scope: "project",
  }));

  return [...userRoots, ...projectRoots];
}

export function configSourcePriority(source: OmpConfigSource): number {
  return SOURCES.indexOf(source);
}