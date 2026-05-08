import type { PromptRequest, PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import type { RuntimeEvent } from "../../runtime/RuntimeEvents.ts";
import type { SessionManager } from "../../session/manager.ts";
import { HostToolBridge, type HostToolExecutor } from "../../runtime/omp/host-tools.ts";
import { translateRuntimeEventToSessionUpdate } from "../../translate/events.ts";
import { translatePromptToOmpRequest } from "../../translate/prompt.ts";

export type SessionPromptConnection = {
  sessionUpdate(params: { sessionId: string; update: SessionUpdate }): Promise<void>;
};

export type SessionPromptHandlerContext = {
  manager: SessionManager;
  connection: SessionPromptConnection;
  cancelledPromptCleanupTimeoutMs?: number;
  hostToolRegistry?: Record<string, HostToolExecutor>;
};


const CANCELLED_PROMPT_CLEANUP_TIMEOUT_MS = 30_000;

export async function handleSessionPrompt(
  params: PromptRequest,
  { manager, connection, hostToolRegistry = {}, cancelledPromptCleanupTimeoutMs = CANCELLED_PROMPT_CLEANUP_TIMEOUT_MS }: SessionPromptHandlerContext,
): Promise<PromptResponse> {
  const { session, cancellation, finish } = manager.beginPrompt(params.sessionId);
  const updatePromises: Promise<void>[] = [];
  let acceptingEvents = true;
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

  const unsubscribe = session.runtime.onEvent((event: RuntimeEvent) => {
    if (event.eventType === "agent_end") {
      completeTurn();
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

    let update: SessionUpdate | undefined;
    try {
      update = translateRuntimeEventToSessionUpdate(event);
    } catch (error) {
      rejectActivePrompt(error);
      return;
    }

    if (update !== undefined) {
      emitUpdate(update);
    }
  });

  try {
    const translated = translatePromptToOmpRequest(params);
    const runtimePromise = session.runtime.request(translated.method, translated.params);
    // OMP RPC "prompt" responses only acknowledge command acceptance; "agent_end" is the turn completion signal.
    // Keep ACP activePrompt owned until both have happened so clients cannot send a second prompt into a busy runtime.
    const promptLifecycle = Promise.all([runtimePromise, turnComplete]).then(() => "runtime" as const);
    const cancelledPromptLifecycle = Promise.all([runtimePromise.catch(() => undefined), turnComplete]);

    const result = await Promise.race([
      promptLifecycle,
      eventFailure,
      cancellation.cancelled.then(() => "cancelled" as const),
    ]);

    if (result === "cancelled") {
      scheduleCancelledPromptCleanup({
        runtimePromise: cancelledPromptLifecycle,
        cleanupTimeoutMs: cancelledPromptCleanupTimeoutMs,
        cleanup: () => {
          acceptingEvents = false;
          unsubscribe();
          finish();
        },
        forceCleanup: async () => {
          acceptingEvents = false;
          unsubscribe();
          finish();
          await manager.closeSession(params.sessionId, session.runtime);
        },
      });
      return { stopReason: "cancelled" };
    }

    if (cancellation.isCancelled) {
      acceptingEvents = false;
      unsubscribe();
      finish();
      return { stopReason: "cancelled" };
    }

    const drainResult = await Promise.race([
      drainUpdatePromises(updatePromises).then(() => "drained" as const),
      cancellation.cancelled.then(() => "cancelled" as const),
      eventFailure,
    ]);
    if (drainResult === "cancelled") {
      acceptingEvents = false;
      unsubscribe();
      finish();
      return { stopReason: "cancelled" };
    }
    return { stopReason: "end_turn" };
  } finally {
    if (!cancellation.isCancelled) {
      acceptingEvents = false;
      unsubscribe();
      finish();
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

function scheduleCancelledPromptCleanup(options: {
  runtimePromise: Promise<unknown>;
  cleanupTimeoutMs: number;
  cleanup: () => void;
  forceCleanup: () => Promise<void>;
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
    options.forceCleanup().catch(cleanupOnce);
  }, options.cleanupTimeoutMs);

  options.runtimePromise.then(
    () => {
      clearTimeout(timeout);
      cleanupOnce();
    },
    () => {
      clearTimeout(timeout);
      cleanupOnce();
    },
  );
}
