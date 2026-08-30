export interface StructuredFailureDiagnostic {
  readonly message: string;
  readonly code?: string;
  readonly fatal?: boolean;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface TransportDiagnostic {
  readonly transportCode: string;
  readonly transportDetails?: Readonly<Record<string, unknown>>;
}

const MAX_ERROR_CHAIN_DEPTH = 8;

const USB_TRANSPORT_CODES = new Set([
  "USB_DEVICE_DISCONNECTED",
  "USB_ENDPOINT_STALLED",
  "USB_ENDPOINT_BABBLE",
  "USB_SHORT_WRITE",
  "USB_OUTGOING_LENGTH_MISMATCH",
  "USB_TRANSFER_FAILED",
  "USB_TRANSFER_TIMEOUT",
  "USB_TRANSFER_ABORTED",
]);

const FATAL_MTP_CODES = new Set([
  "MTP_INVALID_STATE",
  "MTP_TRANSPORT_ERROR",
  "MTP_COMMAND_TIMEOUT",
  "MTP_INACTIVITY_TIMEOUT",
]);

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function messageOf(value: unknown): string {
  const candidate = record(value)?.message;
  return typeof candidate === "string" ? candidate : String(value);
}

/**
 * Produces a small, structured diagnostic for the first typed error in a cause
 * chain. In particular, this unwraps MtpPartialObjectError to its original MTP
 * failure without flattening transaction or USB endpoint context to a string.
 */
export function describeStructuredFailure(error: unknown): StructuredFailureDiagnostic {
  const seen = new Set<object>();
  let current: unknown = error;
  let fallbackMessage = messageOf(error);

  for (let depth = 0; depth < MAX_ERROR_CHAIN_DEPTH; depth += 1) {
    const candidate = record(current);
    if (!candidate || seen.has(candidate)) break;
    seen.add(candidate);

    const message = messageOf(current);
    if (message && message !== "undefined") fallbackMessage = message;
    const code = typeof candidate.code === "string" ? candidate.code : undefined;
    const fatal = typeof candidate.fatal === "boolean" ? candidate.fatal : undefined;
    const context = record(candidate.context);
    const details = record(candidate.details);
    if (code || context || details) {
      return {
        message,
        ...(code ? { code } : {}),
        ...(fatal !== undefined ? { fatal } : {}),
        ...(context ? { context } : {}),
        ...(details ? { details } : {}),
      };
    }
    current = candidate.cause;
  }

  return { message: fallbackMessage };
}

/** Finds only explicit, known USB transport metadata through bounded wrappers. */
export function findTransportDiagnostic(error: unknown): TransportDiagnostic | undefined {
  const seen = new Set<object>();
  const queue: unknown[] = [error];

  for (let visited = 0; queue.length && visited < MAX_ERROR_CHAIN_DEPTH * 3; visited += 1) {
    const current = queue.shift();
    const candidate = record(current);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    const transportCode = typeof candidate.transportCode === "string"
      ? candidate.transportCode
      : undefined;
    if (transportCode) {
      const transportDetails = record(candidate.transportDetails);
      return {
        transportCode,
        ...(transportDetails ? { transportDetails } : {}),
      };
    }

    const code = typeof candidate.code === "string" ? candidate.code : undefined;
    if (code && USB_TRANSPORT_CODES.has(code)) {
      const transportDetails = record(candidate.details);
      return {
        transportCode: code,
        ...(transportDetails ? { transportDetails } : {}),
      };
    }

    // Cause and original-failure fields are deliberately searched before a
    // cleanup failure so the upload's root transport event remains primary.
    queue.push(
      candidate.cause,
      candidate.originalFailure,
      candidate.originalCause,
      candidate.context,
      candidate.details,
      candidate.cleanupFailure,
      candidate.cleanupError,
    );
  }

  return undefined;
}

/**
 * Finds a faulted protocol/transport state through bounded error wrappers.
 * Object-store limit errors intentionally preserve their user-facing code,
 * so callers must also see a fatal MTP session nested as their cause.
 */
export function isFatalTransportFailure(error: unknown): boolean {
  const seen = new Set<object>();
  const queue: unknown[] = [error];

  for (let visited = 0; queue.length && visited < MAX_ERROR_CHAIN_DEPTH * 2; visited += 1) {
    const current = queue.shift();
    const candidate = record(current);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);

    if (candidate.fatal === true) return true;
    const code = typeof candidate.code === "string" ? candidate.code : undefined;
    if (
      (code !== undefined && FATAL_MTP_CODES.has(code))
      || code?.startsWith("USB_") === true
    ) {
      return true;
    }
    queue.push(
      candidate.cause,
      candidate.originalFailure,
      candidate.originalCause,
      candidate.cleanupError,
    );
  }

  return false;
}
