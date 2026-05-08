export class PromptTranslationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PromptTranslationError";
  }
}

export class RuntimeEventTranslationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeEventTranslationError";
  }
}

export class UnsupportedRuntimeEventError extends RuntimeEventTranslationError {
  constructor(eventType: string) {
    super(`Unsupported runtime event: ${eventType}`);
    this.name = "UnsupportedRuntimeEventError";
  }
}