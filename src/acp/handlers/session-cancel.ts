import type { CancelNotification } from "@agentclientprotocol/sdk";
import type { SessionManager } from "../../session/manager.ts";

export function handleSessionCancel(params: CancelNotification, manager: SessionManager): Promise<void> {
  return manager.cancelPrompt(params.sessionId);
}