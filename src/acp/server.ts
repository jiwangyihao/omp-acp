import {
  AgentSideConnection,
  RequestError,
  type Agent,
  type CancelNotification,
  type ForkSessionRequest,
  type LoadSessionRequest,
  type ListSessionsRequest,
  type NewSessionRequest,
  type PromptRequest,
  type ResumeSessionRequest,
  type SetSessionConfigOptionRequest,
  type SetSessionModeRequest,
  type SetSessionModelRequest,
  type Stream,
} from "@agentclientprotocol/sdk";
import { handleAuthenticate } from "./handlers/authenticate.ts";
import { handleInitialize } from "./handlers/initialize.ts";
import { buildAdditionalDirectoriesEnv } from "../runtime/omp/command.ts";
import { startOmpRpcClient } from "../runtime/omp/rpc-client.ts";
import { SessionManager, SessionManagerError, type RuntimeFactory } from "../session/manager.ts";
import { handleSessionCancel } from "./handlers/session-cancel.ts";
import { handleSessionList } from "./handlers/session-list.ts";
import { handleSetSessionConfigOption, handleSetSessionMode, handleSetSessionModel } from "./handlers/session-config.ts";
import { handleSessionFork } from "./handlers/session-fork.ts";
import { handleSessionLoad } from "./handlers/session-load.ts";
import { handleSessionNew } from "./handlers/session-new.ts";
import { handleSessionPrompt } from "./handlers/session-prompt.ts";
import { handleSessionResume } from "./handlers/session-resume.ts";
import type { HostToolExecutor } from "../runtime/omp/host-tools.ts";

export interface StartAcpServerOptions {
  stream: Stream;
  runtimeFactory?: RuntimeFactory;
  hostToolRegistry?: Record<string, HostToolExecutor>;
  agentDir?: string;
}

export function startAcpServer(options: StartAcpServerOptions): AgentSideConnection {
  const manager = new SessionManager({
    runtimeFactory: options.runtimeFactory ?? ((input) => startOmpRpcClient({
      cwd: input.cwd,
      env: buildAdditionalDirectoriesEnv(input.additionalDirectories),
    })),
  });
  const agentOptions = options.agentDir !== undefined ? { agentDir: options.agentDir } : {};
  const connection = new AgentSideConnection((conn) => createOmpAcpAgent(conn, manager, options.hostToolRegistry, agentOptions), options.stream);
  connection.closed.then(() => manager.closeAll()).catch(() => {});
  return connection;
}

export function createOmpAcpAgent(
  connection: AgentSideConnection,
  manager: SessionManager,
  hostToolRegistry: Record<string, HostToolExecutor> = {},
  options: { agentDir?: string } = {},
): Agent {
  const handlerOptions = options.agentDir !== undefined ? { agentDir: options.agentDir } : {};
  return {
    async initialize(params) {
      return handleInitialize(params);
    },

    async newSession(params: NewSessionRequest) {
      return handleSessionNew(params, manager);
    },

    async loadSession(params: LoadSessionRequest) {
      return handleSessionLoad(params, manager, connection, handlerOptions);
    },

    async listSessions(params: ListSessionsRequest) {
      return handleSessionList(params, handlerOptions);
    },

    async resumeSession(params: ResumeSessionRequest) {
      return handleSessionResume(params, manager, handlerOptions);
    },

    async unstable_forkSession(params: ForkSessionRequest) {
      return handleSessionFork(params, manager, handlerOptions);
    },

    async setSessionMode(params: SetSessionModeRequest) {
      return handleSetSessionMode(params, manager, connection);
    },

    async unstable_setSessionModel(params: SetSessionModelRequest) {
      return handleSetSessionModel(params, manager, connection);
    },

    async setSessionConfigOption(params: SetSessionConfigOptionRequest) {
      return handleSetSessionConfigOption(params, manager, connection);
    },

    async authenticate(params) {
      return handleAuthenticate(params);
    },

    async prompt(params: PromptRequest) {
      try {
        return await handleSessionPrompt(params, { manager, connection, hostToolRegistry });
      } catch (error) {
        throw normalizeSessionManagerError(error);
      }
    },

    async cancel(params: CancelNotification) {
      return handleSessionCancel(params, manager);
    }
  };
}

function normalizeSessionManagerError(error: unknown): Error {
  if (error instanceof SessionManagerError && error.message.startsWith("Unknown session:")) {
    return RequestError.resourceNotFound(error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}