import type { ResumeSessionRequest, ResumeSessionResponse } from "@agentclientprotocol/sdk";
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

  await manager.createSessionWithId(params.sessionId, params, async (runtime) => {
    await runtime.request("switch_session", { sessionPath: session.path });
  });

  return {};
}