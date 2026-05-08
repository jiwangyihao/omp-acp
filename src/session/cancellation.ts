export class PromptCancellation {
  #cancelled = false;
  #resolveCancelled!: () => void;
  readonly cancelled: Promise<void>;

  constructor() {
    this.cancelled = new Promise<void>((resolve) => {
      this.#resolveCancelled = resolve;
    });
  }

  get isCancelled(): boolean {
    return this.#cancelled;
  }

  cancel(): void {
    if (this.#cancelled) {
      return;
    }
    this.#cancelled = true;
    this.#resolveCancelled();
  }

  throwIfCancelled(): void {
    if (this.#cancelled) {
      throw new Error("Prompt cancelled");
    }
  }
}