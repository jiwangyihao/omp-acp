import {
  AgentSideConnection,
  RequestError,
  type Agent,
  type AuthenticateRequest,
  type CancelNotification,
  type LoadSessionRequest,
  type ListSessionsRequest,
  type NewSessionRequest,
  type PromptRequest,
  type Stream,
} from "@agentclientprotocol/sdk";
import { handleInitialize } from "./handlers/initialize.ts";
import { startOmpRpcClient } from "../runtime/omp/rpc-client.ts";
import { SessionManager, type RuntimeFactory } from "../session/manager.ts";
import { handleSessionCancel } from "./handlers/session-cancel.ts";
import { handleSessionList } from "./handlers/session-list.ts";
import { handleSessionLoad } from "./handlers/session-load.ts";
import { handleSessionNew } from "./handlers/session-new.ts";
import { handleSessionPrompt } from "./handlers/session-prompt.ts";
import type { HostToolExecutor } from "../runtime/omp/host-tools.ts";

export interface StartAcpServerOptions {
  stream: Stream;
  runtimeFactory?: RuntimeFactory;
  hostToolRegistry?: Record<string, HostToolExecutor>;
  agentDir?: string;
}

export function startAcpServer(options: StartAcpServerOptions): AgentSideConnection {
  const manager = new SessionManager({
    runtimeFactory: options.runtimeFactory ?? ((input) => startOmpRpcClient({ cwd: input.cwd })),
  });
  const connection = new AgentSideConnection((conn) => createOmpAcpAgent(conn, manager, options.hostToolRegistry, { agentDir: options.agentDir }), options.stream);
  connection.closed.then(() => manager.closeAll()).catch(() => {});
  return connection;
}

export function createOmpAcpAgent(
  connection: AgentSideConnection,
  manager: SessionManager,
  hostToolRegistry: Record<string, HostToolExecutor> = {},
  options: { agentDir?: string } = {},
): Agent {
  return {
    async initialize(params) {
      return handleInitialize(params);
    },

    async newSession(params: NewSessionRequest) {
      return handleSessionNew(params, manager);
    },

    async loadSession(params: LoadSessionRequest) {
      return handleSessionLoad(params, manager, connection, { agentDir: options.agentDir });
    },

    async unstable_listSessions(params: ListSessionsRequest) {
      return handleSessionList(params, { agentDir: options.agentDir });
    },

    async authenticate(_params: AuthenticateRequest) {
      throw RequestError.methodNotFound("authenticate");
    },

    async prompt(params: PromptRequest) {
      return handleSessionPrompt(params, { manager, connection, hostToolRegistry });
    },

    async cancel(params: CancelNotification) {
      return handleSessionCancel(params, manager);
    }
  };
}