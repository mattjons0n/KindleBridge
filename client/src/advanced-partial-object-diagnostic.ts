import {
  exactKindleObjectInfoFromInventory,
  isKindleReadableBookFilename,
  type KindleInventorySnapshot,
  type KindlePartialObjectProbePresentation,
} from "./kindle";

const MAX_PRESENTED_PARTIAL_OBJECT_TARGETS = 500;

export interface AdvancedPartialObjectProbeTarget {
  readonly handle: number;
  readonly filename: string;
  readonly size: number;
}

export interface AdvancedPartialObjectProbeTargetSet {
  readonly targets: readonly AdvancedPartialObjectProbeTarget[];
  readonly eligibleCount: number;
  readonly truncated: boolean;
}

export type AdvancedPartialObjectProbeViewState =
  | { readonly phase: "off" }
  | { readonly phase: "armed" }
  | { readonly phase: "opening" }
  | {
    readonly phase: "available" | "running";
    readonly targets: readonly AdvancedPartialObjectProbeTarget[];
    readonly eligibleCount: number;
    readonly targetsTruncated: boolean;
    readonly hasRun: boolean;
  }
  | {
    readonly phase: "complete";
    readonly targets: readonly AdvancedPartialObjectProbeTarget[];
    readonly eligibleCount: number;
    readonly targetsTruncated: boolean;
    readonly result: KindlePartialObjectProbePresentation;
  }
  | {
    readonly phase: "error";
    readonly targets: readonly AdvancedPartialObjectProbeTarget[];
    readonly eligibleCount: number;
    readonly targetsTruncated: boolean;
    readonly hasRun: boolean;
    readonly message: string;
    readonly result?: KindlePartialObjectProbePresentation;
  };

export interface AdvancedPartialObjectProbeRunRequest {
  readonly handle: number;
  /** Must come from the explicit confirmation control beside the selected current file. */
  readonly confirmed: boolean;
  /** A separate confirmation is required after this connection has already run the probe. */
  readonly repeatConfirmed: boolean;
}

export interface AdvancedPartialObjectProbeMetric {
  readonly label: string;
  readonly value: string;
}

/**
 * Produces bounded display choices from one complete, current inventory. Exact
 * ObjectInfo remains held by the inventory's page-local capability and is
 * re-read by ConnectedKindle immediately before the diagnostic.
 */
export function advancedPartialObjectProbeTargets(
  inventory: KindleInventorySnapshot | undefined,
): AdvancedPartialObjectProbeTargetSet {
  if (inventory?.status !== "complete") {
    return Object.freeze({ targets: Object.freeze([]), eligibleCount: 0, truncated: false });
  }

  const eligible = inventory.objects
    .filter((object) => {
      if (
        object.kind !== "file"
        || object.protectionStatus !== 0
        || object.size < 1
        || object.depth !== 1
        || object.parentHandle !== inventory.documentsHandle
        || object.relativePath !== object.filename
        || !isKindleReadableBookFilename(object.filename)
      ) return false;
      const exact = exactKindleObjectInfoFromInventory(inventory, object.handle);
      return exact !== undefined
        && exact.protectionStatus === 0
        && exact.associationType === 0
        && exact.compressedSize === object.size
        && exact.parentHandle === inventory.documentsHandle;
    })
    .sort((left, right) => left.filename.localeCompare(right.filename, "en", { sensitivity: "base" })
      || left.handle - right.handle);
  const targets = eligible.slice(0, MAX_PRESENTED_PARTIAL_OBJECT_TARGETS).map((object) => Object.freeze({
    handle: object.handle,
    filename: object.filename,
    size: object.size,
  }));
  return Object.freeze({
    targets: Object.freeze(targets),
    eligibleCount: eligible.length,
    truncated: eligible.length > targets.length,
  });
}

/**
 * Explicitly projects the byte-free runtime result. This prevents a future
 * extension of the internal probe result from silently entering exports.
 */
export function exportAdvancedPartialObjectProbeResult(
  result: KindlePartialObjectProbePresentation,
): string {
  return JSON.stringify({
    verdict: result.verdict,
    operation: result.operation,
    objectSize: result.objectSize,
    rangeCount: result.rangeCount,
    requestedRangeBytes: result.requestedRangeBytes,
    returnedRangeBytes: result.returnedRangeBytes,
    overlapBytesVerified: result.overlapBytesVerified,
    repeatBytesVerified: result.repeatBytesVerified,
    wholeObjectComparison: result.wholeObjectComparison,
    referenceBytesRead: result.referenceBytesRead,
    eofBehavior: result.eofBehavior,
    elapsedMs: result.elapsedMs,
  }, null, 2);
}

/** Accessible labels for the same fixed, byte-free result vocabulary. */
export function advancedPartialObjectProbeMetrics(
  result: KindlePartialObjectProbePresentation,
): readonly AdvancedPartialObjectProbeMetric[] {
  return Object.freeze([
    Object.freeze({ label: "Verdict", value: result.verdict }),
    Object.freeze({ label: "Operation", value: result.operation }),
    Object.freeze({ label: "Object size", value: `${result.objectSize} bytes` }),
    Object.freeze({ label: "Bounded ranges", value: `${result.rangeCount}` }),
    Object.freeze({
      label: "Range bytes",
      value: `${result.returnedRangeBytes} returned of ${result.requestedRangeBytes} requested`,
    }),
    Object.freeze({ label: "Overlap verified", value: `${result.overlapBytesVerified} bytes` }),
    Object.freeze({ label: "Repeat verified", value: `${result.repeatBytesVerified} bytes` }),
    Object.freeze({ label: "Whole-object comparison", value: result.wholeObjectComparison }),
    Object.freeze({ label: "Reference bytes read", value: `${result.referenceBytesRead} bytes` }),
    Object.freeze({ label: "EOF behavior", value: result.eofBehavior }),
    Object.freeze({ label: "Elapsed", value: `${result.elapsedMs} ms` }),
  ]);
}
