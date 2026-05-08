type JsonObject = Record<string, unknown>;

const scenario = process.argv[2] ?? "normal";
let stdinBuffer = "";
let handledRequests = 0;
let pendingCancelPrompt: { id: unknown; params: unknown } | undefined;
let pendingHostToolPrompt: { id: unknown; params: unknown } | undefined;

const CONTROL_STATE = {
  model: { provider: "fixture", id: "model", name: "Fixture Model" },
  thinkingLevel: "low",
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  interruptMode: "immediate",
  autoCompactionEnabled: true,
};

const AVAILABLE_MODELS = [{ provider: "fixture", id: "model", name: "Fixture Model", thinking: { minLevel: "minimal", maxLevel: "high" } }];

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

function handleRequest(request: JsonObject): void {
  const id = request.id;
  const command = typeof request.type === "string" ? request.type : "";

  if (scenario === "raw-frame-observer") {
    writeFrame({ type: "raw_frame_observed", frame: request });
    if (command === "host_tool_result") {
      return;
    }
  }

  if (scenario === "session-host-tool-unregistered" && command === "host_tool_result") {
    const pending = pendingHostToolPrompt;
    pendingHostToolPrompt = undefined;
    if (pending !== undefined) {
      writeSuccess(pending.id, "prompt", { ok: true });
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
    writeSuccess(id, command, CONTROL_STATE);
    return;
  }

  if (command === "get_available_models") {
    writeSuccess(id, command, AVAILABLE_MODELS);
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
    writeSuccess(id, command, { provider: request.provider, modelId: request.modelId });
    return;
  }

  if (command === "set_thinking_level") {
    writeSuccess(id, command, { level: request.level });
    return;
  }

  if (command === "set_steering_mode") {
    setTimeout(() => writeSuccess(id, command, { mode: request.mode }), 50);
    return;
  }

  if (command === "set_follow_up_mode" || command === "set_interrupt_mode") {
    writeSuccess(id, command, { mode: request.mode });
    return;
  }

  if (command === "set_auto_compaction") {
    writeSuccess(id, command, { enabled: request.enabled });
    return;
  }

  if (command === "prompt" && !isValidPromptCommand(request)) {
    writeFailure(id, command, "invalid prompt command frame");
    return;
  }
  if (command === "prompt") {
    if (scenario === "session-happy") {
      const prompt = getPromptText(request);
      writeFrame({ type: "message_update", content: prompt });
      writeFrame({ type: "message_update", kind: "thought", content: "thinking" });
      writeSuccess(id, command, { ok: true });
      return;
    }

    if (scenario === "session-images") {
      const prompt = getPromptText(request);
      writeFrame({ type: "message_update", content: JSON.stringify({ prompt, images: getPromptImages(request) }) });
      writeSuccess(id, command, { ok: true });
      return;
    }

    if (scenario === "session-error") {
      writeFrame({ type: "extension_error", message: "boom" });
      return;
    }

    if (scenario === "extension-ui-request") {
      writeFrame({ type: "extension_ui_request", method: "showDialog", id: "ui-smoke-1" });
      return;
    }
    if (scenario === "session-cancel") {
      pendingCancelPrompt = { id, params: request };
      return;
    }

    if (scenario === "session-cwd") {
      writeFrame({ type: "message_update", content: process.cwd() });
      writeSuccess(id, command, { ok: true });
      return;
    }

    if (scenario === "session-tool-events") {
      writeFrame({ type: "tool_execution_start", toolCallId: "tool_smoke_1", name: "read_file", title: "Read config", status: "running", input: { path: "config.json" }, path: "config.json", line: 3 });
      writeFrame({ type: "tool_execution_update", toolCallId: "tool_smoke_1", status: "running", content: "reading config", path: "config.json", line: 3 });
      writeFrame({
        type: "tool_execution_update",
        toolCallId: "tool_smoke_1",
        status: "running",
        diff: { path: "config.json", oldText: "old", newText: "new" },
      });
      writeFrame({ type: "tool_execution_end", toolCallId: "tool_smoke_1", status: "completed", output: "done" });
      writeSuccess(id, command, { ok: true });
      return;
    }

    if (scenario === "session-host-tool-unregistered") {
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
        writeSuccess(pending.id, "prompt", { ok: true });
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