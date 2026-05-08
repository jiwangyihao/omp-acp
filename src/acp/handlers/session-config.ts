import {
  RequestError,
  type SessionConfigOption,
  type SessionUpdate,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
} from "@agentclientprotocol/sdk";
import { setSessionConfigControl, setSessionModelControl, type SessionSetupState } from "../session-controls.ts";
import { SessionManager, SessionManagerError, type SessionRecord } from "../../session/manager.ts";

export type SessionConfigConnection = {
  sessionUpdate(params: { sessionId: string; update: SessionUpdate }): Promise<void>;
};

const ACTIVE_PROMPT_MESSAGE = "Cannot change session controls during an active prompt";
const DEFAULT_MODE_ID = "default";

export async function handleSetSessionMode(
  params: SetSessionModeRequest,
  manager: SessionManager,
  connection: SessionConfigConnection,
): Promise<SetSessionModeResponse> {
  requireIdleSession(manager, params.sessionId);
  if (params.modeId !== DEFAULT_MODE_ID) {
    throw RequestError.invalidParams(undefined, `Unsupported session mode: ${params.modeId}`);
  }

  await connection.sessionUpdate({
    sessionId: params.sessionId,
    update: { sessionUpdate: "current_mode_update", currentModeId: DEFAULT_MODE_ID },
  });
  return {};
}

export async function handleSetSessionModel(
  params: SetSessionModelRequest,
  manager: SessionManager,
  connection: SessionConfigConnection,
): Promise<SetSessionModelResponse> {
  const session = requireIdleSession(manager, params.sessionId);
  const setup = await setSessionModelControl(session.runtime, params.modelId);
  await sendConfigOptionUpdate(connection, params.sessionId, setup);
  return {};
}

export async function handleSetSessionConfigOption(
  params: SetSessionConfigOptionRequest,
  manager: SessionManager,
  connection: SessionConfigConnection,
): Promise<SetSessionConfigOptionResponse> {
  const session = requireIdleSession(manager, params.sessionId);
  const setup = await setSessionConfigControl(session.runtime, params);
  const configOptions = requireConfigOptions(setup);
  await connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "config_option_update", configOptions } });
  return { configOptions };
}

function requireIdleSession(manager: SessionManager, sessionId: string): SessionRecord {
  const session = requireSession(manager, sessionId);
  if (session.activePrompt !== undefined) {
    throw RequestError.invalidParams(undefined, ACTIVE_PROMPT_MESSAGE);
  }
  return session;
}

function requireSession(manager: SessionManager, sessionId: string): SessionRecord {
  try {
    return manager.requireSession(sessionId);
  } catch (error) {
    if (error instanceof SessionManagerError && error.message.startsWith("Unknown session:")) {
      throw RequestError.resourceNotFound(sessionId);
    }
    throw error;
  }
}

async function sendConfigOptionUpdate(connection: SessionConfigConnection, sessionId: string, setup: SessionSetupState): Promise<void> {
  await connection.sessionUpdate({ sessionId, update: { sessionUpdate: "config_option_update", configOptions: requireConfigOptions(setup) } });
}

function requireConfigOptions(setup: SessionSetupState): SessionConfigOption[] {
  if (!Array.isArray(setup.configOptions)) {
    throw new Error("Session setup state did not include configOptions");
  }
  return setup.configOptions;
}