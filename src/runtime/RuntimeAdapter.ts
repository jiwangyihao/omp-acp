import type { RuntimeEvent } from "./RuntimeEvents.ts";

export type RuntimeDiagnostics = { stderr: string };

export interface RuntimeAdapter {
  readonly ready: Promise<void>;
  readonly diagnostics: RuntimeDiagnostics;
  request(method: string, params?: unknown): Promise<unknown>;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  close(): Promise<void>;
}