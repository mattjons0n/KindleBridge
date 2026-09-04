import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  catalogManagedUpdateResult,
  catalogManagedUpdateStagePresentation,
  expectedCatalogSourceEtag,
  normalizeCatalogManagedUpdateRequest,
  sha256CatalogUpdateBlob,
  type CatalogManagedUpdateStatus,
} from "../../client/src/catalog-managed-update";

const HASH = "a".repeat(64);
const PRESENTATION = "b".repeat(64);

describe("catalog managed-update contracts", () => {
  it("normalizes only bounded opaque IDs and exact version evidence", () => {
    expect(normalizeCatalogManagedUpdateRequest({
      profileId: "profile-1",
      bookId: "book-1",
      expectedContentHash: HASH.toUpperCase(),
      expectedPresentationVersion: PRESENTATION.toUpperCase(),
      expectedMetadataRevision: 3,
    })).toEqual({
      profileId: "profile-1",
      bookId: "book-1",
      expectedContentHash: HASH,
      expectedPresentationVersion: PRESENTATION,
      expectedMetadataRevision: 3,
    });
    expect(() => normalizeCatalogManagedUpdateRequest({
      profileId: "profile/../../other",
      bookId: "book-1",
      expectedContentHash: HASH,
      expectedPresentationVersion: PRESENTATION,
      expectedMetadataRevision: 3,
    })).toThrow(/opaque/iu);
  });

  it("binds source ETags and hashes blobs without exposing their bytes", async () => {
    const blob = new Blob(["replacement"]);
    expect(expectedCatalogSourceEtag(HASH)).toBe(`"sha256-${HASH}"`);
    expect(await sha256CatalogUpdateBlob(blob)).toBe(createHash("sha256").update("replacement").digest("hex"));
  });

  it("provides bounded progress and preserves queued intent for every recovery outcome", () => {
    expect(catalogManagedUpdateStagePresentation("deleting-old-copy")).toMatchObject({
      phase: "verifying",
      progress: 91,
    });
    const statuses: readonly CatalogManagedUpdateStatus[] = [
      "updated",
      "new-copy-kept-old-recording-required",
      "new-copy-kept-old-cleanup-required",
      "updated-reconciliation-required",
    ];
    const results = statuses.map((status) => catalogManagedUpdateResult({
      operationId: "update-operation",
      status,
      priorFilename: "old.azw3",
      replacementFilename: "new.azw3",
      reconciliationComplete: status !== "updated-reconciliation-required",
      cleanupRecordPersisted: status === "new-copy-kept-old-cleanup-required",
    }));
    expect(results[0]).toMatchObject({ status: "updated", queueDisposition: "remove" });
    expect(results.slice(1).every(({ queueDisposition }) => queueDisposition === "preserve")).toBe(true);
    expect(results[1]).toMatchObject({ deliveryRecordingRequired: true, duplicateCleanupRequired: true });
    expect(results[1]).toMatchObject({ replacementCleanupReminder: "not-stored" });
    expect(results[2]).toMatchObject({
      deliveryRecordingRequired: false,
      duplicateCleanupRequired: true,
      replacementCleanupReminder: "stored",
    });
    expect(results[3]).toMatchObject({ reconciliationRequired: true });
  });
});
