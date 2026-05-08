import type { PromptRequest, PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import type { RuntimeEvent } from "../../runtime/RuntimeEvents.ts";
import type { SessionManager } from "../../session/manager.ts";
import { translateRuntimeEventToSessionUpdate } from "../../translate/events.ts";
import { translatePromptToOmpRequest } from "../../translate/prompt.ts";

export type SessionPromptConnection = {
  sessionUpdate(params: { sessionId: string; update: SessionUpdate }): Promise<void>;
};

export type SessionPromptHandlerContext = {
  manager: SessionManager;
  connection: SessionPromptConnection;
};

export async function handleSessionPrompt(
  params: PromptRequest,
  { manager, connection }: SessionPromptHandlerContext,
): Promise<PromptResponse> {
  const { session, cancellation, finish } = manager.beginPrompt(params.sessionId);
  const updatePromises: Promise<void>[] = [];
  let acceptingEvents = true;
  let failPrompt: (reason: unknown) => void = () => {};
  const eventFailure = new Promise<never>((_, reject) => {
    failPrompt = reject;
  });

  const unsubscribe = session.runtime.onEvent((event: RuntimeEvent) => {
    if (cancellation.isCancelled || !acceptingEvents) {
      return;
    }

    let update: SessionUpdate | undefined;
    try {
      update = translateRuntimeEventToSessionUpdate(event);
    } catch (error) {
      acceptingEvents = false;
      failPrompt(error);
      return;
    }

    if (update !== undefined) {
      const delivery = connection.sessionUpdate({ sessionId: params.sessionId, update });
      updatePromises.push(delivery);
      delivery.catch((error) => {
        acceptingEvents = false;
        failPrompt(error);
      });
    }
  });

  try {
    const translated = translatePromptToOmpRequest(params);
    const runtimePromise = session.runtime.request(translated.method, translated.params);

    const result = await Promise.race([
      runtimePromise.then(() => "runtime" as const),
      eventFailure,
      cancellation.cancelled.then(() => "cancelled" as const),
    ]);

    if (result === "cancelled") {
      runtimePromise.then(
        () => {
          acceptingEvents = false;
          unsubscribe();
          finish();
        },
        () => {
          acceptingEvents = false;
          unsubscribe();
          finish();
        },
      );
      return { stopReason: "cancelled" };
    }

    if (cancellation.isCancelled) {
      acceptingEvents = false;
      unsubscribe();
      finish();
      return { stopReason: "cancelled" };
    }

    await drainUpdatePromises(updatePromises);
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
