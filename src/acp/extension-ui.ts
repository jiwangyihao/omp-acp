import type { RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import type { RuntimeAdapter } from "../runtime/RuntimeAdapter.ts";
import { UnsupportedRuntimeEventError } from "../translate/events.ts";
import { classifyExtensionUiRequest, formatExtensionUiRequest } from "../translate/extension-ui.ts";
import { sanitizeTextForAcp } from "../translate/safety.ts";

export type ExtensionUiConnection = {
  sessionUpdate(params: { sessionId: string; update: SessionUpdate }): Promise<void>;
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
};

const ALLOW_OPTION = { optionId: "allow", kind: "allow_once", name: "Allow" } as const;
const REJECT_OPTION = { optionId: "reject", kind: "reject_once", name: "Reject" } as const;
const MAX_WIDGET_TEXT_LENGTH = 4_000;

export class ExtensionUiBridge {
  readonly #sessionId: string;
  readonly #runtime: RuntimeAdapter;
  readonly #connection: ExtensionUiConnection;
  readonly #emitUpdate: (update: SessionUpdate) => Promise<void>;
  readonly #lastWidgetTextByKey = new Map<string, string>();

  constructor(options: {
    sessionId: string;
    runtime: RuntimeAdapter;
    connection: ExtensionUiConnection;
    emitUpdate(update: SessionUpdate): Promise<void>;
  }) {
    this.#sessionId = options.sessionId;
    this.#runtime = options.runtime;
    this.#connection = options.connection;
    this.#emitUpdate = options.emitUpdate;
  }

  handle(raw: Record<string, unknown>): Promise<void> | undefined {
    switch (classifyExtensionUiRequest(raw)) {
      case "confirm":
        return this.#handleConfirm(raw);
      case "widget":
        return this.#handleSetWidget(raw);
      case "fire_and_forget":
        return undefined;
      case "unsupported_interactive":
      case "unsupported":
        return this.#cancelUnsupportedRequest(raw);
    }
  }

  async #handleConfirm(raw: Record<string, unknown>): Promise<void> {
    const id = requireUiId(raw);
    const rawTitle = nonEmptyString(raw.title);
    const rawMessage = nonEmptyString(raw.message);
    if (rawTitle === undefined && rawMessage === undefined) {
      throw new UnsupportedRuntimeEventError(formatExtensionUiRequest(raw));
    }
    const title = rawTitle !== undefined ? sanitizeTextForAcp(rawTitle) : "OMP confirmation";
    const message = rawMessage !== undefined ? sanitizeTextForAcp(rawMessage) : undefined;
    const contentText = message ?? title;
    const rawInput: Record<string, string> = { method: "confirm", id };
    if (rawTitle !== undefined) {
      rawInput.title = title;
    }
    if (message !== undefined) {
      rawInput.message = message;
    }

    const response = await this.#connection.requestPermission({
      sessionId: this.#sessionId,
      toolCall: {
        toolCallId: `omp_confirm_${id}`,
        title,
        kind: "other",
        status: "pending",
        rawInput,
        content: [{ type: "content", content: { type: "text", text: contentText } }],
      },
      options: [ALLOW_OPTION, REJECT_OPTION],
    });

    if (response.outcome.outcome === "cancelled") {
      await this.#runtime.send({ type: "extension_ui_response", id, cancelled: true });
      return;
    }

    await this.#runtime.send({
      type: "extension_ui_response",
      id,
      confirmed: response.outcome.outcome === "selected" && response.outcome.optionId === "allow",
    });
  }

  #handleSetWidget(raw: Record<string, unknown>): Promise<void> | undefined {
    if (!Array.isArray(raw.widgetLines)) {
      return undefined;
    }
    const lines = raw.widgetLines.filter((line): line is string => typeof line === "string");
    if (lines.length === 0) {
      return undefined;
    }

    const key = nonEmptyString(raw.widgetKey) ?? "widget";
    const text = truncateWidgetText(sanitizeTextForAcp(`[${key}]\n${lines.join("\n")}`));
    if (this.#lastWidgetTextByKey.get(key) === text) {
      return undefined;
    }

    this.#lastWidgetTextByKey.set(key, text);
    return this.#emitUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
  }

  async #cancelUnsupportedRequest(raw: Record<string, unknown>): Promise<void> {
    const id = requireUiId(raw);
    await this.#runtime.send({ type: "extension_ui_response", id, cancelled: true });
    throw new UnsupportedRuntimeEventError(formatExtensionUiRequest(raw));
  }
}

function requireUiId(raw: Record<string, unknown>): string {
  if (typeof raw.id === "string" && raw.id.length > 0) {
    return raw.id;
  }
  if (typeof raw.id === "number") {
    return String(raw.id);
  }
  throw new UnsupportedRuntimeEventError(formatExtensionUiRequest(raw));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function truncateWidgetText(text: string): string {
  if (text.length <= MAX_WIDGET_TEXT_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_WIDGET_TEXT_LENGTH)}…`;
}

