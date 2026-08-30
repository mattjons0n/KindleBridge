// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { reconcileCatalogIndexes, asLastSeenInventory } from "../../client/src/catalog-reconciliation";
import { createManagedFilenameToken, type KindleInventorySnapshot } from "../../client/src/kindle";
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

  it("keeps duplicate managed evidence across extended Kindle formats ambiguous", async () => {
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

    expect(result.statuses.get("book-1")).toBe("possible");
    expect(result.inventory.items.every(({ match }) => match === "possible")).toBe(true);
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

  it("does not re-green an old managed version through unchanged metadata or delivery history", async () => {
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
        deliveries: [{
          deviceKey: "device-key",
          filename: staleObject.objects[0]!.filename,
          artifactSize: staleObject.objects[0]!.size,
          managedToken: oldToken,
          status: "delivered",
          deliveredAt: "2026-08-29T10:00:00.000Z",
        }],
      }],
    };

    const result = await reconcileCatalogIndexes([replacementIndex], staleObject, {
      deviceLabel: "Kindle",
      deviceKey: "device-key",
    });

    expect(result.statuses.get("book-1")).toBe("not-on-kindle");
    expect(result.inventory.items[0]).toMatchObject({ match: "unmatched", managed: true });
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

  it("confirms a uniquely enriched unmanaged book by exact identifier, title, and author", async () => {
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

  it("keeps an otherwise unique unmanaged metadata match uncertain on a global claimant collision", async () => {
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

    expect(result.statuses.get("book-unmanaged")).toBe("possible");
    expect(result.inventory.items[0]?.match).toBe("possible");
  });

  it("fails metadata evidence closed on an incomplete summary but preserves managed evidence", async () => {
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
    expect(metadataResult.statuses.get("book-unmanaged")).toBe("possible");

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

  it("never treats EPUB source length as converted artifact length", async () => {
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

    expect(result.statuses.get("book-epub")).toBe("possible");
    expect(result.inventory.items[0]).toMatchObject({ bookId: "book-epub", match: "possible" });
  });

  it("keeps a unique metadata match possible when another eligible object's metadata is incomplete", async () => {
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

    expect(result.statuses.get("book-unmanaged")).toBe("possible");
    expect(result.inventory.items.find(({ filename }) => filename === "unmanaged.azw3")).toMatchObject({
      bookId: "book-unmanaged",
      match: "possible",
    });
  });

  it("downgrades two catalog books that claim the same unmanaged Kindle object", async () => {
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
    const ambiguousIndex: CatalogMatchIndex = {
      ...first,
      entries: [first.entries[0]!, { ...first.entries[0]!, bookId: "book-b" }],
    };

    const result = await reconcileCatalogIndexes([ambiguousIndex], enriched, { deviceLabel: "Kindle" });

    expect(result.statuses.get("book-a")).toBe("possible");
    expect(result.statuses.get("book-b")).toBe("possible");
    expect(result.statusCountsByProfile.get("profile-a")?.possible).toBe(2);
    expect(result.inventory.items[0]?.match).toBe("possible");
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
