import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeEvent } from "../../../src/runtime/RuntimeEvents.ts";
import { RuntimeEventTranslationError, UnsupportedRuntimeEventError, translateRuntimeEventToSessionUpdate } from "../../../src/translate/events.ts";
import { classifyExtensionUiRequest } from "../../../src/translate/extension-ui.ts";
import { agentEndMessagesToFallbackUpdates, streamedAssistantMessageKey } from "../../../src/translate/messages.ts";

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

test("translateRuntimeEventToSessionUpdate maps OMP assistant text_delta to an agent message chunk", () => {
  assert.deepEqual(
    translateRuntimeEventToSessionUpdate(
      event("message_update", {
        message: { role: "assistant", content: [{ type: "text", text: "final" }], responseId: "r1", timestamp: 1 },
        assistantMessageEvent: { type: "text_delta", delta: "hi", contentIndex: 0 },
      }),
    ),
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
  );
});

test("translateRuntimeEventToSessionUpdate redacts sensitive JSON text deltas", () => {
  assert.deepEqual(
    translateRuntimeEventToSessionUpdate(
      event("message_update", {
        message: { role: "assistant", content: [{ type: "text", text: "final" }], responseId: "r1", timestamp: 1 },
        assistantMessageEvent: { type: "text_delta", delta: '{"token":"secret-token","ok":true}', contentIndex: 0 },
      }),
    ),
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: '{"ok":true}' } },
  );
});

test("agent_end fallback reuses streamed assistant key when user precedes assistant", () => {
  const streamed = streamedAssistantMessageKey({
    message: { role: "assistant", content: ["streamed", "not streamed"] },
    assistantMessageEvent: { type: "text_delta", delta: "streamed", contentIndex: 0 },
  });
  assert.equal(streamed, "message:0:no-ts:0:agent_message_chunk");

  const emitted = new Set<string>([streamed]);
  const updates = agentEndMessagesToFallbackUpdates(
    {
      messages: [
        { role: "user", content: "prompt" },
        { role: "assistant", content: ["streamed", "not streamed"] },
      ],
    },
    emitted,
  );

  assert.deepEqual(updates, [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "not streamed" } },
  ]);
});

test("agent_end fallback redacts sensitive JSON string content", () => {
  const updates = agentEndMessagesToFallbackUpdates(
    { messages: [{ role: "assistant", content: ['{"token":"secret-token","ok":true}'] }] },
    new Set<string>(),
  );

  assert.deepEqual(updates, [
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: '{"ok":true}' } },
  ]);
});

test("translateRuntimeEventToSessionUpdate maps OMP assistant thinking_delta to a thought chunk", () => {
  assert.deepEqual(
    translateRuntimeEventToSessionUpdate(
      event("message_update", {
        message: { role: "assistant", content: [{ type: "thinking", thinking: "final" }], responseId: "r1", timestamp: 1 },
        assistantMessageEvent: { type: "thinking_delta", delta: "reason", contentIndex: 0 },
      }),
    ),
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reason" } },
  );
});

test("translateRuntimeEventToSessionUpdate ignores assistant toolcall message events", () => {
  for (const type of ["toolcall_start", "toolcall_delta", "toolcall_end"]) {
    assert.equal(
      translateRuntimeEventToSessionUpdate(
        event("message_update", {
          message: { role: "assistant", content: [{ type: "toolCall", id: "tc_1", name: "bash" }] },
          assistantMessageEvent: { type, contentIndex: 0 },
        }),
      ),
      undefined,
    );
  }
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

test("shared extension UI classifier keeps translator widget and unsupported interactive boundaries", () => {
  assert.equal(classifyExtensionUiRequest({ method: "setWidget", id: "ui-widget" }), "widget");
  assert.equal(
    translateRuntimeEventToSessionUpdate(
      event("extension_ui_request", { method: "setWidget", id: "ui-widget", widgetLines: ["visible only through bridge"] }),
    ),
    undefined,
  );
  assert.equal(classifyExtensionUiRequest({ method: "select", id: "ui-select" }), "unsupported_interactive");
  assert.throws(
    () => translateRuntimeEventToSessionUpdate(event("extension_ui_request", { method: "select", id: "ui-select" })),
    UnsupportedRuntimeEventError,
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