import {
  PROTOCOL_VERSION,
  type AuthMethod,
  type ClientCapabilities,
  type InitializeRequest,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import {
  buildAgentInfo,
  buildInitialAgentCapabilities,
} from "../capabilities.ts";


export const OMP_SETUP_AUTH_METHOD_ID = "omp-setup";

const OMP_SETUP_AUTH_METHOD: AuthMethod = {
  id: OMP_SETUP_AUTH_METHOD_ID,
  type: "terminal",
  name: "Set up Oh My Pi",
  description: "Open an interactive terminal guide to configure Oh My Pi credentials and models.",
  args: ["--setup"],
};

export function buildAuthMethods(clientCapabilities: ClientCapabilities | undefined): AuthMethod[] | undefined {
  if (clientCapabilities?.auth?.terminal === true || clientCapabilities?._meta?.["terminal-auth"] === true) {
    return [OMP_SETUP_AUTH_METHOD];
  }
  return undefined;
}
export function handleInitialize(
  params: InitializeRequest,
): InitializeResponse {
  const authMethods = buildAuthMethods(params.clientCapabilities);
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: buildAgentInfo(),
    ...(authMethods !== undefined ? { authMethods } : {}),
    agentCapabilities: buildInitialAgentCapabilities(),
  };
}