import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "../../../src/runtime/RuntimeEvents.ts";
import {
  RuntimeEventTranslationError,
  translateRuntimeEventToSessionUpdate,
  UnsupportedRuntimeEventError,
} from "../../../src/translate/events.ts";

function event(eventType: string, raw: Record<string, unknown> = {}): RuntimeEvent {
  return { type: "event", eventType, raw };
}

test("translateRuntimeEventToSessionUpdate maps message_update content text to an agent message chunk", () => {
  assert.deepEqual(
    translateRuntimeEventToSessionUpdate(event("message_update", { content: "hello" })),
    {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    },
  );
});

test("translateRuntimeEventToSessionUpdate maps thought and reasoning updates to thought chunks", () => {
  assert.deepEqual(
    translateRuntimeEventToSessionUpdate(event("message_update", { text: "thinking", kind: "thought" })),
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking" },
    },
  );
  assert.deepEqual(
    translateRuntimeEventToSessionUpdate(event("message_update", { type: "thought", content: "thinking" })),
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking" },
    },
  );
  assert.deepEqual(
    translateRuntimeEventToSessionUpdate(
      event("message_update", { message: { type: "reasoning", text: "reasoning" } }),
    ),
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "reasoning" },
    },
  );
  assert.deepEqual(
    translateRuntimeEventToSessionUpdate(
      event("message_update", { message: { text: "reasoning", channel: "reasoning" } }),
    ),
    {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "reasoning" },
    },
  );
});

test("translateRuntimeEventToSessionUpdate returns undefined for empty or non-string text", () => {
  assert.equal(translateRuntimeEventToSessionUpdate(event("message_update", { content: "" })), undefined);
  assert.equal(translateRuntimeEventToSessionUpdate(event("message_update", { content: 123 })), undefined);
  assert.equal(
    translateRuntimeEventToSessionUpdate(event("message_update", { message: { text: "" } })),
    undefined,
  );
});

test("translateRuntimeEventToSessionUpdate ignores agent_start and unknown telemetry events", () => {
  assert.equal(translateRuntimeEventToSessionUpdate(event("agent_start")), undefined);
  assert.equal(translateRuntimeEventToSessionUpdate(event("future_telemetry", { ok: true })), undefined);
});

test("translateRuntimeEventToSessionUpdate fails extension_error events", () => {
  assert.throws(
    () => translateRuntimeEventToSessionUpdate(event("extension_error", { message: "boom" })),
    RuntimeEventTranslationError,
  );
});

test("translateRuntimeEventToSessionUpdate fails known unsupported host tool action events", () => {
  assert.throws(
    () => translateRuntimeEventToSessionUpdate(event("host_tool_call", { id: "tool-1" })),
    UnsupportedRuntimeEventError,
  );
  assert.throws(
    () => translateRuntimeEventToSessionUpdate(event("host_tool_cancel", { id: "tool-1" })),
    UnsupportedRuntimeEventError,
  );
});