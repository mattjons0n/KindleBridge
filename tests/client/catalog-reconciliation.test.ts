// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { reconcileCatalogIndexes, asLastSeenInventory } from "../../client/src/catalog-reconciliation";
import { createKindleManualMatchDecisionStore, createManagedFilenameToken, type KindleInventorySnapshot } from "../../client/src/kindle";
import type { CatalogMatchIndex } from "../../client/src/catalog-client";
import { METADATA_CLAIM_BITMAP_BYTES } from "../../shared/catalog-contracts";

function claimSummary(collisions: readonly number[] = [], complete = true): NonNullable<CatalogMatchIndex["metadataClaims"]> {
  const bytes = new Uint8Array(METADATA_CLAIM_BITMAP_BYTES);
  for (const position of collisions) {
    bytes[position >>> 3] = (bytes[position >>> 3] ?? 0) | (1 << (position & 7));
  }
  return {
    complete,
    collisionBitmap: btoa(String.fromCharCode(...bytes)),
  };
}

function index(bookId: string): CatalogMatchIndex {
  return {
    profileId: "profile-a",
    generatedAt: "2026-08-29T10:00:00.000Z",
    metadataClaims: claimSummary(),
    entries: [{
      bookId,
      sourceFilename: "Meditations.epub",
      sourceFormat: "EPUB",
      sourceSize: 123,
      contentHash: "a".repeat(64),
      identifiers: ["isbn:9780000000001"],
      title: "Meditations",
      authors: ["Marcus Aurelius"],
      deliveries: [],
    }],
  };
}

async function inventory(bookId: string, status: "complete" | "partial" = "complete"): Promise<KindleInventorySnapshot> {
  const token = await createManagedFilenameToken(bookId, "a".repeat(64));
  return {
    status,
    storageId: 1,
    documentsHandle: 2,
    objects: [{
      handle: 10,
      storageId: 1,
      parentHandle: 2,
      objectFormat: 0xb00a,
      protectionStatus: 0,
      associationType: 0,
      size: 321,
      filename: `Meditations-${token}-20260829T100000Z-abcdef.azw3`,
      relativePath: `Books/Meditations-${token}.azw3`,
      depth: 2,
      kind: "file",
      managedToken: token,
      metadataAdjusted: false,
    }, {
      handle: 11,
      storageId: 1,
      parentHandle: 2,
      objectFormat: 0xb00a,
      protectionStatus: 0,
      associationType: 0,
      size: 20,
      filename: "unmanaged.azw3",
      relativePath: "unmanaged.azw3",
      depth: 1,
      kind: "file",
      metadataAdjusted: false,
      title: "A Distinct Unmanaged Book",
      authors: ["Another Author"],
      identifiers: [],
      bookMetadataState: "enriched",
    }],
    issues: status === "partial" ? [{ code: "children-unavailable", operation: "list-children" }] : [],
    issueCount: status === "partial" ? 1 : 0,
    scannedObjectCount: 2,
    bookMetadata: {
      status: "complete",
      eligibleObjectCount: 2,
      attemptedObjectCount: 2,
      parsedObjectCount: 2,
      enrichedObjectCount: 1,
      failedObjectCount: 0,
      skippedObjectCount: 0,
      indistinguishableObjectCount: 0,
      readByteCount: 341,
      budgetedByteCount: 341,
      truncated: false,
      truncationReasons: [],
    },
  };
}

describe("catalog/Kindle reconciliation", () => {
  it("applies a manual same-book choice only to one unchanged candidate in a complete inventory", async () => {
    const base = await inventory("another-book");
    const possible: KindleInventorySnapshot = {
      ...base,
      objects: [{
        ...base.objects[1]!,
        filename: "Meditations.azw3",
        relativePath: "Books/Meditations.azw3",
        modificationDate: "20260903T120000",
      }],
      scannedObjectCount: 1,
    };
    const decisions = createKindleManualMatchDecisionStore({ persistence: null });
    const options = {
      deviceLabel: "Kindle",
      deviceIdentity: { key: "d".repeat(64), stability: "session" as const },
      manualMatchDecisions: decisions,
    };
    const first = await reconcileCatalogIndexes([index("book-1")], possible, options);
    expect(first.statuses.get("book-1")).toBe("possible");
    expect(first.inventory.items[0]?.candidates?.[0]?.evidence).toMatchObject({
      tier: "filename-similarity",
      candidateCount: 1,
      comparisons: expect.objectContaining({ filename: "match" }),
    });
    const evidence = [...first.manualMatchEvidence.values()][0]!;
    expect(await decisions.remember(evidence, "same-book")).toBe(true);

    const confirmed = await reconcileCatalogIndexes([index("book-1")], possible, options);
    expect(confirmed.statuses.get("book-1")).toBe("confirmed");
    expect(confirmed.inventory.items[0]).toMatchObject({
      bookId: "book-1",
      match: "confirmed",
      candidates: [expect.objectContaining({ decision: "same-book" })],
    });

    const changed = await reconcileCatalogIndexes([index("book-1")], {
      ...possible,
      objects: [{ ...possible.objects[0]!, size: possible.objects[0]!.size + 1 }],
    }, options);
    expect(changed.statuses.get("book-1")).toBe("possible");
    expect(changed.inventory.items[0]?.candidates?.[0]?.decision).toBeUndefined();
  });

  it("retires a manual same-book choice when the catalog presentation changes", async () => {
    const base = await inventory("another-book");
    const possible: KindleInventorySnapshot = {
      ...base,
      objects: [{
        ...base.objects[1]!,
        filename: "Meditations.azw3",
        relativePath: "Books/Meditations.azw3",
        modificationDate: "20260903T120000",
      }],
      scannedObjectCount: 1,
    };
    const decisions = createKindleManualMatchDecisionStore({ persistence: null });
    const options = {
      deviceLabel: "Kindle",
      deviceIdentity: { key: "d".repeat(64), stability: "session" as const },
      manualMatchDecisions: decisions,
    };
    const baseIndex = index("book-1");
    const original: CatalogMatchIndex = {
      ...baseIndex,
      entries: [{ ...baseIndex.entries[0]!, presentationVersion: "a".repeat(64) }],
    };
    const first = await reconcileCatalogIndexes([original], possible, options);
    expect(await decisions.remember([...first.manualMatchEvidence.values()][0]!, "same-book")).toBe(true);
    expect((await reconcileCatalogIndexes([original], possible, options)).statuses.get("book-1")).toBe("confirmed");

    const changed: CatalogMatchIndex = {
      ...original,
      entries: [{ ...original.entries[0]!, presentationVersion: "b".repeat(64) }],
    };
    const result = await reconcileCatalogIndexes([changed], possible, options);

    expect(result.statuses.get("book-1")).toBe("possible");
    expect(result.inventory.items[0]?.candidates?.[0]?.decision).toBeUndefined();
  });

  it("removes a manually rejected exact candidate without resurrecting an absent object", async () => {
    const base = await inventory("another-book");
    const possible: KindleInventorySnapshot = {
      ...base,
      objects: [{ ...base.objects[1]!, filename: "Meditations.azw3", relativePath: "Meditations.azw3" }],
      scannedObjectCount: 1,
    };
    const decisions = createKindleManualMatchDecisionStore({ persistence: null });
    const options = {
      deviceLabel: "Kindle",
      deviceIdentity: { key: "d".repeat(64), stability: "session" as const },
      manualMatchDecisions: decisions,
    };
    const first = await reconcileCatalogIndexes([index("book-1")], possible, options);
    expect(await decisions.remember([...first.manualMatchEvidence.values()][0]!, "not-this-book")).toBe(true);
    const rejected = await reconcileCatalogIndexes([index("book-1")], possible, options);

    expect(rejected.statuses.get("book-1")).toBe("not-on-kindle");
    expect(rejected.inventory.items[0]).toMatchObject({ match: "unmatched" });
    expect(rejected.inventory.items[0]?.candidates?.[0]).toMatchObject({ decision: "not-this-book" });
  });

  it("marks only a unique managed token in a complete inventory as confirmed", async () => {
    const result = await reconcileCatalogIndexes(
      [index("book-1")],
      await inventory("book-1"),
      { deviceLabel: "Household Kindle", scannedAt: new Date("2026-08-29T12:00:00Z") },
    );

    expect(result.statuses.get("book-1")).toBe("confirmed");
    expect(result.statusCountsByProfile.get("profile-a")).toEqual({
      confirmed: 1,
      possible: 0,
      notOnKindle: 0,
      unknown: 0,
    });
    expect(result.inventory.completeness).toBe("complete");
    expect(result.inventory.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ bookId: "book-1", match: "confirmed", managed: true }),
      expect.objectContaining({ filename: "unmanaged.azw3", match: "unmatched", managed: false }),
    ]));
  });

  it("preserves parsed authors and identifiers for presentation without inventing absent metadata", async () => {
    const snapshot = await inventory("book-1");
    const authors = ["Marcus Aurelius", "Gregory Hays"];
    const identifiers = ["isbn:9780000000001", "asin:B000TEST123"];
    const result = await reconcileCatalogIndexes([index("book-1")], {
      ...snapshot,
      objects: [snapshot.objects[0]!, { ...snapshot.objects[1]!, authors, identifiers }],
    }, { deviceLabel: "Kindle" });

    expect(result.inventory.items[1]).toMatchObject({
      author: "Marcus Aurelius, Gregory Hays",
      authors,
      identifiers,
    });
    expect(result.inventory.items[0]).not.toHaveProperty("authors");
    expect(result.inventory.items[0]).not.toHaveProperty("identifiers");
  });

  it.each(["kfx", "azw", "azw8", "prc"] as const)(
    "uses a unique managed .%s object as Kindle presence evidence",
    async (extension) => {
      const snapshot = await inventory("book-1");
      const managed = snapshot.objects[0]!;
      const extended: KindleInventorySnapshot = {
        ...snapshot,
        objects: [{
          ...managed,
          filename: managed.filename.replace(/\.azw3$/u, `.${extension}`),
          relativePath: managed.relativePath.replace(/\.azw3$/u, `.${extension}`),
        }],
        scannedObjectCount: 1,
        bookMetadata: {
          ...snapshot.bookMetadata!,
          eligibleObjectCount: 1,
          attemptedObjectCount: 1,
          parsedObjectCount: 1,
          enrichedObjectCount: 0,
          readByteCount: managed.size,
          budgetedByteCount: managed.size,
        },
      };

      const result = await reconcileCatalogIndexes([index("book-1")], extended, { deviceLabel: "Kindle" });

      expect(result.statuses.get("book-1")).toBe("confirmed");
      expect(result.inventory.items[0]).toMatchObject({
        format: extension.toLocaleUpperCase("en-US"),
        bookId: "book-1",
        match: "confirmed",
      });
    },
  );

  it("associates every duplicate managed device copy with the same confirmed book", async () => {
    const snapshot = await inventory("book-1");
    const managed = snapshot.objects[0]!;
    const first = {
      ...managed,
      filename: managed.filename.replace(/\.azw3$/u, ".kfx"),
      relativePath: managed.relativePath.replace(/\.azw3$/u, ".kfx"),
    };
    const duplicate = {
      ...managed,
      handle: managed.handle + 1,
      filename: managed.filename.replace(/\.azw3$/u, ".azw8"),
      relativePath: managed.relativePath.replace(/\.azw3$/u, ".azw8"),
    };
    const ambiguous: KindleInventorySnapshot = {
      ...snapshot,
      objects: [first, duplicate],
      scannedObjectCount: 2,
      bookMetadata: {
        ...snapshot.bookMetadata!,
        eligibleObjectCount: 2,
        attemptedObjectCount: 2,
        parsedObjectCount: 0,
        enrichedObjectCount: 0,
        readByteCount: first.size + duplicate.size,
        budgetedByteCount: first.size + duplicate.size,
      },
    };

    const result = await reconcileCatalogIndexes([index("book-1")], ambiguous, { deviceLabel: "Kindle" });

    expect(result.statuses.get("book-1")).toBe("confirmed");
    expect(result.inventory.items).toHaveLength(2);
    expect(result.inventory.items.every(({ bookId, match }) => bookId === "book-1" && match === "confirmed")).toBe(true);
  });

  it("rotates strong match authority when a stable catalog path is replaced with different bytes", async () => {
    const priorVersionOnKindle = await inventory("book-1");
    const replacement = index("book-1");
    const replacementIndex: CatalogMatchIndex = {
      ...replacement,
      entries: [{ ...replacement.entries[0]!, contentHash: "b".repeat(64) }],
    };

    const result = await reconcileCatalogIndexes([replacementIndex], priorVersionOnKindle, {
      deviceLabel: "Kindle",
    });

    expect(result.statuses.get("book-1")).not.toBe("confirmed");
    expect(result.inventory.items[0]?.match).not.toBe("confirmed");
  });

  it("keeps an old managed version yellow but exposes its exact removal-only association", async () => {
    const oldVersion = await inventory("book-1");
    const oldToken = oldVersion.objects[0]!.managedToken!;
    const staleObject: KindleInventorySnapshot = {
      ...oldVersion,
      objects: [{
        ...oldVersion.objects[0]!,
        title: "Meditations",
        authors: ["Marcus Aurelius"],
        identifiers: ["isbn:978-0-0000-0000-1"],
        bookMetadataState: "enriched",
      }],
      scannedObjectCount: 1,
      bookMetadata: {
        ...oldVersion.bookMetadata!,
        eligibleObjectCount: 1,
        attemptedObjectCount: 1,
        parsedObjectCount: 1,
        enrichedObjectCount: 1,
        indistinguishableObjectCount: 0,
        readByteCount: 321,
        budgetedByteCount: 321,
      },
    };
    const replacement = index("book-1");
    const replacementIndex: CatalogMatchIndex = {
      ...replacement,
      entries: [{
        ...replacement.entries[0]!,
        contentHash: "b".repeat(64),
        staleManagedTokens: [oldToken],
      }],
    };

    const result = await reconcileCatalogIndexes([replacementIndex], staleObject, {
      deviceLabel: "Kindle",
      deviceKey: "device-key",
    });

    expect(result.statuses.get("book-1")).toBe("possible");
    expect(result.inventory.items[0]).toMatchObject({
      bookId: "book-1",
      match: "possible",
      managed: true,
      stalePresentation: true,
    });
    expect(result.inventory.possibleMatches).toEqual([
      expect.objectContaining({
        profileId: "profile-a",
        bookId: "book-1",
        evidence: expect.objectContaining({ tier: "prior-presentation", candidateCount: 1 }),
      }),
    ]);
  });

  it("never confirms a managed-looking token on a non-book Kindle object", async () => {
    const snapshot = await inventory("book-1");
    const nonBook: KindleInventorySnapshot = {
      ...snapshot,
      objects: [{
        ...snapshot.objects[0]!,
        filename: snapshot.objects[0]!.filename.replace(/\.azw3$/u, ".txt"),
        relativePath: snapshot.objects[0]!.relativePath.replace(/\.azw3$/u, ".txt"),
      }],
      scannedObjectCount: 1,
      bookMetadata: {
        ...snapshot.bookMetadata!,
        eligibleObjectCount: 0,
        attemptedObjectCount: 0,
        parsedObjectCount: 0,
        enrichedObjectCount: 0,
        readByteCount: 0,
        budgetedByteCount: 0,
      },
    };

    const result = await reconcileCatalogIndexes([index("book-1")], nonBook, { deviceLabel: "Kindle" });

    expect(result.statuses.get("book-1")).toBe("not-on-kindle");
    expect(result.inventory.items[0]).toMatchObject({ managed: true, match: "unmatched" });
  });

  it("downgrades token evidence when inventory is partial and labels cached data Last seen", async () => {
    const result = await reconcileCatalogIndexes(
      [index("book-1")],
      await inventory("book-1", "partial"),
      { deviceLabel: "Kindle" },
    );

    expect(result.statuses.get("book-1")).toBe("possible");
    expect(asLastSeenInventory(result.inventory)?.completeness).toBe("last-seen");
  });

  it("preserves an actionable explanation when a partial inventory has no candidate object", async () => {
    const base = await inventory("different-book", "partial");
    const partial: KindleInventorySnapshot = {
      ...base,
      objects: [],
      scannedObjectCount: 0,
      bookMetadata: {
        ...base.bookMetadata!,
        status: "partial",
        eligibleObjectCount: 0,
        attemptedObjectCount: 0,
        parsedObjectCount: 0,
        enrichedObjectCount: 0,
        failedObjectCount: 0,
        skippedObjectCount: 0,
        indistinguishableObjectCount: 0,
        readByteCount: 0,
        budgetedByteCount: 0,
      },
    };

    const result = await reconcileCatalogIndexes([index("book-1")], partial, { deviceLabel: "Kindle" });

    expect(result.statuses.get("book-1")).toBe("possible");
    expect(result.inventory.items).toHaveLength(0);
    expect(result.inventory.possibleMatches).toEqual([{
      profileId: "profile-a",
      bookId: "book-1",
      reason: "The Kindle scan was incomplete, so this possible match cannot be confirmed.",
      evidence: expect.objectContaining({
        tier: "inventory-partial",
        inventoryCompleteness: "partial",
        candidateCount: 0,
        ambiguous: true,
        comparisons: {
          title: "not-compared",
          authors: "not-compared",
          identifiers: "not-compared",
          filename: "not-compared",
          size: "not-compared",
        },
      }),
    }]);
  });

  it("never gives failed, queued, or sending delivery records strong match authority", async () => {
    const deviceSnapshot = await inventory("different-book");
    const deviceToken = deviceSnapshot.objects[0]!.managedToken!;
    for (const status of ["failed", "queued", "sending"] as const) {
      const failedIndex = index("book-1");
      const withUnprovenDelivery: CatalogMatchIndex = {
        ...failedIndex,
        entries: [{
          ...failedIndex.entries[0]!,
          deliveries: [{
            deviceKey: "device-key",
            filename: deviceSnapshot.objects[0]!.filename,
            artifactSize: deviceSnapshot.objects[0]!.size,
            managedToken: deviceToken,
            status,
            deliveredAt: "2026-08-29T10:00:00.000Z",
          }],
        }],
      };

      const result = await reconcileCatalogIndexes([withUnprovenDelivery], deviceSnapshot, {
        deviceLabel: "Kindle",
        deviceKey: "device-key",
      });
      expect(result.statuses.get("book-1"), status).not.toBe("confirmed");
    }
  });

  it("confirms a uniquely enriched unmanaged book by normalized title and author", async () => {
    const snapshot = await inventory("another-book");
    const enriched: KindleInventorySnapshot = {
      ...snapshot,
      objects: [{
        ...snapshot.objects[1]!,
        title: "Meditations",
        authors: ["Marcus Aurelius"],
        identifiers: [],
        bookMetadataState: "enriched",
      }],
      scannedObjectCount: 1,
      bookMetadata: {
        ...snapshot.bookMetadata!,
        eligibleObjectCount: 1,
        attemptedObjectCount: 1,
        parsedObjectCount: 1,
        enrichedObjectCount: 1,
        readByteCount: 20,
        budgetedByteCount: 20,
      },
    };

    const result = await reconcileCatalogIndexes([index("book-unmanaged")], enriched, {
      deviceLabel: "Kindle",
    });

    expect(result.statuses.get("book-unmanaged")).toBe("confirmed");
    expect(result.inventory.items[0]).toMatchObject({
      title: "Meditations",
      author: "Marcus Aurelius",
      bookId: "book-unmanaged",
      managed: false,
      match: "confirmed",
    });
  });

  it("scopes Calibre-compatible metadata matching to the selected profile", async () => {
    const snapshot = await inventory("another-book");
    const enriched: KindleInventorySnapshot = {
      ...snapshot,
      objects: [{
        ...snapshot.objects[1]!,
        title: "Meditations",
        authors: ["Marcus Aurelius"],
        identifiers: ["isbn:978-0-0000-0000-1"],
        bookMetadataState: "enriched",
      }],
      scannedObjectCount: 1,
      bookMetadata: {
        ...snapshot.bookMetadata!,
        eligibleObjectCount: 1,
        attemptedObjectCount: 1,
        parsedObjectCount: 1,
        enrichedObjectCount: 1,
        readByteCount: 20,
        budgetedByteCount: 20,
      },
    };
    const collided = index("book-unmanaged");
    const result = await reconcileCatalogIndexes([{ ...collided, metadataClaims: claimSummary([0]) }], enriched, {
      deviceLabel: "Kindle",
    });

    expect(result.statuses.get("book-unmanaged")).toBe("confirmed");
    expect(result.inventory.items[0]?.match).toBe("confirmed");
  });

  it("does not let a legacy cross-profile summary weaken selected-profile evidence", async () => {
    const unmanagedSnapshot = await inventory("another-book");
    const enriched: KindleInventorySnapshot = {
      ...unmanagedSnapshot,
      objects: [{
        ...unmanagedSnapshot.objects[1]!,
        title: "Meditations",
        authors: ["Marcus Aurelius"],
        identifiers: ["isbn:978-0-0000-0000-1"],
        bookMetadataState: "enriched",
      }],
      scannedObjectCount: 1,
      bookMetadata: {
        ...unmanagedSnapshot.bookMetadata!,
        eligibleObjectCount: 1,
        attemptedObjectCount: 1,
        parsedObjectCount: 1,
        enrichedObjectCount: 1,
        readByteCount: 20,
        budgetedByteCount: 20,
      },
    };
    const incomplete = index("book-unmanaged");
    const metadataResult = await reconcileCatalogIndexes([
      { ...incomplete, metadataClaims: claimSummary([], false) },
    ], enriched, { deviceLabel: "Kindle" });
    expect(metadataResult.statuses.get("book-unmanaged")).toBe("confirmed");

    const managed = index("book-managed");
    const managedResult = await reconcileCatalogIndexes([
      { ...managed, metadataClaims: claimSummary([0], false) },
    ], await inventory("book-managed"), { deviceLabel: "Kindle" });
    expect(managedResult.statuses.get("book-managed")).toBe("confirmed");
  });

  it("uses a verified AZW3 byte length in the live title-author-size tier", async () => {
    const snapshot = await inventory("another-book");
    const enriched: KindleInventorySnapshot = {
      ...snapshot,
      objects: [{
        ...snapshot.objects[1]!,
        size: 123,
        title: "Meditations",
        authors: ["Marcus Aurelius"],
        identifiers: [],
        bookMetadataState: "enriched",
      }],
      scannedObjectCount: 1,
      bookMetadata: {
        ...snapshot.bookMetadata!,
        eligibleObjectCount: 1,
        attemptedObjectCount: 1,
        parsedObjectCount: 1,
        enrichedObjectCount: 1,
        indistinguishableObjectCount: 0,
        readByteCount: 123,
        budgetedByteCount: 123,
      },
    };
    const azw3 = index("book-azw3");
    const azw3Index: CatalogMatchIndex = {
      ...azw3,
      entries: [{
        ...azw3.entries[0]!,
        sourceFilename: "Meditations.azw3",
        sourceFormat: "AZW3",
        sourceSize: 123,
        identifiers: [],
      }],
    };

    const result = await reconcileCatalogIndexes([azw3Index], enriched, { deviceLabel: "Kindle" });

    expect(result.statuses.get("book-azw3")).toBe("confirmed");
    expect(result.inventory.items[0]).toMatchObject({ bookId: "book-azw3", match: "confirmed" });
  });

  it("falls through from an unusable EPUB source length to Calibre-compatible title-author evidence", async () => {
    const snapshot = await inventory("another-book");
    const enriched: KindleInventorySnapshot = {
      ...snapshot,
      objects: [{
        ...snapshot.objects[1]!,
        size: 123,
        title: "Meditations",
        authors: ["Marcus Aurelius"],
        identifiers: [],
        bookMetadataState: "enriched",
      }],
      scannedObjectCount: 1,
      bookMetadata: {
        ...snapshot.bookMetadata!,
        eligibleObjectCount: 1,
        attemptedObjectCount: 1,
        parsedObjectCount: 1,
        enrichedObjectCount: 1,
        indistinguishableObjectCount: 0,
        readByteCount: 123,
        budgetedByteCount: 123,
      },
    };

    const result = await reconcileCatalogIndexes([index("book-epub")], enriched, { deviceLabel: "Kindle" });

    expect(result.statuses.get("book-epub")).toBe("confirmed");
    expect(result.inventory.items[0]).toMatchObject({ bookId: "book-epub", match: "confirmed" });
  });

  it("confirms an exact parsed row even when an unrelated object's metadata is incomplete", async () => {
    const snapshot = await inventory("another-book");
    const exact = {
      ...snapshot.objects[1]!,
      title: "Meditations",
      authors: ["Marcus Aurelius"],
      identifiers: ["isbn:978-0-0000-0000-1"],
      bookMetadataState: "enriched" as const,
    };
    const unread = {
      ...snapshot.objects[1]!,
      handle: 12,
      filename: "unread.azw3",
      relativePath: "unread.azw3",
      title: undefined,
      authors: undefined,
      identifiers: undefined,
      bookMetadataState: "skipped-object-count" as const,
    };
    const incomplete: KindleInventorySnapshot = {
      ...snapshot,
      objects: [exact, unread],
      scannedObjectCount: 2,
      bookMetadata: {
        ...snapshot.bookMetadata!,
        status: "partial",
        eligibleObjectCount: 2,
        attemptedObjectCount: 1,
        parsedObjectCount: 1,
        enrichedObjectCount: 1,
        skippedObjectCount: 1,
        indistinguishableObjectCount: 0,
        readByteCount: 20,
        budgetedByteCount: 20,
        truncated: true,
        truncationReasons: ["object-count"],
      },
    };

    const result = await reconcileCatalogIndexes([index("book-unmanaged")], incomplete, {
      deviceLabel: "Kindle",
    });

    expect(result.statuses.get("book-unmanaged")).toBe("confirmed");
    expect(result.inventory.items.find(({ filename }) => filename === "unmanaged.azw3")).toMatchObject({
      bookId: "book-unmanaged",
      match: "confirmed",
    });
    expect(result.inventory.items.find(({ filename }) => filename === "unread.azw3")).toMatchObject({
      match: "unmatched",
    });
  });

  it("deterministically assigns an indistinguishable Kindle object to one selected-profile book", async () => {
    const snapshot = await inventory("another-book");
    const enriched: KindleInventorySnapshot = {
      ...snapshot,
      objects: [{
        ...snapshot.objects[1]!,
        title: "Meditations",
        authors: ["Marcus Aurelius"],
        identifiers: ["isbn:978-0-0000-0000-1"],
        bookMetadataState: "enriched",
      }],
      scannedObjectCount: 1,
      bookMetadata: {
        ...snapshot.bookMetadata!,
        eligibleObjectCount: 1,
        attemptedObjectCount: 1,
        parsedObjectCount: 1,
        enrichedObjectCount: 1,
        readByteCount: 20,
        budgetedByteCount: 20,
      },
    };
    const first = index("book-a");
    const indistinguishable = { ...first.entries[0]!, identifiers: [] };
    const ambiguousIndex: CatalogMatchIndex = {
      ...first,
      entries: [{ ...indistinguishable, bookId: "book-b" }, indistinguishable],
    };

    const result = await reconcileCatalogIndexes([ambiguousIndex], enriched, { deviceLabel: "Kindle" });

    expect(result.statuses.get("book-a")).toBe("confirmed");
    expect(result.statuses.get("book-b")).toBe("not-on-kindle");
    expect(result.statusCountsByProfile.get("profile-a")).toEqual({
      confirmed: 1,
      possible: 0,
      notOnKindle: 1,
      unknown: 0,
    });
    expect(result.inventory.items[0]).toMatchObject({ bookId: "book-a", match: "confirmed" });
  });

  it("lets a non-lexicographic preferred presentation win a current confirmed tie", async () => {
    const snapshot = await inventory("another-book");
    const enriched: KindleInventorySnapshot = {
      ...snapshot,
      objects: [{
        ...snapshot.objects[1]!,
        title: "Meditations",
        authors: ["Marcus Aurelius"],
        identifiers: ["isbn:978-0-0000-0000-1"],
        bookMetadataState: "enriched",
      }],
      scannedObjectCount: 1,
      bookMetadata: {
        ...snapshot.bookMetadata!,
        eligibleObjectCount: 1,
        attemptedObjectCount: 1,
        parsedObjectCount: 1,
        enrichedObjectCount: 1,
        readByteCount: 20,
        budgetedByteCount: 20,
      },
    };
    const first = index("book-a");
    const indistinguishable = { ...first.entries[0]!, identifiers: [] };
    const preferredIndex: CatalogMatchIndex = {
      ...first,
      entries: [
        indistinguishable,
        { ...indistinguishable, bookId: "book-z", preferredPresentation: true },
      ],
    };

    const result = await reconcileCatalogIndexes([preferredIndex], enriched, { deviceLabel: "Kindle" });

    expect(result.statuses.get("book-a")).toBe("not-on-kindle");
    expect(result.statuses.get("book-z")).toBe("confirmed");
    expect(result.inventory.items[0]).toMatchObject({ bookId: "book-z", match: "confirmed" });
  });

  it("ignores a stale preference whose book is not among the current confirmed claims", async () => {
    const snapshot = await inventory("another-book");
    const enriched: KindleInventorySnapshot = {
      ...snapshot,
      objects: [{
        ...snapshot.objects[1]!,
        title: "Meditations",
        authors: ["Marcus Aurelius"],
        identifiers: ["isbn:978-0-0000-0000-1"],
        bookMetadataState: "enriched",
      }],
      scannedObjectCount: 1,
      bookMetadata: {
        ...snapshot.bookMetadata!,
        eligibleObjectCount: 1,
        attemptedObjectCount: 1,
        parsedObjectCount: 1,
        enrichedObjectCount: 1,
        readByteCount: 20,
        budgetedByteCount: 20,
      },
    };
    const first = index("book-a");
    const indistinguishable = { ...first.entries[0]!, identifiers: [] };
    const stalePreference: CatalogMatchIndex = {
      ...first,
      entries: [
        { ...indistinguishable, bookId: "book-b" },
        indistinguishable,
        {
          ...indistinguishable,
          bookId: "book-z",
          preferredPresentation: true,
          title: "A different book",
          authors: ["A different author"],
        },
      ],
    };

    const result = await reconcileCatalogIndexes([stalePreference], enriched, { deviceLabel: "Kindle" });

    expect(result.statuses.get("book-a")).toBe("confirmed");
    expect(result.statuses.get("book-b")).toBe("not-on-kindle");
    expect(result.statuses.get("book-z")).toBe("not-on-kindle");
    expect(result.inventory.items[0]).toMatchObject({ bookId: "book-a", match: "confirmed" });
  });

  it("does not leave a weak overlapping-author claim possible after an exact Calibre match wins", async () => {
    const snapshot = await inventory("another-book");
    const enriched: KindleInventorySnapshot = {
      ...snapshot,
      objects: [{
        ...snapshot.objects[1]!,
        title: "Meditations",
        authors: ["Marcus Aurelius"],
        identifiers: [],
        bookMetadataState: "enriched",
      }],
      scannedObjectCount: 1,
      bookMetadata: {
        ...snapshot.bookMetadata!,
        eligibleObjectCount: 1,
        attemptedObjectCount: 1,
        parsedObjectCount: 1,
        enrichedObjectCount: 1,
        readByteCount: 20,
        budgetedByteCount: 20,
      },
    };
    const exact = index("book-exact");
    const base = { ...exact.entries[0]!, identifiers: [] };
    const overlapping: CatalogMatchIndex = {
      ...exact,
      entries: [
        base,
        { ...base, bookId: "book-overlap", authors: ["Marcus Aurelius", "Another Author"] },
      ],
    };

    const result = await reconcileCatalogIndexes([overlapping], enriched, { deviceLabel: "Kindle" });

    expect(result.statuses.get("book-exact")).toBe("confirmed");
    expect(result.statuses.get("book-overlap")).toBe("not-on-kindle");
    expect(result.inventory.items[0]).toMatchObject({ bookId: "book-exact", match: "confirmed" });
  });

  it("keeps absence unknown when bounded Kindle metadata enrichment is incomplete", async () => {
    const snapshot = await inventory("some-other-book");
    const metadataPartial: KindleInventorySnapshot = {
      ...snapshot,
      objects: snapshot.objects.slice(1),
      scannedObjectCount: 1,
      bookMetadata: {
        ...snapshot.bookMetadata!,
        status: "partial",
        eligibleObjectCount: 1,
        attemptedObjectCount: 0,
        parsedObjectCount: 0,
        enrichedObjectCount: 0,
        skippedObjectCount: 1,
        readByteCount: 0,
        budgetedByteCount: 0,
        truncated: true,
        truncationReasons: ["object-count"],
      },
    };

    const result = await reconcileCatalogIndexes([index("book-unknown")], metadataPartial, {
      deviceLabel: "Kindle",
    });

    expect(result.statuses.get("book-unknown")).toBe("unknown");
    expect(result.statusCountsByProfile.get("profile-a")?.unknown).toBe(1);
    expect(result.inventory.metadata).toMatchObject({
      status: "partial",
      eligible: 1,
      enriched: 0,
      skipped: 1,
      truncated: true,
    });
    expect(result.inventory.completeness).toBe("complete");
    expect(result.inventory.truncated).toBe(false);
  });

  it("keeps absence unknown when an unmanaged KFX object has no supported metadata parser", async () => {
    const snapshot = await inventory("some-other-book");
    const opaqueKfx = {
      ...snapshot.objects[1]!,
      filename: "opaque-amazon-book.KFX",
      relativePath: "opaque-amazon-book.KFX",
      title: undefined,
      authors: undefined,
      identifiers: undefined,
      bookMetadataState: "skipped-unsupported-format" as const,
    };
    const metadataPartial: KindleInventorySnapshot = {
      ...snapshot,
      objects: [opaqueKfx],
      scannedObjectCount: 1,
      bookMetadata: {
        ...snapshot.bookMetadata!,
        status: "partial",
        eligibleObjectCount: 1,
        attemptedObjectCount: 0,
        parsedObjectCount: 0,
        enrichedObjectCount: 0,
        skippedObjectCount: 1,
        readByteCount: 0,
        budgetedByteCount: 0,
        truncated: true,
        truncationReasons: ["unsupported-format"],
      },
    };

    const result = await reconcileCatalogIndexes([index("book-unknown")], metadataPartial, {
      deviceLabel: "Kindle",
    });

    expect(result.statuses.get("book-unknown")).toBe("unknown");
    expect(result.inventory.items[0]).toMatchObject({
      filename: "opaque-amazon-book.KFX",
      match: "unmatched",
    });
  });

  it.each([
    {
      label: "empty",
      metadata: {
        title: undefined,
        authors: [] as readonly string[],
        identifiers: [] as readonly string[],
        bookMetadataState: "empty" as const,
      },
    },
    {
      label: "title-only",
      metadata: {
        title: "An Unidentified Kindle Book",
        authors: [] as readonly string[],
        identifiers: [] as readonly string[],
        bookMetadataState: "enriched" as const,
      },
    },
  ])("keeps global absence unknown for a parsed $label unmanaged object", async ({ metadata }) => {
    const snapshot = await inventory("some-other-book");
    const insufficient: KindleInventorySnapshot = {
      ...snapshot,
      objects: [{ ...snapshot.objects[1]!, ...metadata }],
      scannedObjectCount: 1,
      // Deliberately retain a legacy/optimistic complete summary: reconciliation
      // must independently reject global absence from the actual object evidence.
      bookMetadata: {
        ...snapshot.bookMetadata!,
        status: "complete",
        eligibleObjectCount: 1,
        attemptedObjectCount: 1,
        parsedObjectCount: 1,
        enrichedObjectCount: metadata.bookMetadataState === "empty" ? 0 : 1,
        indistinguishableObjectCount: 0,
        readByteCount: 20,
        budgetedByteCount: 20,
      },
    };

    const result = await reconcileCatalogIndexes([index("book-unknown")], insufficient, {
      deviceLabel: "Kindle",
    });

    expect(result.statuses.get("book-unknown")).toBe("unknown");
    expect(result.statusCountsByProfile.get("profile-a")?.unknown).toBe(1);
  });

  it.each([
    {
      label: "trustworthy identifier",
      metadata: {
        title: undefined,
        authors: [] as readonly string[],
        identifiers: ["asin:B0DISTINCT"] as readonly string[],
      },
    },
    {
      label: "title and author",
      metadata: {
        title: "A Distinct Kindle Book",
        authors: ["Another Author"] as readonly string[],
        identifiers: [] as readonly string[],
      },
    },
  ])("does not broaden global unknown for an unmanaged object with $label", async ({ metadata }) => {
    const snapshot = await inventory("some-other-book");
    const distinguishable: KindleInventorySnapshot = {
      ...snapshot,
      objects: [{
        ...snapshot.objects[1]!,
        ...metadata,
        bookMetadataState: "enriched",
      }],
      scannedObjectCount: 1,
      bookMetadata: {
        ...snapshot.bookMetadata!,
        eligibleObjectCount: 1,
        attemptedObjectCount: 1,
        parsedObjectCount: 1,
        enrichedObjectCount: 1,
        indistinguishableObjectCount: 0,
        readByteCount: 20,
        budgetedByteCount: 20,
      },
    };

    const result = await reconcileCatalogIndexes([index("book-absent")], distinguishable, {
      deviceLabel: "Kindle",
    });

    expect(result.statuses.get("book-absent")).toBe("not-on-kindle");
    expect(result.statusCountsByProfile.get("profile-a")?.notOnKindle).toBe(1);
  });
});
