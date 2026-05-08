import type { RuntimeEvent } from "../RuntimeEvents.ts";

export class OmpRpcFrameParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OmpRpcFrameParseError";
  }
}

export type OmpRpcRequestId = string | number;

export type OmpRpcReadyFrame = {
  type: "ready";
};

export type OmpRpcResponseFrame = {
  type: "response";
  id: OmpRpcRequestId;
  result?: unknown;
  error?: unknown;
};

export type OmpRpcFrame = OmpRpcReadyFrame | OmpRpcResponseFrame | RuntimeEvent;

export function parseOmpRpcFrame(line: string): OmpRpcFrame {
  const rawFrame = parseJson(line);

  if (!isRecord(rawFrame)) {
    throw new OmpRpcFrameParseError("Invalid OMP RPC JSONL frame: frame must be an object");
  }

  const frameType = rawFrame.type;
  if (typeof frameType !== "string") {
    throw new OmpRpcFrameParseError("Invalid OMP RPC JSONL frame: missing string type");
  }

  if (frameType === "ready") {
    return { type: "ready" };
  }

  if (frameType === "response") {
    return parseResponseFrame(rawFrame);
  }

  return {
    type: "event",
    eventType: frameType,
    raw: rawFrame,
  };
}

export function isOmpRpcResponseFrame(frame: OmpRpcFrame): frame is OmpRpcResponseFrame {
  return frame.type === "response";
}

export function isOmpRpcReadyFrame(frame: OmpRpcFrame): frame is OmpRpcReadyFrame {
  return frame.type === "ready";
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    throw new OmpRpcFrameParseError("Invalid OMP RPC JSONL frame: malformed JSON", {
      cause: error,
    });
  }
}

function parseResponseFrame(rawFrame: Record<string, unknown>): OmpRpcResponseFrame {
  const id = rawFrame.id;
  if (typeof id !== "string" && typeof id !== "number") {
    throw new OmpRpcFrameParseError("Invalid OMP RPC response frame: missing id");
  }

  const hasResult = Object.hasOwn(rawFrame, "result");
  const hasError = Object.hasOwn(rawFrame, "error");
  if (hasResult === hasError) {
    throw new OmpRpcFrameParseError(
      "Invalid OMP RPC response frame: must include exactly one result or error",
    );
  }

  const response: OmpRpcResponseFrame = { type: "response", id };

  if (hasResult) {
    response.result = rawFrame.result;
  }

  if (hasError) {
    response.error = rawFrame.error;
  }

  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}