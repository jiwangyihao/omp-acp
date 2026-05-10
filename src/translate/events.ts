import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { RuntimeEvent } from "../runtime/RuntimeEvents.ts";
import { RuntimeEventTranslationError, UnsupportedRuntimeEventError } from "./errors.ts";
import { toolExecutionEndToUpdate, toolExecutionStartToUpdate, toolExecutionUpdateToUpdate } from "./tools.ts";
import { messageUpdateEventToSessionUpdate } from "./messages.ts";
import { classifyExtensionUiRequest, formatExtensionUiRequest } from "./extension-ui.ts";

export { RuntimeEventTranslationError, UnsupportedRuntimeEventError } from "./errors.ts";

export function translateRuntimeEventToSessionUpdate(event: RuntimeEvent): SessionUpdate | undefined {
  switch (event.eventType) {
    case "message_update":
      return messageUpdateEventToSessionUpdate(event.raw);
    case "agent_start":
      return undefined;
    case "extension_error":
      throw new RuntimeEventTranslationError(formatExtensionError(event.raw));
    case "host_tool_call":
    case "host_tool_cancel":
      return undefined;
    case "extension_ui_request":
      switch (classifyExtensionUiRequest(event.raw)) {
        case "fire_and_forget":
          return undefined;
        case "widget":
          // Widget visibility is owned by the prompt bridge; the generic translator fallback stays silent.
          return undefined;
        case "confirm":
        case "unsupported_interactive":
        case "unsupported":
          throw new UnsupportedRuntimeEventError(formatExtensionUiRequest(event.raw));
      }
    case "tool_execution_start":
      return toolExecutionStartToUpdate(event.raw);
    case "tool_execution_update":
      return toolExecutionUpdateToUpdate(event.raw);
    case "tool_execution_end":
      return toolExecutionEndToUpdate(event.raw);
    default:
      return undefined;
  }
}



function formatExtensionError(raw: Record<string, unknown>): string {
  const message = typeof raw.message === "string" && raw.message.length > 0 ? raw.message : "extension_error";
  return `Runtime extension error: ${message}`;
}
