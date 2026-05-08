import assert from "node:assert/strict";
import test from "node:test";
import type { PromptRequest } from "@agentclientprotocol/sdk";
import { PromptTranslationError, translatePromptToOmpRequest } from "../../../src/translate/prompt.ts";

function promptRequest(prompt: PromptRequest["prompt"]): PromptRequest {
  return { sessionId: "session-1", prompt };
}

test("translatePromptToOmpRequest maps a text prompt block to an OMP prompt request", () => {
  const result = translatePromptToOmpRequest(
    promptRequest([{ type: "text", text: "hello agent" }]),
  );

  assert.deepEqual(result, {
    method: "prompt",
    params: { sessionId: "session-1", prompt: "hello agent" },
  });
});

test("translatePromptToOmpRequest preserves multiple text blocks in order", () => {
  const result = translatePromptToOmpRequest(
    promptRequest([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
      { type: "text", text: "third" },
    ]),
  );

  assert.equal(result.params.prompt, "first\n\nsecond\n\nthird");
});

test("translatePromptToOmpRequest formats resource_link blocks with title, name, and description", () => {
  const titled = translatePromptToOmpRequest(
    promptRequest([
      {
        type: "resource_link",
        uri: "file:///project/spec.md",
        name: "spec.md",
        title: "Design Spec",
        description: "Use this as context.",
      },
    ]),
  );
  const named = translatePromptToOmpRequest(
    promptRequest([
      {
        type: "resource_link",
        uri: "file:///project/notes.md",
        name: "notes.md",
        description: "   ",
      },
    ]),
  );

  assert.equal(
    titled.params.prompt,
    "[Resource: Design Spec] file:///project/spec.md\nUse this as context.",
  );
  assert.equal(named.params.prompt, "[Resource: notes.md] file:///project/notes.md");
});

test("translatePromptToOmpRequest rejects unsupported image and embedded resource blocks", () => {
  assert.throws(
    () =>
      translatePromptToOmpRequest(
        promptRequest([{ type: "image", data: "abc", mimeType: "image/png" }]),
      ),
    PromptTranslationError,
  );
  assert.throws(
    () =>
      translatePromptToOmpRequest(
        promptRequest([
          {
            type: "resource",
            resource: { uri: "file:///x.txt", text: "contents" },
          },
        ]),
      ),
    PromptTranslationError,
  );
});