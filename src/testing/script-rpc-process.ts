type JsonObject = Record<string, unknown>;

const scenario = process.argv[2] ?? "normal";
let stdinBuffer = "";
let handledRequests = 0;

function writeFrame(frame: JsonObject): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function writeReady(): void {
  writeFrame({ type: "ready" });
}

function handleRequest(request: JsonObject): void {
  handledRequests += 1;

  if (scenario === "malformed-on-request" && handledRequests === 1) {
    process.stdout.write("{bad json\n");
    return;
  }

  if (scenario === "exit-on-request" && handledRequests === 1) {
    process.exit(42);
  }

  const id = request.id;
  const method = request.method;

  if (method === "echo") {
    const result: JsonObject = { method };
    if (Object.hasOwn(request, "params")) {
      result.params = request.params;
    }
    writeFrame({ type: "response", id, result });
    return;
  }

  if (method === "slowEcho") {
    setTimeout(() => {
      writeFrame({ type: "response", id, result: { method, params: request.params } });
    }, 50);
    return;
  }

  if (method === "fastEcho") {
    writeFrame({ type: "response", id, result: { method, params: request.params } });
    return;
  }

  if (method === "eventThenResponse") {
    writeFrame({ type: "message_update", content: "hello" });
    writeFrame({ type: "response", id, result: { ok: true } });
    return;
  }

  if (method === "fail") {
    writeFrame({ type: "response", id, error: "fixture failure" });
    return;
  }

  writeFrame({ type: "response", id, error: `unsupported fixture method: ${String(method)}` });
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