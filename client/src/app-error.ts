import type { KindleErrorCode } from "./kindle/errors";
import type { MtpObjectStoreErrorCode } from "./mtp/object-store";
import type { MtpSessionErrorCode } from "./mtp/session";
import type { UsbErrorCode } from "./usb/errors";
import { findTransportDiagnostic } from "./error-diagnostics";

export type AppErrorCode =
  | UsbErrorCode
  | MtpSessionErrorCode
  | MtpObjectStoreErrorCode
  | KindleErrorCode
  | "CONVERSION_INVALID_INPUT"
  | "CONVERSION_TIMEOUT"
  | "CONVERSION_ABORTED"
  | "CONVERSION_BUSY"
  | "CONVERSION_OUTPUT_TOO_LARGE"
  | "CONVERSION_FAILED"
  | "CATALOG_SOURCE_CHANGED"
  | "CATALOG_FORMAT_MISMATCH"
  | "CATALOG_HASH_MISSING"
  | "CATALOG_REQUEST_FAILED"
  | "INVALID_UPDATE_ARTIFACT"
  | "INSUFFICIENT_COEXISTENCE_SPACE"
  | "OLD_COPY_CHANGED"
  | "OLD_COPY_NOT_MANAGED"
  | "INVENTORY_INCOMPLETE"
  | "UNSUPPORTED_EDITED_AZW3"
  | "REQUEST_TOO_LARGE"
  | "ORIGIN_NOT_ALLOWED"
  | "INTERNAL_ERROR"
  | "USB_DEVICE_IDENTITY_UNAVAILABLE"
  | "USB_OPEN_TIMEOUT"
  | "USB_SESSION_STALE"
  | "INVALID_STATE"
  | "UNKNOWN_ERROR";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;

  constructor(
    code: AppErrorCode,
    message: string,
    options: {
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function toAppError(error: unknown, fallbackMessage = "An unexpected error occurred"): AppError {
  if (error instanceof AppError) return error;
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "NotFoundError") {
    return new AppError("USB_PERMISSION_CANCELLED", "No USB device was selected", { cause: error });
  }
  if (error instanceof Error) {
    const source = error as Error & {
      code?: unknown;
      details?: unknown;
      context?: unknown;
      fatal?: unknown;
      handle?: unknown;
      filename?: unknown;
      cleanupAttempted?: unknown;
      cleanupSucceeded?: unknown;
    };
    if (typeof source.code === "string") {
      const rawDetails = source.details ?? source.context;
      const details = rawDetails && typeof rawDetails === "object"
        ? { ...(rawDetails as Record<string, unknown>) }
        : {};
      if (typeof source.fatal === "boolean") details.fatal = source.fatal;
      const transport = findTransportDiagnostic(error);
      if (transport && typeof details.transportCode !== "string") {
        details.transportCode = transport.transportCode;
        if (transport.transportDetails) details.transportDetails = transport.transportDetails;
      }
      return new AppError(source.code as AppErrorCode, source.message || fallbackMessage, {
        details,
        cause: error,
      });
    }
    if (source.cleanupAttempted === true && typeof source.handle === "number") {
      const transport = findTransportDiagnostic(error);
      return new AppError(
        "MTP_PARTIAL_OBJECT_CLEANUP_FAILED",
        source.message || fallbackMessage,
        {
          cause: error,
          details: {
            createdHandle: source.handle,
            filename: source.filename,
            cleanupAttempted: true,
            cleanupSucceeded: source.cleanupSucceeded === true,
            ...(transport ?? {}),
          },
        },
      );
    }
    return new AppError("UNKNOWN_ERROR", error.message || fallbackMessage, { cause: error });
  }
  return new AppError("UNKNOWN_ERROR", fallbackMessage, { cause: error });
}
