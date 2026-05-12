import type { PromptRequest, PromptResponse, RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import type { RuntimeEvent } from "../../runtime/RuntimeEvents.ts";
import { SessionManagerError, type ActivePromptOutcome, type SessionManager } from "../../session/manager.ts";
import { HostToolBridge, type HostToolExecutor } from "../../runtime/omp/host-tools.ts";
import { ExtensionUiBridge } from "../extension-ui.ts";
import { translateRuntimeEventToSessionUpdate } from "../../translate/events.ts";
import { agentEndMessagesToFallbackUpdates, streamedAssistantMessageKey } from "../../translate/messages.ts";
import { translatePromptToOmpRequest } from "../../translate/prompt.ts";
import { toolExecutionEndToAdditionalUpdates } from "../../translate/tools.ts";

export type SessionPromptConnection = {
  sessionUpdate(params: { sessionId: string; update: SessionUpdate }): Promise<void>;
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
};

export type SessionPromptHandlerContext = {
  manager: SessionManager;
  connection: SessionPromptConnection;
  cancelledPromptCleanupTimeoutMs?: number;
  hostToolRegistry?: Record<string, HostToolExecutor>;
};


const CANCELLED_PROMPT_CLEANUP_TIMEOUT_MS = 30_000;
const RUNTIME_IDLE_POLL_INTERVAL_MS = 1;
const RUNTIME_IDLE_TIMEOUT_MS = 30_000;
const BUSY_PROMPT_ERROR_PATTERN = /Agent is already processing|Use steer\(\) or followUp\(\)/i;
type RuntimeTurnState = {
  readonly complete: Promise<void>;
  resolve: () => void;
};

export async function handleSessionPrompt(
  params: PromptRequest,
  { manager, connection, hostToolRegistry = {}, cancelledPromptCleanupTimeoutMs = CANCELLED_PROMPT_CLEANUP_TIMEOUT_MS }: SessionPromptHandlerContext,
): Promise<PromptResponse> {
  const existingSession = manager.requireSession(params.sessionId);
  const existingPrompt = existingSession.activePrompt;
  if (existingPrompt !== undefined) {
    if (existingPrompt.cancellation.isCancelled) {
      const outcome = await existingPrompt.completion;
      if (outcome.status === "error") {
        throw outcome.error;
      }
      if (outcome.status === "closed") {
        throw new SessionManagerError(`Session closed during active prompt: ${params.sessionId}`);
      }
      return handleSessionPrompt(params, { manager, connection, hostToolRegistry, cancelledPromptCleanupTimeoutMs });
    }

    if (existingPrompt.runtimeTurnCompleted || existingPrompt.runtimeTurnEnding) {
      const outcome = await existingPrompt.completion;
      if (outcome.status === "error") {
        throw outcome.error;
      }
      if (outcome.status === "closed") {
        throw new SessionManagerError(`Session closed during active prompt: ${params.sessionId}`);
      }
      return handleSessionPrompt(params, { manager, connection, hostToolRegistry, cancelledPromptCleanupTimeoutMs });
    }

    if (!existingPrompt.acceptsQueuedPrompt) {
      throw new SessionManagerError(`Session already has an active prompt: ${params.sessionId}`);
    }

    const translated = translatePromptToOmpRequest(params);
    const ownerOutcome = existingPrompt.completion.then((outcome) => ({ status: "owner" as const, outcome }));
    const steerRequest = existingSession.runtime.request("steer", translated.params).then(
      () => ({ status: "accepted" as const }),
      (error) => ({ status: "steerRejected" as const, error }),
    );
    const steerOutcome = await Promise.race([
      steerRequest,
      existingPrompt.cancellation.cancelled.then(() => ({ status: "cancelled" as const })),
      ownerOutcome,
    ]);
    if (steerOutcome.status === "accepted") {
      return promptResponse(params, "end_turn");
    }
    if (steerOutcome.status === "owner" && steerOutcome.outcome.status === "error") {
      throw steerOutcome.outcome.error;
    }
    if (steerOutcome.status === "owner" && steerOutcome.outcome.status === "closed") {
      throw new SessionManagerError(`Session closed during active prompt: ${params.sessionId}`);
    }
    if (steerOutcome.status === "owner" && steerOutcome.outcome.status === "cancelled") {
      return promptResponse(params, "cancelled");
    }
    if (steerOutcome.status === "owner") {
      return handleSessionPrompt(params, { manager, connection, hostToolRegistry, cancelledPromptCleanupTimeoutMs });
    }
    if (steerOutcome.status === "cancelled") {
      return promptResponse(params, "cancelled");
    }
    if (!isBusyPromptError(steerOutcome.error)) {
      throw steerOutcome.error;
    }
    existingPrompt.replacementRequested = true;
    existingPrompt.acceptsQueuedPrompt = false;
    existingPrompt.beginReplacement?.();
    const replacementRequest: Promise<"accepted" | { status: "owner"; outcome: ActivePromptOutcome }> = existingSession.runtime.request("abort_and_prompt", translated.params).then(
      () => {
        if (!existingPrompt.cancellation.isCancelled && !existingPrompt.completed && !existingPrompt.failed && existingSession.activePrompt === existingPrompt) {
          existingPrompt.acceptReplacement?.();
          return "accepted" as const;
        }
        return existingPrompt.completion.then((outcome) => ({ status: "owner" as const, outcome }));
      },
      (abortAndPromptError) => {
        existingPrompt.rejectReplacement?.();
        existingPrompt.replacementRequested = false;
        if (!existingPrompt.cancellation.isCancelled) {
          existingPrompt.acceptsQueuedPrompt = true;
        }
        throw abortAndPromptError;
      },
    );
    const replacementOutcome = await Promise.race([
      replacementRequest,
      existingPrompt.cancellation.cancelled.then(() => ({ status: "cancelled" as const })),
      ownerOutcome,
    ]);
    if (replacementOutcome === "accepted") {
      return promptResponse(params, "end_turn");
    }
    if (replacementOutcome.status === "owner" && replacementOutcome.outcome.status === "error") {
      throw replacementOutcome.outcome.error;
    }
    if (replacementOutcome.status === "owner" && replacementOutcome.outcome.status === "closed") {
      throw new SessionManagerError(`Session closed during active prompt: ${params.sessionId}`);
    }
    void replacementRequest.catch(() => undefined);
    return promptResponse(params, "cancelled");
  }
  const { session, cancellation, finish } = manager.beginPrompt(params.sessionId);
  const activePrompt = session.activePrompt;
  if (activePrompt === undefined) {
    throw new SessionManagerError(`Session failed to start active prompt: ${params.sessionId}`);
  }
  const updatePromises: Promise<void>[] = [];
  const responseForPrompt = (stopReason: PromptResponse["stopReason"]): PromptResponse => promptResponse(params, stopReason);
  const streamedAssistantMessages = new Set<string>();
  const streamedIndex = {
    has: (key: string) => streamedAssistantMessages.has(key),
    add: (key: string) => {
      streamedAssistantMessages.add(key);
    },
  };
  let acceptingEvents = true;
  let queuedPromptBlockers = 0;
  const blockQueuedPrompts = () => {
    queuedPromptBlockers += 1;
    activePrompt.acceptsQueuedPrompt = false;
    return () => {
      queuedPromptBlockers -= 1;
      activePrompt.acceptsQueuedPrompt = queuedPromptBlockers === 0;
    };
  };
  let failPrompt: (reason: unknown) => void = () => {};
  const eventFailure = new Promise<never>((_, reject) => {
    failPrompt = reject;
  });
  let runtimeTurn = createRuntimeTurnState();
  let replacementPending = false;
  let ignoredAgentEndDuringReplacement = false;
  activePrompt.beginReplacement = () => {
    activePrompt.runtimeTurnCompleted = false;
    activePrompt.runtimeTurnEnding = false;
    replacementPending = true;
    ignoredAgentEndDuringReplacement = false;
  };
  activePrompt.acceptReplacement = () => {
    activePrompt.runtimeTurnCompleted = false;
    activePrompt.runtimeTurnEnding = false;
    runtimeTurn.resolve();
    runtimeTurn = createRuntimeTurnState();

    ignoredAgentEndDuringReplacement = false;
    activePrompt.replacementRequested = false;
    replacementPending = false;
  };
  activePrompt.rejectReplacement = () => {
    activePrompt.runtimeTurnCompleted = true;
    activePrompt.runtimeTurnEnding = false;
    if (ignoredAgentEndDuringReplacement) {
      runtimeTurn.resolve();
    }
    replacementPending = false;
    ignoredAgentEndDuringReplacement = false;
  };
  const rejectActivePrompt = (error: unknown) => {
    if (!cancellation.isCancelled && acceptingEvents) {
      activePrompt.failed = true;
      acceptingEvents = false;
      activePrompt.acceptsQueuedPrompt = false;
      failPrompt(error);
    }
  };
  const emitUpdate = (update: SessionUpdate): Promise<void> => {
    if (cancellation.isCancelled || !acceptingEvents) {
      return Promise.resolve();
    }
    const delivery = connection.sessionUpdate({ sessionId: params.sessionId, update });
    updatePromises.push(delivery);
    delivery.catch(rejectActivePrompt);
    return delivery;
  };
  const bridge = new HostToolBridge({
    registry: hostToolRegistry,
    sendFrame: (frame) => {
      if (cancellation.isCancelled) {
        return Promise.resolve();
      }
      return session.runtime.send(frame);
    },
    emitUpdate: (update) => {
      emitUpdate(update);
      return Promise.resolve();
    },
    failPrompt: rejectActivePrompt,
  });
  const extensionUiBridge = new ExtensionUiBridge({
    sessionId: params.sessionId,
    runtime: session.runtime,
    connection,
    emitUpdate,
  });

  const unsubscribe = session.runtime.onEvent((event: RuntimeEvent) => {
    if (event.eventType === "agent_end" && replacementPending) {
      ignoredAgentEndDuringReplacement = true;
      return;
    }
    if (event.eventType === "agent_end") {
      const observedTurn = runtimeTurn;
      if (!cancellation.isCancelled && acceptingEvents) {
        for (const update of agentEndMessagesToFallbackUpdates(event.raw, streamedIndex)) {
          emitUpdate(update);
        }
      }
      activePrompt.runtimeTurnEnding = true;
      waitForRuntimeIdle(session.runtime, { eventFailure }).then(() => {
        activePrompt.runtimeTurnEnding = false;
        activePrompt.runtimeTurnCompleted = true;
        observedTurn.resolve();
      }, rejectActivePrompt);
      return;
    }

    if (cancellation.isCancelled || !acceptingEvents) {
      return;
    }

    if (event.eventType === "host_tool_call" || event.eventType === "host_tool_cancel") {
      const handled = bridge.handle(event.raw);
      updatePromises.push(handled);
      handled.catch(rejectActivePrompt);
      return;
    }

    if (event.eventType === "extension_ui_request") {
      const blocksQueuedPrompts = event.raw.method === "confirm";
      let handled: Promise<void> | undefined;
      try {
        handled = extensionUiBridge.handle(event.raw);
      } catch (error) {
        rejectActivePrompt(error);
        return;
      }
      if (handled !== undefined) {
        if (blocksQueuedPrompts) {
          const unblockQueuedPrompts = blockQueuedPrompts();
          const tracked = handled.then(
            () => {
              unblockQueuedPrompts();
            },
            (error) => {
              rejectActivePrompt(error);
              throw error;
            },
          );
          updatePromises.push(tracked);
          tracked.catch(() => undefined);
        } else {
          updatePromises.push(handled);
          handled.catch(rejectActivePrompt);
        }
      }
      return;
    }

    let update: SessionUpdate | undefined;
    try {
      update = translateRuntimeEventToSessionUpdate(event);
    } catch (error) {
      rejectActivePrompt(error);
      return;
    }

    if (update !== undefined) {
      emitUpdate(update);
      if (event.eventType === "tool_execution_end") {
        for (const additionalUpdate of toolExecutionEndToAdditionalUpdates(event.raw)) {
          emitUpdate(additionalUpdate);
        }
      }
      if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
        const key = streamedAssistantMessageKey(event.raw);
        if (key !== undefined) {
          streamedIndex.add(key);
        }
      }
    }
  });

  try {

    const translated = translatePromptToOmpRequest(params);
    const startRuntimeRequest = async () => {
      try {
        return await session.runtime.request(translated.method, translated.params);
      } catch (error) {
        if (translated.method === "prompt" && isBusyPromptError(error)) {
          activePrompt.replacementRequested = true;
          activePrompt.acceptsQueuedPrompt = false;
          activePrompt.beginReplacement?.();
          try {
            return await session.runtime.request("abort_and_prompt", translated.params).then((result) => {
              if (!activePrompt.cancellation.isCancelled) {
                activePrompt.acceptReplacement?.();
              }
              return result;
            });
          } catch (abortAndPromptError) {
            activePrompt.rejectReplacement?.();
            activePrompt.replacementRequested = false;
            if (!activePrompt.cancellation.isCancelled) {
              activePrompt.acceptsQueuedPrompt = true;
            }
            throw abortAndPromptError;
          }
        }
        throw error;
      }
    };
    const runtimePromise = startRuntimeRequest();
    // OMP RPC "prompt" responses only acknowledge command acceptance; "agent_end" + runtime idle is the turn completion signal.
    // If OMP reports a stale in-flight turn, abort_and_prompt is the atomic recovery path that replaces it without restarting ACP.
    const waitForCurrentRuntimeTurn = async (ignoreRuntimeRejection = false) => {
      for (;;) {
        const observedTurn = runtimeTurn;
        if (ignoreRuntimeRejection) {
          await runtimePromise.catch(() => undefined);
          await observedTurn.complete;
        } else {
          await Promise.all([runtimePromise, observedTurn.complete]);
        }
        if (observedTurn === runtimeTurn) {
          return;
        }
      }
    };
    const promptLifecycle = waitForCurrentRuntimeTurn().then(() => "runtime" as const);
    const buildCancelledPromptCleanup = () => waitForCurrentRuntimeTurn(true).then(() => drainUpdatePromises(updatePromises));

    const result = await Promise.race([
      promptLifecycle,
      eventFailure,
      cancellation.cancelled.then(() => "cancelled" as const),
    ]);

    if (result === "cancelled") {
      if (activePrompt.replacementRequested) {
        acceptingEvents = false;
        unsubscribe();
        finish({ status: "cancelled" });
        return responseForPrompt("cancelled");
      }
      scheduleCancelledPromptCleanup({
        runtimePromise: buildCancelledPromptCleanup(),
        cleanupTimeoutMs: cancelledPromptCleanupTimeoutMs,
        cleanup: () => {
          acceptingEvents = false;
          unsubscribe();
          finish({ status: "cancelled" });
        },
        forceCleanup: async (error) => {
          acceptingEvents = false;
          unsubscribe();
          finish({ status: "error", error });
          await manager.closeSession(params.sessionId, session.runtime);
        },
      });
      return responseForPrompt("cancelled");
    }

    if (cancellation.isCancelled) {
      if (activePrompt.replacementRequested) {
        acceptingEvents = false;
        unsubscribe();
        finish({ status: "cancelled" });
        return responseForPrompt("cancelled");
      }
      scheduleCancelledPromptCleanup({
        runtimePromise: buildCancelledPromptCleanup(),
        cleanupTimeoutMs: cancelledPromptCleanupTimeoutMs,
        cleanup: () => {
          acceptingEvents = false;
          unsubscribe();
          finish({ status: "cancelled" });
        },
        forceCleanup: async (error) => {
          acceptingEvents = false;
          unsubscribe();
          finish({ status: "error", error });
          await manager.closeSession(params.sessionId, session.runtime);
        },
      });
      return responseForPrompt("cancelled");
    }

    const drainResult = await Promise.race([
      drainUpdatePromises(updatePromises).then(() => "drained" as const),
      cancellation.cancelled.then(() => "cancelled" as const),
      eventFailure,
    ]);
    if (drainResult === "cancelled") {
      if (activePrompt.replacementRequested) {
        acceptingEvents = false;
        unsubscribe();
        finish({ status: "cancelled" });
        return responseForPrompt("cancelled");
      }
      scheduleCancelledPromptCleanup({
        runtimePromise: buildCancelledPromptCleanup(),
        cleanupTimeoutMs: cancelledPromptCleanupTimeoutMs,
        cleanup: () => {
          acceptingEvents = false;
          unsubscribe();
          finish({ status: "cancelled" });
        },
        forceCleanup: async (error) => {
          acceptingEvents = false;
          unsubscribe();
          finish({ status: "error", error });
          await manager.closeSession(params.sessionId, session.runtime);
        },
      });
      return responseForPrompt("cancelled");
    }
    finish({ status: "idle" });
    acceptingEvents = false;
    unsubscribe();
    return responseForPrompt("end_turn");
  } catch (error) {
    finish({ status: "error", error });
    throw error;
  } finally {
    if (!cancellation.isCancelled) {
      acceptingEvents = false;
      unsubscribe();
      if (session.activePrompt === activePrompt) {
        session.activePrompt = undefined;
      }
    }
  }
}

function promptResponse(params: PromptRequest, stopReason: PromptResponse["stopReason"]): PromptResponse {
  return {
    stopReason,
    ...(params.messageId !== undefined && params.messageId !== null ? { userMessageId: params.messageId } : {}),
  };
}

function createRuntimeTurnState(): RuntimeTurnState {
  let resolve!: () => void;
  const complete = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { complete, resolve };
}

function isBusyPromptError(error: unknown): boolean {
  if (error instanceof Error) {
    return BUSY_PROMPT_ERROR_PATTERN.test(error.message);
  }
  return BUSY_PROMPT_ERROR_PATTERN.test(String(error));
}

async function drainUpdatePromises(updatePromises: Promise<void>[]): Promise<void> {
  let drainedCount = 0;
  while (drainedCount < updatePromises.length) {
    const pendingUpdates = updatePromises.slice(drainedCount);
    drainedCount = updatePromises.length;
    await Promise.all(pendingUpdates);
  }
}

async function waitForRuntimeIdle(
  runtime: { request(method: string, params?: unknown): Promise<unknown> },
  options: { eventFailure: Promise<never> },
): Promise<void> {
  const deadline = Date.now() + RUNTIME_IDLE_TIMEOUT_MS;
  for (;;) {
    const state = await Promise.race([runtime.request("get_state"), options.eventFailure]);
    if (!isRuntimeStreaming(state)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for OMP runtime to become idle after agent_end");
    }
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, RUNTIME_IDLE_POLL_INTERVAL_MS)),
      options.eventFailure,
    ]);
  }
}

function isRuntimeStreaming(state: unknown): boolean {
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    return false;
  }
  const runtimeState = state as { isStreaming?: unknown; promptInFlight?: unknown; promptInFlightCount?: unknown; isProcessing?: unknown };
  return (
    runtimeState.isStreaming === true ||
    runtimeState.promptInFlight === true ||
    runtimeState.isProcessing === true ||
    (typeof runtimeState.promptInFlightCount === "number" && runtimeState.promptInFlightCount > 0)
  );
}

function scheduleCancelledPromptCleanup(options: {
  runtimePromise: Promise<unknown>;
  cleanupTimeoutMs: number;
  cleanup: () => void;
  forceCleanup: (error: Error) => Promise<void>;
}): void {
  let cleaned = false;
  const cleanupOnce = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    options.cleanup();
  };

  const timeout = setTimeout(() => {
    options.forceCleanup(new Error("Timed out waiting for cancelled OMP prompt cleanup")).catch(cleanupOnce);
  }, options.cleanupTimeoutMs);

  options.runtimePromise.then(
    () => {
      clearTimeout(timeout);
      cleanupOnce();
    },
    (error) => {
      clearTimeout(timeout);
      options.forceCleanup(error instanceof Error ? error : new Error(String(error))).catch(cleanupOnce);
    },
  );
}
