import type { ContentBlock, PromptRequest } from "@agentclientprotocol/sdk";
import { PromptTranslationError } from "./errors.ts";

export { PromptTranslationError } from "./errors.ts";

export type OmpPromptRequest = {
  method: "prompt";
  params: {
    sessionId: string;
    prompt: string;
  };
};

export function translatePromptToOmpRequest(params: PromptRequest): OmpPromptRequest {
  return {
    method: "prompt",
    params: {
      sessionId: params.sessionId,
      prompt: params.prompt.map(translatePromptBlock).join("\n\n"),
    },
  };
}

function translatePromptBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return formatResourceLink(block);
    case "image":
    case "audio":
    case "resource":
      throw new PromptTranslationError(`Unsupported prompt content block: ${block.type}`);
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