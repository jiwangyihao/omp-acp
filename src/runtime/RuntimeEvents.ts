export type KnownRuntimeEventType =
  | "agent_start"
  | "message_update"
  | "tool_execution_start"
  | "tool_execution_update"
  | "tool_execution_end"
  | "host_tool_call"
  | "host_tool_cancel"
  | "extension_error";

export type RuntimeEventType = KnownRuntimeEventType | string;

export type RuntimeEvent = {
  type: "event";
  eventType: RuntimeEventType;
  raw: Record<string, unknown>;
};