import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { sanitizeContentBlock, summarizeUnknownContentBlock } from "./content.ts";
import { isRecord, sanitizeTextForAcp } from "./safety.ts";

export type StreamedAssistantMessageIndex = {
  has(key: string): boolean;
  add(key: string): void;
};

type ChunkType = "agent_message_chunk" | "agent_thought_chunk";

export function messageUpdateEventToSessionUpdate(raw: Record<string, unknown>): SessionUpdate | undefined {
  if (isRecord(raw.assistantMessageEvent)) {
    return assistantMessageEventToSessionUpdate(raw.assistantMessageEvent);
  }

  const text = extractLegacyMessageText(raw);
  if (typeof text !== "string" || text.length === 0) return undefined;

  return textUpdate(isThought(raw) ? "agent_thought_chunk" : "agent_message_chunk", sanitizeTextForAcp(text));
}

export function messageToSessionUpdates(
  message: unknown,
  options: { role?: "user" | "assistant"; unknownText?: "drop" | "summarize"; includeToolCalls?: boolean } = {},
): SessionUpdate[] {
  const role = options.role ?? (isRecord(message) && message.role === "assistant" ? "assistant" : "user");
  const chunks = messageContentItems(message);
  const updates: SessionUpdate[] = [];

  chunks.forEach((item) => {
    const update = contentItemToSessionUpdate(item, role, options.unknownText ?? "drop", options.includeToolCalls ?? false);
    if (update !== undefined) updates.push(update);
  });

  return updates;
}

export function agentEndMessagesToFallbackUpdates(raw: Record<string, unknown>, emitted: StreamedAssistantMessageIndex): SessionUpdate[] {
  if (!Array.isArray(raw.messages)) return [];
  const updates: SessionUpdate[] = [];

  let assistantIndex = 0;

  raw.messages.forEach((message) => {
    if (!isRecord(message) || message.role !== "assistant") return;
    const chunks = messageContentItems(message);
    chunks.forEach((item, contentIndex) => {
      const update = contentItemToSessionUpdate(item, "assistant", "summarize", false);
      if (update === undefined) return;
      const key = assistantMessageContentKey(message, contentIndex, update.sessionUpdate, assistantIndex);
      if (emitted.has(key)) return;
      emitted.add(key);
      updates.push(update);
    });
    assistantIndex += 1;
  });

  return updates;
}

export function streamedAssistantMessageKey(raw: Record<string, unknown>): string | undefined {
  if (!isRecord(raw.assistantMessageEvent)) return undefined;
  const updateType = assistantEventChunkType(raw.assistantMessageEvent.type);
  if (updateType === undefined) return undefined;
  const message = isRecord(raw.message) ? raw.message : raw;
  const contentIndex = numberOrString(raw.assistantMessageEvent.contentIndex) ?? "0";
  return assistantMessageContentKey(message, contentIndex, updateType);
}

function assistantMessageEventToSessionUpdate(event: Record<string, unknown>): SessionUpdate | undefined {
  const type = event.type;
  if (type === "toolcall_start" || type === "toolcall_delta" || type === "toolcall_end") return undefined;
  if (type === "text_delta") return typeof event.delta === "string" && event.delta.length > 0 ? textUpdate("agent_message_chunk", sanitizeTextForAcp(event.delta)) : undefined;
  if (type === "thinking_delta") return typeof event.delta === "string" && event.delta.length > 0 ? textUpdate("agent_thought_chunk", sanitizeTextForAcp(event.delta)) : undefined;
  if (type === "error") {
    const error = isRecord(event.error) ? event.error : undefined;
    const message = typeof error?.errorMessage === "string" ? error.errorMessage : typeof error?.message === "string" ? error.message : undefined;
    return message !== undefined && message.length > 0 ? textUpdate("agent_message_chunk", sanitizeTextForAcp(message)) : undefined;
  }
  return undefined;
}

function contentItemToSessionUpdate(
  item: unknown,
  role: "user" | "assistant",
  unknownText: "drop" | "summarize",
  includeToolCalls: boolean,
): SessionUpdate | undefined {
  if (!includeToolCalls && isRecord(item) && (item.type === "toolCall" || item.type === "tool_result" || item.type === "toolResult")) return undefined;

  if (typeof item === "string") return textUpdate(role === "assistant" ? "agent_message_chunk" : "user_message_chunk", sanitizeTextForAcp(item));

  if (isRecord(item) && (item.type === "thinking" || item.type === "thought" || item.type === "reasoning")) {
    const text = typeof item.thinking === "string" ? item.thinking : typeof item.text === "string" ? item.text : undefined;
    return role === "assistant" && text !== undefined && text.length > 0 ? textUpdate("agent_thought_chunk", sanitizeTextForAcp(text)) : undefined;
  }

  const block = sanitizeContentBlock(item);
  if (block !== undefined) return { sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk", content: block } as SessionUpdate;

  if (unknownText === "summarize" && isRecord(item)) {
    const summary = summarizeUnknownContentBlock(item);
    if (summary !== undefined) return textUpdate(role === "assistant" ? "agent_message_chunk" : "user_message_chunk", sanitizeTextForAcp(summary));
  }

  return undefined;
}

function messageContentItems(message: unknown): unknown[] {
  if (typeof message === "string") return [message];
  if (!isRecord(message)) return [];
  if (Array.isArray(message.content)) return message.content;
  if (message.content !== undefined) return [message.content];
  if (typeof message.text === "string") return [message.text];
  if (typeof message.message === "string") return [message.message];
  return [];
}

function extractLegacyMessageText(raw: Record<string, unknown>): unknown {
  if (typeof raw.content === "string") return raw.content;
  if (typeof raw.text === "string") return raw.text;
  if (typeof raw.message === "string") return raw.message;
  if (isRecord(raw.message)) {
    if (typeof raw.message.content === "string") return raw.message.content;
    if (typeof raw.message.text === "string") return raw.message.text;
    if (typeof raw.message.message === "string") return raw.message.message;
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

function assistantEventChunkType(type: unknown): ChunkType | undefined {
  if (type === "text_delta" || type === "error") return "agent_message_chunk";
  if (type === "thinking_delta") return "agent_thought_chunk";
  return undefined;
}

function assistantMessageContentKey(
  message: Record<string, unknown>,
  contentIndex: string | number,
  chunkType: ChunkType | SessionUpdate["sessionUpdate"],
  fallbackIndex?: number,
): string {
  const id = numberOrString(message.responseId) ?? numberOrString(message.id) ?? numberOrString(message.messageId) ?? `message:${fallbackIndex ?? 0}`;
  const timestamp = numberOrString(message.timestamp) ?? "no-ts";
  return `${id}:${timestamp}:${String(contentIndex)}:${String(chunkType)}`;
}

function numberOrString(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function textUpdate(sessionUpdate: ChunkType | "user_message_chunk", text: string): SessionUpdate {
  return { sessionUpdate, content: { type: "text", text } } as SessionUpdate;
}