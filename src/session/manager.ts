import { randomUUID } from "node:crypto";
import type { ForkSessionRequest, LoadSessionRequest, NewSessionRequest, NewSessionResponse, ResumeSessionRequest } from "@agentclientprotocol/sdk";
import type { RuntimeAdapter } from "../runtime/RuntimeAdapter.ts";
import { PromptCancellation } from "./cancellation.ts";

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
type BeforePublishRuntime = (runtime: RuntimeAdapter) => Promise<void>;

export type ActivePrompt = {
  cancellation: PromptCancellation;
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
    beforePublish?: BeforePublishRuntime,
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

    try {
      runtime = this.#runtimeFactory(input);
      this.#pendingRuntimes.add(runtime);

      try {
        await runtime.ready;
        if (beforePublish !== undefined) {
          await beforePublish(runtime);
        }
      } catch (cause) {
        if (this.#pendingRuntimes.delete(runtime)) {
          await runtime.close();
        }
        throw new SessionManagerError(`Runtime failed to become ready for session ${sessionId}`, { cause });
      }

      this.#pendingRuntimes.delete(runtime);
      if (cleanupGeneration !== this.#cleanupGeneration) {
        await runtime.close();
        throw new SessionManagerError(`Session creation was cancelled during cleanup for session ${sessionId}`);
      }

      const session: SessionRecord = {
        sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        runtime,
        activePrompt: undefined,
      };
      this.#sessions.set(sessionId, session);
      return session;
    } finally {
      if (this.#pendingSessionIds.get(sessionId) === pendingSessionReservation) {
        this.#pendingSessionIds.delete(sessionId);
      }
    }
  }

  requireSession(sessionId: string): SessionRecord {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new SessionManagerError(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  beginPrompt(sessionId: string): { session: SessionRecord; cancellation: PromptCancellation; finish: () => void } {
    const session = this.requireSession(sessionId);
    if (this.#activeForkSources.has(sessionId)) {
      throw new SessionManagerError(`Session is being forked: ${sessionId}`);
    }
    if (session.activePrompt !== undefined) {
      throw new SessionManagerError(`Session already has an active prompt: ${sessionId}`);
    }

    const activePrompt: ActivePrompt = { cancellation: new PromptCancellation() };
    session.activePrompt = activePrompt;

    return {
      session,
      cancellation: activePrompt.cancellation,
      finish: () => {
        if (session.activePrompt === activePrompt) {
          session.activePrompt = undefined;
        }
      },
    };
  }

  async cancelPrompt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    session.activePrompt?.cancellation.cancel();

    try {
      await session.runtime.request("cancel", { sessionId });
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
      session.activePrompt?.cancellation.cancel();
      session.activePrompt = undefined;
    }

    await Promise.all([
      ...sessions.map((session) => session.runtime.close()),
      ...pendingRuntimes.map((runtime) => runtime.close()),
    ]);
  }
}