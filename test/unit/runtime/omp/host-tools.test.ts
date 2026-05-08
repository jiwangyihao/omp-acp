import assert from "node:assert/strict";
import test from "node:test";

import { HostToolBridge, type HostToolExecutor } from "../../../../src/runtime/omp/host-tools.ts";

function createBridge(registry: Record<string, HostToolExecutor> = {}) {
  const frames: Record<string, unknown>[] = [];
  const updates: unknown[] = [];
  const promptFailures: unknown[] = [];
  const bridge = new HostToolBridge({
    registry,
    sendFrame: async (frame) => {
      frames.push(frame);
    },
    emitUpdate: async (update) => {
      updates.push(update);
    },
    failPrompt: (error) => {
      promptFailures.push(error);
    },
  });

  return { bridge, frames, updates, promptFailures };
}

test("unregistered host tool emits pending and failed ACP updates plus raw error result", async () => {
  const { bridge, frames, updates, promptFailures } = createBridge();

  await bridge.handle({ type: "host_tool_call", id: "host_1", toolCallId: "tc_1", toolName: "missing", arguments: { value: 1 } });

  assert.deepEqual(updates, [
    { sessionUpdate: "tool_call", toolCallId: "tc_1", title: "missing", kind: "other", status: "pending", rawInput: { value: 1 } },
    { sessionUpdate: "tool_call_update", toolCallId: "tc_1", status: "failed", rawOutput: { error: "Unsupported host tool: missing" } },
  ]);
  assert.deepEqual(frames, [
    {
      type: "host_tool_result",
      id: "host_1",
      isError: true,
      result: { content: [{ type: "text", text: "Unsupported host tool: missing" }] },
    },
  ]);
  assert.deepEqual(promptFailures, []);
});

test("registered host tool emits progress raw update, ACP completion, and raw success result", async () => {
  const { bridge, frames, updates } = createBridge({
    lookup: async ({ arguments: input, sendUpdate }) => {
      await sendUpdate({ step: "half" });
      return { ok: true, input };
    },
  });

  await bridge.handle({ type: "host_tool_call", id: "host_2", name: "lookup", input: { query: "abc" } });

  assert.deepEqual(updates, [
    { sessionUpdate: "tool_call", toolCallId: "host_2", title: "lookup", kind: "other", status: "pending", rawInput: { query: "abc" } },
    { sessionUpdate: "tool_call_update", toolCallId: "host_2", status: "completed", rawOutput: { ok: true, input: { query: "abc" } } },
  ]);
  assert.deepEqual(frames, [
    { type: "host_tool_update", id: "host_2", partialResult: { step: "half" } },
    { type: "host_tool_result", id: "host_2", result: { ok: true, input: { query: "abc" } } },
  ]);
});

test("registered host tool failure emits failed ACP update and raw error result", async () => {
  const { bridge, frames, updates } = createBridge({
    explode: async () => {
      throw new Error("boom");
    },
  });

  await bridge.handle({ type: "host_tool_call", id: "host_3", toolName: "explode" });

  assert.deepEqual(updates, [
    { sessionUpdate: "tool_call", toolCallId: "host_3", title: "explode", kind: "other", status: "pending", rawInput: undefined },
    { sessionUpdate: "tool_call_update", toolCallId: "host_3", status: "failed", rawOutput: { error: "boom" } },
  ]);
  assert.deepEqual(frames, [
    {
      type: "host_tool_result",
      id: "host_3",
      isError: true,
      result: { content: [{ type: "text", text: "boom" }] },
    },
  ]);
});

test("cancel active host tool aborts executor and emits failed cancelled update plus raw error result", async () => {
  let observedAbort = false;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { bridge, frames, updates } = createBridge({
    long: async ({ signal }) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
        release();
      });
      await started;
      return { shouldNotWin: true };
    },
  });

  const call = bridge.handle({ type: "host_tool_call", id: "host_4", toolName: "long" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await bridge.handle({ type: "host_tool_cancel", id: "cancel_1", targetId: "host_4" });
  await call;

  assert.equal(observedAbort, true);
  assert.deepEqual(updates, [
    { sessionUpdate: "tool_call", toolCallId: "host_4", title: "long", kind: "other", status: "pending", rawInput: undefined },
    { sessionUpdate: "tool_call_update", toolCallId: "host_4", status: "failed", rawOutput: { cancelled: true } },
  ]);
  assert.deepEqual(frames, [
    {
      type: "host_tool_result",
      id: "host_4",
      isError: true,
      result: { content: [{ type: "text", text: "Host tool call cancelled" }] },
    },
  ]);
});

test("cancel missing target emits explicit failed update and raw cancel error result", async () => {
  const { bridge, frames, updates } = createBridge();

  await bridge.handle({ type: "host_tool_cancel", id: "cancel_2", targetId: "host_missing" });

  assert.deepEqual(updates, [
    { sessionUpdate: "tool_call_update", toolCallId: "host_missing", status: "failed", rawOutput: { error: "No active host tool call: host_missing" } },
  ]);
  assert.deepEqual(frames, [
    {
      type: "host_tool_result",
      id: "host_missing",
      isError: true,
      result: { content: [{ type: "text", text: "No active host tool call: host_missing" }] },
    },
  ]);
});