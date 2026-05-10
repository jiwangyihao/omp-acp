export type ExtensionUiRequestClass = "confirm" | "widget" | "fire_and_forget" | "unsupported_interactive" | "unsupported";

export function classifyExtensionUiRequest(raw: Record<string, unknown>): ExtensionUiRequestClass {
  switch (raw.method) {
    case "confirm":
      return "confirm";
    case "setWidget":
      return "widget";
    case "cancel":
    case "notify":
    case "setStatus":
    case "setTitle":
    case "set_editor_text":
      return "fire_and_forget";
    case "select":
    case "input":
    case "editor":
      return "unsupported_interactive";
    default:
      return "unsupported";
  }
}

export function isFireAndForgetExtensionUiRequest(raw: Record<string, unknown>): boolean {
  return classifyExtensionUiRequest(raw) === "fire_and_forget";
}

export function formatExtensionUiRequest(raw: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof raw.method === "string" && raw.method.length > 0) {
    parts.push(`method=${raw.method}`);
  }
  if (typeof raw.id === "string" || typeof raw.id === "number") {
    parts.push(`id=${String(raw.id)}`);
  }
  return parts.length === 0 ? "extension_ui_request" : `extension_ui_request ${parts.join(", ")}`;
}