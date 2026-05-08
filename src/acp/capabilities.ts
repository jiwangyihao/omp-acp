import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentCapabilities, Implementation } from "@agentclientprotocol/sdk";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolvePackageJsonPath(moduleDir);

interface PackageMetadata {
  name: string;
  version: string;
}

export function buildInitialAgentCapabilities(): AgentCapabilities {
  return {
    loadSession: true,
    promptCapabilities: {
      image: true,
      audio: false,
      embeddedContext: true,
    },
    mcpCapabilities: {
      http: false,
      sse: false,
    },
    sessionCapabilities: {
      list: {},
      resume: {},
      fork: {},
    },
  };
}

export function buildAgentInfo(): Implementation {
  const packageMetadata = JSON.parse(
    readFileSync(packageJsonPath, "utf8"),
  ) as PackageMetadata;

  return {
    name: packageMetadata.name,
    version: packageMetadata.version,
  };
}

function resolvePackageJsonPath(moduleDir: string): string {
  const candidates = [
    resolve(moduleDir, "../package.json"),
    resolve(moduleDir, "../../package.json"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to locate package.json from ${moduleDir}`);
}