export type SafeKindleUpdateStage =
  | "preparing"
  | "checking-write-proof"
  | "revalidating-old-copy"
  | "checking-capacity"
  | "uploading-new-copy"
  | "verifying-new-copy"
  | "recording-new-copy"
  | "recording-required"
  | "deleting-old-copy"
  | "verifying-old-copy-absent"
  | "reconciling"
  | "reconciliation-required"
  | "complete"
  | "cleanup-required";

export interface SafeKindleUpdatePreparedArtifact {
  readonly filename: string;
  readonly byteLength: number;
  readonly artifactHash: string;
  /** Opaque prepared derivative; never the mounted source file. */
  readonly value: unknown;
}

export interface SafeKindleUpdateOldCopy {
  readonly handle: number;
  readonly filename: string;
  readonly byteLength: number;
  readonly exactIdentity: string;
}

export interface SafeKindleUpdateUploadedCopy {
  readonly handle: number;
  readonly filename: string;
  readonly byteLength: number;
  readonly exactIdentity?: string;
}

export interface SafeKindleUpdateVerifiedCopy extends SafeKindleUpdateUploadedCopy {
  readonly exactIdentity: string;
}

export interface SafeKindleUpdateDependencies {
  /** Source/hash/overlay/conversion/PDOC validation completes before device mutation. */
  readonly prepare: () => Promise<SafeKindleUpdatePreparedArtifact>;
  /** Owns the one browser/device operation lock for all MTP stages. */
  readonly withDeviceLock: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly ensureCurrentConnectionWriteProof: () => Promise<void>;
  readonly revalidateOldCopy: (expected: SafeKindleUpdateOldCopy) => Promise<SafeKindleUpdateOldCopy>;
  readonly readFreeBytes: () => Promise<bigint>;
  readonly uploadNewCopy: (prepared: SafeKindleUpdatePreparedArtifact) => Promise<SafeKindleUpdateUploadedCopy>;
  readonly verifyNewCopy: (
    uploaded: SafeKindleUpdateUploadedCopy,
    prepared: SafeKindleUpdatePreparedArtifact,
  ) => Promise<SafeKindleUpdateVerifiedCopy>;
  /** Must durably accept the verified identity before old-copy deletion. */
  readonly recordVerifiedDelivery: (
    verified: SafeKindleUpdateVerifiedCopy,
    prepared: SafeKindleUpdatePreparedArtifact,
  ) => Promise<void>;
  readonly deleteExactOldCopy: (revalidated: SafeKindleUpdateOldCopy) => Promise<void>;
  readonly verifyOldCopyAbsent: (oldCopy: SafeKindleUpdateOldCopy) => Promise<void>;
  /** Persist a non-authoritative exact-cleanup reminder before reconciliation. */
  readonly recordCleanupRequired?: (
    verified: SafeKindleUpdateVerifiedCopy,
    oldCopy: SafeKindleUpdateOldCopy,
    reason: "delivery-recording" | "old-copy-cleanup",
  ) => Promise<void>;
  readonly reconcile: () => Promise<void>;
  readonly onStage?: (stage: SafeKindleUpdateStage) => void;
  /** Optional reserve retained for Kindle indexing and subsequent housekeeping. */
  readonly freeSpaceReserveBytes?: bigint;
}

export type SafeKindleUpdateResult =
  | {
      readonly status: "new-copy-kept-old-recording-required";
      readonly newCopy: SafeKindleUpdateVerifiedCopy;
      readonly oldCopy: SafeKindleUpdateOldCopy;
      readonly deliveryRecordError: unknown;
      readonly cleanupRecordError?: unknown;
    }
  | {
      readonly status: "updated";
      readonly newCopy: SafeKindleUpdateVerifiedCopy;
      readonly oldCopy: SafeKindleUpdateOldCopy;
    }
  | {
      readonly status: "new-copy-kept-old-cleanup-required";
      readonly newCopy: SafeKindleUpdateVerifiedCopy;
      readonly oldCopy: SafeKindleUpdateOldCopy;
      readonly cleanupError: unknown;
      /** Journal failure is explicit; it never obscures the verified new copy. */
      readonly cleanupRecordError?: unknown;
    }
  | {
      readonly status: "updated-reconciliation-required";
      readonly newCopy: SafeKindleUpdateVerifiedCopy;
      readonly oldCopy: SafeKindleUpdateOldCopy;
      readonly reconciliationError: unknown;
    };

export class SafeKindleUpdateError extends Error {
  constructor(
    readonly code:
      | "INVALID_UPDATE_ARTIFACT"
      | "INSUFFICIENT_COEXISTENCE_SPACE"
      | "OLD_COPY_CHANGED"
      | "OLD_COPY_NOT_MANAGED"
      | "INVENTORY_INCOMPLETE"
      | "UNSUPPORTED_EDITED_AZW3",
    message: string,
  ) {
    super(message);
    this.name = "SafeKindleUpdateError";
  }
}

function validPrepared(value: SafeKindleUpdatePreparedArtifact): boolean {
  return typeof value.filename === "string"
    && value.filename.length > 0
    && value.filename.length <= 255
    && !/[\\/\p{Cc}]/u.test(value.filename)
    && Number.isSafeInteger(value.byteLength)
    && value.byteLength > 0
    && value.byteLength <= 0xffff_ffff
    && /^[a-f0-9]{64}$/u.test(value.artifactHash);
}

function sameOldCopy(left: SafeKindleUpdateOldCopy, right: SafeKindleUpdateOldCopy): boolean {
  return left.handle === right.handle
    && left.filename === right.filename
    && left.byteLength === right.byteLength
    && left.exactIdentity === right.exactIdentity;
}

/**
 * Implements the loss-averse update order:
 * prepare -> upload/verify/record new -> delete/verify exact old -> reconcile.
 * It never silently falls back to delete-first when capacity is low.
 */
export async function runSafeKindleUpdate(
  expectedOldCopy: SafeKindleUpdateOldCopy,
  dependencies: SafeKindleUpdateDependencies,
): Promise<SafeKindleUpdateResult> {
  dependencies.onStage?.("preparing");
  const prepared = await dependencies.prepare();
  if (!validPrepared(prepared)) {
    throw new SafeKindleUpdateError("INVALID_UPDATE_ARTIFACT", "The prepared Kindle derivative is invalid.");
  }
  const reserve = dependencies.freeSpaceReserveBytes ?? 0n;
  if (reserve < 0n) throw new RangeError("freeSpaceReserveBytes cannot be negative");

  return dependencies.withDeviceLock(async () => {
    dependencies.onStage?.("checking-write-proof");
    await dependencies.ensureCurrentConnectionWriteProof();
    dependencies.onStage?.("revalidating-old-copy");
    const firstOldSnapshot = await dependencies.revalidateOldCopy(expectedOldCopy);
    if (!sameOldCopy(firstOldSnapshot, expectedOldCopy)) {
      throw new SafeKindleUpdateError("OLD_COPY_CHANGED", "The old Kindle copy changed before update.");
    }
    dependencies.onStage?.("checking-capacity");
    const freeBytes = await dependencies.readFreeBytes();
    const required = BigInt(prepared.byteLength) + reserve;
    if (freeBytes < required) {
      throw new SafeKindleUpdateError(
        "INSUFFICIENT_COEXISTENCE_SPACE",
        "The Kindle does not have enough free space to hold the verified replacement beside the old copy.",
      );
    }

    dependencies.onStage?.("uploading-new-copy");
    const uploaded = await dependencies.uploadNewCopy(prepared);
    dependencies.onStage?.("verifying-new-copy");
    const verified = await dependencies.verifyNewCopy(uploaded, prepared);
    dependencies.onStage?.("recording-new-copy");
    try {
      await dependencies.recordVerifiedDelivery(verified, prepared);
    } catch (deliveryRecordError) {
      dependencies.onStage?.("recording-required");
      let cleanupRecordError: unknown;
      try {
        await dependencies.recordCleanupRequired?.(verified, expectedOldCopy, "delivery-recording");
      } catch (error) {
        cleanupRecordError = error;
      }
      try {
        dependencies.onStage?.("reconciling");
        await dependencies.reconcile();
      } catch {
        // Both exact copies remain; reconnect can reconcile the durable reminder.
      }
      return Object.freeze({
        status: "new-copy-kept-old-recording-required" as const,
        newCopy: verified,
        oldCopy: expectedOldCopy,
        deliveryRecordError,
        ...(cleanupRecordError === undefined ? {} : { cleanupRecordError }),
      });
    }

    let oldForDeletion: SafeKindleUpdateOldCopy;
    try {
      dependencies.onStage?.("deleting-old-copy");
      oldForDeletion = await dependencies.revalidateOldCopy(expectedOldCopy);
      if (!sameOldCopy(oldForDeletion, expectedOldCopy)) {
        throw new SafeKindleUpdateError("OLD_COPY_CHANGED", "The old Kindle copy changed after replacement upload.");
      }
      await dependencies.deleteExactOldCopy(oldForDeletion);
      dependencies.onStage?.("verifying-old-copy-absent");
      await dependencies.verifyOldCopyAbsent(oldForDeletion);
    } catch (cleanupError) {
      dependencies.onStage?.("cleanup-required");
      let cleanupRecordError: unknown;
      try {
        await dependencies.recordCleanupRequired?.(verified, expectedOldCopy, "old-copy-cleanup");
      } catch (error) {
        cleanupRecordError = error;
      }
      try {
        dependencies.onStage?.("reconciling");
        await dependencies.reconcile();
      } catch {
        // The verified new delivery remains durable; reconnect will reconcile.
      }
      return Object.freeze({
        status: "new-copy-kept-old-cleanup-required" as const,
        newCopy: verified,
        oldCopy: expectedOldCopy,
        cleanupError,
        ...(cleanupRecordError === undefined ? {} : { cleanupRecordError }),
      });
    }

    dependencies.onStage?.("reconciling");
    try {
      await dependencies.reconcile();
    } catch (reconciliationError) {
      dependencies.onStage?.("reconciliation-required");
      return Object.freeze({
        status: "updated-reconciliation-required" as const,
        newCopy: verified,
        oldCopy: oldForDeletion,
        reconciliationError,
      });
    }
    dependencies.onStage?.("complete");
    return Object.freeze({ status: "updated" as const, newCopy: verified, oldCopy: oldForDeletion });
  });
}
