import {
  AgentSideConnection,
  RequestError,
  type Agent,
  type AuthenticateRequest,
  type CancelNotification,
  type NewSessionRequest,
  type PromptRequest,
  type Stream,
} from "@agentclientprotocol/sdk";
import { handleInitialize } from "./handlers/initialize.ts";
import { startOmpRpcClient } from "../runtime/omp/rpc-client.ts";
import { SessionManager, type RuntimeFactory } from "../session/manager.ts";
import { handleSessionCancel } from "./handlers/session-cancel.ts";
import { handleSessionNew } from "./handlers/session-new.ts";
import { handleSessionPrompt } from "./handlers/session-prompt.ts";

export interface StartAcpServerOptions {
  stream: Stream;
  runtimeFactory?: RuntimeFactory;
}

export function startAcpServer(options: StartAcpServerOptions): AgentSideConnection {
  const manager = new SessionManager({
    runtimeFactory: options.runtimeFactory ?? ((input) => startOmpRpcClient({ cwd: input.cwd })),
  });
  const connection = new AgentSideConnection((conn) => createOmpAcpAgent(conn, manager), options.stream);
  connection.closed.then(() => manager.closeAll()).catch(() => {});
  return connection;
}

export function createOmpAcpAgent(connection: AgentSideConnection, manager: SessionManager): Agent {
  return {
    async initialize(params) {
      return handleInitialize(params);
    },

    async newSession(params: NewSessionRequest) {
      return handleSessionNew(params, manager);
    },

    async authenticate(_params: AuthenticateRequest) {
      throw RequestError.methodNotFound("authenticate");
    },

    async prompt(params: PromptRequest) {
      return handleSessionPrompt(params, { manager, connection });
    },

    async cancel(params: CancelNotification) {
      return handleSessionCancel(params, manager);
    }
  };
}