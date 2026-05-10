import type { ResumeSessionRequest, ResumeSessionResponse } from "@agentclientprotocol/sdk";
import { buildSessionSetupState, requireSessionSetupState, toPublicSessionSetupState, type SessionSetupState } from "../session-controls.ts";
import { findOmpSessionById } from "../../runtime/omp/sessions.ts";
import type { SessionManager } from "../../session/manager.ts";

export type SessionResumeHandlerOptions = {
  agentDir?: string;
};

export async function handleSessionResume(
  params: ResumeSessionRequest,
  manager: SessionManager,
  options: SessionResumeHandlerOptions = {},
): Promise<ResumeSessionResponse> {
  const session = await findOmpSessionById(params.sessionId, {
    cwd: params.cwd,
    ...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
  });
  if (session === undefined) {
    throw new Error(`Unknown OMP session: ${params.sessionId}`);
  }

  let setupState: SessionSetupState | undefined;
  await manager.createSessionWithId(params.sessionId, params, {
    beforeGuard: async (runtime) => {
      await runtime.request("switch_session", { sessionPath: session.path });
      return { sessionId: params.sessionId };
    },
    afterGuard: async (runtime) => {
      setupState = await buildSessionSetupState(runtime);
      return undefined;
    },
  });

  return toPublicSessionSetupState(requireSessionSetupState(setupState));
}
