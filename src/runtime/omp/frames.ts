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

export type OmpRpcResponseFrame =
  | {
      type: "response";
      id: OmpRpcRequestId;
      command: string;
      success: true;
      data?: unknown;
    }
  | {
      type: "response";
      id: OmpRpcRequestId;
      command: string;
      success: false;
      error: string;
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
  if ((typeof id !== "string" || id.length === 0) && typeof id !== "number") {
    throw new OmpRpcFrameParseError("Invalid OMP RPC response frame: missing id");
  }

  const command = rawFrame.command;
  if (typeof command !== "string" || command.length === 0) {
    throw new OmpRpcFrameParseError("Invalid OMP RPC response frame: missing string command");
  }

  const success = rawFrame.success;
  if (typeof success !== "boolean") {
    throw new OmpRpcFrameParseError("Invalid OMP RPC response frame: missing boolean success");
  }

  if (!success) {
    const error = rawFrame.error;
    if (typeof error !== "string") {
      throw new OmpRpcFrameParseError("Invalid OMP RPC response frame: missing string error");
    }

    return { type: "response", id, command, success: false, error };
  }

  if (Object.hasOwn(rawFrame, "data")) {
    return { type: "response", id, command, success: true, data: rawFrame.data };
  }

  return { type: "response", id, command, success: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}