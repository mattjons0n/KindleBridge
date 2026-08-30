export interface DebugLogEntry {
  readonly timestamp: Date;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export type DebugLogListener = (entries: readonly DebugLogEntry[]) => void;

const MAX_ENTRIES = 500;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_CONTEXT_DEPTH = 5;
const MAX_CONTEXT_ITEMS = 80;
const MAX_CONTEXT_STRING = 1_000;

const DIAGNOSTIC_TEXT_KEY = /^(?:stdout|stderr|raw|output|bookContent)$/i;

function maskSensitiveValue(key: string, value: unknown): unknown {
  if (!/serial/i.test(key) || typeof value !== "string") return value;
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

function sanitizeValue(
  value: unknown,
  key: string,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (DIAGNOSTIC_TEXT_KEY.test(key) && typeof value === "string") {
    return `[redacted diagnostic text: ${value.length} character(s)]`;
  }
  const masked = maskSensitiveValue(key, value);
  if (masked !== value) return masked;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return value.length > MAX_CONTEXT_STRING
      ? `${value.slice(0, MAX_CONTEXT_STRING)}…[truncated]`
      : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_CONTEXT_DEPTH) return "[Maximum depth reached]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_CONTEXT_ITEMS)
      .map((item) => sanitizeValue(item, key, seen, depth + 1));
    if (value.length > MAX_CONTEXT_ITEMS) result.push(`[${value.length - MAX_CONTEXT_ITEMS} more item(s)]`);
    return result;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message.length > MAX_CONTEXT_STRING
        ? `${value.message.slice(0, MAX_CONTEXT_STRING)}…[truncated]`
        : value.message,
    };
  }
  return Object.fromEntries(
    Object.entries(value).slice(0, MAX_CONTEXT_ITEMS)
      .map(([nestedKey, nestedValue]) => [
        nestedKey,
        sanitizeValue(nestedValue, nestedKey, seen, depth + 1),
      ]),
  );
}

function sanitizeContext(context?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
  if (!context) return undefined;
  return sanitizeValue(context, "context", new WeakSet<object>(), 0) as Readonly<Record<string, unknown>>;
}

export class DebugLog {
  #entries: DebugLogEntry[] = [];
  #listeners = new Set<DebugLogListener>();

  get entries(): readonly DebugLogEntry[] {
    return this.#entries;
  }

  info(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.#append("info", message, context);
  }

  warn(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.#append("warn", message, context);
  }

  error(message: string, context?: Readonly<Record<string, unknown>>): void {
    this.#append("error", message, context);
  }

  subscribe(listener: DebugLogListener): () => void {
    this.#listeners.add(listener);
    listener(this.#entries);
    return () => this.#listeners.delete(listener);
  }

  format(): string {
    return this.#entries
      .map((entry) => {
        const time = entry.timestamp.toLocaleTimeString([], { hour12: false });
        const context = entry.context ? ` · ${JSON.stringify(entry.context)}` : "";
        return `${time}  ${entry.level.toUpperCase().padEnd(5)}  ${entry.message}${context}`;
      })
      .join("\n");
  }

  #append(
    level: DebugLogEntry["level"],
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ): void {
    const boundedMessage = message.length > MAX_MESSAGE_LENGTH
      ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…[truncated]`
      : message;
    let safeContext: Readonly<Record<string, unknown>> | undefined;
    try {
      safeContext = sanitizeContext(context);
    } catch {
      safeContext = { sanitizationError: "Context could not be safely retained" };
    }
    this.#entries.push({
      timestamp: new Date(),
      level,
      message: boundedMessage,
      context: safeContext,
    });
    if (this.#entries.length > MAX_ENTRIES) this.#entries.splice(0, this.#entries.length - MAX_ENTRIES);
    for (const listener of this.#listeners) listener(this.#entries);
  }
}
