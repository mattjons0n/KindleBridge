import { MtpOperationCode, MtpResponseCode } from "../mtp/constants";
import type { KindleObjectStore, KindleOperationOptions } from "./contracts";

const UINT32_MAX = 0xffff_ffff;
const DEFAULT_SAMPLE_BYTES = 4 * 1024;
const MAX_SAMPLE_BYTES = 64 * 1024;
const DEFAULT_MAX_REFERENCE_BYTES = 256 * 1024;
const MAX_REFERENCE_BYTES = 1024 * 1024;

export type KindlePartialObjectProbeErrorCode =
  | "KINDLE_PARTIAL_OBJECT_PROBE_DISABLED"
  | "KINDLE_PARTIAL_OBJECT_PROBE_ALREADY_RUN"
  | "KINDLE_PARTIAL_OBJECT_PROBE_SELECTION_INVALID"
  | "KINDLE_PARTIAL_OBJECT_NOT_ADVERTISED"
  | "KINDLE_PARTIAL_OBJECT_PROBE_SHORT_READ"
  | "KINDLE_PARTIAL_OBJECT_PROBE_MISMATCH"
  | "KINDLE_PARTIAL_OBJECT_PROBE_EOF_MISMATCH"
  | "KINDLE_PARTIAL_OBJECT_PROBE_REFERENCE_MISMATCH";

export class KindlePartialObjectProbeError extends Error {
  readonly code: KindlePartialObjectProbeErrorCode;

  constructor(code: KindlePartialObjectProbeErrorCode, message: string) {
    super(message);
    this.name = "KindlePartialObjectProbeError";
    this.code = code;
  }
}

export interface KindlePartialObjectProbeRequest {
  /** One concrete existing object selected by development tooling. */
  readonly handle: number;
  /** Exact compressed size from the object's current live ObjectInfo. */
  readonly objectSize: number;
  /** Per-read sample size; hard-capped at 64 KiB. */
  readonly sampleBytes?: number;
}

export interface KindlePartialObjectProbeSample {
  readonly purpose: "prefix" | "overlap" | "middle" | "tail" | "repeat" | "eof" | "beyond-eof";
  readonly offset: number;
  readonly requestedBytes: number;
  readonly returnedBytes: number;
  /** Non-OK MTP responses reject below this result contract. */
  readonly responseCode: MtpResponseCode.OK;
  readonly elapsedMs: number;
}

export interface KindlePartialObjectProbeResult {
  readonly operationCode: MtpOperationCode.GetPartialObject;
  readonly operationAdvertised: true;
  readonly objectSize: number;
  readonly sampleBytes: number;
  readonly samples: readonly KindlePartialObjectProbeSample[];
  readonly overlapBytesVerified: number;
  readonly repeatBytesVerified: number;
  readonly wholeObjectComparison: "matched" | "not-run-object-too-large" | "not-run-unavailable";
  readonly referenceBytesRead: number;
  readonly eofBehavior: "zero-byte-success" | "exact-only-offset-limit" | "not-probed-offset-limit";
  readonly totalBytesRead: number;
  readonly elapsedMs: number;
}

export interface KindlePartialObjectProbeRunOptions extends KindleOperationOptions {
  readonly maxReferenceBytes?: number;
  readonly now?: () => number;
}

/** Byte-free projection suitable for a later Advanced diagnostics panel. */
export interface KindlePartialObjectProbePresentation {
  readonly verdict: "advertised-and-consistent";
  readonly operation: "GetPartialObject (0x101b)";
  readonly objectSize: number;
  readonly rangeCount: number;
  readonly requestedRangeBytes: number;
  readonly returnedRangeBytes: number;
  readonly overlapBytesVerified: number;
  readonly repeatBytesVerified: number;
  readonly wholeObjectComparison: KindlePartialObjectProbeResult["wholeObjectComparison"];
  readonly referenceBytesRead: number;
  readonly eofBehavior: KindlePartialObjectProbeResult["eofBehavior"];
  readonly elapsedMs: number;
}

function boundedPositiveInteger(
  value: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function kindleAdvertisesPartialObject(
  operationsSupported: readonly number[] | undefined,
): boolean {
  return operationsSupported?.includes(MtpOperationCode.GetPartialObject) === true;
}

/**
 * Development-only, read-only capability probe. It is intentionally separate
 * from inventory and returns measurements rather than any sampled book bytes.
 */
export async function runKindlePartialObjectProbe(
  store: Pick<KindleObjectStore, "readObjectRange"> & Partial<Pick<KindleObjectStore, "readObject">>,
  operationsSupported: readonly number[] | undefined,
  request: KindlePartialObjectProbeRequest,
  options: KindlePartialObjectProbeRunOptions = {},
): Promise<KindlePartialObjectProbeResult> {
  if (!kindleAdvertisesPartialObject(operationsSupported)) {
    throw new KindlePartialObjectProbeError(
      "KINDLE_PARTIAL_OBJECT_NOT_ADVERTISED",
      "The connected MTP device does not advertise GetPartialObject (0x101b).",
    );
  }
  boundedPositiveInteger(request.handle, UINT32_MAX - 1, "object handle");
  const objectSize = boundedPositiveInteger(request.objectSize, UINT32_MAX, "objectSize");
  const sampleBytes = boundedPositiveInteger(
    request.sampleBytes ?? DEFAULT_SAMPLE_BYTES,
    MAX_SAMPLE_BYTES,
    "sampleBytes",
  );
  const maxReferenceBytes = boundedPositiveInteger(
    options.maxReferenceBytes ?? DEFAULT_MAX_REFERENCE_BYTES,
    MAX_REFERENCE_BYTES,
    "maxReferenceBytes",
  );
  const now = options.now ?? (() => performance.now());
  const probeStartedAt = now();
  const operationOptions: KindleOperationOptions = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs }),
    ...(options.inactivityTimeoutMs === undefined ? {} : { inactivityTimeoutMs: options.inactivityTimeoutMs }),
    ...(options.onObjectState === undefined ? {} : { onObjectState: options.onObjectState }),
  };
  const sampleLength = Math.min(sampleBytes, objectSize);
  const samples: KindlePartialObjectProbeSample[] = [];

  const readExact = async (
    purpose: KindlePartialObjectProbeSample["purpose"],
    offset: number,
    length: number,
  ): Promise<Uint8Array> => {
    const startedAt = now();
    const bytes = await store.readObjectRange({
      handle: request.handle,
      offset,
      length,
    }, operationOptions);
    samples.push(Object.freeze({
      purpose,
      offset,
      requestedBytes: length,
      returnedBytes: bytes.byteLength,
      responseCode: MtpResponseCode.OK,
      elapsedMs: Math.max(0, now() - startedAt),
    }));
    if (bytes.byteLength !== length) {
      throw new KindlePartialObjectProbeError(
        "KINDLE_PARTIAL_OBJECT_PROBE_SHORT_READ",
        `GetPartialObject returned ${bytes.byteLength} byte(s) for a ${length}-byte in-bounds probe range.`,
      );
    }
    return bytes;
  };

  const prefix = await readExact("prefix", 0, sampleLength);
  let overlapBytesVerified = 0;
  let overlap: { readonly offset: number; readonly bytes: Uint8Array } | undefined;
  if (sampleLength >= 2 && objectSize > 1) {
    const offset = Math.floor(sampleLength / 2);
    const length = Math.min(sampleLength, objectSize - offset);
    const bytes = await readExact("overlap", offset, length);
    const sharedLength = Math.min(prefix.byteLength - offset, bytes.byteLength);
    if (sharedLength > 0) {
      if (!equalBytes(prefix.subarray(offset, offset + sharedLength), bytes.subarray(0, sharedLength))) {
        throw new KindlePartialObjectProbeError(
          "KINDLE_PARTIAL_OBJECT_PROBE_MISMATCH",
          "Overlapping GetPartialObject ranges returned different bytes.",
        );
      }
      overlapBytesVerified = sharedLength;
    }
    overlap = { offset, bytes };
  }

  const middleOffset = Math.floor((objectSize - sampleLength) / 2);
  const middle = middleOffset === 0
    ? prefix
    : overlap?.offset === middleOffset
      ? overlap.bytes
      : await readExact("middle", middleOffset, sampleLength);

  const tailOffset = objectSize - sampleLength;
  const tail = tailOffset === 0
    ? prefix
    : overlap?.offset === tailOffset
      ? overlap.bytes
      : await readExact("tail", tailOffset, sampleLength);
  const repeatedTail = await readExact("repeat", tailOffset, sampleLength);
  if (!equalBytes(tail, repeatedTail)) {
    throw new KindlePartialObjectProbeError(
      "KINDLE_PARTIAL_OBJECT_PROBE_MISMATCH",
      "Repeated GetPartialObject ranges returned different bytes.",
    );
  }


  let eofBehavior: KindlePartialObjectProbeResult["eofBehavior"] = "not-probed-offset-limit";
  if (objectSize < UINT32_MAX) {
    const startedAt = now();
    const eof = await store.readObjectRange({
      handle: request.handle,
      offset: objectSize,
      length: 1,
    }, operationOptions);
    samples.push(Object.freeze({
      purpose: "eof",
      offset: objectSize,
      requestedBytes: 1,
      returnedBytes: eof.byteLength,
      responseCode: MtpResponseCode.OK,
      elapsedMs: Math.max(0, now() - startedAt),
    }));
    if (eof.byteLength !== 0) {
      throw new KindlePartialObjectProbeError(
        "KINDLE_PARTIAL_OBJECT_PROBE_EOF_MISMATCH",
        "GetPartialObject returned bytes for a range beginning exactly at EOF.",
      );
    }
    eofBehavior = "zero-byte-success";
    if (objectSize < UINT32_MAX - 1) {
      const beyondStartedAt = now();
      const beyond = await store.readObjectRange({
        handle: request.handle,
        offset: objectSize + 1,
        length: 1,
      }, operationOptions);
      samples.push(Object.freeze({
        purpose: "beyond-eof",
        offset: objectSize + 1,
        requestedBytes: 1,
        returnedBytes: beyond.byteLength,
        responseCode: MtpResponseCode.OK,
        elapsedMs: Math.max(0, now() - beyondStartedAt),
      }));
      if (beyond.byteLength !== 0) {
        throw new KindlePartialObjectProbeError(
          "KINDLE_PARTIAL_OBJECT_PROBE_EOF_MISMATCH",
          "GetPartialObject returned bytes for a range beginning beyond EOF.",
        );
      }
    } else {
      eofBehavior = "exact-only-offset-limit";
    }
  }

  let wholeObjectComparison: KindlePartialObjectProbeResult["wholeObjectComparison"] =
    objectSize > maxReferenceBytes ? "not-run-object-too-large" : "not-run-unavailable";
  let referenceBytesRead = 0;
  if (objectSize <= maxReferenceBytes && store.readObject !== undefined) {
    const reference = await store.readObject(request.handle, {
      ...operationOptions,
      maxBytes: objectSize,
    });
    referenceBytesRead = reference.byteLength;
    if (
      reference.byteLength !== objectSize
      || !equalBytes(reference.subarray(0, prefix.byteLength), prefix)
      || !equalBytes(reference.subarray(middleOffset, middleOffset + middle.byteLength), middle)
      || !equalBytes(reference.subarray(tailOffset, tailOffset + tail.byteLength), tail)
    ) {
      throw new KindlePartialObjectProbeError(
        "KINDLE_PARTIAL_OBJECT_PROBE_REFERENCE_MISMATCH",
        "GetPartialObject ranges differ from the bounded whole-object reference.",
      );
    }
    wholeObjectComparison = "matched";
  }

  return Object.freeze({
    operationCode: MtpOperationCode.GetPartialObject,
    operationAdvertised: true,
    objectSize,
    sampleBytes: sampleLength,
    samples: Object.freeze(samples),
    overlapBytesVerified,
    repeatBytesVerified: sampleLength,
    wholeObjectComparison,
    referenceBytesRead,
    eofBehavior,
    totalBytesRead: samples.reduce((total, sample) => total + sample.returnedBytes, 0) + referenceBytesRead,
    elapsedMs: Math.max(0, now() - probeStartedAt),
  });
}

export function presentKindlePartialObjectProbeResult(
  result: KindlePartialObjectProbeResult,
): KindlePartialObjectProbePresentation {
  const requestedRangeBytes = result.samples.reduce((total, sample) => total + sample.requestedBytes, 0);
  const returnedRangeBytes = result.samples.reduce((total, sample) => total + sample.returnedBytes, 0);
  return Object.freeze({
    verdict: "advertised-and-consistent",
    operation: "GetPartialObject (0x101b)",
    objectSize: result.objectSize,
    rangeCount: result.samples.length,
    requestedRangeBytes,
    returnedRangeBytes,
    overlapBytesVerified: result.overlapBytesVerified,
    repeatBytesVerified: result.repeatBytesVerified,
    wholeObjectComparison: result.wholeObjectComparison,
    referenceBytesRead: result.referenceBytesRead,
    eofBehavior: result.eofBehavior,
    elapsedMs: result.elapsedMs,
  });
}
