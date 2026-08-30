export type UsbErrorCode =
  | "USB_NOT_SUPPORTED"
  | "USB_PERMISSION_CANCELLED"
  | "USB_DEVICE_NOT_FOUND"
  | "USB_WRONG_DEVICE"
  | "USB_MTP_INTERFACE_NOT_FOUND"
  | "USB_MTP_INTERFACE_AMBIGUOUS"
  | "USB_DEVICE_OPEN_FAILED"
  | "USB_CONFIGURATION_FAILED"
  | "USB_INTERFACE_CLAIM_FAILED"
  | "USB_ALTERNATE_SELECTION_FAILED"
  | "USB_DEVICE_DISCONNECTED"
  | "USB_ENDPOINT_STALLED"
  | "USB_ENDPOINT_BABBLE"
  | "USB_SHORT_WRITE"
  | "USB_OUTGOING_LENGTH_MISMATCH"
  | "USB_TRANSFER_FAILED"
  | "USB_TRANSFER_TIMEOUT"
  | "USB_TRANSFER_ABORTED"
  | "USB_CLOSE_FAILED";

export class UsbTransportError extends Error {
  readonly code: UsbErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: UsbErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UsbTransportError";
    this.code = code;
    this.details = details;
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError"
  );
}

export function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
