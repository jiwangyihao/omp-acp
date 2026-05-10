export function parseToolInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function isPrivateAcpVisibleKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("signature")
    || normalized.includes("encrypted")
    || normalized.includes("provider")
    || normalized.includes("apikey")
    || normalized.includes("api_key")
    || normalized === "key"
    || normalized.endsWith("key")
    || normalized.includes("_key")
    || normalized.includes("-key")
    || normalized === "authorization"
    || normalized === "auth"
    || normalized === "config"
    || normalized.endsWith("config")
    || normalized === "token"
    || normalized.endsWith("token")
    || normalized.includes("secret")
    || normalized.includes("baseurl")
    || normalized.includes("base_url");
}

const SENSITIVE_JSON_TEXT_KEY_PATTERN = /"(?:[^"\\]|\\.)*(?:signature|encrypted|provider|apiKey|api_key|key|authorization|auth|config|token|secret|baseURL|base_url)(?:[^"\\]|\\.)*"\s*:/i;

export function sanitizeTextForAcp(value: string): string {
  const parsedJson = parseJsonText(value);
  if (parsedJson.parsed) {
    if (typeof parsedJson.value === "string") return "[redacted]";
    if (isJsonSanitizationCandidate(parsedJson.value) || SENSITIVE_JSON_TEXT_KEY_PATTERN.test(value)) {
      const sanitized = sanitizeAcpVisibleValue(parsedJson.value);
      return sanitized === undefined ? "[redacted]" : JSON.stringify(sanitized);
    }
    return value;
  }

  if (!SENSITIVE_JSON_TEXT_KEY_PATTERN.test(value)) {
    return value;
  }
  return "[redacted]";
}

function parseJsonText(value: string): { parsed: true; value: unknown } | { parsed: false } {
  try {
    return { parsed: true, value: JSON.parse(value) as unknown };
  } catch {
    return { parsed: false };
  }
}

function isJsonSanitizationCandidate(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isJsonSanitizationCandidate);
  if (isRecord(value)) {
    return Object.entries(value).some(([key, nested]) => isPrivateAcpVisibleKey(key) || isJsonSanitizationCandidate(nested));
  }
  if (typeof value === "string") {
    const parsedJson = parseJsonText(value);
    if (!parsedJson.parsed) return SENSITIVE_JSON_TEXT_KEY_PATTERN.test(value);
    return typeof parsedJson.value === "string" || isJsonSanitizationCandidate(parsedJson.value) || SENSITIVE_JSON_TEXT_KEY_PATTERN.test(value);
  }
  return false;
}




export function sanitizeToolInput(value: unknown): unknown {
  return sanitizeAcpVisibleValue(value);
}

export function sanitizeToolOutputForAcp(value: unknown): unknown {
  if (typeof value === "string") return sanitizeTextForAcp(value);
  return sanitizeAcpVisibleValue(value);
}


export function sanitizeAcpVisibleValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const sanitized = value.map(sanitizeAcpVisibleValue).filter((item) => item !== undefined);
    return sanitized.length > 0 ? sanitized : undefined;
  }

  if (isRecord(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (isPrivateAcpVisibleKey(key)) continue;
      const sanitizedValue = sanitizeAcpVisibleValue(nested);
      if (sanitizedValue !== undefined) sanitized[key] = sanitizedValue;
    }
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
  }

  if (typeof value === "string") {
    return sanitizeTextForAcp(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}