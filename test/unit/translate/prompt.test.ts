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

test("translatePromptToOmpRequest forwards image blocks separately without prompt text pollution", () => {
  const result = translatePromptToOmpRequest(
    promptRequest([
      { type: "text", text: "describe" },
      { type: "image", data: "abc", mimeType: "image/png", uri: "file:///img.png" },
      { type: "image", data: "def", mimeType: "image/jpeg", uri: null },
    ]),
  );

  assert.deepEqual(result, {
    method: "prompt",
    params: {
      sessionId: "session-1",
      prompt: "describe",
      images: [
        { type: "image", data: "abc", mimeType: "image/png", uri: "file:///img.png" },
        { type: "image", data: "def", mimeType: "image/jpeg" },
      ],
    },
  });
});

test("translatePromptToOmpRequest embeds text and blob resources as stable prompt sections", () => {
  const result = translatePromptToOmpRequest(
    promptRequest([
      { type: "text", text: "use context" },
      { type: "resource", resource: { uri: "file:///x.txt", mimeType: "text/plain", text: "contents" } },
      { type: "resource", resource: { uri: "file:///x.bin", blob: "Ymlu", mimeType: "application/octet-stream" } },
      { type: "resource", resource: { uri: "file:///no-mime.txt", text: "plain" } },
    ]),
  );

  assert.equal(
    result.params.prompt,
    "use context\n\n[Embedded Resource: file:///x.txt]\nMIME: text/plain\ncontents\n\n[Embedded Blob Resource: file:///x.bin]\nMIME: application/octet-stream\nYmlu\n\n[Embedded Resource: file:///no-mime.txt]\nplain",
  );
});

test("translatePromptToOmpRequest rejects audio and unknown embedded resource shapes", () => {
  assert.throws(
    () =>
      translatePromptToOmpRequest(
        promptRequest([{ type: "audio", data: "abc", mimeType: "audio/wav" }]),
      ),
    PromptTranslationError,
  );
  assert.throws(
    () =>
      translatePromptToOmpRequest(
        promptRequest([
          {
            type: "resource",
            resource: { uri: "file:///x" },
          } as never,
        ]),
      ),
    PromptTranslationError,
  );
});