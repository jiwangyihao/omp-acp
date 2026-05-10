type JsonObject = Record<string, unknown>;

const scenario = process.argv[2] ?? "normal";
let stdinBuffer = "";
let handledRequests = 0;
let pendingCancelPrompt: { id: unknown; params: unknown } | undefined;
let pendingHostToolPrompt: { id: unknown; params: unknown } | undefined;
let pendingConfirmPrompt: { promptId: unknown; uiId: string } | undefined;

const availableModels = [
  { provider: "fixture", id: "model", name: "Fixture Model", thinking: { minLevel: "minimal", maxLevel: "high" } },
  { provider: "fixture", id: "model-2", name: "Fixture Model 2", thinking: { minLevel: "minimal", maxLevel: "medium" } },
];

const controlState = {
  model: { provider: "fixture", id: "model", name: "Fixture Model", thinking: { minLevel: "minimal", maxLevel: "high" } },
  thinkingLevel: "low",
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  interruptMode: "immediate",
  autoCompactionEnabled: true,
  sessionId: "fixture-runtime-session",
};
let activeToolNames = ["read", "ask", "plugin_tool"];

function writeFrame(frame: JsonObject): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function writeReady(): void {
  writeFrame({ type: "ready" });
}

function writeSuccess(id: unknown, command: string, data?: unknown): void {
  const frame: JsonObject = { id, type: "response", command, success: true };
  if (data !== undefined) {
    frame.data = data;
  }
  writeFrame(frame);
}

function writeFailure(id: unknown, command: string, error: string): void {
  writeFrame({ id, type: "response", command, success: false, error });
}

function writeAgentEnd(): void {
  writeFrame({ type: "agent_end", messages: [] });
}

function handleRequest(request: JsonObject): void {
  const id = request.id;
  const command = typeof request.type === "string" ? request.type : "";

  if (scenario === "raw-frame-observer") {
    writeFrame({ type: "raw_frame_observed", frame: request });
    if (command === "host_tool_result") {
      return;
    }
  }

  if (command === "extension_ui_response") {
    if (pendingConfirmPrompt !== undefined && request.id === pendingConfirmPrompt.uiId) {
      const confirmed = request.confirmed === true;
      writeFrame({ type: "message_update", content: confirmed ? "confirm accepted" : "confirm rejected" });
      pendingConfirmPrompt = undefined;
      writeAgentEnd();
    }
    return;
  }

  if (scenario === "session-host-tool-unregistered" && command === "host_tool_result") {
    const pending = pendingHostToolPrompt;
    pendingHostToolPrompt = undefined;
    if (pending !== undefined) {
      writeAgentEnd();
    }
    return;
  }

  handledRequests += 1;

  if (scenario === "malformed-on-request" && handledRequests === 1) {
    process.stdout.write("{bad json\n");
    return;
  }

  if (scenario === "exit-on-request" && handledRequests === 1) {
    process.exit(42);
  }

  if (command === "get_state") {
    if (scenario === "event-before-response") {
      writeFrame({ type: "message_update", content: "hello" });
    }
    writeSuccess(id, command, { ...structuredClone(controlState), dumpTools: activeToolNames.map((name) => ({ name })) });
    return;
  }

  if (command === "get_available_models") {
    writeSuccess(id, command, structuredClone(availableModels));
    return;
  }

  if (command === "switch_session") {
    writeSuccess(id, command, { ok: true, sessionPath: request.sessionPath });
    return;
  }

  if (command === "set_model") {
    if (request.provider === "fail") {
      writeFailure(id, command, "fixture failure");
      return;
    }
    const model = availableModels.find((candidate) => candidate.provider === request.provider && candidate.id === request.modelId);
    if (model === undefined) {
      writeFailure(id, command, `fixture model not found: ${String(request.provider)}/${String(request.modelId)}`);
      return;
    }
    controlState.model = structuredClone(model);
    writeSuccess(id, command, structuredClone(model));
    return;
  }

  if (command === "set_thinking_level") {
    if (typeof request.level !== "string") {
      writeFailure(id, command, "missing thinking level");
      return;
    }
    controlState.thinkingLevel = request.level;
    writeSuccess(id, command, { level: request.level });
    return;
  }

  if (command === "set_steering_mode") {
    if (request.mode !== "all" && request.mode !== "one-at-a-time") {
      writeFailure(id, command, "invalid steering mode");
      return;
    }
    controlState.steeringMode = request.mode;
    setTimeout(() => writeSuccess(id, command, { mode: request.mode }), 50);
    return;
  }

  if (command === "set_follow_up_mode") {
    if (request.mode !== "all" && request.mode !== "one-at-a-time") {
      writeFailure(id, command, "invalid follow-up mode");
      return;
    }
    controlState.followUpMode = request.mode;
    writeSuccess(id, command, { mode: request.mode });
    return;
  }

  if (command === "set_interrupt_mode") {
    if (request.mode !== "immediate" && request.mode !== "wait") {
      writeFailure(id, command, "invalid interrupt mode");
      return;
    }
    controlState.interruptMode = request.mode;
    writeSuccess(id, command, { mode: request.mode });
    return;
  }

  if (command === "set_auto_compaction") {
    if (typeof request.enabled !== "boolean") {
      writeFailure(id, command, "invalid auto compaction value");
      return;
    }
    controlState.autoCompactionEnabled = request.enabled;
    writeSuccess(id, command, { enabled: request.enabled });
    return;
  }

  if (command === "set_active_tools") {
    if (!Array.isArray(request.toolNames) || request.toolNames.some((item) => typeof item !== "string")) {
      writeFailure(id, command, "invalid active tool names");
      return;
    }
    activeToolNames = [...request.toolNames];
    writeSuccess(id, command, { toolNames: activeToolNames });
    return;
  }

  if (command === "prompt" && !isValidPromptCommand(request)) {
    writeFailure(id, command, "invalid prompt command frame");
    return;
  }
  if (command === "prompt") {
    if (scenario === "session-happy") {
      const prompt = getPromptText(request);
      writeSuccess(id, command, { ok: true });
      writeFrame({ type: "message_update", content: prompt });
      writeFrame({ type: "message_update", kind: "thought", content: "thinking" });
      writeAgentEnd();
      return;
    }

    if (scenario === "session-images") {
      const prompt = getPromptText(request);
      writeSuccess(id, command, { ok: true });
      writeFrame({ type: "message_update", content: JSON.stringify({ prompt, images: getPromptImages(request) }) });
      writeAgentEnd();
      return;
    }

    if (scenario === "session-error") {
      writeSuccess(id, command, { ok: true });
      writeFrame({ type: "extension_error", message: "boom" });
      return;
    }

    if (scenario === "extension-ui-request") {
      writeSuccess(id, command, { ok: true });
      writeFrame({ type: "extension_ui_request", method: "showDialog", id: "ui-smoke-1" });
      return;
    }

    if (scenario === "extension-ui-set-widget") {
      writeSuccess(id, command, { ok: true });
      writeFrame({ type: "extension_ui_request", method: "setWidget", id: "ui-widget-1", widgetKey: "autoresearch", widgetLines: ["status"] });
      writeFrame({ type: "message_update", content: "widget ignored" });
      writeAgentEnd();
      return;
    }

    if (scenario === "extension-ui-confirm" || scenario === "extension-ui-confirm-reject") {
      writeSuccess(id, command, { ok: true });
      pendingConfirmPrompt = { promptId: id, uiId: "ui-confirm-1" };
      writeFrame({ type: "extension_ui_request", method: "confirm", id: "ui-confirm-1", title: "Approve action", message: "Allow action?" });
      return;
    }

    if (scenario === "extension-ui-set-widget-display") {
      writeSuccess(id, command, { ok: true });
      writeFrame({ type: "extension_ui_request", method: "setWidget", id: "ui-widget-1", widgetKey: "autoresearch", widgetLines: ["Searching", "Done"] });
      writeFrame({ type: "message_update", content: "widget displayed" });
      writeAgentEnd();
      return;
    }
    if (scenario === "session-cancel") {
      writeSuccess(id, command, { ok: true });
      pendingCancelPrompt = { id, params: request };
      return;
    }

    if (scenario === "session-cwd") {
      writeSuccess(id, command, { ok: true });
      writeFrame({ type: "message_update", content: process.cwd() });
      writeAgentEnd();
      return;
    }

    if (scenario === "session-tool-events") {
      writeSuccess(id, command, { ok: true });
      writeFrame({ type: "tool_execution_start", toolCallId: "tool_smoke_1", toolName: "bash", args: { command: "npm run check", cwd: "C:/repo" }, status: "running" });
      writeFrame({
        type: "tool_execution_update",
        toolCallId: "tool_smoke_1",
        toolName: "bash",
        args: { command: "npm run check", cwd: "C:/repo" },
        status: "running",
        partialResult: { content: [{ type: "text", text: "running config check" }], details: { exitCode: 0 } },
      });
      writeFrame({
        type: "tool_execution_update",
        toolCallId: "tool_smoke_1",
        status: "running",
        diff: { path: "config.json", oldText: "old", newText: "new" },
      });
      writeFrame({ type: "tool_execution_end", toolCallId: "tool_smoke_1", status: "completed", result: { content: [{ type: "text", text: "done" }], details: { exitCode: 0 } } });
      writeAgentEnd();
      return;
    }

    if (scenario === "session-host-tool-unregistered") {
      writeSuccess(id, command, { ok: true });
      pendingHostToolPrompt = { id, params: request };
      writeFrame({ type: "host_tool_call", id: "host_smoke_1", toolCallId: "host_tool_smoke_1", toolName: "missing_tool", arguments: { value: 1 } });
      return;
    }

    if (scenario === "raw-frame-observer") {
      writeSuccess(id, command);
      return;
    }
  }

  if (command === "abort" && scenario === "session-cancel") {
    writeSuccess(id, command, { ok: true });
    const pending = pendingCancelPrompt;
    pendingCancelPrompt = undefined;
    if (pending !== undefined) {
      setTimeout(() => {
        writeFrame({ type: "message_update", content: "late message" });
        writeAgentEnd();
      }, 50);
    }
    return;
  }


  writeFailure(id, command || "unknown", `unsupported fixture method: ${String(command)}`);
}

function getPromptText(params: unknown): string {
  if (typeof params === "object" && params !== null && !Array.isArray(params)) {
    const promptParams = params as { message?: unknown };
    if (typeof promptParams.message === "string") {
      return promptParams.message;
    }
  }
  return "";
}

function isValidPromptCommand(params: unknown): boolean {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return false;
  }
  const promptParams = params as Record<string, unknown>;
  return (
    typeof promptParams.message === "string" &&
    !Object.hasOwn(promptParams, "prompt") &&
    !Object.hasOwn(promptParams, "sessionId") &&
    !Object.hasOwn(promptParams, "method") &&
    !Object.hasOwn(promptParams, "params")
  );
}

function getPromptImages(params: unknown): unknown {
  if (typeof params === "object" && params !== null && !Array.isArray(params) && Array.isArray((params as { images?: unknown }).images)) {
    return (params as { images: unknown[] }).images;
  }
  return [];
}


function handleStdinChunk(chunk: string): void {
  stdinBuffer += chunk;

  while (true) {
    const newlineIndex = stdinBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      return;
    }

    const line = stdinBuffer.slice(0, newlineIndex).replace(/\r$/, "");
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (line.trim() === "") {
      continue;
    }

    try {
      const request = JSON.parse(line) as unknown;
      if (typeof request === "object" && request !== null && !Array.isArray(request)) {
        handleRequest(request as JsonObject);
      }
    } catch {
      // Malformed stdin is outside this fixture's contract.
    }
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => handleStdinChunk(String(chunk)));

if (scenario === "delayed-ready") {
  setTimeout(writeReady, 100);
} else {
  writeReady();
}

if (scenario === "stderr") {
  process.stderr.write("fixture warning\n");
}