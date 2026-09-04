import type { CatalogTransferUpdate } from "./catalog-browser";
import type { SafeKindleUpdateStage } from "./safe-kindle-update";

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface CatalogManagedUpdateRequest {
  /** Opaque active-profile identifier; paths are never accepted. */
  readonly profileId: string;
  /** Opaque stable catalog-book identifier; paths are never accepted. */
  readonly bookId: string;
  /** Version facts shown by the UI that initiated this update. */
  readonly expectedContentHash: string;
  readonly expectedPresentationVersion: string;
  readonly expectedMetadataRevision: number;
}

export type CatalogManagedUpdateStatus =
  | "updated"
  | "new-copy-kept-old-recording-required"
  | "new-copy-kept-old-cleanup-required"
  | "updated-reconciliation-required";

export interface CatalogManagedUpdateResult {
  readonly operationId: string;
  readonly status: CatalogManagedUpdateStatus;
  /** A later queue UI removes an entry only after the exact `updated` result. */
  readonly queueDisposition: "remove" | "preserve";
  readonly priorFilename: string;
  readonly replacementFilename: string;
  readonly message: string;
  readonly deliveryRecordingRequired: boolean;
  readonly duplicateCleanupRequired: boolean;
  readonly reconciliationRequired: boolean;
  readonly replacementCleanupReminder: "not-needed" | "stored" | "not-stored";
}

export interface NormalizedCatalogManagedUpdateRequest extends CatalogManagedUpdateRequest {}

export function normalizeCatalogManagedUpdateRequest(
  request: CatalogManagedUpdateRequest,
): NormalizedCatalogManagedUpdateRequest {
  const contentHash = request.expectedContentHash.trim().toLocaleLowerCase("en-US");
  const presentationVersion = request.expectedPresentationVersion.trim().toLocaleLowerCase("en-US");
  if (!OPAQUE_ID.test(request.profileId) || !OPAQUE_ID.test(request.bookId)) {
    throw new TypeError("Update requires opaque profile and book IDs.");
  }
  if (!SHA256.test(contentHash) || !SHA256.test(presentationVersion)) {
    throw new TypeError("Update requires exact SHA-256 source and presentation versions.");
  }
  if (!Number.isSafeInteger(request.expectedMetadataRevision) || request.expectedMetadataRevision < 0) {
    throw new TypeError("Update requires a valid metadata revision.");
  }
  return Object.freeze({
    profileId: request.profileId,
    bookId: request.bookId,
    expectedContentHash: contentHash,
    expectedPresentationVersion: presentationVersion,
    expectedMetadataRevision: request.expectedMetadataRevision,
  });
}

export function expectedCatalogSourceEtag(contentHash: string): string {
  if (!SHA256.test(contentHash)) throw new TypeError("A normalized SHA-256 source hash is required.");
  return `"sha256-${contentHash}"`;
}

export async function sha256CatalogUpdateBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function catalogManagedUpdateStagePresentation(
  stage: SafeKindleUpdateStage,
): CatalogTransferUpdate {
  switch (stage) {
    case "preparing":
      return { phase: "validating", progress: 24, message: "Prepared replacement is ready for the guarded Kindle update" };
    case "checking-write-proof":
      return { phase: "validating", progress: 26, message: "Checking the current connection's safe-write proof" };
    case "revalidating-old-copy":
      return { phase: "validating", progress: 29, message: "Revalidating the exact prior managed copy" };
    case "checking-capacity":
      return { phase: "validating", progress: 32, message: "Checking space to keep both copies during replacement" };
    case "uploading-new-copy":
      return { phase: "sending", progress: 35, message: "Uploading the new copy beside the existing copy" };
    case "verifying-new-copy":
      return { phase: "verifying", progress: 82, message: "Verifying the new managed Kindle object" };
    case "recording-new-copy":
      return { phase: "verifying", progress: 87, message: "Securing the new delivery record before cleanup" };
    case "recording-required":
      return { phase: "verifying", progress: 88, message: "Keeping both copies because delivery recording needs attention" };
    case "deleting-old-copy":
      return { phase: "verifying", progress: 91, message: "Removing only the revalidated prior managed copy" };
    case "verifying-old-copy-absent":
      return { phase: "verifying", progress: 95, message: "Verifying that the exact prior copy is absent" };
    case "reconciling":
      return { phase: "verifying", progress: 98, message: "Refreshing the final Kindle comparison" };
    case "reconciliation-required":
      return { phase: "verifying", progress: 99, message: "The replacement is verified; catalog comparison needs a refresh" };
    case "cleanup-required":
      return { phase: "verifying", progress: 96, message: "The new copy is safe; exact duplicate cleanup needs attention" };
    case "complete":
      return { phase: "complete", progress: 100, message: "Kindle copy updated and verified" };
  }
}

export function catalogManagedUpdateResult(input: {
  readonly operationId: string;
  readonly status: CatalogManagedUpdateStatus;
  readonly priorFilename: string;
  readonly replacementFilename: string;
  readonly reconciliationComplete: boolean;
  readonly cleanupRecordPersisted?: boolean;
}): CatalogManagedUpdateResult {
  const shared = {
    operationId: input.operationId,
    status: input.status,
    priorFilename: input.priorFilename,
    replacementFilename: input.replacementFilename,
  };
  switch (input.status) {
    case "updated":
      return Object.freeze({
        ...shared,
        queueDisposition: "remove" as const,
        message: "Kindle copy updated and verified.",
        deliveryRecordingRequired: false,
        duplicateCleanupRequired: false,
        reconciliationRequired: false,
        replacementCleanupReminder: "not-needed" as const,
      });
    case "new-copy-kept-old-recording-required":
      return Object.freeze({
        ...shared,
        queueDisposition: "preserve" as const,
        message: input.cleanupRecordPersisted
          ? "The replacement was uploaded and verified, but its delivery record could not be secured. Both copies were kept and an exact cleanup reminder was stored; retry after the catalog is available."
          : "The replacement was uploaded and verified, but neither its delivery record nor cleanup reminder could be secured. Both copies were kept; keep this result open and retry after storage is available.",
        deliveryRecordingRequired: true,
        duplicateCleanupRequired: true,
        reconciliationRequired: !input.reconciliationComplete,
        replacementCleanupReminder: input.cleanupRecordPersisted ? "stored" as const : "not-stored" as const,
      });
    case "new-copy-kept-old-cleanup-required":
      return Object.freeze({
        ...shared,
        queueDisposition: "preserve" as const,
        message: input.cleanupRecordPersisted
          ? "The replacement was uploaded, verified, and recorded, but the exact prior copy could not be removed safely. An exact cleanup reminder was stored; reconnect and complete it."
          : "The replacement was uploaded, verified, and recorded, but the exact prior copy could not be removed safely and the cleanup reminder could not be stored. Keep this result open and reconnect before another action.",
        deliveryRecordingRequired: false,
        duplicateCleanupRequired: true,
        reconciliationRequired: !input.reconciliationComplete,
        replacementCleanupReminder: input.cleanupRecordPersisted ? "stored" as const : "not-stored" as const,
      });
    case "updated-reconciliation-required":
      return Object.freeze({
        ...shared,
        queueDisposition: "preserve" as const,
        message: "The replacement and removal were verified, but the final catalog comparison could not refresh. Reconnect or refresh before another Kindle action.",
        deliveryRecordingRequired: false,
        duplicateCleanupRequired: false,
        reconciliationRequired: true,
        replacementCleanupReminder: "not-needed" as const,
      });
  }
}
