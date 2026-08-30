export type ServerLogLevel = "info" | "warn" | "error";

export interface ServerLogRecord {
  readonly at: string;
  readonly level: ServerLogLevel;
  readonly event: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

const SENSITIVE_KEY = /(?:path|directory|filename|serial|password|secret|credential|bookbytes|sourcebytes|converteroutput|rawoutput)$/iu;
const MAX_DEPTH = 4;
const MAX_ITEMS = 64;
const MAX_STRING = 500;

export function sanitizeServerLogContext(
  context: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!context) return undefined;
  return sanitize(context, "context", new WeakSet<object>(), 0) as Readonly<Record<string, unknown>>;
}

export function structuredServerLog(
  target: Pick<NodeJS.WriteStream, "write">,
  level: ServerLogLevel,
  event: string,
  context?: Readonly<Record<string, unknown>>,
): void {
  const record: ServerLogRecord = {
    at: new Date().toISOString(),
    level,
    event: event.replace(/[^a-z0-9._-]/giu, "_").slice(0, 100) || "catalog.event",
    ...(context ? { context: sanitizeServerLogContext(context) } : {}),
  };
  target.write(`${JSON.stringify(record)}\n`);
}

function sanitize(value: unknown, key: string, seen: WeakSet<object>, depth: number): unknown {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING)}…[truncated]`;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[maximum depth]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => sanitize(item, key, seen, depth + 1));
  if (value instanceof Error) return { name: value.name };
  return Object.fromEntries(
    Object.entries(value).slice(0, MAX_ITEMS).map(([nestedKey, nestedValue]) => [
      nestedKey,
      sanitize(nestedValue, nestedKey, seen, depth + 1),
    ]),
  );
}
