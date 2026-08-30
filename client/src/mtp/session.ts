import {
  MTP_CONTAINER_HEADER_SIZE,
  MTP_MAX_CONTAINER_PARAMETERS,
  MTP_MAX_RESPONSE_CONTAINER_BYTES,
  MtpContainerType,
  MtpOperationCode,
  MtpResponseCode,
  formatMtpCode,
} from "./constants";
import {
  MtpCodecError,
  decodeContainer,
  decodeContainerHeader,
  decodeContainerParameters,
  encodeCommandContainer,
  encodeContainerHeader,
} from "./codec";
import { type MtpDeviceInfo, decodeDeviceInfo } from "./datasets";

const UINT32_MAX = 0xffff_ffff;
const MAX_MTP_TRANSACTION_ID = 0xffff_fffe;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_INCOMING_CONTAINER_BYTES = 256 * 1024 * 1024 + MTP_CONTAINER_HEADER_SIZE;
const MAX_DEVICE_INFO_DATA_BYTES = 1024 * 1024;

export interface MtpTransportIoOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * One complete USB Still Image/PTP bulk-OUT phase.
 *
 * `length` is the exact number of phase bytes yielded by `chunks`.  Keeping the
 * phase boundary in the transport contract is essential: an arbitrary short
 * USB transfer ends a PTP phase, so a container header and its streamed payload
 * cannot be written as unrelated byte writes.
 */
export interface MtpOutgoingTransportPhase {
  readonly length: number;
  readonly chunks: AsyncIterable<Uint8Array>;
  /** Called after each validated USB transfer with cumulative phase bytes. */
  readonly onProgress?: (bytesWritten: number, totalBytes: number) => void;
}

/** One host-side bulk-IN transfer and whether it consumed the phase delimiter. */
export interface MtpIncomingTransportChunk {
  readonly data: Uint8Array;
  /** True when the transfer completed on a short packet, including a ZLP. */
  readonly phaseEnded: boolean;
}

/** A claimed pair of USB bulk endpoints, expressed without WebUSB dependencies. */
export interface MtpBulkTransport {
  writePhase(
    phase: MtpOutgoingTransportPhase,
    options?: MtpTransportIoOptions,
  ): Promise<{ readonly bytesWritten: number }>;
  read(options?: MtpTransportIoOptions): Promise<MtpIncomingTransportChunk>;
}

export interface MtpSessionOptions {
  readonly commandTimeoutMs?: number;
  readonly inactivityTimeoutMs?: number;
  readonly maxIncomingContainerBytes?: number;
}

export interface MtpOperationOptions {
  readonly signal?: AbortSignal;
  readonly commandTimeoutMs?: number;
  readonly inactivityTimeoutMs?: number;
}

export interface MtpOutgoingData {
  /** Exact data-phase payload length, excluding the 12-byte container header. */
  readonly length: number;
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly onProgress?: (bytesTransferred: number, totalBytes: number) => void;
}

export interface MtpTransactionRequest {
  readonly operationCode: number;
  readonly parameters?: readonly number[];
  readonly dataOut?: MtpOutgoingData;
  readonly expectData?: boolean;
  /** Optional operation-specific cap checked from the data header before allocation. */
  readonly maxDataBytes?: number;
  /** Exact parameter count expected on a successful response. */
  readonly expectedResponseParameterCount?: number;
}

export interface MtpTransactionResult {
  readonly operationCode: number;
  readonly transactionId: number;
  readonly responseCode: number;
  readonly responseParameters: readonly number[];
  readonly data?: Uint8Array;
}

export type MtpSessionState = "idle" | "opening" | "open" | "closing" | "faulted";

export type MtpSessionErrorCode =
  | "MTP_INVALID_STATE"
  | "MTP_INVALID_CONTAINER"
  | "MTP_UNEXPECTED_CONTAINER"
  | "MTP_UNEXPECTED_TRANSACTION"
  | "MTP_UNEXPECTED_OPERATION"
  | "MTP_RESPONSE_ERROR"
  | "MTP_COMMAND_TIMEOUT"
  | "MTP_INACTIVITY_TIMEOUT"
  | "MTP_OPERATION_ABORTED"
  | "MTP_TRANSPORT_ERROR"
  | "MTP_SHORT_WRITE"
  | "MTP_TRANSACTION_ID_EXHAUSTED"
  | "MTP_OUTGOING_LENGTH_MISMATCH"
  | "MTP_OUTGOING_SOURCE_ERROR"
  | "MTP_INCOMING_DATA_TOO_LARGE";

export interface MtpErrorContext {
  readonly operationCode?: number;
  readonly expectedTransactionId?: number;
  readonly receivedTransactionId?: number;
  readonly receivedContainerType?: number;
  readonly responseCode?: number;
  readonly transportCode?: string;
  readonly transportDetails?: Readonly<Record<string, unknown>>;
}

export class MtpSessionError extends Error {
  readonly code: MtpSessionErrorCode;
  readonly fatal: boolean;
  readonly context: MtpErrorContext;
  override readonly cause?: unknown;

  constructor(
    code: MtpSessionErrorCode,
    message: string,
    options: { fatal?: boolean; context?: MtpErrorContext; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "MtpSessionError";
    this.code = code;
    this.fatal = options.fatal ?? true;
    this.context = options.context ?? {};
    this.cause = options.cause;
  }
}

export class MtpResponseError extends MtpSessionError {
  readonly operationCode: number;
  readonly transactionId: number;
  readonly responseCode: number;
  readonly responseParameters: readonly number[];

  constructor(
    operationCode: number,
    transactionId: number,
    responseCode: number,
    responseParameters: readonly number[],
  ) {
    super(
      "MTP_RESPONSE_ERROR",
      `MTP operation ${formatMtpCode(operationCode)} returned ${formatMtpCode(responseCode)}`,
      {
        fatal: false,
        context: {
          operationCode,
          expectedTransactionId: transactionId,
          receivedTransactionId: transactionId,
          receivedContainerType: MtpContainerType.Response,
          responseCode,
        },
      },
    );
    this.name = "MtpResponseError";
    this.operationCode = operationCode;
    this.transactionId = transactionId;
    this.responseCode = responseCode;
    this.responseParameters = responseParameters;
  }
}

interface OperationTiming {
  readonly operationCode: number;
  readonly transactionId: number;
  readonly signal?: AbortSignal;
  readonly inactivityTimeoutMs: number;
  readonly deadline: number;
}

type MtpContainerIdentity = Readonly<{
  type: number;
  code: number;
  transactionId: number;
}>;

function assertPositiveTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number`);
  }
  return value;
}

function assertUint32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new RangeError(`${label} must be an unsigned 32-bit integer`);
  }
}

function abortMessage(signal?: AbortSignal): string {
  if (signal?.reason instanceof Error && signal.reason.message) {
    return signal.reason.message;
  }
  return "MTP operation was aborted";
}

function nestedTransportContext(error: unknown): Pick<
  MtpErrorContext,
  "transportCode" | "transportDetails"
> {
  if (!error || typeof error !== "object") return {};
  const candidate = error as { code?: unknown; details?: unknown };
  const transportCode = typeof candidate.code === "string"
    ? candidate.code
    : undefined;
  const transportDetails = candidate.details
    && typeof candidate.details === "object"
    && !Array.isArray(candidate.details)
      ? candidate.details as Readonly<Record<string, unknown>>
      : undefined;
  return {
    ...(transportCode ? { transportCode } : {}),
    ...(transportDetails ? { transportDetails } : {}),
  };
}

export class MtpSession {
  private readonly transport: MtpBulkTransport;
  private readonly commandTimeoutMs: number;
  private readonly inactivityTimeoutMs: number;
  private readonly maxIncomingContainerBytes: number;
  private incoming = new Uint8Array();
  private incomingLength = 0;
  private incomingPhaseEnded = false;
  private stateValue: MtpSessionState = "idle";
  private sessionIdValue: number | undefined;
  private nextTransactionId = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(transport: MtpBulkTransport, options: MtpSessionOptions = {}) {
    this.transport = transport;
    this.commandTimeoutMs = assertPositiveTimeout(
      options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      "commandTimeoutMs",
    );
    this.inactivityTimeoutMs = assertPositiveTimeout(
      options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS,
      "inactivityTimeoutMs",
    );
    this.maxIncomingContainerBytes = options.maxIncomingContainerBytes
      ?? DEFAULT_MAX_INCOMING_CONTAINER_BYTES;
    if (
      !Number.isInteger(this.maxIncomingContainerBytes)
      || this.maxIncomingContainerBytes < MTP_CONTAINER_HEADER_SIZE
      || this.maxIncomingContainerBytes > UINT32_MAX
    ) {
      throw new RangeError(
        `maxIncomingContainerBytes must be an integer from ${MTP_CONTAINER_HEADER_SIZE} to ${UINT32_MAX}`,
      );
    }
  }

  get state(): MtpSessionState {
    return this.stateValue;
  }

  get sessionId(): number | undefined {
    return this.sessionIdValue;
  }

  get isOpen(): boolean {
    return this.stateValue === "open";
  }

  /**
   * Opens a PTP/MTP session. Per the protocol, OpenSession uses transaction ID
   * zero; successful in-session operations then increase monotonically from 1.
   */
  async open(sessionId = 1, options: MtpOperationOptions = {}): Promise<void> {
    assertUint32(sessionId, "session ID");
    if (sessionId === 0) {
      throw new RangeError("session ID zero is reserved for the pre-session state");
    }
    return this.enqueue(async () => {
      if (this.stateValue !== "idle") {
        throw this.invalidState("open", "idle");
      }
      this.stateValue = "opening";
      this.nextTransactionId = 0;
      try {
        await this.executeInternal(
          {
            operationCode: MtpOperationCode.OpenSession,
            parameters: [sessionId],
            expectedResponseParameterCount: 0,
          },
          options,
          true,
        );
        this.sessionIdValue = sessionId;
        this.stateValue = "open";
      } catch (error) {
        this.stateValue = error instanceof MtpSessionError && error.fatal ? "faulted" : "idle";
        throw error;
      }
    });
  }

  async close(options: MtpOperationOptions = {}): Promise<void> {
    return this.enqueue(async () => {
      if (this.stateValue !== "open") {
        throw this.invalidState("close", "open");
      }
      this.stateValue = "closing";
      try {
        await this.executeInternal(
          {
            operationCode: MtpOperationCode.CloseSession,
            expectedResponseParameterCount: 0,
          },
          options,
          true,
        );
        this.sessionIdValue = undefined;
        this.nextTransactionId = 0;
        this.incoming = new Uint8Array();
        this.incomingLength = 0;
        this.incomingPhaseEnded = false;
        this.stateValue = "idle";
      } catch (error) {
        this.stateValue = error instanceof MtpSessionError && error.fatal ? "faulted" : "open";
        throw error;
      }
    });
  }

  async execute(
    request: MtpTransactionRequest,
    options: MtpOperationOptions = {},
  ): Promise<MtpTransactionResult> {
    return this.enqueue(async () => {
      if (this.stateValue !== "open") {
        throw this.invalidState("execute an operation", "open");
      }
      return this.executeInternal(request, options, true);
    });
  }

  async getDeviceInfo(options: MtpOperationOptions = {}): Promise<MtpDeviceInfo> {
    return this.enqueue(async () => {
      if (this.stateValue !== "idle" && this.stateValue !== "open") {
        throw this.invalidState("get device information", "idle");
      }
      // PTP permits GetDeviceInfo before a session and requires transaction ID
      // zero there. OpenSession starts its own transaction sequence at zero.
      if (this.stateValue === "idle") {
        this.nextTransactionId = 0;
      }
      const result = await this.executeInternal(
        {
          operationCode: MtpOperationCode.GetDeviceInfo,
          expectData: true,
          maxDataBytes: MAX_DEVICE_INFO_DATA_BYTES,
          expectedResponseParameterCount: 0,
        },
        options,
        true,
      );
      return decodeDeviceInfo(this.requireData(result));
    });
  }

  private async executeInternal(
    request: MtpTransactionRequest,
    options: MtpOperationOptions,
    consumeTransactionId: boolean,
  ): Promise<MtpTransactionResult> {
    if (request.dataOut && request.expectData) {
      throw new TypeError("an MTP transaction cannot send and receive a data phase simultaneously");
    }
    if (request.maxDataBytes !== undefined) {
      if (!request.expectData) {
        throw new TypeError("maxDataBytes is valid only for a transaction that expects data");
      }
      if (
        !Number.isInteger(request.maxDataBytes)
        || request.maxDataBytes < 0
        || request.maxDataBytes > UINT32_MAX - MTP_CONTAINER_HEADER_SIZE
      ) {
        throw new RangeError(
          `maxDataBytes must be an integer from 0 to ${UINT32_MAX - MTP_CONTAINER_HEADER_SIZE}`,
        );
      }
    }
    if (
      request.expectedResponseParameterCount !== undefined
      && (
        !Number.isInteger(request.expectedResponseParameterCount)
        || request.expectedResponseParameterCount < 0
        || request.expectedResponseParameterCount > MTP_MAX_CONTAINER_PARAMETERS
      )
    ) {
      throw new RangeError(
        `expectedResponseParameterCount must be an integer from 0 to ${MTP_MAX_CONTAINER_PARAMETERS}`,
      );
    }
    if (!Number.isInteger(request.operationCode) || request.operationCode < 0 || request.operationCode > 0xffff) {
      throw new RangeError("operationCode must be an unsigned 16-bit integer");
    }
    const parameters = request.parameters ?? [];
    if (parameters.length > MTP_MAX_CONTAINER_PARAMETERS) {
      throw new RangeError(
        `an MTP command can contain at most ${MTP_MAX_CONTAINER_PARAMETERS} parameters`,
      );
    }
    for (const parameter of parameters) {
      assertUint32(parameter, "MTP command parameter");
    }
    if (request.dataOut) {
      if (
        !Number.isInteger(request.dataOut.length)
        || request.dataOut.length < 0
        || request.dataOut.length > UINT32_MAX - MTP_CONTAINER_HEADER_SIZE
      ) {
        throw new RangeError(
          `outgoing MTP data length must be an integer from 0 to ${UINT32_MAX - MTP_CONTAINER_HEADER_SIZE}`,
        );
      }
      if (typeof request.dataOut.chunks?.[Symbol.asyncIterator] !== "function") {
        throw new TypeError("outgoing MTP data chunks must be an AsyncIterable");
      }
    }
    if (options.signal?.aborted) {
      throw new MtpSessionError("MTP_OPERATION_ABORTED", abortMessage(options.signal), {
        fatal: false,
        context: { operationCode: request.operationCode },
      });
    }

    const commandTimeoutMs = assertPositiveTimeout(
      options.commandTimeoutMs ?? this.commandTimeoutMs,
      "commandTimeoutMs",
    );
    const inactivityTimeoutMs = assertPositiveTimeout(
      options.inactivityTimeoutMs ?? this.inactivityTimeoutMs,
      "inactivityTimeoutMs",
    );
    const transactionId = this.allocateTransactionId(consumeTransactionId);
    const timing: OperationTiming = {
      operationCode: request.operationCode,
      transactionId,
      signal: options.signal,
      inactivityTimeoutMs,
      deadline: Date.now() + commandTimeoutMs,
    };
    let commandStarted = false;

    try {
      const command = encodeCommandContainer(
        request.operationCode,
        transactionId,
        request.parameters,
      );
      commandStarted = true;
      await this.writePhaseExactly(
        {
          length: command.byteLength,
          chunks: singleChunk(command),
        },
        "command container",
        timing,
      );

      if (request.dataOut) {
        await this.writeDataPhase(request.operationCode, transactionId, request.dataOut, timing);
      }

      let data: Uint8Array | undefined;
      if (request.expectData) {
        const first = await this.readNextContainer(
          timing,
          request.maxDataBytes === undefined
            ? this.maxIncomingContainerBytes
            : Math.min(
                this.maxIncomingContainerBytes,
                request.maxDataBytes + MTP_CONTAINER_HEADER_SIZE,
              ),
        );
        this.validateTransaction(first, request.operationCode, transactionId);
        if (first.type === MtpContainerType.Response) {
          this.validateResponse(first, request.operationCode, transactionId);
          throw new MtpSessionError(
            "MTP_UNEXPECTED_CONTAINER",
            `operation ${formatMtpCode(request.operationCode)} returned OK without its required data container`,
            {
              context: {
                operationCode: request.operationCode,
                expectedTransactionId: transactionId,
                receivedTransactionId: first.transactionId,
                receivedContainerType: first.type,
                responseCode: first.code,
              },
            },
          );
        }
        if (first.type !== MtpContainerType.Data) {
          throw this.unexpectedContainer(first, request.operationCode, transactionId, "data");
        }
        if (first.code !== request.operationCode) {
          throw new MtpSessionError(
            "MTP_UNEXPECTED_OPERATION",
            `data container code ${formatMtpCode(first.code)} does not match operation ${formatMtpCode(request.operationCode)}`,
            {
              context: {
                operationCode: request.operationCode,
                expectedTransactionId: transactionId,
                receivedTransactionId: first.transactionId,
                receivedContainerType: first.type,
              },
            },
          );
        }
        data = first.payload;
      }

      const response = await this.readNextContainer(timing);
      const responseParameters = this.validateResponse(
        response,
        request.operationCode,
        transactionId,
      );
      if (
        request.expectedResponseParameterCount !== undefined
        && responseParameters.length !== request.expectedResponseParameterCount
      ) {
        throw new MtpSessionError(
          "MTP_INVALID_CONTAINER",
          `operation ${formatMtpCode(request.operationCode)} returned ${responseParameters.length} response parameter(s); expected ${request.expectedResponseParameterCount}`,
          {
            context: {
              operationCode: request.operationCode,
              expectedTransactionId: transactionId,
              receivedTransactionId: response.transactionId,
              receivedContainerType: response.type,
              responseCode: response.code,
            },
          },
        );
      }
      return {
        operationCode: request.operationCode,
        transactionId,
        responseCode: response.code,
        responseParameters,
        data,
      };
    } catch (error) {
      const normalized = this.normalizeError(error, request.operationCode, transactionId);
      if (commandStarted && normalized.fatal) {
        this.stateValue = "faulted";
      }
      throw normalized;
    }
  }

  private allocateTransactionId(consume: boolean): number {
    if (!consume) {
      return this.nextTransactionId;
    }
    // 0xFFFFFFFF is reserved and must never appear as an operation transaction
    // ID. This POC reconnects at exhaustion instead of silently rolling over.
    if (this.nextTransactionId > MAX_MTP_TRANSACTION_ID) {
      throw new MtpSessionError(
        "MTP_TRANSACTION_ID_EXHAUSTED",
        "the 32-bit MTP transaction ID space is exhausted; reconnect the device",
      );
    }
    const value = this.nextTransactionId;
    this.nextTransactionId += 1;
    return value;
  }

  private async writeDataPhase(
    operationCode: number,
    transactionId: number,
    data: MtpOutgoingData,
    timing: OperationTiming,
  ): Promise<void> {
    if (!Number.isInteger(data.length) || data.length < 0 || data.length > UINT32_MAX - MTP_CONTAINER_HEADER_SIZE) {
      throw new RangeError(
        `outgoing MTP data length must be an integer from 0 to ${UINT32_MAX - MTP_CONTAINER_HEADER_SIZE}`,
      );
    }
    const header = encodeContainerHeader(
      MtpContainerType.Data,
      operationCode,
      transactionId,
      data.length,
    );
    let lastPayloadProgress = 0;
    await this.writePhaseExactly(
      {
        length: header.byteLength + data.length,
        chunks: this.dataPhaseChunks(
          header,
          data,
          timing,
          operationCode,
          transactionId,
        ),
        onProgress: (phaseBytesWritten) => {
          const payloadBytesWritten = Math.min(
            data.length,
            Math.max(0, phaseBytesWritten - header.byteLength),
          );
          // A terminating ZLP reports the same cumulative byte count. Keep UI
          // progress payload-only and avoid duplicate completion callbacks.
          if (payloadBytesWritten === lastPayloadProgress) return;
          lastPayloadProgress = payloadBytesWritten;
          try {
            data.onProgress?.(payloadBytesWritten, data.length);
          } catch {
            // Progress is observational. UI callback failures must never
            // interrupt a wire transaction already in flight.
          }
        },
      },
      "data container",
      timing,
    );
  }

  private async *dataPhaseChunks(
    header: Uint8Array,
    data: MtpOutgoingData,
    timing: OperationTiming,
    operationCode: number,
    transactionId: number,
  ): AsyncGenerator<Uint8Array> {
    // Header and payload are deliberately yielded into the same transport
    // phase so the 12-byte header cannot become a premature USB short packet.
    yield header;

    let transferred = 0;
    const iterator = data.chunks[Symbol.asyncIterator]();
    while (true) {
      // Source reads (notably Blob.slice().arrayBuffer()) are part of the same
      // bounded command; a stalled source must not bypass either timeout.
      const next = await this.performIo(
        "waiting for outgoing data",
        timing,
        () => iterator.next(),
        "MTP_OUTGOING_SOURCE_ERROR",
        "outgoing data source failed",
      );
      if (next.done) break;
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("outgoing MTP data chunks must be Uint8Array instances");
      }
      if (chunk.byteLength === 0) continue;
      if (transferred + chunk.byteLength > data.length) {
        throw new MtpSessionError(
          "MTP_OUTGOING_LENGTH_MISMATCH",
          `outgoing data exceeded its declared ${data.length}-byte length`,
          {
            context: { operationCode, expectedTransactionId: transactionId },
          },
        );
      }
      transferred += chunk.byteLength;
      yield chunk;
    }
    if (transferred !== data.length) {
      throw new MtpSessionError(
        "MTP_OUTGOING_LENGTH_MISMATCH",
        `outgoing data ended after ${transferred} byte(s), expected ${data.length}`,
        {
          context: { operationCode, expectedTransactionId: transactionId },
        },
      );
    }
  }

  private async writePhaseExactly(
    phase: MtpOutgoingTransportPhase,
    label: string,
    timing: OperationTiming,
  ): Promise<void> {
    const result = await this.performIo(
      `writing ${label}`,
      timing,
      (ioOptions, reportActivity) => this.transport.writePhase(
        {
          ...phase,
          chunks: chunksWithActivity(phase.chunks, reportActivity),
          onProgress: (bytesWritten, totalBytes) => {
            reportActivity();
            phase.onProgress?.(bytesWritten, totalBytes);
          },
        },
        ioOptions,
      ),
    );
    if (
      !Number.isInteger(result.bytesWritten)
      || result.bytesWritten !== phase.length
    ) {
      throw new MtpSessionError(
        "MTP_SHORT_WRITE",
        `short USB write while writing ${label}: wrote ${String(result.bytesWritten)} of ${phase.length} byte(s)`,
        {
          context: {
            operationCode: timing.operationCode,
            expectedTransactionId: timing.transactionId,
          },
        },
      );
    }
  }

  private async readNextContainer(
    timing: OperationTiming,
    maximumLength = this.maxIncomingContainerBytes,
  ): Promise<ReturnType<typeof decodeContainer>> {
    while (this.incomingLength < MTP_CONTAINER_HEADER_SIZE) {
      if (this.incomingPhaseEnded) {
        throw this.invalidContainer(
          new MtpCodecError(
            this.incomingLength === 0
              ? "received an empty USB phase where an MTP container was expected"
              : `USB phase ended after ${this.incomingLength} byte(s), before the MTP header was complete`,
          ),
          timing,
        );
      }
      await this.readIntoBuffer(timing);
    }

    let header: ReturnType<typeof decodeContainerHeader>;
    try {
      header = decodeContainerHeader(this.incoming.subarray(0, this.incomingLength));
    } catch (error) {
      throw this.invalidContainer(error, timing);
    }
    if (header.length < MTP_CONTAINER_HEADER_SIZE) {
      throw this.invalidContainer(
        new MtpCodecError(`invalid MTP container length ${header.length}`),
        timing,
        header,
      );
    }
    let effectiveMaximumLength: number;
    if (header.type === MtpContainerType.Data) {
      effectiveMaximumLength = maximumLength;
    } else if (header.type === MtpContainerType.Response) {
      // PTP/MTP responses contain only the 12-byte header and at most five
      // 32-bit parameters. Apply that wire-protocol bound from the header,
      // before a malicious declared length can drive a payload read or buffer
      // allocation.
      effectiveMaximumLength = Math.min(
        this.maxIncomingContainerBytes,
        MTP_MAX_RESPONSE_CONTAINER_BYTES,
      );
    } else if (
      header.type === MtpContainerType.Command
      || header.type === MtpContainerType.Event
    ) {
      // Commands are host-to-device only and events belong on the interrupt
      // endpoint. Neither is valid in a transaction's bulk-IN response phase.
      this.validateTransaction(header, timing.operationCode, timing.transactionId);
      throw this.unexpectedContainer(
        header,
        timing.operationCode,
        timing.transactionId,
        "data or response",
      );
    } else {
      throw this.invalidContainer(
        new MtpCodecError(`unknown MTP container type ${header.type}`),
        timing,
        header,
      );
    }
    if (header.length > effectiveMaximumLength) {
      if (
        header.type === MtpContainerType.Data
        && effectiveMaximumLength < this.maxIncomingContainerBytes
      ) {
        throw new MtpSessionError(
          "MTP_INCOMING_DATA_TOO_LARGE",
          `MTP data payload declares ${header.length - MTP_CONTAINER_HEADER_SIZE} byte(s), exceeding the operation limit ${effectiveMaximumLength - MTP_CONTAINER_HEADER_SIZE}`,
          {
            context: {
              operationCode: timing.operationCode,
              expectedTransactionId: timing.transactionId,
              receivedTransactionId: header.transactionId,
              receivedContainerType: header.type,
            },
          },
        );
      }
      throw this.invalidContainer(
        new MtpCodecError(
          `MTP container length ${header.length} exceeds limit ${effectiveMaximumLength}`,
        ),
        timing,
        header,
      );
    }

    if (this.incomingLength > header.length) {
      throw this.invalidContainer(
        new MtpCodecError(
          `USB phase contains ${this.incomingLength} byte(s), exceeding its declared MTP container length ${header.length}`,
        ),
        timing,
        header,
      );
    }
    while (this.incomingLength < header.length) {
      if (this.incomingPhaseEnded) {
        throw this.invalidContainer(
          new MtpCodecError(
            `USB phase ended after ${this.incomingLength} byte(s), before the declared ${header.length}-byte MTP container was complete`,
          ),
          timing,
          header,
        );
      }
      await this.readIntoBuffer(timing, header.length);
      if (this.incomingLength > header.length) {
        throw this.invalidContainer(
          new MtpCodecError(
            `USB phase contains ${this.incomingLength} byte(s), exceeding its declared MTP container length ${header.length}`,
          ),
          timing,
          header,
        );
      }
    }

    if (!this.incomingPhaseEnded) {
      // The final data byte exactly filled the host request, so that request
      // completed before it could consume the USB-required terminating ZLP.
      // Consume and validate that delimiter now; otherwise it would be mistaken
      // for the next response container.
      await this.readIntoBuffer(timing, header.length);
      if (this.incomingLength !== header.length || !this.incomingPhaseEnded) {
        throw this.invalidContainer(
          new MtpCodecError(
            "an exact-boundary MTP phase was not followed by an empty terminating USB transfer",
          ),
          timing,
          header,
        );
      }
    }
    const containerBytes = this.incoming.subarray(0, this.incomingLength);
    this.incoming = new Uint8Array();
    this.incomingLength = 0;
    this.incomingPhaseEnded = false;
    try {
      return decodeContainer(containerBytes, effectiveMaximumLength);
    } catch (error) {
      throw this.invalidContainer(error, timing, header);
    }
  }

  private async readIntoBuffer(timing: OperationTiming, requiredCapacity?: number): Promise<void> {
    const chunk = await this.performIo(
      "reading a bulk-IN packet",
      timing,
      (ioOptions) => this.transport.read(ioOptions),
    );
    if (
      !chunk
      || !(chunk.data instanceof Uint8Array)
      || typeof chunk.phaseEnded !== "boolean"
      || (chunk.data.byteLength === 0 && !chunk.phaseEnded)
    ) {
      throw new MtpSessionError(
        "MTP_TRANSPORT_ERROR",
        "bulk transport returned an invalid bulk-IN chunk",
        {
          context: {
            operationCode: timing.operationCode,
            expectedTransactionId: timing.transactionId,
          },
        },
      );
    }
    if (this.incomingPhaseEnded) {
      throw this.invalidContainer(
        new MtpCodecError("attempted to append bytes after the USB phase had ended"),
        timing,
      );
    }
    const combinedLength = this.incomingLength + chunk.data.byteLength;
    if (combinedLength > this.incoming.byteLength) {
      const nextCapacity = requiredCapacity === undefined
        ? Math.max(combinedLength, Math.max(MTP_CONTAINER_HEADER_SIZE, this.incoming.byteLength * 2))
        : Math.max(combinedLength, requiredCapacity);
      const expanded = new Uint8Array(nextCapacity);
      expanded.set(this.incoming.subarray(0, this.incomingLength), 0);
      this.incoming = expanded;
    }
    this.incoming.set(chunk.data, this.incomingLength);
    this.incomingLength = combinedLength;
    this.incomingPhaseEnded = chunk.phaseEnded;
  }

  private validateTransaction(
    container: MtpContainerIdentity,
    operationCode: number,
    transactionId: number,
  ): void {
    if (container.transactionId !== transactionId) {
      throw new MtpSessionError(
        "MTP_UNEXPECTED_TRANSACTION",
        `received transaction ${container.transactionId}, expected ${transactionId} for ${formatMtpCode(operationCode)}`,
        {
          context: {
            operationCode,
            expectedTransactionId: transactionId,
            receivedTransactionId: container.transactionId,
            receivedContainerType: container.type,
            responseCode: container.type === MtpContainerType.Response ? container.code : undefined,
          },
        },
      );
    }
  }

  private validateResponse(
    container: ReturnType<typeof decodeContainer>,
    operationCode: number,
    transactionId: number,
  ): number[] {
    this.validateTransaction(container, operationCode, transactionId);
    if (container.type !== MtpContainerType.Response) {
      throw this.unexpectedContainer(container, operationCode, transactionId, "response");
    }
    let parameters: number[];
    try {
      parameters = decodeContainerParameters(container.payload);
    } catch (error) {
      throw this.invalidContainer(error, {
        operationCode,
        transactionId,
      }, container);
    }
    if (container.code !== MtpResponseCode.OK) {
      throw new MtpResponseError(operationCode, transactionId, container.code, parameters);
    }
    return parameters;
  }

  private unexpectedContainer(
    container: MtpContainerIdentity,
    operationCode: number,
    transactionId: number,
    expected: string,
  ): MtpSessionError {
    return new MtpSessionError(
      "MTP_UNEXPECTED_CONTAINER",
      `received MTP container type ${container.type}; expected ${expected}`,
      {
        context: {
          operationCode,
          expectedTransactionId: transactionId,
          receivedTransactionId: container.transactionId,
          receivedContainerType: container.type,
          responseCode: container.type === MtpContainerType.Response ? container.code : undefined,
        },
      },
    );
  }

  private invalidContainer(
    cause: unknown,
    timing: Pick<OperationTiming, "operationCode" | "transactionId">,
    header?: { readonly transactionId: number; readonly type: number; readonly code: number },
  ): MtpSessionError {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new MtpSessionError("MTP_INVALID_CONTAINER", `invalid MTP container: ${detail}`, {
      cause,
      context: {
        operationCode: timing.operationCode,
        expectedTransactionId: timing.transactionId,
        receivedTransactionId: header?.transactionId,
        receivedContainerType: header?.type,
        responseCode: header?.type === MtpContainerType.Response ? header.code : undefined,
      },
    });
  }

  private async performIo<T>(
    activity: string,
    timing: OperationTiming,
    operation: (
      options: MtpTransportIoOptions,
      reportActivity: () => void,
    ) => Promise<T>,
    failureCode: MtpSessionErrorCode = "MTP_TRANSPORT_ERROR",
    failureLabel = "USB transport failed",
  ): Promise<T> {
    if (timing.signal?.aborted) {
      throw new MtpSessionError("MTP_OPERATION_ABORTED", abortMessage(timing.signal), {
        context: {
          operationCode: timing.operationCode,
          expectedTransactionId: timing.transactionId,
        },
      });
    }
    const remaining = timing.deadline - Date.now();
    if (remaining <= 0) {
      throw new MtpSessionError(
        "MTP_COMMAND_TIMEOUT",
        `MTP command timed out while ${activity}`,
        {
          context: {
            operationCode: timing.operationCode,
            expectedTransactionId: timing.transactionId,
          },
        },
      );
    }
    const controller = new AbortController();

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        timing.signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => {
        controller.abort(timing.signal?.reason);
        finish(() => reject(new MtpSessionError(
          "MTP_OPERATION_ABORTED",
          abortMessage(timing.signal),
          {
            context: {
              operationCode: timing.operationCode,
              expectedTransactionId: timing.transactionId,
            },
          },
        )));
      };
      const scheduleTimeout = (): void => {
        if (settled) return;
        if (timer !== undefined) clearTimeout(timer);
        const currentRemaining = timing.deadline - Date.now();
        const timeoutCode: MtpSessionErrorCode =
          currentRemaining <= timing.inactivityTimeoutMs
            ? "MTP_COMMAND_TIMEOUT"
            : "MTP_INACTIVITY_TIMEOUT";
        const timeoutMs = Math.max(
          0,
          Math.min(timing.inactivityTimeoutMs, currentRemaining),
        );
        timer = setTimeout(() => {
          controller.abort(new Error(`${timeoutCode}: ${activity}`));
          finish(() => reject(new MtpSessionError(
            timeoutCode,
            `MTP ${timeoutCode === "MTP_COMMAND_TIMEOUT" ? "command" : "I/O inactivity"} timed out while ${activity}`,
            {
              context: {
                operationCode: timing.operationCode,
                expectedTransactionId: timing.transactionId,
              },
            },
          )));
        }, timeoutMs);
      };
      const reportActivity = (): void => scheduleTimeout();

      scheduleTimeout();
      timing.signal?.addEventListener("abort", onAbort, { once: true });
      if (timing.signal?.aborted) {
        onAbort();
        return;
      }

      Promise.resolve().then(() => operation(
        {
          signal: controller.signal,
          // The transport applies this per source read / USB transfer. The
          // timer above additionally enforces the immutable command deadline.
          timeoutMs: Math.min(
            timing.inactivityTimeoutMs,
            Math.max(1, timing.deadline - Date.now()),
          ),
        },
        reportActivity,
      )).then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(
          error instanceof MtpSessionError
            ? error
            : new MtpSessionError(
              failureCode,
              `${failureLabel} while ${activity}: ${error instanceof Error ? error.message : String(error)}`,
              {
                cause: error,
                context: {
                  operationCode: timing.operationCode,
                  expectedTransactionId: timing.transactionId,
                  ...nestedTransportContext(error),
                },
              },
            ),
        )),
      );
    });
  }

  private normalizeError(
    error: unknown,
    operationCode: number,
    transactionId: number,
  ): MtpSessionError {
    if (error instanceof MtpSessionError) {
      return error;
    }
    if (error instanceof MtpCodecError || error instanceof RangeError || error instanceof TypeError) {
      return new MtpSessionError("MTP_INVALID_CONTAINER", error.message, {
        cause: error,
        context: { operationCode, expectedTransactionId: transactionId },
      });
    }
    return new MtpSessionError(
      "MTP_TRANSPORT_ERROR",
      `MTP operation failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
        context: {
          operationCode,
          expectedTransactionId: transactionId,
          ...nestedTransportContext(error),
        },
      },
    );
  }

  private invalidState(action: string, expected: MtpSessionState): MtpSessionError {
    return new MtpSessionError(
      "MTP_INVALID_STATE",
      `cannot ${action} while MTP session state is ${this.stateValue}; expected ${expected}`,
      { fatal: false },
    );
  }

  private requireData(result: MtpTransactionResult): Uint8Array {
    if (!result.data) {
      throw new MtpSessionError(
        "MTP_UNEXPECTED_CONTAINER",
        `operation ${formatMtpCode(result.operationCode)} did not return data`,
        {
          context: {
            operationCode: result.operationCode,
            expectedTransactionId: result.transactionId,
          },
        },
      );
    }
    return result.data;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function* singleChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

async function* chunksWithActivity(
  chunks: AsyncIterable<Uint8Array>,
  reportActivity: () => void,
): AsyncGenerator<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const next = await iterator.next();
      reportActivity();
      if (next.done) {
        completed = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!completed && iterator.return) {
      await iterator.return();
    }
  }
}

export function outgoingDataFromBytes(
  bytes: Uint8Array,
  onProgress?: (bytesTransferred: number, totalBytes: number) => void,
): MtpOutgoingData {
  return {
    length: bytes.byteLength,
    chunks: (async function* chunks(): AsyncGenerator<Uint8Array> {
      if (bytes.byteLength > 0) {
        yield bytes;
      }
    })(),
    onProgress,
  };
}
