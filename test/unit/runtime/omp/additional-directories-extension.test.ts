import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error untyped OMP extension module
import additionalDirectoriesInAcp from "../../../../src/runtime/omp/additional-directories-extension.mjs";

type BeforeAgentStartHandler = (event: { type: string; prompt: string; systemPrompt: string[] }) => Promise<{ systemPrompt?: string[] } | undefined>;

function registerExtension(): BeforeAgentStartHandler {
  let handler: BeforeAgentStartHandler | undefined;
  additionalDirectoriesInAcp({
    on(eventName: string, eventHandler: BeforeAgentStartHandler) {
      if (eventName === "before_agent_start") {
        handler = eventHandler;
      }
    },
  });
  assert.notEqual(handler, undefined, "extension must register a before_agent_start handler");
  return handler!;
}

async function runHandler(env: string | undefined): Promise<{ systemPrompt?: string[] } | undefined> {
  const handler = registerExtension();
  const previous = process.env.OMP_ACP_ADDITIONAL_DIRS_JSON;
  if (env === undefined) {
    delete process.env.OMP_ACP_ADDITIONAL_DIRS_JSON;
  } else {
    process.env.OMP_ACP_ADDITIONAL_DIRS_JSON = env;
  }
  try {
    return await handler({ type: "before_agent_start", prompt: "hi", systemPrompt: ["base prompt"] });
  } finally {
    if (previous === undefined) {
      delete process.env.OMP_ACP_ADDITIONAL_DIRS_JSON;
    } else {
      process.env.OMP_ACP_ADDITIONAL_DIRS_JSON = previous;
    }
  }
}

test("additional-directories extension appends a workspace roots section to the system prompt", async () => {
  const result = await runHandler(JSON.stringify(["/extra/root1", "C:/extra/root2"]));

  assert.notEqual(result, undefined);
  assert.equal(result!.systemPrompt!.length, 2);
  assert.equal(result!.systemPrompt![0], "base prompt");
  assert.match(result!.systemPrompt![1]!, /## Additional workspace roots/);
  assert.match(result!.systemPrompt![1]!, /- \/extra\/root1/);
  assert.match(result!.systemPrompt![1]!, /- C:\/extra\/root2/);
});

test("additional-directories extension is a no-op without the env var", async () => {
  assert.equal(await runHandler(undefined), undefined);
});

test("additional-directories extension ignores malformed or empty payloads", async () => {
  assert.equal(await runHandler("not json"), undefined);
  assert.equal(await runHandler(JSON.stringify([])), undefined);
  assert.equal(await runHandler(JSON.stringify({ not: "an array" })), undefined);
});
