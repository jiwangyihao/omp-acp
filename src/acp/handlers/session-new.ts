import type { NewSessionRequest, NewSessionResponse } from "@agentclientprotocol/sdk";
import { buildSessionSetupState, requireSessionSetupState, toPublicSessionSetupState, type SessionSetupState } from "../session-controls.ts";
import type { SessionManager } from "../../session/manager.ts";

export async function handleSessionNew(params: NewSessionRequest, manager: SessionManager): Promise<NewSessionResponse> {
  const sessionId = manager.reserveSessionId();
  let setupState: SessionSetupState | undefined;
  const record = await manager.createSessionWithId(sessionId, params, {
    afterGuard: async (runtime) => {
      setupState = await buildSessionSetupState(runtime);
      return setupState.runtimeSessionId !== undefined ? { sessionId: setupState.runtimeSessionId } : undefined;
    },
  });
  return { sessionId: record.sessionId, ...toPublicSessionSetupState(requireSessionSetupState(setupState)) };
}