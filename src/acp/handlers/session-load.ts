import type { LoadSessionRequest, LoadSessionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { findOmpSessionById, loadOmpSessionHistory } from "../../runtime/omp/sessions.ts";
import type { SessionManager } from "../../session/manager.ts";

export type SessionLoadConnection = {
  sessionUpdate(params: { sessionId: string; update: SessionUpdate }): Promise<void>;
};

export type SessionLoadHandlerOptions = {
  agentDir?: string;
};

export async function handleSessionLoad(
  params: LoadSessionRequest,
  manager: SessionManager,
  connection: SessionLoadConnection,
  options: SessionLoadHandlerOptions = {},
): Promise<LoadSessionResponse> {
  const session = await findOmpSessionById(params.sessionId, {
    cwd: params.cwd,
    ...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
  });
  if (session === undefined) {
    throw new Error(`Unknown OMP session: ${params.sessionId}`);
  }

  const history = await loadOmpSessionHistory(session.path);
  await manager.createSessionWithId(params.sessionId, params, async (runtime) => {
    await runtime.request("switch_session", { sessionPath: session.path });
  });

  for (const update of history) {
    await connection.sessionUpdate({ sessionId: params.sessionId, update });
  }

  return {};
}