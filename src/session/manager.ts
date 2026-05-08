import { randomUUID } from "node:crypto";
import type { NewSessionRequest, NewSessionResponse } from "@agentclientprotocol/sdk";
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

  constructor(options: SessionManagerOptions) {
    this.#runtimeFactory = options.runtimeFactory;
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async createSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const sessionId = this.#idGenerator();
    const input: RuntimeFactoryInput = {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      sessionId,
    };
    const runtime = this.#runtimeFactory(input);

    try {
      await runtime.ready;
    } catch (cause) {
      await runtime.close();
      throw new SessionManagerError(`Runtime failed to become ready for session ${sessionId}`, { cause });
    }

    this.#sessions.set(sessionId, {
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      runtime,
      activePrompt: undefined,
    });

    return { sessionId };
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

  async closeAll(): Promise<void> {
    const sessions = Array.from(this.#sessions.values());
    this.#sessions.clear();

    for (const session of sessions) {
      session.activePrompt?.cancellation.cancel();
      session.activePrompt = undefined;
    }

    await Promise.all(sessions.map((session) => session.runtime.close()));
  }
}