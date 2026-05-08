import type { ContentBlock, PromptRequest } from "@agentclientprotocol/sdk";
import { PromptTranslationError } from "./errors.ts";

export { PromptTranslationError } from "./errors.ts";

export type OmpPromptRequest = {
  method: "prompt";
  params: {
    sessionId: string;
    prompt: string;
    images?: OmpImageContent[];
  };
};

export type OmpImageContent = {
  type: "image";
  data: string;
  mimeType: string;
  uri?: string;
};

export function translatePromptToOmpRequest(params: PromptRequest): OmpPromptRequest {
  const promptParts: string[] = [];
  const images: OmpImageContent[] = [];

  for (const block of params.prompt) {
    if (block.type === "image") {
      images.push(translateImageBlock(block));
    } else {
      promptParts.push(translatePromptBlock(block));
    }
  }

  return {
    method: "prompt",
    params: {
      sessionId: params.sessionId,
      prompt: promptParts.join("\n\n"),
      ...(images.length > 0 ? { images } : {}),
    },
  };
}

function translatePromptBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return formatResourceLink(block);
    case "audio":
      throw new PromptTranslationError(`Unsupported prompt content block: ${block.type}`);
    case "resource":
      return formatEmbeddedResource(block);
    default:
      return rejectUnknownBlock(block);
  }
}

function formatResourceLink(block: Extract<ContentBlock, { type: "resource_link" }>): string {
  const label = nonEmptyString(block.title) ?? block.name;
  const header = `[Resource: ${label}] ${block.uri}`;
  const description = nonEmptyString(block.description);

  return description === undefined ? header : `${header}\n${description}`;
}

function translateImageBlock(block: Extract<ContentBlock, { type: "image" }>): OmpImageContent {
  return {
    type: "image",
    data: block.data,
    mimeType: block.mimeType,
    ...(typeof block.uri === "string" ? { uri: block.uri } : {}),
  };
}

function formatEmbeddedResource(block: Extract<ContentBlock, { type: "resource" }>): string {
  const resource = block.resource;
  if (isRecord(resource) && typeof resource.uri === "string" && typeof resource.text === "string") {
    return formatEmbeddedResourceSection("Embedded Resource", resource.uri, resource.text, resource.mimeType);
  }
  if (isRecord(resource) && typeof resource.uri === "string" && typeof resource.blob === "string") {
    return formatEmbeddedResourceSection("Embedded Blob Resource", resource.uri, resource.blob, resource.mimeType);
  }

  throw new PromptTranslationError("Unsupported embedded resource shape");
}

function formatEmbeddedResourceSection(label: string, uri: string, body: string, mimeType: unknown): string {
  const lines = [`[${label}: ${uri}]`];
  if (typeof mimeType === "string") {
    lines.push(`MIME: ${mimeType}`);
  }
  lines.push(body);
  return lines.join("\n");
}

function nonEmptyString(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.trim().length === 0 ? undefined : value;
}

function rejectUnknownBlock(block: unknown): never {
  const type = typeof block === "object" && block !== null && "type" in block ? String(block.type) : "unknown";
  throw new PromptTranslationError(`Unsupported prompt content block: ${type}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}