import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { RuntimeEvent } from "../runtime/RuntimeEvents.ts";
import { RuntimeEventTranslationError, UnsupportedRuntimeEventError } from "./errors.ts";

export { RuntimeEventTranslationError, UnsupportedRuntimeEventError } from "./errors.ts";

export function translateRuntimeEventToSessionUpdate(event: RuntimeEvent): SessionUpdate | undefined {
  switch (event.eventType) {
    case "message_update":
      return translateMessageUpdate(event.raw);
    case "agent_start":
      return undefined;
    case "extension_error":
      throw new RuntimeEventTranslationError(formatExtensionError(event.raw));
    case "host_tool_call":
    case "host_tool_cancel":
      throw new UnsupportedRuntimeEventError(event.eventType);
    default:
      return undefined;
  }
}

function translateMessageUpdate(raw: Record<string, unknown>): SessionUpdate | undefined {
  const text = extractMessageText(raw);

  if (typeof text !== "string" || text.length === 0) {
    return undefined;
  }

  return {
    sessionUpdate: isThought(raw) ? "agent_thought_chunk" : "agent_message_chunk",
    content: { type: "text", text },
  };
}

function extractMessageText(raw: Record<string, unknown>): unknown {
  if (typeof raw.content === "string") {
    return raw.content;
  }
  if (typeof raw.text === "string") {
    return raw.text;
  }
  if (typeof raw.message === "string") {
    return raw.message;
  }
  if (isRecord(raw.message)) {
    if (typeof raw.message.content === "string") {
      return raw.message.content;
    }
    if (typeof raw.message.text === "string") {
      return raw.message.text;
    }
    if (typeof raw.message.message === "string") {
      return raw.message.message;
    }
  }

  return undefined;
}

function isThought(raw: Record<string, unknown>): boolean {
  return hasThoughtMarker(raw) || (isRecord(raw.message) && hasThoughtMarker(raw.message));
}

function hasThoughtMarker(value: Record<string, unknown>): boolean {
  return isThoughtValue(value.type) || isThoughtValue(value.kind) || isThoughtValue(value.role) || isThoughtValue(value.channel);
}

function isThoughtValue(value: unknown): boolean {
  return value === "thought" || value === "reasoning";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatExtensionError(raw: Record<string, unknown>): string {
  const message = typeof raw.message === "string" && raw.message.length > 0 ? raw.message : "extension_error";
  return `Runtime extension error: ${message}`;
}