import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import { isPrivateAcpVisibleKey, isRecord, sanitizeTextForAcp } from "./safety.ts";

export type UnknownTextPolicy = "drop" | "summarize";
export type ToolCallContent = NonNullable<Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>["content"]>[number];
export type ToolCallContentBlock = Extract<ToolCallContent, { type: "content" }>;

export function sanitizeContentBlock(value: unknown): ContentBlock | undefined {
  if (typeof value === "string") return { type: "text", text: sanitizeTextForAcp(value) };
  if (!isRecord(value)) return undefined;

  switch (value.type) {
    case "text":
      return typeof value.text === "string" ? { type: "text", text: sanitizeTextForAcp(value.text) } : undefined;
    case "image":
      if (typeof value.data !== "string" || typeof value.mimeType !== "string") return undefined;
      return typeof value.uri === "string"
        ? { type: "image", data: value.data, mimeType: sanitizeTextForAcp(value.mimeType), uri: sanitizeTextForAcp(value.uri) }
        : { type: "image", data: value.data, mimeType: sanitizeTextForAcp(value.mimeType) };
    case "resource_link":
      return sanitizeResourceLink(value);
    case "resource":
      return sanitizeResource(value);
    default:
      return undefined;
  }
}

export function contentItemsToToolCallContent(
  items: unknown,
  options: { unknownText?: UnknownTextPolicy } = {},
): ToolCallContentBlock[] {
  const values = Array.isArray(items) ? items : [items];
  const content: ToolCallContentBlock[] = [];

  for (const item of values) {
    const block = sanitizeContentBlock(item);
    if (block !== undefined) {
      content.push({ type: "content", content: block });
      continue;
    }

    if (options.unknownText === "summarize" && isRecord(item)) {
      const summary = summarizeUnknownContentBlock(item);
      if (summary !== undefined) content.push({ type: "content", content: { type: "text", text: summary } });
    }
  }

  return content;
}

export function summarizeUnknownContentBlock(block: Record<string, unknown>): string | undefined {
  if (hasPrivateKey(block) || isPrivateBlockType(block.type)) return undefined;

  for (const key of ["type", "title", "name", "label", "text", "summary", "message", "content"]) {
    const value = block[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }

  return undefined;
}

function sanitizeResourceLink(value: Record<string, unknown>): ContentBlock | undefined {
  if (typeof value.uri !== "string" || typeof value.name !== "string") return undefined;
  const block: Record<string, unknown> = { type: "resource_link", uri: sanitizeTextForAcp(value.uri), name: sanitizeTextForAcp(value.name) };
  for (const key of ["title", "description", "mimeType"]) {
    if (typeof value[key] === "string") block[key] = sanitizeTextForAcp(value[key]);
  }
  if (typeof value.size === "number") block.size = value.size;
  return block as ContentBlock;
}

function sanitizeResource(value: Record<string, unknown>): ContentBlock | undefined {
  if (!isRecord(value.resource) || hasPrivateKey(value.resource)) return undefined;
  const resource: Record<string, unknown> = {};
  if (typeof value.resource.uri === "string") resource.uri = sanitizeTextForAcp(value.resource.uri);
  if (typeof value.resource.text === "string") resource.text = sanitizeTextForAcp(value.resource.text);
  else if (typeof value.resource.blob === "string") resource.blob = sanitizeTextForAcp(value.resource.blob);
  else return undefined;
  if (typeof value.resource.mimeType === "string") resource.mimeType = sanitizeTextForAcp(value.resource.mimeType);
  return { type: "resource", resource } as ContentBlock;
}

function hasPrivateKey(value: Record<string, unknown>): boolean {
  return Object.keys(value).some(isPrivateAcpVisibleKey);
}

function isPrivateBlockType(value: unknown): boolean {
  return typeof value === "string" && isPrivateAcpVisibleKey(value);
}