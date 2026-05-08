import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeToolKind,
  normalizeToolStatus,
  toolExecutionEndToUpdate,
  toolExecutionStartToUpdate,
  toolExecutionUpdateToUpdate,
} from "../../../src/translate/tools.ts";

test("normalizeToolStatus maps runtime statuses to ACP statuses", () => {
  assert.equal(normalizeToolStatus("pending", "tool_execution_update"), "pending");
  assert.equal(normalizeToolStatus("queued", "tool_execution_update"), "pending");
  assert.equal(normalizeToolStatus("running", "tool_execution_update"), "in_progress");
  assert.equal(normalizeToolStatus("in_progress", "tool_execution_update"), "in_progress");
  assert.equal(normalizeToolStatus("started", "tool_execution_update"), "in_progress");
  assert.equal(normalizeToolStatus("success", "tool_execution_update"), "completed");
  assert.equal(normalizeToolStatus("succeeded", "tool_execution_update"), "completed");
  assert.equal(normalizeToolStatus("complete", "tool_execution_update"), "completed");
  assert.equal(normalizeToolStatus("completed", "tool_execution_update"), "completed");
  assert.equal(normalizeToolStatus(undefined, "tool_execution_end"), "completed");
  assert.equal(normalizeToolStatus("failed", "tool_execution_update"), "failed");
  assert.equal(normalizeToolStatus("error", "tool_execution_update"), "failed");
  assert.equal(normalizeToolStatus("cancelled", "tool_execution_update"), "failed");
  assert.equal(normalizeToolStatus("canceled", "tool_execution_update"), "failed");
});

test("normalizeToolKind passes known kinds through and maps OMP names", () => {
  assert.equal(normalizeToolKind("read"), "read");
  assert.equal(normalizeToolKind("edit"), "edit");
  assert.equal(normalizeToolKind("read_file"), "read");
  assert.equal(normalizeToolKind("patch"), "edit");
  assert.equal(normalizeToolKind("write"), "edit");
  assert.equal(normalizeToolKind("grep"), "search");
  assert.equal(normalizeToolKind("bash"), "execute");
  assert.equal(normalizeToolKind("shell"), "execute");
  assert.equal(normalizeToolKind("custom_tool"), "other");
});

test("toolExecutionStartToUpdate maps start event to ACP tool_call", () => {
  assert.deepEqual(
    toolExecutionStartToUpdate({
      type: "tool_execution_start",
      toolCallId: "call-1",
      name: "Read File",
      title: "Reading C:\\repo\\file.ts",
      kind: "read_file",
      status: "running",
      input: { path: "C:\\repo\\file.ts" },
      path: "C:\\repo\\file.ts",
      line: 7,
    }),
    {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Reading C:\\repo\\file.ts",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "C:\\repo\\file.ts" },
      locations: [{ path: "C:\\repo\\file.ts", line: 7 }],
    },
  );
});

test("toolExecutionStartToUpdate preserves OMP args and summarizes bash command", () => {
  assert.deepEqual(
    toolExecutionStartToUpdate({
      type: "tool_execution_start",
      toolCallId: "call-bash",
      toolName: "bash",
      args: { command: "npm run check", cwd: "/repo" },
      status: "running",
    }),
    {
      sessionUpdate: "tool_call",
      toolCallId: "call-bash",
      title: "Bash: npm run check",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "npm run check", cwd: "/repo" },
      content: [{ type: "content", content: { type: "text", text: "$ npm run check" } }],
    },
  );
});

test("toolExecutionUpdateToUpdate wraps text content, rawOutput, and locations", () => {
  assert.deepEqual(
    toolExecutionUpdateToUpdate({
      type: "tool_execution_update",
      id: "call-2",
      status: "success",
      output: "done",
      rawOutput: { bytes: 4 },
      path: "/repo/file.ts",
      line: 11,
    }),
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-2",
      status: "completed",
      rawOutput: { bytes: 4 },
      content: [{ type: "content", content: { type: "text", text: "done" } }],
      locations: [{ path: "/repo/file.ts", line: 11 }],
    },
  );
});

test("toolExecutionUpdateToUpdate extracts OMP partialResult text", () => {
  const partialResult = {
    content: [{ type: "text", text: "running command" }],
    details: { exitCode: 0 },
  };

  assert.deepEqual(
    toolExecutionUpdateToUpdate({
      type: "tool_execution_update",
      toolCallId: "call-output",
      status: "running",
      partialResult,
    }),
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-output",
      status: "in_progress",
      rawOutput: partialResult,
      content: [{ type: "content", content: { type: "text", text: "running command" } }],
    },
  );
});

test("toolExecutionEndToUpdate extracts OMP result text", () => {
  const result = {
    content: [{ type: "text", text: "command finished" }],
    details: { exitCode: 0 },
  };

  assert.deepEqual(
    toolExecutionEndToUpdate({
      type: "tool_execution_end",
      toolCallId: "call-result",
      status: "completed",
      result,
    }),
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-result",
      status: "completed",
      rawOutput: result,
      content: [{ type: "content", content: { type: "text", text: "command finished" } }],
    },
  );
});

test("toolExecutionEndToUpdate maps missing end status to completed and cancelled to failed rawOutput", () => {
  assert.deepEqual(toolExecutionEndToUpdate({ type: "tool_execution_end", toolCallId: "call-3" }), {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-3",
    status: "completed",
  });

  assert.deepEqual(
    toolExecutionEndToUpdate({ type: "tool_execution_end", toolCallId: "call-4", status: "cancelled" }),
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-4",
      status: "failed",
      rawOutput: { cancelled: true },
    },
  );
});

test("toolExecutionEndToUpdate returns failed update for unsupported rename diff", () => {
  assert.deepEqual(
    toolExecutionEndToUpdate({
      type: "tool_execution_end",
      toolCallId: "call-5",
      diff: { operation: "rename", oldPath: "/repo/old.ts", newPath: "/repo/new.ts" },
    }),
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-5",
      status: "failed",
      rawOutput: {
        error: "Unsupported rename diff payload: rename requires string newText",
        diff: { operation: "rename", oldPath: "/repo/old.ts", newPath: "/repo/new.ts" },
      },
    },
  );
});
