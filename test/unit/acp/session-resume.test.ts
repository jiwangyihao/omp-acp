import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { Agent, ResumeSessionRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import { createOmpAcpAgent } from "../../../src/acp/server.ts";
import type { RuntimeAdapter } from "../../../src/runtime/RuntimeAdapter.ts";
import { SessionManager, type RuntimeFactoryInput } from "../../../src/session/manager.ts";

class FakeRuntime implements RuntimeAdapter {
  readonly ready = Promise.resolve();
  readonly diagnostics = { stderr: "" };
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  closed = false;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return { ok: true };
  }

  onEvent(): () => void {
    return () => {};
  }

  async send(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

type TestAgent = Agent & Required<Pick<Agent, "resumeSession">>;

async function makeAgent() {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-acp-resume-agent-"));
  const runtimes: FakeRuntime[] = [];
  const inputs: RuntimeFactoryInput[] = [];
  const manager = new SessionManager({
    runtimeFactory: (input) => {
      inputs.push(input);
      const runtime = new FakeRuntime();
      runtimes.push(runtime);
      return runtime;
    },
  });
  const updates: Array<{ sessionId: string; update: SessionUpdate }> = [];
  const connection = {
    sessionUpdate: async (params: { sessionId: string; update: SessionUpdate }) => {
      updates.push(params);
    },
  };
  const agent = createOmpAcpAgent(connection as never, manager, {}, { agentDir }) as TestAgent;
  return { agent, agentDir, runtimes, inputs, updates };
}

async function writeSession(agentDir: string, cwd: string, sessionId: string, lines: unknown[]) {
  const dir = join(agentDir, "sessions", `--${sessionId}--`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

test("resumeSession switches runtime to OMP session path, publishes same session id, and does not replay history", async () => {
  const { agent, agentDir, runtimes, inputs, updates } = await makeAgent();
  const cwd = join(tmpdir(), "resume-project");
  const sessionPath = await writeSession(agentDir, cwd, "resume-me", [
    { type: "session", id: "resume-me", cwd, timestamp: "2026-05-08T01:00:00.000Z" },
    { type: "message", role: "user", content: "old question" },
    { type: "message", role: "assistant", content: "old answer" },
  ]);

  const response = await agent.resumeSession({ sessionId: "resume-me", cwd, mcpServers: [] } as ResumeSessionRequest);

  assert.deepEqual(response, {});
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0], { sessionId: "resume-me", cwd, mcpServers: [] });
  assert.deepEqual(runtimes[0]?.requests, [{ method: "switch_session", params: { sessionPath } }]);
  assert.deepEqual(updates, []);

  await agent.prompt({ sessionId: "resume-me", prompt: [{ type: "text", text: "after resume" }] });
  assert.deepEqual(runtimes[0]?.requests.at(-1), {
    method: "prompt",
    params: { sessionId: "resume-me", prompt: "after resume" },
  });
});

test("resumeSession fails clearly for unknown sessions", async () => {
  const { agent } = await makeAgent();
  const cwd = join(tmpdir(), "resume-missing");

  await assert.rejects(
    agent.resumeSession({ sessionId: "missing", cwd, mcpServers: [] } as ResumeSessionRequest),
    /Unknown OMP session: missing/,
  );
});