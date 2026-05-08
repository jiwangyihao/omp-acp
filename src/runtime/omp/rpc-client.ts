import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { RuntimeAdapter } from "../RuntimeAdapter.ts";
import type { RuntimeEvent } from "../RuntimeEvents.ts";
import {
  isOmpRpcReadyFrame,
  isOmpRpcResponseFrame,
  parseOmpRpcFrame,
  type OmpRpcRequestId,
} from "./frames.ts";
import { startOmpRpcProcess, type StartOmpRpcProcessOptions } from "./process.ts";

export class OmpRpcClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OmpRpcClientError";
  }
}

export class OmpRpcResponseError extends OmpRpcClientError {
  readonly command: string;
  readonly responseError: string;

  constructor(command: string, responseError: string) {
    super(`OMP RPC ${command} response error: ${responseError}`);
    this.name = "OmpRpcResponseError";
    this.command = command;
    this.responseError = responseError;
  }
}

export type OmpRpcClientOptions = StartOmpRpcProcessOptions & { readyTimeoutMs?: number };

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

export class OmpRpcClient implements RuntimeAdapter {
  readonly process: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly diagnostics = { stderr: "" };

  private readyState: "pending" | "ready" | "failed" | "closed" = "pending";
  private readonly pending = new Map<OmpRpcRequestId, PendingRequest>();
  private readonly eventListeners = new Set<(event: RuntimeEvent) => void>();
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private closePromise: Promise<void> | undefined;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readyTimeout: NodeJS.Timeout | undefined;

  constructor(options: OmpRpcClientOptions = {}) {
    this.process = startOmpRpcProcess(options);
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.handleStdout(String(chunk)));
    this.process.stderr.on("data", (chunk) => {
      this.diagnostics.stderr += String(chunk);
    });
    this.process.on("error", (error) => this.fail(new OmpRpcClientError("OMP RPC process error", { cause: error })));
    this.process.on("exit", (code, signal) => {
      this.handleProcessExit(code, signal);
    });

    if (options.readyTimeoutMs !== undefined) {
      this.readyTimeout = setTimeout(() => {
        if (this.readyState === "pending") {
          this.fail(new OmpRpcClientError(`OMP RPC process not ready within ${options.readyTimeoutMs}ms`));
        }
      }, options.readyTimeoutMs);
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.readyState !== "ready") {
      return Promise.reject(new OmpRpcClientError("OMP RPC client not ready"));
    }

    const id = this.nextRequestId++;
    let request: Record<string, unknown>;
    try {
      request = buildCommandFrame(id, method, params);
    } catch (error) {
      return Promise.reject(toClientError(error, "Invalid OMP RPC request"));
    }

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error !== null && error !== undefined) {
          this.pending.delete(id);
          reject(new OmpRpcClientError("Failed to write OMP RPC request", { cause: error }));
        }
      });
    });
  }

  send(frame: Record<string, unknown>): Promise<void> {
    if (this.readyState !== "ready" || this.process.stdin.destroyed || this.process.stdin.writableEnded) {
      return Promise.reject(new OmpRpcClientError("OMP RPC client not ready or closed"));
    }

    return new Promise<void>((resolve, reject) => {
      this.process.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error !== null && error !== undefined) {
          reject(new OmpRpcClientError("Failed to write OMP RPC frame", { cause: error }));
          return;
        }
        resolve();
      });
    });
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    const closeError = new OmpRpcClientError("OMP RPC client closed");
    this.rejectPending(closeError);
    if (this.readyState === "pending") {
      this.rejectReady(closeError);
    }
    this.readyState = "closed";
    this.clearReadyTimeout();

    this.closePromise = new Promise<void>((resolve) => {
      if (this.process.exitCode !== null || this.process.signalCode !== null) {
        resolve();
        return;
      }

      this.process.once("close", () => resolve());
      if (!this.process.stdin.destroyed) {
        this.process.stdin.end();
      }
      this.process.kill();
    });

    return this.closePromise;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim() === "") {
        continue;
      }

      try {
        this.handleFrame(line);
      } catch (error) {
        this.fail(toClientError(error, "Failed to parse OMP RPC frame"));
        return;
      }
    }
  }

  private handleFrame(line: string): void {
    const frame = parseOmpRpcFrame(line);

    if (isOmpRpcReadyFrame(frame)) {
      if (this.readyState === "pending") {
        this.readyState = "ready";
        this.clearReadyTimeout();
        this.resolveReady();
      }
      return;
    }

    if (isOmpRpcResponseFrame(frame)) {
      const pending = this.pending.get(frame.id);
      if (pending === undefined) {
        throw new OmpRpcClientError(`Received OMP RPC response for unknown request id: ${String(frame.id)}`);
      }

      this.pending.delete(frame.id);
      if (!frame.success) {
        pending.reject(new OmpRpcResponseError(frame.command, frame.error));
      } else {
        pending.resolve(Object.hasOwn(frame, "data") ? frame.data : undefined);
      }
      return;
    }

    for (const listener of this.eventListeners) {
      listener(frame);
    }
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    const error = new OmpRpcClientError(
      `OMP RPC process exited before completing request lifecycle: code ${code ?? "null"}, signal ${signal ?? "null"}`,
    );

    this.clearReadyTimeout();
    if (this.readyState === "pending") {
      this.readyState = "failed";
      this.rejectReady(error);
    } else if (this.readyState === "ready") {
      this.readyState = "failed";
    }
    this.rejectPending(error);
  }

  private fail(error: Error): void {
    this.clearReadyTimeout();
    if (this.readyState === "pending") {
      this.readyState = "failed";
      this.rejectReady(error);
    } else if (this.readyState === "ready") {
      this.readyState = "failed";
    }
    this.rejectPending(error);
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill();
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private clearReadyTimeout(): void {
    if (this.readyTimeout !== undefined) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = undefined;
    }
  }
}

export function startOmpRpcClient(options?: OmpRpcClientOptions): OmpRpcClient {
  return new OmpRpcClient(options);
}

function buildCommandFrame(id: OmpRpcRequestId, method: string, params: unknown): Record<string, unknown> {
  switch (method) {
    case "prompt": {
      const promptParams = requireRecord(params, method);
      const message = requireString(promptParams, "message", method);
      const frame: Record<string, unknown> = { id, type: method, message };
      if (Object.hasOwn(promptParams, "images")) {
        frame.images = promptParams.images;
      }
      return frame;
    }
    case "switch_session":
      return { id, type: method, sessionPath: requireString(requireRecord(params, method), "sessionPath", method) };
    case "get_state":
    case "get_available_models":
    case "abort":
      return { id, type: method };
    case "set_model": {
      const modelParams = requireRecord(params, method);
      return {
        id,
        type: method,
        provider: requireString(modelParams, "provider", method),
        modelId: requireString(modelParams, "modelId", method),
      };
    }
    case "set_thinking_level":
      return { id, type: method, level: requireString(requireRecord(params, method), "level", method) };
    case "set_steering_mode":
    case "set_follow_up_mode":
    case "set_interrupt_mode":
      return { id, type: method, mode: requireString(requireRecord(params, method), "mode", method) };
    case "set_auto_compaction":
      return { id, type: method, enabled: requireBoolean(requireRecord(params, method), "enabled", method) };
    default:
      throw new OmpRpcClientError(`Unsupported OMP RPC method: ${method}`);
  }
}

function requireRecord(value: unknown, command: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OmpRpcClientError(`OMP RPC ${command} params must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(params: Record<string, unknown>, field: string, command: string): string {
  const value = params[field];
  if (typeof value !== "string") {
    throw new OmpRpcClientError(`OMP RPC ${command} params.${field} must be a string`);
  }
  return value;
}


function requireBoolean(params: Record<string, unknown>, field: string, command: string): boolean {
  const value = params[field];
  if (typeof value !== "boolean") {
    throw new OmpRpcClientError(`OMP RPC ${command} params.${field} must be a boolean`);
  }
  return value;
}

function toClientError(error: unknown, message: string): OmpRpcClientError {
  if (error instanceof OmpRpcClientError) {
    return error;
  }
  if (error instanceof Error) {
    return new OmpRpcClientError(message, { cause: error });
  }
  return new OmpRpcClientError(message);
}