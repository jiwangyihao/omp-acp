import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { sanitizeToolInput, sanitizeToolOutputForAcp } from "../../translate/safety.ts";

export type HostToolExecutorContext = {
  id: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  signal: AbortSignal;
  sendUpdate(partialResult: unknown): Promise<void>;
};

export type HostToolExecutor = (context: HostToolExecutorContext) => unknown | Promise<unknown>;

export type HostToolBridgeOptions = {
  registry: Record<string, HostToolExecutor>;
  sendFrame(frame: Record<string, unknown>): Promise<void>;
  emitUpdate(update: SessionUpdate): Promise<void>;
  failPrompt(error: unknown): void;
};

type ActiveCall = {
  id: string;
  toolCallId: string;
  controller: AbortController;
  cancelled: boolean;
};

export class HostToolBridge {
  private readonly registry: Record<string, HostToolExecutor>;
  private readonly sendFrame: (frame: Record<string, unknown>) => Promise<void>;
  private readonly emitUpdate: (update: SessionUpdate) => Promise<void>;
  private readonly failPrompt: (error: unknown) => void;
  private readonly activeCallsById = new Map<string, ActiveCall>();
  private readonly activeCallIdByToolCallId = new Map<string, string>();

  constructor(options: HostToolBridgeOptions) {
    this.registry = options.registry;
    this.sendFrame = options.sendFrame;
    this.emitUpdate = options.emitUpdate;
    this.failPrompt = options.failPrompt;
  }

  async handle(raw: Record<string, unknown>): Promise<void> {
    if (raw.type === "host_tool_call") {
      await this.handleCall(raw);
      return;
    }

    if (raw.type === "host_tool_cancel") {
      await this.handleCancel(raw);
    }
  }

  private async handleCall(raw: Record<string, unknown>): Promise<void> {
    const id = stringValue(raw.id);
    const toolName = stringValue(raw.toolName) ?? stringValue(raw.name);
    const toolCallId = stringValue(raw.toolCallId) ?? id ?? "unknown_host_tool_call";
    const input = Object.hasOwn(raw, "arguments") ? raw.arguments : raw.input;

    if (id === undefined || toolName === undefined) {
      const message = id === undefined ? "Host tool call missing id" : "Host tool call missing tool name";
      await this.emitUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        rawOutput: { error: message },
      });
      if (id !== undefined) {
        await this.sendErrorResult(id, message);
      }
      return;
    }

    await this.emitUpdate({
      sessionUpdate: "tool_call",
      toolCallId,
      title: toolName,
      kind: "other",
      status: "pending",
      rawInput: sanitizeToolInput(input),
    });

    const executor = this.registry[toolName];
    if (executor === undefined) {
      const message = `Unsupported host tool: ${toolName}`;
      await this.emitFailed(toolCallId, { error: message });
      await this.sendErrorResult(id, message);
      return;
    }

    const active: ActiveCall = { id, toolCallId, controller: new AbortController(), cancelled: false };
    this.activeCallsById.set(id, active);
    this.activeCallIdByToolCallId.set(toolCallId, id);

    try {
      const result = await executor({
        id,
        toolCallId,
        toolName,
        arguments: input,
        signal: active.controller.signal,
        sendUpdate: async (partialResult) => {
          if (!active.cancelled) {
            await this.transmit({ type: "host_tool_update", id, partialResult });
          }
        },
      });

      if (!active.cancelled) {
        await this.emitUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
          rawOutput: sanitizeToolOutputForAcp(result),
        });
        await this.transmit({ type: "host_tool_result", id, result });
      }
    } catch (error) {
      if (!active.cancelled) {
        const message = errorMessage(error);
        await this.emitFailed(toolCallId, { error: message });
        await this.sendErrorResult(id, message);
      }
    } finally {
      this.activeCallsById.delete(id);
      this.activeCallIdByToolCallId.delete(toolCallId);
    }
  }

  private async handleCancel(raw: Record<string, unknown>): Promise<void> {
    const targetId = stringValue(raw.targetId);
    const cancelToolCallId = stringValue(raw.toolCallId);
    const requestedId = targetId ?? cancelToolCallId;
    if (requestedId === undefined) {
      await this.emitUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "unknown_host_tool_call",
        status: "failed",
        rawOutput: { error: "Host tool cancel missing targetId" },
      });
      return;
    }

    let active = targetId === undefined ? undefined : this.activeCallsById.get(targetId);
    if (active === undefined && cancelToolCallId !== undefined) {
      const id = this.activeCallIdByToolCallId.get(cancelToolCallId);
      active = id === undefined ? undefined : this.activeCallsById.get(id);
    }

    if (active === undefined) {
      const message = `No active host tool call: ${requestedId}`;
      await this.emitFailed(requestedId, { error: message });
      if (targetId !== undefined) {
        await this.sendErrorResult(targetId, message);
      }
      return;
    }

    active.cancelled = true;
    active.controller.abort();

    await this.emitFailed(active.toolCallId, { cancelled: true });
    await this.sendErrorResult(active.id, "Host tool call cancelled");
  }

  private async emitFailed(toolCallId: string, rawOutput: Record<string, unknown>): Promise<void> {
    await this.emitUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "failed",
      rawOutput: sanitizeToolOutputForAcp(rawOutput),
    });
  }

  private async sendErrorResult(id: string, message: string): Promise<void> {
    await this.transmit({
      type: "host_tool_result",
      id,
      isError: true,
      result: { content: [{ type: "text", text: message }] },
    });
  }

  private async transmit(frame: Record<string, unknown>): Promise<void> {
    try {
      await this.sendFrame(frame);
    } catch (error) {
      this.failPrompt(error);
      throw error;
    }
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "Host tool execution failed";
}