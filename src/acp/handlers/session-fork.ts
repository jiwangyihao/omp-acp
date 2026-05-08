import { rm } from "node:fs/promises";
import { RequestError, type ForkSessionRequest, type ForkSessionResponse } from "@agentclientprotocol/sdk";
import {
  findOmpSessionById,
  forkOmpSessionFile,
  OmpSessionForkSourceError,
} from "../../runtime/omp/sessions.ts";
import { SessionManager, SessionManagerError } from "../../session/manager.ts";

export type SessionForkHandlerOptions = {
  agentDir?: string;
  forkSessionFile?: typeof forkOmpSessionFile;
};

const ACTIVE_PROMPT_MESSAGE = "Cannot fork a session with an active prompt";

export async function handleSessionFork(
  params: ForkSessionRequest,
  manager: SessionManager,
  options: SessionForkHandlerOptions = {},
): Promise<ForkSessionResponse> {
  let sourceGuard;
  try {
    sourceGuard = manager.beginForkSource(params.sessionId);
  } catch (error) {
    if (error instanceof SessionManagerError) {
      throw RequestError.invalidParams(undefined, ACTIVE_PROMPT_MESSAGE);
    }
    throw error;
  }

  try {
    const source = await findOmpSessionById(params.sessionId, {
      cwd: params.cwd,
      ...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
    });
    if (source === undefined) {
      throw RequestError.resourceNotFound(params.sessionId);
    }

    const forkId = manager.reserveSessionId();
    const forkSessionFile = options.forkSessionFile ?? forkOmpSessionFile;
    let fork: Awaited<ReturnType<typeof forkOmpSessionFile>> | undefined;

    try {
      try {
        fork = await forkSessionFile({
          sourcePath: source.path,
          sourceSessionId: params.sessionId,
          forkSessionId: forkId,
          cwd: params.cwd,
          ...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
        });
      } catch (error) {
        if (error instanceof OmpSessionForkSourceError) {
          throw RequestError.resourceNotFound(params.sessionId);
        }
        throw error;
      }

      await manager.createSessionWithId(forkId, params, async (runtime) => {
        await runtime.request("switch_session", { sessionPath: fork!.path });
      });
    } catch (error) {
      if (fork !== undefined) {
        await rm(fork.path, { force: true });
      }
      throw error;
    }

    if (fork === undefined) {
      throw RequestError.internalError({ details: "Fork session file was not created" });
    }

    return { sessionId: fork.sessionId };
  } finally {
    sourceGuard.finish();
  }
}