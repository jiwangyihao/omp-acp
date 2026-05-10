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

export async function handleSessionPrompt(
  params: PromptRequest,
  { manager, connection, hostToolRegistry = {}, cancelledPromptCleanupTimeoutMs = CANCELLED_PROMPT_CLEANUP_TIMEOUT_MS }: SessionPromptHandlerContext,
): Promise<PromptResponse> {
  const existingSession = manager.requireSession(params.sessionId);
  const existingPrompt = existingSession.activePrompt;
  if (existingPrompt !== undefined) {
    if (!existingPrompt.cancellation.isCancelled && !existingPrompt.acceptsQueuedPrompt) {
      throw new SessionManagerError(`Session already has an active prompt: ${params.sessionId}`);
    }

    const outcome = await existingPrompt.completion;
    if (outcome.status === "error") {
      throw outcome.error;
    }
    if (outcome.status === "closed") {
      throw new SessionManagerError(`Session closed during active prompt: ${params.sessionId}`);
    }
    return handleSessionPrompt(params, { manager, connection, hostToolRegistry, cancelledPromptCleanupTimeoutMs });
  }

  const { session, cancellation, finish } = manager.beginPrompt(params.sessionId);
  const activePrompt = session.activePrompt;
  if (activePrompt === undefined) {
    throw new SessionManagerError(`Session failed to start active prompt: ${params.sessionId}`);
  }
  const updatePromises: Promise<void>[] = [];
  const promptResponse = (stopReason: PromptResponse["stopReason"]): PromptResponse => ({
    stopReason,
    ...(params.messageId !== undefined && params.messageId !== null ? { userMessageId: params.messageId } : {}),
  });
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
  let completeTurn: () => void = () => {};
  const turnComplete = new Promise<void>((resolve) => {
    completeTurn = resolve;
  });
  const rejectActivePrompt = (error: unknown) => {
    if (!cancellation.isCancelled && acceptingEvents) {
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
    if (event.eventType === "agent_end") {
      if (!cancellation.isCancelled && acceptingEvents) {
        for (const update of agentEndMessagesToFallbackUpdates(event.raw, streamedIndex)) {
          emitUpdate(update);
        }
      }
      waitForRuntimeIdle(session.runtime, { eventFailure }).then(completeTurn, rejectActivePrompt);
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
    const runtimePromise = session.runtime.request(translated.method, translated.params);
    // OMP RPC "prompt" responses only acknowledge command acceptance; "agent_end" + runtime idle is the turn completion signal.
    // Keep ACP activePrompt owned until both have happened so clients cannot send a second prompt into a busy runtime.
    const promptLifecycle = Promise.all([runtimePromise, turnComplete]).then(() => "runtime" as const);
    const buildCancelledPromptCleanup = () => Promise.all([runtimePromise.catch(() => undefined), turnComplete, drainUpdatePromises(updatePromises)]);

    const result = await Promise.race([
      promptLifecycle,
      eventFailure,
      cancellation.cancelled.then(() => "cancelled" as const),
    ]);

    if (result === "cancelled") {
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
      return promptResponse("cancelled");
    }

    if (cancellation.isCancelled) {
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
      return promptResponse("cancelled");
    }

    const drainResult = await Promise.race([
      drainUpdatePromises(updatePromises).then(() => "drained" as const),
      cancellation.cancelled.then(() => "cancelled" as const),
      eventFailure,
    ]);
    if (drainResult === "cancelled") {
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
      return promptResponse("cancelled");
    }
    finish({ status: "idle" });
    return promptResponse("end_turn");
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
