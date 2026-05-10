import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeToolKind,
  normalizeToolStatus,
  toolExecutionEndToUpdate,
  toolExecutionStartToUpdate,
  toolExecutionUpdateToUpdate,
} from "../../../src/translate/tools.ts";

function assertToolCallUpdate(update: ReturnType<typeof toolExecutionEndToUpdate> | ReturnType<typeof toolExecutionUpdateToUpdate>) {
  assert.equal(update?.sessionUpdate, "tool_call_update");
  return update;
}

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

test("toolExecutionStartToUpdate sanitizes ACP-visible rawInput and keeps bash title", () => {
  assert.deepEqual(
    toolExecutionStartToUpdate({
      type: "tool_execution_start",
      toolCallId: "call-bash-sensitive",
      toolName: "bash",
      args: {
        command: "npm test",
        cwd: "/repo",
        providerApiKey: "secret-provider-key",
        token: "secret-token",
        config: { baseURL: "https://secret.example" },
        accessKey: "secret-access-key",
        plain_key: "secret-plain-key",
        "api-key": "secret-api-key",
        key: "secret-key",
      },
      status: "running",
    }),
    {
      sessionUpdate: "tool_call",
      toolCallId: "call-bash-sensitive",
      title: "Bash: npm test",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "npm test", cwd: "/repo" },
      content: [{ type: "content", content: { type: "text", text: "$ npm test" } }],
    },
  );
});

test("toolExecutionStartToUpdate sanitizes ACP-visible title", () => {
  assert.deepEqual(
    toolExecutionStartToUpdate({
      type: "tool_execution_start",
      toolCallId: "call-title-sensitive",
      toolName: "bash",
      title: '{"token":"secret-token","ok":true}',
      args: { command: "npm test" },
      status: "running",
    }),
    {
      sessionUpdate: "tool_call",
      toolCallId: "call-title-sensitive",
      title: '{"ok":true}',
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "npm test" },
      content: [{ type: "content", content: { type: "text", text: "$ npm test" } }],
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

test("toolExecutionEndToUpdate sanitizes rawOutput and uses shared content extraction", () => {
  assert.deepEqual(
    toolExecutionEndToUpdate({
      type: "tool_execution_end",
      toolCallId: "call-sensitive-result",
      status: "completed",
      result: {
        content: [
          { type: "text", text: "done" },
          { type: "providerPayload", token: "secret-token" },
        ],
        details: { exitCode: 0, token: "secret-token", config: { baseURL: "https://secret.example" } },
        providerPayload: { token: "secret-token" },
      },
    }),
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-sensitive-result",
      status: "completed",
      rawOutput: { content: [{ type: "text", text: "done" }], details: { exitCode: 0 } },
      content: [{ type: "content", content: { type: "text", text: "done" } }],
    },
  );
});

test("toolExecutionEndToUpdate keeps JSON string rawOutput as text", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-json-output",
    status: "completed",
    rawOutput: '{"ok":true}',
  }));

  assert.equal(update.rawOutput, '{"ok":true}');
  assert.deepEqual(update.content, [{ type: "content", content: { type: "text", text: '{"ok":true}' } }]);
});

test("toolExecutionEndToUpdate redacts sensitive JSON string rawOutput consistently in rawOutput and content", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-json-secret-output",
    status: "completed",
    rawOutput: '{"token":"secret-token","ok":true,"config":{"baseURL":"https://private"}}',
  }));

  assert.equal(typeof update.rawOutput, "string");
  const serialized = JSON.stringify(update);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("https://private"), false);
  assert.equal(serialized.includes("token"), false);
  assert.equal(serialized.includes("baseURL"), false);
  assert.equal(serialized.includes("config"), false);
  assert.equal(update.content?.[0]?.type, "content");
  assert.equal((update.content?.[0] as { content: { text?: string } }).content.text, update.rawOutput);
});

test("toolExecutionEndToUpdate redacts escaped sensitive JSON object keys", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-escaped-json-key",
    status: "completed",
    rawOutput: '{"tok\\u0065n":"secret-token","ok":true}',
  }));

  assert.equal(update.rawOutput, '{"ok":true}');
  assert.deepEqual(update.content, [{ type: "content", content: { type: "text", text: '{"ok":true}' } }]);
});

test("toolExecutionEndToUpdate redacts escaped sensitive keys inside nested JSON strings", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-nested-escaped-json-key",
    status: "completed",
    rawOutput: '{"stdout":"{\\"tok\\\\u0065n\\":\\"secret-token\\",\\"ok\\":true}","ok":true}',
  }));

  assert.equal(update.rawOutput, '{"stdout":"{\\"ok\\":true}","ok":true}');
  assert.deepEqual(update.content, [{ type: "content", content: { type: "text", text: '{"stdout":"{\\"ok\\":true}","ok":true}' } }]);
});

test("toolExecutionEndToUpdate still sanitizes structured object output", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-structured-output",
    status: "completed",
    rawOutput: { ok: true, token: "secret", data: { value: 1 }, config: { baseURL: "https://private" } },
  }));

  assert.deepEqual(update.rawOutput, { ok: true, data: { value: 1 } });
});

test("toolExecutionEndToUpdate redacts nested JSON strings inside structured output", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-nested-json-output",
    status: "completed",
    rawOutput: {
      stdout: '{"token":"secret-token","ok":true}',
      content: [{ type: "text", text: '{"apiKey":"secret-key","ok":true}' }],
    },
  }));

  assert.equal(typeof (update.rawOutput as { stdout?: unknown }).stdout, "string");
  const serialized = JSON.stringify(update);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("secret-key"), false);
  assert.equal(serialized.includes("token"), false);
  assert.equal(serialized.includes("apiKey"), false);
  assert.equal(update.content === undefined || JSON.stringify(update.content).includes("secret-key") === false, true);
});

test("toolExecutionEndToUpdate redacts bare string content in structured output", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-bare-string-content",
    status: "completed",
    result: { content: ['{"token":"secret-token","ok":true}'] },
  }));

  const serialized = JSON.stringify(update);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("token"), false);
});

test("toolExecutionEndToUpdate redacts image mimeType fields", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-image-content",
    status: "completed",
    result: {
      content: [
        { type: "image", data: "aW1n", mimeType: '{"token":"secret-token","ok":true}' },
      ],
    },
  }));

  assert.deepEqual(update.content, [
    { type: "content", content: { type: "image", data: "aW1n", mimeType: '{"ok":true}' } },
  ]);
});

test("toolExecutionEndToUpdate redacts resource text content in structured output", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-resource-text-content",
    status: "completed",
    result: {
      content: [
        { type: "resource", resource: { uri: "file:///out.json", text: '{"token":"secret-token","ok":true}' } },
        { type: "resource", resource: { uri: "file:///out.blob", blob: '{"apiKey":"secret-key","ok":true}' } },
      ],
    },
  }));

  const serialized = JSON.stringify(update);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("secret-key"), false);
  assert.equal(serialized.includes("token"), false);
  assert.equal(serialized.includes("apiKey"), false);
});

test("toolExecutionEndToUpdate redacts resource link visible fields", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-resource-link-content",
    status: "completed",
    result: {
      content: [
        { type: "resource_link", uri: '{"token":"secret-token","ok":true}', name: '{"accessKey":"secret-access-key","ok":true}', title: '{"token":"secret-token"}', description: '{"apiKey":"secret-key"}', mimeType: '{"key":"secret-mime-key","ok":true}' },
      ],
    },
  }));

  const serialized = JSON.stringify(update);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("secret-key"), false);
  assert.equal(serialized.includes("token"), false);
  assert.equal(serialized.includes("apiKey"), false);
});

test("toolExecutionEndToUpdate redacts top-level JSON string literals", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-json-string-literal",
    status: "completed",
    rawOutput: '"secret-token"',
  }));

  assert.equal(update.rawOutput, "[redacted]");
  assert.deepEqual(update.content, [{ type: "content", content: { type: "text", text: "[redacted]" } }]);
});

test("toolExecutionEndToUpdate extracts visible content only from sanitized structured result", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-sanitized-content-source",
    status: "completed",
    result: { content: [{ type: "resource_link", uri: "file:///safe", name: "safe", description: '{"token":"secret-token"}' }] },
  }));

  const serialized = JSON.stringify(update);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("token"), false);
  assert.equal(update.content?.[0]?.type, "content");
});

test("toolExecutionEndToUpdate preserves explicit content inside structured raw output", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-raw-with-content",
    status: "completed",
    rawOutput: { data: { value: 1 }, content: [{ type: "text", text: "visible output" }] },
  }));

  assert.deepEqual(update.rawOutput, { data: { value: 1 }, content: [{ type: "text", text: "visible output" }] });
  assert.equal(JSON.stringify(update.rawOutput).includes("visible output"), true);
});

test("toolExecutionEndToUpdate keeps JSON string result as text", () => {
  const update = assertToolCallUpdate(toolExecutionEndToUpdate({
    type: "tool_execution_end",
    toolCallId: "call-json-result",
    status: "completed",
    result: '{"ok":true}',
  }));

  assert.equal(update.rawOutput, '{"ok":true}');
  assert.deepEqual(update.content, [{ type: "content", content: { type: "text", text: '{"ok":true}' } }]);
});

test("toolExecutionUpdateToUpdate keeps JSON string partialResult as text", () => {
  const update = assertToolCallUpdate(toolExecutionUpdateToUpdate({
    type: "tool_execution_update",
    toolCallId: "call-json-partial",
    status: "running",
    partialResult: '{"ok":true}',
  }));

  assert.equal(update.rawOutput, '{"ok":true}');
  assert.deepEqual(update.content, [{ type: "content", content: { type: "text", text: '{"ok":true}' } }]);
});

test("toolExecutionUpdateToUpdate keeps non-JSON string output as visible text", () => {
  assert.deepEqual(
    toolExecutionUpdateToUpdate({
      type: "tool_execution_update",
      toolCallId: "call-text-output",
      status: "running",
      output: "plain progress",
    }),
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-text-output",
      status: "in_progress",
      rawOutput: "plain progress",
      content: [{ type: "content", content: { type: "text", text: "plain progress" } }],
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

test("toolExecutionEndToUpdate sanitizes unsupported diff rawOutput", () => {
  assert.deepEqual(
    toolExecutionEndToUpdate({
      type: "tool_execution_end",
      toolCallId: "call-sensitive-diff",
      diff: {
        operation: "rename",
        oldPath: "/repo/old.ts",
        newPath: "/repo/new.ts",
        token: "secret",
        config: { baseURL: "https://secret.example" },
      },
    }),
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-sensitive-diff",
      status: "failed",
      rawOutput: {
        error: "Unsupported rename diff payload: rename requires string newText",
        diff: { operation: "rename", oldPath: "/repo/old.ts", newPath: "/repo/new.ts" },
      },
    },
  );
});
