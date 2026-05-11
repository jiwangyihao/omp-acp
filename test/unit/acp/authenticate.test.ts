import assert from "node:assert/strict";
import test from "node:test";
import { AgentSideConnection } from "@agentclientprotocol/sdk";
import { createOmpAcpAgent } from "../../../src/acp/server.ts";
import { SessionManager } from "../../../src/session/manager.ts";

function createAgent() {
  const manager = new SessionManager({
    runtimeFactory: () => {
      throw new Error("runtime factory should not be called by authenticate");
    },
  });
  const connection = {} as AgentSideConnection;
  return createOmpAcpAgent(connection, manager);
}

test("authenticate accepts the terminal setup method without starting runtime", async () => {
  const agent = createAgent();

  await assert.doesNotReject(async () => {
    assert.deepEqual(await agent.authenticate({ methodId: "omp-setup" }), {});
  });
});

test("authenticate rejects unknown methods", async () => {
  const agent = createAgent();

  await assert.rejects(
    () => agent.authenticate({ methodId: "unknown" }),
    /Unsupported authentication method: unknown/,
  );
});
