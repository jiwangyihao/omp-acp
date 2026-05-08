import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "../../../src/runtime/RuntimeEvents.ts";
import { RuntimeEventTranslationError, UnsupportedRuntimeEventError, translateRuntimeEventToSessionUpdate } from "../../../src/translate/events.ts";

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

test("translateRuntimeEventToSessionUpdate leaves host tool events for the session bridge", () => {
  assert.equal(translateRuntimeEventToSessionUpdate(event("host_tool_call", { id: "host-1", toolName: "x" })), undefined);
  assert.equal(translateRuntimeEventToSessionUpdate(event("host_tool_cancel", { targetId: "host-1" })), undefined);
});

test("translateRuntimeEventToSessionUpdate ignores fire-and-forget extension UI state updates", () => {
  assert.equal(
    translateRuntimeEventToSessionUpdate(
      event("extension_ui_request", { method: "setWidget", id: "ui-1", widgetKey: "autoresearch", widgetLines: [] }),
    ),
    undefined,
  );
  assert.equal(
    translateRuntimeEventToSessionUpdate(event("extension_ui_request", { method: "setStatus", id: "ui-2", statusKey: "x" })),
    undefined,
  );
});

test("translateRuntimeEventToSessionUpdate fails interactive extension_ui_request with method and id", () => {
  assert.throws(
    () => translateRuntimeEventToSessionUpdate(event("extension_ui_request", { method: "select", id: "ui-1" })),
    (error) => error instanceof UnsupportedRuntimeEventError
      && /extension_ui_request/.test(error.message)
      && /select/.test(error.message)
      && /ui-1/.test(error.message),
  );
});

test("translateRuntimeEventToSessionUpdate maps tool execution events to ACP tool updates", () => {
  assert.deepEqual(
    translateRuntimeEventToSessionUpdate(
      event("tool_execution_start", {
        toolCallId: "call-1",
        title: "Reading /repo/file.ts",
        kind: "read_file",
        input: { path: "/repo/file.ts" },
        path: "/repo/file.ts",
        line: 3,
      }),
    ),
    {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Reading /repo/file.ts",
      kind: "read",
      status: "pending",
      rawInput: { path: "/repo/file.ts" },
      locations: [{ path: "/repo/file.ts", line: 3 }],
    },
  );

  assert.deepEqual(
    translateRuntimeEventToSessionUpdate(
      event("tool_execution_end", {
        toolCallId: "call-1",
        status: "completed",
        content: "ok",
        diff: { path: "/repo/file.ts", oldText: "old", newText: "new" },
      }),
    ),
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      rawOutput: "ok",
      content: [
        { type: "content", content: { type: "text", text: "ok" } },
        { type: "diff", path: "/repo/file.ts", oldText: "old", newText: "new" },
      ],
    },
  );
});