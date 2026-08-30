import { selectMtpInterface, type UsbInterfaceSelection } from "./descriptors";
import {
  describeUnknownError,
  isAbortError,
  UsbTransportError,
} from "./errors";
import type {
  MtpTransportIoOptions,
  UsbBulkInChunk,
  UsbBulkOutPhase,
  UsbBulkTransport,
  UsbConnectionEventLike,
  UsbDeviceLike,
  UsbDirection,
  UsbManagerLike,
} from "./types";
import { getUsbManager } from "./types";

const DEFAULT_TRANSFER_TIMEOUT_MS = 10_000;
const DEFAULT_CHUNK_SIZE = 64 * 1024;
const DEFAULT_READ_SIZE = 64 * 1024;
const MAX_READ_SIZE = 16 * 1024 * 1024;

export interface WebUsbBulkTransportOptions {
  usb?: UsbManagerLike;
  chunkSize?: number;
  readSize?: number;
  defaultTimeoutMs?: number;
}

export interface UsbWriteOptions extends MtpTransportIoOptions {
  onProgress?: (bytesWritten: number, totalBytes: number) => void;
}

interface TransferContext {
  operation: string;
  direction?: UsbDirection;
  endpointNumber?: number;
}

function positiveInteger(value: number, name: string, maximum?: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || (maximum && value > maximum)) {
    throw new RangeError(
      `${name} must be a positive integer${maximum ? ` no greater than ${maximum}` : ""}.`,
    );
  }
  return value;
}

function timeoutValue(value: number | undefined, fallback: number): number {
  return positiveInteger(value ?? fallback, "timeoutMs");
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function boundedCleanupStep(
  label: string,
  timeoutMs: number,
  operation: () => Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(
      () => finish(() => reject(
        new Error(`${label} timed out after ${timeoutMs} ms`),
      )),
      timeoutMs,
    );
    Promise.resolve().then(operation).then(
      () => finish(resolve),
      (error) => finish(() => reject(error)),
    );
  });
}

export class WebUsbBulkTransport implements UsbBulkTransport {
  readonly device: UsbDeviceLike;
  readonly selection: Readonly<UsbInterfaceSelection>;

  private readonly usb?: UsbManagerLike;
  private readonly chunkSize: number;
  private readonly readSize: number;
  private readonly defaultTimeoutMs: number;
  private readonly disconnectController = new AbortController();
  private claimed = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly pendingNativeOperations = new Set<Promise<unknown>>();

  private readonly handleDisconnect = (event: UsbConnectionEventLike): void => {
    if (event.device !== this.device || this.disconnectController.signal.aborted) {
      return;
    }
    this.disconnectController.abort(
      new UsbTransportError(
        "USB_DEVICE_DISCONNECTED",
        "The Kindle disconnected during a USB operation.",
        this.endpointContext(),
      ),
    );
    void this.close().catch(() => {
      // Physical removal makes release/close best-effort; the disconnect error
      // already contains the actionable failure.
    });
  };

  private constructor(
    device: UsbDeviceLike,
    selection: UsbInterfaceSelection,
    options: WebUsbBulkTransportOptions,
  ) {
    this.device = device;
    this.selection = Object.freeze({ ...selection });
    this.usb = options.usb;
    this.chunkSize = positiveInteger(
      options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      "chunkSize",
    );
    this.readSize = positiveInteger(
      options.readSize ?? DEFAULT_READ_SIZE,
      "readSize",
      MAX_READ_SIZE,
    );
    this.defaultTimeoutMs = positiveInteger(
      options.defaultTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS,
      "defaultTimeoutMs",
    );
  }

  static async connect(
    device: UsbDeviceLike,
    options: WebUsbBulkTransportOptions = {},
  ): Promise<WebUsbBulkTransport> {
    let transport: WebUsbBulkTransport | undefined;

    try {
      const selection = selectMtpInterface(device);
      const usb = options.usb ?? getUsbManager();
      transport = new WebUsbBulkTransport(device, selection, {
        ...options,
        usb,
      });
      usb?.addEventListener("disconnect", transport.handleDisconnect);

      if (!device.opened) {
        try {
          await transport.runTransfer(
            { operation: "open" },
            {},
            () => device.open(),
            true,
          );
        } catch (error) {
          if (isConnectionLifecycleError(error)) throw error;
          throw new UsbTransportError(
            "USB_DEVICE_OPEN_FAILED",
            `Could not open the selected USB device: ${describeUnknownError(error)}`,
            { vendorId: device.vendorId, productId: device.productId },
            { cause: error },
          );
        }
      }

      if (
        device.configuration?.configurationValue !==
        selection.configurationValue
      ) {
        try {
          await transport.runTransfer(
            { operation: "selectConfiguration" },
            {},
            () => device.selectConfiguration(selection.configurationValue),
          );
        } catch (error) {
          if (isConnectionLifecycleError(error)) throw error;
          throw new UsbTransportError(
            "USB_CONFIGURATION_FAILED",
            `Could not select USB configuration ${selection.configurationValue}: ${describeUnknownError(error)}`,
            transport.endpointContext(),
            { cause: error },
          );
        }
      }

      try {
        await transport.runTransfer(
          { operation: "claimInterface" },
          {},
          () => device.claimInterface(selection.interfaceNumber),
        );
        transport.claimed = true;
      } catch (error) {
        if (isConnectionLifecycleError(error)) throw error;
        throw new UsbTransportError(
          "USB_INTERFACE_CLAIM_FAILED",
          `Could not claim USB interface ${selection.interfaceNumber}. Close other MTP applications and confirm file-transfer mode.`,
          transport.endpointContext(),
          { cause: error },
        );
      }

      const selectedInterface = device.configuration?.interfaces.find(
        (usbInterface) =>
          usbInterface.interfaceNumber === selection.interfaceNumber,
      );
      if (
        selectedInterface?.alternate.alternateSetting !==
        selection.alternateSetting
      ) {
        try {
          await transport.runTransfer(
            { operation: "selectAlternateInterface" },
            {},
            () =>
              device.selectAlternateInterface(
                selection.interfaceNumber,
                selection.alternateSetting,
              ),
          );
        } catch (error) {
          if (isConnectionLifecycleError(error)) throw error;
          throw new UsbTransportError(
            "USB_ALTERNATE_SELECTION_FAILED",
            `Could not select alternate ${selection.alternateSetting} on USB interface ${selection.interfaceNumber}.`,
            transport.endpointContext(),
            { cause: error },
          );
        }
      }

      return transport;
    } catch (error) {
      if (transport) {
        await transport.closeAfterConnectFailure();
      } else if (device.opened) {
        try {
          const requestedTimeout = options.defaultTimeoutMs;
          const cleanupTimeout = Number.isSafeInteger(requestedTimeout)
            && (requestedTimeout ?? 0) > 0
              ? requestedTimeout as number
              : DEFAULT_TRANSFER_TIMEOUT_MS;
          await boundedCleanupStep(
            "close device",
            cleanupTimeout,
            () => device.close(),
          );
        } catch {
          // The original connection error is more actionable.
        }
      }
      throw error;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isDisconnected(): boolean {
    return this.disconnectController.signal.aborted;
  }

  /** Lets the controller update UI state immediately on physical removal. */
  get disconnectSignal(): AbortSignal {
    return this.disconnectController.signal;
  }

  async write(
    data: Uint8Array,
    options: UsbWriteOptions = {},
  ): Promise<{ bytesWritten: number }> {
    return this.writePhase(
      {
        length: data.byteLength,
        chunks: singleChunk(data),
        onProgress: options.onProgress,
      },
      options,
    );
  }

  /**
   * Sends exactly one USB Still Image/PTP bulk-OUT phase.
   *
   * WebUSB exposes transfer boundaries directly. Every non-final positive
   * transfer therefore has to contain a whole number of endpoint packets; a
   * short transfer is reserved for the end of the phase. An exact packet
   * multiple is terminated explicitly with a checked zero-length transfer.
   */
  async writePhase(
    phase: UsbBulkOutPhase,
    options: MtpTransportIoOptions = {},
  ): Promise<{ bytesWritten: number }> {
    this.assertUsable("writePhase");
    if (!Number.isSafeInteger(phase.length) || phase.length < 0) {
      throw new RangeError("phase.length must be a non-negative safe integer");
    }
    if (typeof phase.chunks?.[Symbol.asyncIterator] !== "function") {
      throw new TypeError("phase.chunks must be an AsyncIterable of Uint8Array values");
    }

    const packetSize = positiveInteger(
      this.selection.packetSize.bulkOut,
      "bulk OUT endpoint packet size",
    );
    // A staging transfer must itself be packet-aligned. If a caller chooses a
    // smaller chunkSize, one endpoint packet is still the minimum safe unit.
    const packetsPerTransfer = Math.max(1, Math.floor(this.chunkSize / packetSize));
    const transferCapacity = packetsPerTransfer * packetSize;
    const staging = new Uint8Array(transferCapacity);
    const iterator = phase.chunks[Symbol.asyncIterator]();
    let staged = 0;
    let produced = 0;
    let totalWritten = 0;
    let sourceCompleted = false;

    const send = async (chunk: Uint8Array): Promise<void> => {
      // Make the BufferSource's ArrayBuffer ownership explicit for WebUSB's
      // DOM typing and prevent a producer from mutating an in-flight transfer.
      const transferBytes = new Uint8Array(chunk.byteLength);
      transferBytes.set(chunk);
      const result = await this.runTransfer(
        {
          operation: "transferOut",
          direction: "out",
          endpointNumber: this.selection.bulkOutEndpoint,
        },
        options,
        () => this.device.transferOut(this.selection.bulkOutEndpoint, transferBytes),
      );

      this.validateStatus(
        result.status,
        "out",
        this.selection.bulkOutEndpoint,
      );
      if (
        !Number.isInteger(result.bytesWritten)
        || result.bytesWritten !== transferBytes.byteLength
      ) {
        throw new UsbTransportError(
          "USB_SHORT_WRITE",
          `USB reported ${String(result.bytesWritten)} bytes written for a ${transferBytes.byteLength}-byte transfer.`,
          {
            ...this.endpointContext("out", this.selection.bulkOutEndpoint),
            expectedBytes: transferBytes.byteLength,
            bytesWritten: result.bytesWritten,
            totalBytesWrittenBeforeFailure: totalWritten,
          },
        );
      }

      totalWritten += result.bytesWritten;
      try {
        // A ZLP reports the same cumulative count and still constitutes wire
        // activity for the MTP inactivity timer.
        phase.onProgress?.(totalWritten, phase.length);
      } catch {
        // Progress is observational and must not corrupt a phase already sent.
      }
    };

    try {
      while (true) {
        const next = await this.nextPhaseChunk(iterator, options);
        if (next.done) {
          sourceCompleted = true;
          break;
        }
        const source = next.value;
        if (!(source instanceof Uint8Array)) {
          throw new TypeError("phase.chunks must yield Uint8Array values");
        }
        if (produced + source.byteLength > phase.length) {
          throw this.outgoingLengthMismatch(phase.length, produced + source.byteLength);
        }
        produced += source.byteLength;

        let sourceOffset = 0;
        while (sourceOffset < source.byteLength) {
          const copied = Math.min(
            transferCapacity - staged,
            source.byteLength - sourceOffset,
          );
          staging.set(source.subarray(sourceOffset, sourceOffset + copied), staged);
          staged += copied;
          sourceOffset += copied;

          if (staged === transferCapacity) {
            await send(staging);
            staged = 0;
          }
        }
      }

      if (produced !== phase.length) {
        throw this.outgoingLengthMismatch(phase.length, produced);
      }

      if (staged > 0) {
        // This is the sole permitted positive short transfer in the phase.
        await send(staging.slice(0, staged));
      }
      if (phase.length % packetSize === 0) {
        // WebUSB does not promise to append a terminating ZLP when transferOut
        // receives an exact packet multiple, so make that phase delimiter
        // explicit and validate its status/count like every other transfer.
        await send(new Uint8Array());
      }

      return { bytesWritten: totalWritten };
    } finally {
      if (!sourceCompleted && iterator.return) {
        // Cleanup is best effort and deliberately not awaited: a broken source
        // must not be able to hold a timed-out/aborted wire operation open.
        void Promise.resolve(iterator.return()).catch(() => undefined);
      }
    }
  }

  async read(options: MtpTransportIoOptions = {}): Promise<UsbBulkInChunk> {
    this.assertUsable("read");
    const packetSize = positiveInteger(
      this.selection.packetSize.bulkIn,
      "bulk IN endpoint packet size",
    );
    const packetsPerTransfer = Math.max(1, Math.floor(this.readSize / packetSize));
    const transferSize = packetsPerTransfer * packetSize;
    const result = await this.runTransfer(
      {
        operation: "transferIn",
        direction: "in",
        endpointNumber: this.selection.bulkInEndpoint,
      },
      options,
      () =>
        this.device.transferIn(this.selection.bulkInEndpoint, transferSize),
    );

    this.validateStatus(result.status, "in", this.selection.bulkInEndpoint);
    const data = result.data
      ? new Uint8Array(
          result.data.buffer,
          result.data.byteOffset,
          result.data.byteLength,
        ).slice()
      : new Uint8Array();
    if (data.byteLength > transferSize) {
      throw new UsbTransportError(
        "USB_ENDPOINT_BABBLE",
        `USB bulk IN returned ${data.byteLength} bytes for a ${transferSize}-byte request.`,
        {
          ...this.endpointContext("in", this.selection.bulkInEndpoint),
          requestedBytes: transferSize,
          receivedBytes: data.byteLength,
        },
      );
    }
    return {
      data,
      // A short bulk transfer is the USB phase delimiter. A zero-byte result is
      // therefore meaningful here and is validated by the MTP session rather
      // than rejected generically by the transport.
      phaseEnded: data.byteLength < transferSize,
    };
  }

  async clearHalt(
    direction: UsbDirection,
    options: MtpTransportIoOptions = {},
  ): Promise<void> {
    this.assertUsable("clearHalt");
    const endpointNumber =
      direction === "in"
        ? this.selection.bulkInEndpoint
        : this.selection.bulkOutEndpoint;
    await this.runTransfer(
      { operation: "clearHalt", direction, endpointNumber },
      options,
      () => this.device.clearHalt(direction, endpointNumber),
    );
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.performClose(false);
    return this.closePromise;
  }

  /** True while an uncancellable WebUSB promise can still settle in this document. */
  get hasPendingNativeOperations(): boolean {
    return this.pendingNativeOperations.size > 0;
  }

  /** Resolves only after every already-started native WebUSB call has settled. */
  async waitForNativeOperations(): Promise<void> {
    while (this.pendingNativeOperations.size > 0) {
      await Promise.allSettled([...this.pendingNativeOperations]);
    }
  }

  private async closeAfterConnectFailure(): Promise<void> {
    try {
      await this.performClose(true);
    } catch {
      // Preserve the connection failure.
    }
  }

  private async performClose(suppressErrors: boolean): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.usb?.removeEventListener("disconnect", this.handleDisconnect);

    const failures: string[] = [];
    if (this.claimed && deviceCanBeClosed(this.device)) {
      try {
        await boundedCleanupStep(
          "release interface",
          this.defaultTimeoutMs,
          () => this.trackNativeOperation(
            () => this.device.releaseInterface(this.selection.interfaceNumber),
          ),
        );
      } catch (error) {
        failures.push(`release interface: ${describeUnknownError(error)}`);
      } finally {
        this.claimed = false;
      }
    }

    if (this.device.opened) {
      try {
        await boundedCleanupStep(
          "close device",
          this.defaultTimeoutMs,
          () => this.trackNativeOperation(() => this.device.close()),
        );
      } catch (error) {
        failures.push(`close device: ${describeUnknownError(error)}`);
      }
    }

    if (
      failures.length &&
      !suppressErrors &&
      !this.disconnectController.signal.aborted
    ) {
      throw new UsbTransportError(
        "USB_CLOSE_FAILED",
        `USB cleanup was incomplete (${failures.join("; ")}).`,
        this.endpointContext(),
      );
    }
  }

  private async runTransfer<T>(
    context: TransferContext,
    options: MtpTransportIoOptions,
    operation: () => Promise<T>,
    allowUnopened = false,
  ): Promise<T> {
    if (allowUnopened) {
      if (this.disconnectController.signal.aborted) {
        throw this.disconnectController.signal.reason;
      }
      if (this.closed) {
        throw new UsbTransportError(
          "USB_DEVICE_DISCONNECTED",
          `Cannot ${context.operation}: the USB transport is closed.`,
          this.endpointContext(),
        );
      }
    } else {
      this.assertUsable(context.operation);
    }
    if (options.signal?.aborted) {
      throw new UsbTransportError(
        "USB_TRANSFER_ABORTED",
        `${context.operation} was aborted before it began.`,
        { ...this.endpointContext(context.direction, context.endpointNumber) },
        { cause: abortReason(options.signal) },
      );
    }

    const timeoutMs = timeoutValue(options.timeoutMs, this.defaultTimeoutMs);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", handleAbort);
        this.disconnectController.signal.removeEventListener(
          "abort",
          handleDisconnect,
        );
        callback();
      };

      const handleAbort = (): void =>
        finish(() =>
          reject(
            new UsbTransportError(
              "USB_TRANSFER_ABORTED",
              `${context.operation} was aborted.`,
              this.endpointContext(context.direction, context.endpointNumber),
              { cause: options.signal ? abortReason(options.signal) : undefined },
            ),
          ),
        );
      const handleDisconnect = (): void =>
        finish(() => reject(this.disconnectController.signal.reason));
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new UsbTransportError(
                "USB_TRANSFER_TIMEOUT",
                `${context.operation} made no progress for ${timeoutMs} ms.`,
                {
                  ...this.endpointContext(
                    context.direction,
                    context.endpointNumber,
                  ),
                  timeoutMs,
                },
              ),
            ),
          ),
        timeoutMs,
      );

      options.signal?.addEventListener("abort", handleAbort, { once: true });
      this.disconnectController.signal.addEventListener(
        "abort",
        handleDisconnect,
        { once: true },
      );

      // Abort events are edge-triggered. Recheck after subscribing so an abort
      // in the narrow gap after the initial guard cannot turn into a timeout.
      if (options.signal?.aborted) {
        handleAbort();
        return;
      }
      if (this.disconnectController.signal.aborted) {
        handleDisconnect();
        return;
      }

      this.trackNativeOperation(operation).then(
        (value) => {
          if (settled) {
            if (
              context.operation === "open" &&
              this.closed &&
              this.device.opened
            ) {
              void this.device.close().catch(() => {
                // The original timeout/disconnect remains the reported error.
              });
            }
            return;
          }
          finish(() => resolve(value));
        },
        (error) =>
          finish(() => {
            if (error instanceof UsbTransportError) {
              reject(error);
              return;
            }
            if (isAbortError(error)) {
              reject(
                new UsbTransportError(
                  "USB_TRANSFER_ABORTED",
                  `${context.operation} was aborted.`,
                  this.endpointContext(
                    context.direction,
                    context.endpointNumber,
                  ),
                  { cause: error },
                ),
              );
              return;
            }
            if (!allowUnopened && !this.device.opened) {
              reject(
                new UsbTransportError(
                  "USB_DEVICE_DISCONNECTED",
                  `The Kindle disconnected during ${context.operation}.`,
                  this.endpointContext(
                    context.direction,
                    context.endpointNumber,
                  ),
                  { cause: error },
                ),
              );
              return;
            }
            reject(
              new UsbTransportError(
                "USB_TRANSFER_FAILED",
                `${context.operation} failed: ${describeUnknownError(error)}`,
                this.endpointContext(
                  context.direction,
                  context.endpointNumber,
                ),
                { cause: error },
              ),
            );
          }),
      );
    });
  }

  private trackNativeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(operation);
    this.pendingNativeOperations.add(pending);
    void pending.then(
      () => this.pendingNativeOperations.delete(pending),
      () => this.pendingNativeOperations.delete(pending),
    );
    return pending;
  }

  private async nextPhaseChunk(
    iterator: AsyncIterator<Uint8Array>,
    options: MtpTransportIoOptions,
  ): Promise<IteratorResult<Uint8Array>> {
    this.assertUsable("read the outgoing phase source");
    if (options.signal?.aborted) {
      throw new UsbTransportError(
        "USB_TRANSFER_ABORTED",
        "Reading the outgoing phase source was aborted before it began.",
        this.endpointContext("out", this.selection.bulkOutEndpoint),
        { cause: abortReason(options.signal) },
      );
    }

    const timeoutMs = timeoutValue(options.timeoutMs, this.defaultTimeoutMs);
    return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", handleAbort);
        this.disconnectController.signal.removeEventListener(
          "abort",
          handleDisconnect,
        );
        callback();
      };
      const handleAbort = (): void =>
        finish(() =>
          reject(
            new UsbTransportError(
              "USB_TRANSFER_ABORTED",
              "Reading the outgoing phase source was aborted.",
              this.endpointContext("out", this.selection.bulkOutEndpoint),
              { cause: options.signal ? abortReason(options.signal) : undefined },
            ),
          ),
        );
      const handleDisconnect = (): void =>
        finish(() => reject(this.disconnectController.signal.reason));
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new UsbTransportError(
                "USB_TRANSFER_TIMEOUT",
                `The outgoing phase source made no progress for ${timeoutMs} ms.`,
                {
                  ...this.endpointContext("out", this.selection.bulkOutEndpoint),
                  timeoutMs,
                },
              ),
            ),
          ),
        timeoutMs,
      );

      options.signal?.addEventListener("abort", handleAbort, { once: true });
      this.disconnectController.signal.addEventListener(
        "abort",
        handleDisconnect,
        { once: true },
      );
      if (options.signal?.aborted) {
        handleAbort();
        return;
      }
      if (this.disconnectController.signal.aborted) {
        handleDisconnect();
        return;
      }

      Promise.resolve().then(() => iterator.next()).then(
        (value) => finish(() => resolve(value)),
        // Source errors are intentionally preserved. The MTP layer gives them
        // the operation-specific MTP_OUTGOING_SOURCE_ERROR classification.
        (error) => finish(() => reject(error)),
      );
    });
  }

  private outgoingLengthMismatch(
    declaredBytes: number,
    producedBytes: number,
  ): UsbTransportError {
    return new UsbTransportError(
      "USB_OUTGOING_LENGTH_MISMATCH",
      `Outgoing phase produced ${producedBytes} byte(s); expected exactly ${declaredBytes}.`,
      {
        ...this.endpointContext("out", this.selection.bulkOutEndpoint),
        declaredBytes,
        producedBytes,
      },
    );
  }

  private validateStatus(
    status: "ok" | "stall" | "babble",
    direction: UsbDirection,
    endpointNumber: number,
  ): void {
    if (status === "ok") return;
    const context = this.endpointContext(direction, endpointNumber);
    if (status === "stall") {
      throw new UsbTransportError(
        "USB_ENDPOINT_STALLED",
        `USB bulk ${direction.toUpperCase()} endpoint ${endpointNumber} stalled.`,
        {
          ...context,
          safeNextAction:
            "Retry only after the MTP layer explicitly clears this endpoint halt.",
        },
      );
    }
    throw new UsbTransportError(
      "USB_ENDPOINT_BABBLE",
      `USB bulk ${direction.toUpperCase()} endpoint ${endpointNumber} returned babble status.`,
      context,
    );
  }

  private assertUsable(operation: string): void {
    if (this.disconnectController.signal.aborted) {
      throw this.disconnectController.signal.reason;
    }
    if (this.closed || !this.device.opened) {
      throw new UsbTransportError(
        "USB_DEVICE_DISCONNECTED",
        `Cannot ${operation}: the USB transport is closed.`,
        this.endpointContext(),
      );
    }
  }

  private endpointContext(
    direction?: UsbDirection,
    endpointNumber?: number,
  ): Record<string, unknown> {
    return {
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      configurationValue: this.selection.configurationValue,
      interfaceNumber: this.selection.interfaceNumber,
      alternateSetting: this.selection.alternateSetting,
      ...(direction ? { direction } : {}),
      ...(endpointNumber === undefined ? {} : { endpointNumber }),
    };
  }
}

async function* singleChunk(data: Uint8Array): AsyncGenerator<Uint8Array> {
  // Copy once so callers cannot mutate the phase while transferOut is pending.
  yield data.slice();
}

function deviceCanBeClosed(device: UsbDeviceLike): boolean {
  return device.opened;
}

function isConnectionLifecycleError(error: unknown): boolean {
  return (
    error instanceof UsbTransportError &&
    (error.code === "USB_DEVICE_DISCONNECTED" ||
      error.code === "USB_TRANSFER_TIMEOUT" ||
      error.code === "USB_TRANSFER_ABORTED")
  );
}
