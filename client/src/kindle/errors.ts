export type KindleErrorCode =
  | "TRANSFER_CANCELLED"
  | "MTP_STORAGE_NOT_WRITABLE"
  | "MTP_INSUFFICIENT_SPACE"
  | "MTP_DOCUMENTS_NOT_FOUND"
  | "MTP_FILENAME_INVALID"
  | "MTP_FILENAME_COLLISION"
  | "MTP_INVALID_BOOK"
  | "MTP_SELF_TEST_REQUIRED"
  | "MTP_BOOK_REMOVAL_REJECTED"
  | "MTP_OBJECT_VERIFICATION_FAILED"
  | "MTP_READBACK_MISMATCH"
  | "MTP_PARTIAL_OBJECT_CLEANUP_FAILED";

export class KindleDeviceError extends Error {
  readonly code: KindleErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: KindleErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KindleDeviceError";
    this.code = code;
    this.details = details;
  }
}
