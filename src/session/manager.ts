import { randomUUID } from "node:crypto";
import type { ForkSessionRequest, LoadSessionRequest, NewSessionRequest, NewSessionResponse, ResumeSessionRequest } from "@agentclientprotocol/sdk";
import type { RuntimeAdapter } from "../runtime/RuntimeAdapter.ts";
import { PromptCancellation } from "./cancellation.ts";

export type ActivePromptOutcome =
  | { status: "idle" }
  | { status: "cancelled" }
  | { status: "closed" }
  | { status: "error"; error: unknown };


export class SessionManagerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionManagerError";
  }
}

export type RuntimeFactoryInput = {
  cwd: string;
  mcpServers: unknown[];
  sessionId: string;
};

export type RuntimeFactory = (input: RuntimeFactoryInput) => RuntimeAdapter;
type SessionPublishOverride = { sessionId?: string } | undefined;
export type CreateSessionHooks = {
  beforeGuard?: (runtime: RuntimeAdapter) => Promise<SessionPublishOverride>;
  afterGuard?: (runtime: RuntimeAdapter) => Promise<SessionPublishOverride>;
};
type BeforePublishRuntime = (runtime: RuntimeAdapter) => Promise<{ sessionId?: string } | void>;
type CreateSessionPublishHooks = BeforePublishRuntime | CreateSessionHooks;

const OMP_ASK_TOOL_NAME = "ask";

async function disableOmpAskTool(runtime: RuntimeAdapter): Promise<void> {
  const state = await runtime.request("get_state");
  const toolNames = extractDumpToolNames(state);
  if (!toolNames.includes(OMP_ASK_TOOL_NAME)) {
    return;
  }

  await runtime.request("set_active_tools", {
    toolNames: toolNames.filter((name) => name !== OMP_ASK_TOOL_NAME),
  });
}

function extractDumpToolNames(state: unknown): string[] {
  if (typeof state !== "object" || state === null || !Object.hasOwn(state, "dumpTools")) {
    return [];
  }
  const dumpTools = (state as { dumpTools?: unknown }).dumpTools;
  if (!Array.isArray(dumpTools)) {
    return [];
  }
  return dumpTools
    .map((tool): string | undefined => {
      if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
        return undefined;
      }
      const name = (tool as { name?: unknown }).name;
      return typeof name === "string" && name.length > 0 ? name : undefined;
    })
    .filter((name): name is string => name !== undefined);
}

function normalizeCreateSessionHooks(hooks?: CreateSessionPublishHooks): CreateSessionHooks {
  if (hooks === undefined) {
    return {};
  }
  if (typeof hooks === "function") {
    return { beforeGuard: async (runtime) => hooks(runtime).then((result) => result ?? undefined) };
  }
  return hooks;
}

export type ActivePrompt = {
  cancellation: PromptCancellation;
  acceptsQueuedPrompt: boolean;
  replacementRequested: boolean;
  runtimeTurnCompleted: boolean;
  runtimeTurnEnding: boolean;
  completion: Promise<ActivePromptOutcome>;
  completed: boolean;
  failed: boolean;
  complete: (outcome: ActivePromptOutcome) => void;
  beginReplacement?: () => void;
  acceptReplacement?: () => void;
  rejectReplacement?: () => void;
};

export type SessionRecord = {
  sessionId: string;
  cwd: string;
  mcpServers: unknown[];
  runtime: RuntimeAdapter;
  activePrompt: ActivePrompt | undefined;
};

export type SessionManagerOptions = {
  runtimeFactory: RuntimeFactory;
  idGenerator?: () => string;
};

export class SessionManager {
  readonly #runtimeFactory: RuntimeFactory;
  readonly #idGenerator: () => string;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #pendingRuntimes = new Set<RuntimeAdapter>();
  readonly #pendingSessionIds = new Map<string, symbol>();
  readonly #activeForkSources = new Set<string>();
  #cleanupGeneration = 0;

  constructor(options: SessionManagerOptions) {
    this.#runtimeFactory = options.runtimeFactory;
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async createSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = this.#idGenerator();
    await this.createSessionWithId(sessionId, params);
    return { sessionId };
  }

  reserveSessionId(): string {
    return this.#idGenerator();
  }

  tryGetSession(sessionId: string): SessionRecord | undefined {
    return this.#sessions.get(sessionId);
  }

  beginForkSource(sessionId: string): { finish: () => void } {
    if (this.#activeForkSources.has(sessionId)) {
      throw new SessionManagerError(`Session is already being forked: ${sessionId}`);
    }
    const session = this.#sessions.get(sessionId);
    if (session?.activePrompt !== undefined) {
      throw new SessionManagerError(`Session has an active prompt: ${sessionId}`);
    }
    this.#activeForkSources.add(sessionId);
    return {
      finish: () => {
        this.#activeForkSources.delete(sessionId);
      },
    };
  }

  async createSessionWithId(
    sessionId: string,
    params: NewSessionRequest | LoadSessionRequest | ResumeSessionRequest | ForkSessionRequest,
    hooks?: CreateSessionPublishHooks,
  ): Promise<SessionRecord> {
    if (this.#sessions.has(sessionId) || this.#pendingSessionIds.has(sessionId)) {
      throw new SessionManagerError(`Session already exists: ${sessionId}`);
    }
    const pendingSessionReservation = Symbol(sessionId);
    this.#pendingSessionIds.set(sessionId, pendingSessionReservation);

    const input: RuntimeFactoryInput = {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      sessionId,
    };
    const cleanupGeneration = this.#cleanupGeneration;
    let runtime: RuntimeAdapter | undefined;
    let publishedSessionId = sessionId;
    let finalReservation: { sessionId: string; token: symbol } | undefined;
    let published = false;

    try {
      runtime = this.#runtimeFactory(input);
      this.#pendingRuntimes.add(runtime);
      const createHooks = normalizeCreateSessionHooks(hooks);

      try {
        await runtime.ready;
        const beforeOverride = await createHooks.beforeGuard?.(runtime);
        await disableOmpAskTool(runtime);
        const afterOverride = await createHooks.afterGuard?.(runtime);
        publishedSessionId = afterOverride?.sessionId ?? beforeOverride?.sessionId ?? sessionId;
      } catch (cause) {
        if (this.#pendingRuntimes.delete(runtime)) {
          await runtime.close();
        }
        throw new SessionManagerError(`Runtime failed to become ready for session ${sessionId}`, { cause });
      }

      finalReservation = this.#reserveFinalSessionId(publishedSessionId, sessionId, pendingSessionReservation);
      this.#pendingRuntimes.delete(runtime);
      if (cleanupGeneration !== this.#cleanupGeneration) {
        await runtime.close();
        throw new SessionManagerError(`Session creation was cancelled during cleanup for session ${sessionId}`);
      }

      const session: SessionRecord = {
        sessionId: publishedSessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        runtime,
        activePrompt: undefined,
      };
      this.#sessions.set(publishedSessionId, session);
      published = true;
      return session;
    } catch (error) {
      if (runtime !== undefined && !published && this.#pendingRuntimes.delete(runtime)) {
        await runtime.close();
      }
      throw error;
    } finally {
      if (this.#pendingSessionIds.get(sessionId) === pendingSessionReservation) {
        this.#pendingSessionIds.delete(sessionId);
      }
      if (finalReservation !== undefined && this.#pendingSessionIds.get(finalReservation.sessionId) === finalReservation.token) {
        this.#pendingSessionIds.delete(finalReservation.sessionId);
      }
    }
  }

  #reserveFinalSessionId(finalSessionId: string, initialSessionId: string, initialReservation: symbol) {
    if (this.#sessions.has(finalSessionId)) {
      throw new SessionManagerError(`Session already exists: ${finalSessionId}`);
    }

    const existingPending = this.#pendingSessionIds.get(finalSessionId);
    if (existingPending !== undefined && !(finalSessionId === initialSessionId && existingPending === initialReservation)) {
      throw new SessionManagerError(`Session already exists: ${finalSessionId}`);
    }

    if (finalSessionId === initialSessionId) {
      return undefined;
    }

    const token = Symbol(finalSessionId);
    this.#pendingSessionIds.set(finalSessionId, token);
    return { sessionId: finalSessionId, token };
  }

  requireSession(sessionId: string): SessionRecord {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new SessionManagerError(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  beginPrompt(sessionId: string): { session: SessionRecord; cancellation: PromptCancellation; finish: (outcome?: ActivePromptOutcome) => void } {
    const session = this.requireSession(sessionId);
    if (this.#activeForkSources.has(sessionId)) {
      throw new SessionManagerError(`Session is being forked: ${sessionId}`);
    }
    if (session.activePrompt !== undefined) {
      throw new SessionManagerError(`Session already has an active prompt: ${sessionId}`);
    }

    let completed = false;
    let resolveCompletion!: (outcome: ActivePromptOutcome) => void;
    const completion = new Promise<ActivePromptOutcome>((resolve) => {
      resolveCompletion = resolve;
    });
    const activePrompt: ActivePrompt = {
      cancellation: new PromptCancellation(),
      acceptsQueuedPrompt: true,
      completion,
      completed: false,
      replacementRequested: false,
      failed: false,
      runtimeTurnCompleted: false,
      runtimeTurnEnding: false,
      complete: (outcome) => {
        if (completed) {
          return;
        }
        completed = true;
        activePrompt.completed = true;
        resolveCompletion(outcome);
      },
    };
    session.activePrompt = activePrompt;

    return {
      session,
      cancellation: activePrompt.cancellation,
      finish: (outcome = { status: "idle" }) => {
        if (session.activePrompt === activePrompt) {
          activePrompt.complete(outcome);
          session.activePrompt = undefined;
        }
      },
    };
  }

  async cancelPrompt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.activePrompt !== undefined) {
      session.activePrompt.rejectReplacement?.();
      session.activePrompt.acceptsQueuedPrompt = false;
      session.activePrompt.cancellation.cancel();
    }

    try {
      await session.runtime.request("abort");
    } catch {
    }
  }

  async closeSession(sessionId: string, expectedRuntime?: RuntimeAdapter): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      return;
    }
    if (expectedRuntime !== undefined && session.runtime !== expectedRuntime) {
      return;
    }

    this.#sessions.delete(sessionId);
    session.activePrompt?.complete({ status: "closed" });
    session.activePrompt?.cancellation.cancel();
    session.activePrompt = undefined;
    await session.runtime.close();
  }

  async closeAll(): Promise<void> {
    this.#cleanupGeneration += 1;
    const sessions = Array.from(this.#sessions.values());
    const pendingRuntimes = Array.from(this.#pendingRuntimes);
    this.#sessions.clear();
    this.#pendingRuntimes.clear();
    this.#pendingSessionIds.clear();
    this.#activeForkSources.clear();

    for (const session of sessions) {
      session.activePrompt?.complete({ status: "closed" });
      session.activePrompt?.cancellation.cancel();
      session.activePrompt = undefined;
    }

    await Promise.all([
      ...sessions.map((session) => session.runtime.close()),
      ...pendingRuntimes.map((runtime) => runtime.close()),
    ]);
  }
}