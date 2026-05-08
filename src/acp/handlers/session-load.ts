import type { LoadSessionRequest, LoadSessionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { buildSessionSetupState, type SessionSetupState } from "../session-controls.ts";
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
  await manager.createSessionWithId(params.sessionId, params, async (runtime) => {
    await runtime.request("switch_session", { sessionPath: session.path });
    setupState = await buildSessionSetupState(runtime);
  });

  for (const update of history) {
    await connection.sessionUpdate({ sessionId: params.sessionId, update });
  }

  return requireSetupState(setupState);
}

function requireSetupState(setupState: SessionSetupState | undefined): SessionSetupState {
  if (setupState === undefined) {
    throw new Error("Session setup state was not built before publish");
  }
  return setupState;
}