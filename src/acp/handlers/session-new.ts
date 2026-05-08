import type { NewSessionRequest, NewSessionResponse } from "@agentclientprotocol/sdk";
import type { SessionManager } from "../../session/manager.ts";

export function handleSessionNew(params: NewSessionRequest, manager: SessionManager): Promise<NewSessionResponse> {
  return manager.createSession(params);
}