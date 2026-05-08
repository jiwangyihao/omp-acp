import type { ListSessionsRequest, ListSessionsResponse, SessionInfo } from "@agentclientprotocol/sdk";
import { listOmpSessions } from "../../runtime/omp/sessions.ts";

export type SessionListHandlerOptions = {
  agentDir?: string;
};

export async function handleSessionList(
  params: ListSessionsRequest,
  options: SessionListHandlerOptions = {},
): Promise<ListSessionsResponse> {
  const result = await listOmpSessions({
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
  });

  return {
    sessions: result.sessions.map((session): SessionInfo => {
      const info: SessionInfo = {
        sessionId: session.sessionId,
        cwd: session.cwd,
        updatedAt: session.updatedAt,
        _meta: { ompSessionPath: session.path },
      };
      if (session.title !== undefined) {
        info.title = session.title;
      }
      return info;
    }),
  };
}
