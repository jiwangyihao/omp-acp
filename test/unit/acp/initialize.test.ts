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

test("buildInitialAgentCapabilities declares implemented rich prompt and session capabilities only", () => {
  const capabilities = buildInitialAgentCapabilities();

  assert.equal(capabilities.loadSession, true);
  assert.deepEqual(capabilities.promptCapabilities, {
    image: true,
    audio: false,
    embeddedContext: true,
  });
  assert.deepEqual(capabilities.mcpCapabilities, {
    http: false,
    sse: false,
  });
  assert.deepEqual(capabilities.sessionCapabilities, { list: {}, resume: {}, fork: {}, additionalDirectories: {} });
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

test("handleInitialize advertises terminal auth for SDK auth capability", async () => {
  const response = await handleInitialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { auth: { terminal: true } },
  });

  assert.deepEqual(response.authMethods, [
    {
      id: "omp-setup",
      type: "terminal",
      name: "Set up Oh My Pi",
      description: "Open an interactive terminal guide to configure Oh My Pi credentials and models.",
      args: ["--setup"],
    },
  ]);
});

test("handleInitialize advertises terminal auth for Registry meta capability", async () => {
  const response = await handleInitialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { terminal: true, _meta: { "terminal-auth": true } },
  });

  assert.deepEqual(response.authMethods?.[0], {
    id: "omp-setup",
    type: "terminal",
    name: "Set up Oh My Pi",
    description: "Open an interactive terminal guide to configure Oh My Pi credentials and models.",
    args: ["--setup"],
  });
});

test("handleInitialize does not treat terminal request support as terminal auth support", async () => {
  const response = await handleInitialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { terminal: true },
  });

  assert.equal(response.authMethods, undefined);
});

test("handleInitialize does not declare unimplemented capabilities as true", async () => {
  const response = await handleInitialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  });
  const capabilities = response.agentCapabilities;

  assert.equal(capabilities?.loadSession, true);
  assert.deepEqual(capabilities?.sessionCapabilities?.list, {});
  assert.deepEqual(capabilities?.sessionCapabilities?.resume, {});
  assert.deepEqual(capabilities?.sessionCapabilities?.fork, {});
  assert.equal(Object.hasOwn(capabilities?.sessionCapabilities ?? {}, "close"), false);
  assert.notEqual(capabilities?.mcpCapabilities?.http, true);
  assert.notEqual(capabilities?.mcpCapabilities?.sse, true);
  assert.equal(capabilities?.promptCapabilities?.image, true);
  assert.notEqual(capabilities?.promptCapabilities?.audio, true);
  assert.equal(capabilities?.promptCapabilities?.embeddedContext, true);
});