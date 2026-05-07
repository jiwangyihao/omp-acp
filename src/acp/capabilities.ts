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
    loadSession: false,
    promptCapabilities: {
      image: false,
      audio: false,
      embeddedContext: false,
    },
    mcpCapabilities: {
      http: false,
      sse: false,
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