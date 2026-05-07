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

export interface StartAcpServerOptions {
  stream: Stream;
}

export function startAcpServer(options: StartAcpServerOptions): AgentSideConnection {
  return new AgentSideConnection(createOmpAcpAgent, options.stream);
}

export function createOmpAcpAgent(_connection: AgentSideConnection): Agent {
  return {
    async initialize(params) {
      return handleInitialize(params);
    },

    async newSession(_params: NewSessionRequest) {
      throw RequestError.methodNotFound("session/new");
    },

    async authenticate(_params: AuthenticateRequest) {
      throw RequestError.methodNotFound("authenticate");
    },

    async prompt(_params: PromptRequest) {
      throw RequestError.methodNotFound("session/prompt");
    },

    async cancel(_params: CancelNotification) {}
  };
}