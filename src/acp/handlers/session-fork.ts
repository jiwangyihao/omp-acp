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
  removeForkFile?: typeof rm;
};

const ACTIVE_PROMPT_MESSAGE = "Cannot fork a session with an active prompt";

async function removeForkFileAfterFailure(
  path: string,
  forkError: unknown,
  removeForkFile: typeof rm,
): Promise<void> {
  try {
    await removeForkFile(path, { force: true });
  } catch (cleanupError) {
    throw new AggregateError([forkError, cleanupError], `Fork session failed and cleanup failed for ${path}`);
  }
}

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
    const removeForkFile = options.removeForkFile ?? rm;
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
        await removeForkFileAfterFailure(fork.path, error, removeForkFile);
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