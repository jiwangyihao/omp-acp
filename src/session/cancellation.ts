export class PromptCancellation {
  #cancelled = false;

  get isCancelled(): boolean {
    return this.#cancelled;
  }

  cancel(): void {
    this.#cancelled = true;
  }

  throwIfCancelled(): void {
    if (this.#cancelled) {
      throw new Error("Prompt cancelled");
    }
  }
}