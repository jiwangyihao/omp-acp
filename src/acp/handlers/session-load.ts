import type { LoadSessionRequest, LoadSessionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { buildSessionSetupState, requireSessionSetupState, toPublicSessionSetupState, type SessionSetupState } from "../session-controls.ts";
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
  let setupState: SessionSetupState | undefined;
  const record = await manager.createSessionWithId(params.sessionId, params, {
    beforeGuard: async (runtime) => {
      await runtime.request("switch_session", { sessionPath: session.path });
      return { sessionId: params.sessionId };
    },
    afterGuard: async (runtime) => {
      setupState = await buildSessionSetupState(runtime);
      return undefined;
    },
  });

  try {
    for (const update of history) {
      await connection.sessionUpdate({ sessionId: record.sessionId, update });
    }
  } catch (error) {
    try {
      await manager.closeSession(record.sessionId, record.runtime);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "session/load history replay failed and rollback cleanup failed");
    }
    throw error;
  }

  return toPublicSessionSetupState(requireSessionSetupState(setupState));
}