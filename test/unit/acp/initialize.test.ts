import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { buildAgentInfo, buildInitialAgentCapabilities } from "../../../src/acp/capabilities.ts";
import { handleInitialize } from "../../../src/acp/handlers/initialize.ts";

import test from "node:test";

const packageJsonPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../package.json",
);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  name: string;
  version: string;
};

test("buildInitialAgentCapabilities returns conservative false capabilities", () => {
  const capabilities = buildInitialAgentCapabilities();

  assert.equal(capabilities.loadSession, false);
  assert.deepEqual(capabilities.promptCapabilities, {
    image: false,
    audio: false,
    embeddedContext: false,
  });
  assert.deepEqual(capabilities.mcpCapabilities, {
    http: false,
    sse: false,
  });
});

test("buildInitialAgentCapabilities does not declare sessionCapabilities", () => {
  const capabilities = buildInitialAgentCapabilities();

  assert.equal(Object.hasOwn(capabilities, "sessionCapabilities"), false);
});

test("buildAgentInfo reads package name and version", () => {
  const agentInfo = buildAgentInfo();

  assert.equal(packageJson.name, "omp-acp");
  assert.deepEqual(agentInfo, {
    name: packageJson.name,
    version: packageJson.version,
  });
});

test("handleInitialize returns protocol version, agent info, and capabilities without authMethods", async () => {
  const response = await handleInitialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });

  assert.equal(response.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(response.agentInfo, buildAgentInfo());
  assert.deepEqual(response.agentCapabilities, buildInitialAgentCapabilities());
  assert.equal(Object.hasOwn(response, "authMethods"), false);
});

test("handleInitialize does not declare unimplemented or unverified capabilities as true", async () => {
  const response = await handleInitialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  const capabilities = response.agentCapabilities;

  assert.notEqual(capabilities?.loadSession, true);
  assert.notEqual(capabilities?.mcpCapabilities?.http, true);
  assert.notEqual(capabilities?.mcpCapabilities?.sse, true);
  assert.notEqual(capabilities?.promptCapabilities?.image, true);
  assert.notEqual(capabilities?.promptCapabilities?.audio, true);
  assert.notEqual(capabilities?.promptCapabilities?.embeddedContext, true);
  assert.notEqual(capabilities?.sessionCapabilities?.list, true);
  assert.notEqual(capabilities?.sessionCapabilities?.fork, true);
  assert.notEqual(capabilities?.sessionCapabilities?.resume, true);
});