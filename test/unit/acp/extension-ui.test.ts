import assert from "node:assert/strict";
import test from "node:test";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { ExtensionUiBridge } from "../../../src/acp/extension-ui.ts";
import type { RuntimeAdapter, RuntimeDiagnostics } from "../../../src/runtime/RuntimeAdapter.ts";
import { UnsupportedRuntimeEventError } from "../../../src/translate/events.ts";
import { classifyExtensionUiRequest, formatExtensionUiRequest, isFireAndForgetExtensionUiRequest } from "../../../src/translate/extension-ui.ts";

class FakeRuntime implements RuntimeAdapter {
  readonly ready = Promise.resolve();
  readonly diagnostics: RuntimeDiagnostics = { stderr: "" };
  readonly sentFrames: Record<string, unknown>[] = [];
  nextSendError: Error | undefined;

  request(): Promise<unknown> {
    return Promise.resolve(undefined);
  }

  send(frame: Record<string, unknown>): Promise<void> {
    if (this.nextSendError) {
      return Promise.reject(this.nextSendError);
    }
    this.sentFrames.push(frame);
    return Promise.resolve();
  }

  onEvent(): () => void {
    return () => undefined;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeConnection {
  readonly permissionRequests: RequestPermissionRequest[] = [];
  readonly sessionUpdates: { sessionId: string; update: SessionUpdate }[] = [];
  nextPermissionResponse: RequestPermissionResponse = { outcome: { outcome: "selected", optionId: "allow" } };
  nextPermissionError: Error | undefined;

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.permissionRequests.push(params);
    if (this.nextPermissionError) {
      return Promise.reject(this.nextPermissionError);
    }
    return Promise.resolve(this.nextPermissionResponse);
  }

  sessionUpdate(params: { sessionId: string; update: SessionUpdate }): Promise<void> {
    this.sessionUpdates.push(params);
    return Promise.resolve();
  }
}

function createBridge(options: {
  runtime?: FakeRuntime;
  connection?: FakeConnection;
  updates?: SessionUpdate[];
} = {}): { bridge: ExtensionUiBridge; runtime: FakeRuntime; connection: FakeConnection; updates: SessionUpdate[] } {
  const runtime = options.runtime ?? new FakeRuntime();
  const connection = options.connection ?? new FakeConnection();
  const updates = options.updates ?? [];
  const bridge = new ExtensionUiBridge({
    sessionId: "session-1",
    runtime,
    connection,
    emitUpdate: async (update) => {
      updates.push(update);
    },
  });
  return { bridge, runtime, connection, updates };
}

test("shared extension UI classifier covers supported and unsupported method classes", () => {
  const cases: Array<[Record<string, unknown>, ReturnType<typeof classifyExtensionUiRequest>]> = [
    [{ method: "confirm", id: "ui-confirm" }, "confirm"],
    [{ method: "setWidget", id: "ui-widget" }, "widget"],
    [{ method: "notify", id: "ui-notify" }, "fire_and_forget"],
    [{ method: "setStatus", id: "ui-status" }, "fire_and_forget"],
    [{ method: "setTitle", id: "ui-title" }, "fire_and_forget"],
    [{ method: "set_editor_text", id: "ui-editor-text" }, "fire_and_forget"],
    [{ method: "cancel", id: "ui-cancel" }, "fire_and_forget"],
    [{ method: "select", id: "ui-select" }, "unsupported_interactive"],
    [{ method: "input", id: "ui-input" }, "unsupported_interactive"],
    [{ method: "editor", id: "ui-editor" }, "unsupported_interactive"],
    [{ method: "showDialog", id: "ui-unknown" }, "unsupported"],
  ];

  for (const [raw, expected] of cases) {
    assert.equal(classifyExtensionUiRequest(raw), expected);
  }
  assert.equal(isFireAndForgetExtensionUiRequest({ method: "setWidget" }), false);
  assert.equal(isFireAndForgetExtensionUiRequest({ method: "notify" }), true);
  assert.equal(formatExtensionUiRequest({ method: "select", id: 7 }), "extension_ui_request method=select, id=7");
});

test("confirm permission allow writes confirmed true extension response", async () => {
  const { bridge, runtime, connection } = createBridge();

  await bridge.handle({ method: "confirm", id: "ui-1", title: "Run command?", message: "Allow bash?" });

  assert.equal(connection.permissionRequests.length, 1);
  assert.deepEqual(connection.permissionRequests[0]!.options, [
    { optionId: "allow", kind: "allow_once", name: "Allow" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ]);
  assert.deepEqual(runtime.sentFrames, [{ type: "extension_ui_response", id: "ui-1", confirmed: true }]);
});

test("confirm permission sanitizes ACP-visible title and message", async () => {
  const { bridge, connection } = createBridge();

  await bridge.handle({ method: "confirm", id: "ui-secret", title: '{"apiKey":"secret-key","ok":true}', message: '{"token":"secret-token","ok":true}' });

  const request = connection.permissionRequests[0]!;
  const serialized = JSON.stringify(request);
  assert.equal(serialized.includes("secret-key"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("apiKey"), false);
  assert.equal(serialized.includes("token"), false);
});

test("confirm permission reject writes confirmed false extension response", async () => {
  const connection = new FakeConnection();
  connection.nextPermissionResponse = { outcome: { outcome: "selected", optionId: "reject" } };
  const { bridge, runtime } = createBridge({ connection });

  await bridge.handle({ method: "confirm", id: "ui-1", title: "Run command?", message: "Allow bash?" });

  assert.deepEqual(runtime.sentFrames, [{ type: "extension_ui_response", id: "ui-1", confirmed: false }]);
});

test("confirm permission cancelled writes cancelled extension response", async () => {
  const connection = new FakeConnection();
  connection.nextPermissionResponse = { outcome: { outcome: "cancelled" } };
  const { bridge, runtime } = createBridge({ connection });

  await bridge.handle({ method: "confirm", id: "ui-1", title: "Run command?", message: "Allow bash?" });

  assert.deepEqual(runtime.sentFrames, [{ type: "extension_ui_response", id: "ui-1", cancelled: true }]);
});

test("confirm permission request has ACP tool call shape", async () => {
  const { bridge, connection } = createBridge();

  await bridge.handle({ method: "confirm", id: "ui-1", title: "Run command?", message: "Allow bash?" });

  const request = connection.permissionRequests[0]!;
  assert.equal(request.sessionId, "session-1");
  assert.equal(request.toolCall.toolCallId, "omp_confirm_ui-1");
  assert.equal(request.toolCall.title, "Run command?");
  assert.equal(request.toolCall.kind, "other");
  assert.equal(request.toolCall.status, "pending");
  assert.deepEqual(request.toolCall.rawInput, { method: "confirm", id: "ui-1", title: "Run command?", message: "Allow bash?" });
  assert.deepEqual(request.toolCall.content, [
    { type: "content", content: { type: "text", text: "Allow bash?" } },
  ]);
});

test("confirm without title or message is unsupported", async () => {
  const { bridge, runtime, connection } = createBridge();

  await assert.rejects(
    async () => { await bridge.handle({ method: "confirm", id: "ui-1" }); },
    (error: unknown) => error instanceof UnsupportedRuntimeEventError
      && /extension_ui_request/.test(error.message)
      && /confirm/.test(error.message)
      && /ui-1/.test(error.message),
  );
  assert.deepEqual(connection.permissionRequests, []);
  assert.deepEqual(runtime.sentFrames, []);
});

test("requestPermission rejection rejects bridge and does not write success response", async () => {
  const connection = new FakeConnection();
  connection.nextPermissionError = new Error("permission failed");
  const { bridge, runtime } = createBridge({ connection });

  await assert.rejects(
    async () => { await bridge.handle({ method: "confirm", id: "ui-1", title: "T", message: "M" }); },
    /permission failed/,
  );
  assert.deepEqual(runtime.sentFrames, []);
});

test("runtime send rejection rejects bridge", async () => {
  const runtime = new FakeRuntime();
  runtime.nextSendError = new Error("stdin closed");
  const { bridge } = createBridge({ runtime });

  await assert.rejects(
    async () => { await bridge.handle({ method: "confirm", id: "ui-1", title: "T", message: "M" }); },
    /stdin closed/,
  );
});

test("setWidget emits thought chunk from widget lines", async () => {
  const { bridge, updates } = createBridge();

  await bridge.handle({ method: "setWidget", id: "w1", widgetKey: "research", widgetLines: ["Searching", "Done"] });

  assert.deepEqual(updates, [
    { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "[research]\nSearching\nDone" } },
  ]);
});

test("setWidget deduplicates identical content by widget key", async () => {
  const { bridge, updates } = createBridge();

  await bridge.handle({ method: "setWidget", id: "w1", widgetKey: "research", widgetLines: ["Searching", "Done"] });
  await bridge.handle({ method: "setWidget", id: "w2", widgetKey: "research", widgetLines: ["Searching", "Done"] });

  assert.equal(updates.length, 1);
});

test("setWidget does not emit update for missing or empty widget lines", async () => {
  const { bridge, updates } = createBridge();

  await bridge.handle({ method: "setWidget", id: "w1", widgetKey: "research", widgetLines: undefined });
  await bridge.handle({ method: "setWidget", id: "w2", widgetKey: "empty", widgetLines: [] });

  assert.deepEqual(updates, []);
});

test("setWidget truncates overlong text to 4000 characters plus ellipsis", async () => {
  const { bridge, updates } = createBridge();

  await bridge.handle({ method: "setWidget", id: "w1", widgetKey: "research", widgetLines: ["x".repeat(5_000)] });

  const update = updates[0];
  assert.equal(update?.sessionUpdate, "agent_thought_chunk");
  const text = update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text" ? update.content.text : "";
  assert.equal(text.length, 4_001);
  assert.equal(text.endsWith("…"), true);
});

test("select input editor and unknown methods cancel OMP requests before throwing unsupported errors", async () => {
  for (const method of ["select", "input", "editor", "showDialog"]) {
    const { bridge, runtime } = createBridge();

    await assert.rejects(
      async () => bridge.handle({ method, id: "ui-1", title: "Question" }),
      (error: unknown) => error instanceof UnsupportedRuntimeEventError
        && /extension_ui_request/.test(error.message)
        && new RegExp(method).test(error.message)
        && /ui-1/.test(error.message),
    );
    assert.deepEqual(runtime.sentFrames, [{ type: "extension_ui_response", id: "ui-1", cancelled: true }]);
  }
});

test("unsupported request cancel send failures reject with the transport error", async () => {
  const runtime = new FakeRuntime();
  runtime.nextSendError = new Error("stdin closed");
  const { bridge } = createBridge({ runtime });

  await assert.rejects(
    async () => bridge.handle({ method: "select", id: "ui-1", title: "Question" }),
    /stdin closed/,
  );
});

test("fire-and-forget methods return undefined without permission send or update", () => {
  for (const method of ["setStatus", "setTitle", "notify", "set_editor_text", "cancel"]) {
    const { bridge, runtime, connection, updates } = createBridge();

    const result = bridge.handle({ method, id: "ui-1" });

    assert.equal(result, undefined);
    assert.deepEqual(connection.permissionRequests, []);
    assert.deepEqual(runtime.sentFrames, []);
    assert.deepEqual(updates, []);
  }
});
