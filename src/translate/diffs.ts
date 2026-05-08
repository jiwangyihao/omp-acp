import type { ToolCallContent } from "@agentclientprotocol/sdk";

export type DiffTranslationResult = Array<ToolCallContent> | UnsupportedDiffResult;

export type UnsupportedDiffResult = {
  unsupported: true;
  rawOutput: Record<string, unknown>;
};

export function translateDiffPayloadToToolCallContent(diff: unknown): DiffTranslationResult {
  if (!isRecord(diff)) {
    return unsupportedDiff("Unsupported diff payload", diff);
  }

  if (diff.operation === "rename") {
    if (typeof diff.oldPath !== "string" || typeof diff.newPath !== "string") {
      return unsupportedDiff("Unsupported rename diff payload: rename requires oldPath and newPath", diff);
    }
    if (typeof diff.newText !== "string") {
      return unsupportedDiff("Unsupported rename diff payload: rename requires string newText", diff);
    }
    return [
      { type: "diff", path: diff.oldPath, oldText: typeof diff.oldText === "string" ? diff.oldText : "", newText: "" },
      { type: "diff", path: diff.newPath, oldText: null, newText: diff.newText },
    ];
  }

  const path = typeof diff.path === "string" ? diff.path : typeof diff.filePath === "string" ? diff.filePath : undefined;
  if (typeof path !== "string" || typeof diff.newText !== "string") {
    return unsupportedDiff("Unsupported diff payload", diff);
  }

  return [{ type: "diff", path, oldText: typeof diff.oldText === "string" ? diff.oldText : null, newText: diff.newText }];
}

export function isUnsupportedDiffResult(value: DiffTranslationResult): value is UnsupportedDiffResult {
  return !Array.isArray(value) && value.unsupported === true;
}

function unsupportedDiff(error: string, diff: unknown): UnsupportedDiffResult {
  return { unsupported: true, rawOutput: { error, diff } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
