import { RequestError, type AuthenticateRequest, type AuthenticateResponse } from "@agentclientprotocol/sdk";
import { OMP_SETUP_AUTH_METHOD_ID } from "./initialize.ts";

export function handleAuthenticate(params: AuthenticateRequest): AuthenticateResponse {
  if (params.methodId === OMP_SETUP_AUTH_METHOD_ID) {
    return {};
  }
  throw RequestError.invalidParams(undefined, `Unsupported authentication method: ${params.methodId}`);
}
