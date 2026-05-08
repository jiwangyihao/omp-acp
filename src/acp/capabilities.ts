import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentCapabilities, Implementation } from "@agentclientprotocol/sdk";

const packageJsonPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../package.json",
);

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