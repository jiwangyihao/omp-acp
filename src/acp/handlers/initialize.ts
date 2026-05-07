import {
  PROTOCOL_VERSION,
  type InitializeRequest,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import {
  buildAgentInfo,
  buildInitialAgentCapabilities,
} from "../capabilities.ts";

export function handleInitialize(
  _params: InitializeRequest,
): InitializeResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: buildAgentInfo(),
    agentCapabilities: buildInitialAgentCapabilities(),
  };
}