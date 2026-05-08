import type { NewSessionRequest, NewSessionResponse } from "@agentclientprotocol/sdk";
import { buildSessionSetupState, type SessionSetupState } from "../session-controls.ts";
import type { SessionManager } from "../../session/manager.ts";

export async function handleSessionNew(params: NewSessionRequest, manager: SessionManager): Promise<NewSessionResponse> {
  const sessionId = manager.reserveSessionId();
  let setupState: SessionSetupState | undefined;
  await manager.createSessionWithId(sessionId, params, async (runtime) => {
    setupState = await buildSessionSetupState(runtime);
  });
  return { sessionId, ...requireSetupState(setupState) };
}

function requireSetupState(setupState: SessionSetupState | undefined): SessionSetupState {
  if (setupState === undefined) {
    throw new Error("Session setup state was not built before publish");
  }
  return setupState;
}