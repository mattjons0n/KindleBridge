import { describe, expect, it } from "vitest";
import {
  KindleDevice,
  MTP_OBJECT_FORMAT_ASSOCIATION,
} from "../../client/src/kindle/kindle-device";
import {
  kindleInventoryObjectToMatchInput,
  matchCatalogBookToKindle,
} from "../../client/src/kindle/matching";
import { makeKindleBookFixture } from "./book-fixture";
import { FakeKindleObjectStore, objectInfo } from "./fake-store";

function device(store: FakeKindleObjectStore): KindleDevice {
  return new KindleDevice(store, {
    now: () => new Date("2026-08-29T12:00:00Z"),
    random: () => 0,
  });
}

describe("recursive Kindle Documents inventory", () => {
  it("recursively returns bounded read-only metadata and managed tokens", async () => {
    const store = new FakeKindleObjectStore();
    store.objects.set(20, objectInfo(20, {
      parentHandle: 10,
      objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
      associationType: 1,
      filename: "Fiction",
    }));
    store.objects.set(11, objectInfo(11, {
      parentHandle: 10,
      compressedSize: 42,
      filename: "Essays-kb-0123456789abcdefabcd-20260829T120000Z-000000.azw3",
    }));
    store.objects.set(21, objectInfo(21, {
      parentHandle: 20,
      compressedSize: 84,
      filename: "Nested.azw3",
    }));

    const snapshot = await device(store).inventory();

    expect(snapshot.status).toBe("complete");
    expect(snapshot.issueCount).toBe(0);
    expect(snapshot.objects).toEqual([
      expect.objectContaining({
        handle: 20,
        kind: "folder",
        relativePath: "Fiction",
        depth: 1,
      }),
      expect.objectContaining({
        handle: 11,
        kind: "file",
        relativePath: "Essays-kb-0123456789abcdefabcd-20260829T120000Z-000000.azw3",
        managedToken: "kb-0123456789abcdefabcd",
        size: 42,
      }),
      expect.objectContaining({
        handle: 21,
        kind: "file",
        relativePath: "Fiction/Nested.azw3",
        depth: 2,
      }),
    ]);
    expect(store.deletedHandles).toEqual([]);
    expect(store.createRequests).toEqual([]);
  });

  it("keeps useful objects but marks the snapshot partial when one metadata read fails", async () => {
    const store = new FakeKindleObjectStore();
    store.objects.set(11, objectInfo(11, { parentHandle: 10, filename: "vanished.azw3" }));
    store.objects.set(12, objectInfo(12, { parentHandle: 10, filename: "present.azw3" }));
    store.metadataFailures.set(11, new Error("sensitive device text must not escape"));

    const snapshot = await device(store).inventory();

    expect(snapshot.status).toBe("partial");
    expect(snapshot.objects.map(({ handle }) => handle)).toEqual([12]);
    expect(snapshot.issues).toEqual([
      expect.objectContaining({
        code: "metadata-unavailable",
        operation: "read-metadata",
        handle: 11,
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("sensitive device text");
  });

  it("bounds hostile handle datasets before allocation and never reports absence as complete", async () => {
    const store = new FakeKindleObjectStore();
    store.objects.set(11, objectInfo(11, { parentHandle: 10, filename: "one.azw3" }));
    store.objects.set(12, objectInfo(12, { parentHandle: 10, filename: "two.azw3" }));

    const snapshot = await device(store).inventory({ maxObjects: 1 });

    expect(snapshot).toMatchObject({
      status: "partial",
      scannedObjectCount: 0,
      issues: [{
        code: "handle-limit",
        operation: "list-children",
        parentHandle: 10,
        detailCode: "MTP_HANDLE_LIMIT_EXCEEDED",
      }],
    });
  });

  it("bounds recursion depth and sanitizes display-only metadata", async () => {
    const store = new FakeKindleObjectStore();
    store.objects.set(20, objectInfo(20, {
      parentHandle: 10,
      objectFormat: MTP_OBJECT_FORMAT_ASSOCIATION,
      associationType: 1,
      filename: "unsafe/folder",
    }));
    store.objects.set(21, objectInfo(21, {
      parentHandle: 20,
      filename: "not-enumerated.azw3",
    }));

    const snapshot = await device(store).inventory({ maxDepth: 1 });

    expect(snapshot.status).toBe("partial");
    expect(snapshot.objects).toEqual([
      expect.objectContaining({
        handle: 20,
        filename: "unsafe\ufffdfolder",
        metadataAdjusted: true,
      }),
    ]);
    expect(snapshot.issues.map(({ code }) => code)).toEqual([
      "metadata-sanitized",
      "depth-limit",
    ]);
  });

  it("propagates a transport fault because the MTP session can no longer authorize Send", async () => {
    const store = new FakeKindleObjectStore();
    store.childListFailures.set(10, Object.assign(new Error("raw USB secret"), {
      code: "MTP_TRANSPORT_ERROR",
    }));

    await expect(device(store).inventory()).rejects.toMatchObject({ code: "MTP_TRANSPORT_ERROR" });
  });

  it("enriches only eligible AZW3/MOBI objects with bounded read-only metadata", async () => {
    const store = new FakeKindleObjectStore();
    const azw3 = makeKindleBookFixture({
      exthTitle: "The Left Hand of Darkness",
      authors: ["Ursula K. Le Guin"],
      asin113: "B000FC1HBY",
      language: "en",
    });
    const mobi = makeKindleBookFixture({
      exthTitle: "A Wizard of Earthsea",
      authors: ["Ursula K. Le Guin"],
      asin504: "B008T9L6AM",
    });
    store.objects.set(11, objectInfo(11, {
      parentHandle: 10,
      filename: "left-hand.azw3",
      compressedSize: azw3.byteLength,
    }));
    store.objects.set(12, objectInfo(12, {
      parentHandle: 10,
      filename: "earthsea.MOBI",
      compressedSize: mobi.byteLength,
    }));
    store.objects.set(13, objectInfo(13, {
      parentHandle: 10,
      filename: "ignore.epub",
      compressedSize: 900,
    }));
    store.objectData.set(11, azw3);
    store.objectData.set(12, mobi);
    store.objectData.set(13, new Uint8Array(900));

    const snapshot = await device(store).inventory();

    expect(snapshot.status).toBe("complete");
    expect(snapshot.bookMetadata).toEqual({
      status: "complete",
      eligibleObjectCount: 2,
      attemptedObjectCount: 2,
      parsedObjectCount: 2,
      enrichedObjectCount: 2,
      failedObjectCount: 0,
      skippedObjectCount: 0,
      indistinguishableObjectCount: 0,
      readByteCount: azw3.byteLength + mobi.byteLength,
      budgetedByteCount: azw3.byteLength + mobi.byteLength,
      truncated: false,
      truncationReasons: [],
    });
    expect(snapshot.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        handle: 11,
        title: "The Left Hand of Darkness",
        authors: ["Ursula K. Le Guin"],
        identifiers: ["asin:B000FC1HBY"],
        language: "en",
        bookMetadataState: "enriched",
      }),
      expect.objectContaining({
        handle: 12,
        title: "A Wizard of Earthsea",
        identifiers: ["asin:B008T9L6AM"],
      }),
    ]));
    expect(store.readRequests).toEqual([
      { handle: 11, maxBytes: azw3.byteLength },
      { handle: 12, maxBytes: mobi.byteLength },
    ]);
    expect(store.createRequests).toEqual([]);
    expect(store.deletedHandles).toEqual([]);
  });

  it("makes parsed empty unmanaged books conservatively incomplete for absence", async () => {
    const store = new FakeKindleObjectStore();
    const empty = makeKindleBookFixture({ databaseTitle: "", mobiTitle: "" });
    store.objects.set(11, objectInfo(11, {
      parentHandle: 10,
      filename: "unmanaged-empty.azw3",
      compressedSize: empty.byteLength,
    }));
    store.objectData.set(11, empty);

    const snapshot = await device(store).inventory();

    expect(snapshot.bookMetadata).toMatchObject({
      status: "partial",
      parsedObjectCount: 1,
      enrichedObjectCount: 0,
      failedObjectCount: 0,
      skippedObjectCount: 0,
      indistinguishableObjectCount: 1,
      truncated: false,
    });
    expect(snapshot.objects[0]).toMatchObject({ bookMetadataState: "empty" });
  });

  it("makes title-only unmanaged books conservatively incomplete for absence", async () => {
    const store = new FakeKindleObjectStore();
    const titleOnly = makeKindleBookFixture({ exthTitle: "A Title Without an Author" });
    store.objects.set(11, objectInfo(11, {
      parentHandle: 10,
      filename: "unmanaged-title-only.azw3",
      compressedSize: titleOnly.byteLength,
    }));
    store.objectData.set(11, titleOnly);

    const snapshot = await device(store).inventory();

    expect(snapshot.bookMetadata).toMatchObject({
      status: "partial",
      parsedObjectCount: 1,
      enrichedObjectCount: 1,
      indistinguishableObjectCount: 1,
    });
    expect(snapshot.objects[0]).toMatchObject({
      title: "A Title Without an Author",
      authors: [],
      bookMetadataState: "enriched",
    });
  });

  it("keeps title-and-author unmanaged books complete for absence comparison", async () => {
    const store = new FakeKindleObjectStore();
    const distinguishable = makeKindleBookFixture({
      exthTitle: "A Distinguishable Book",
      authors: ["Known Author"],
    });
    store.objects.set(11, objectInfo(11, {
      parentHandle: 10,
      filename: "unmanaged-distinguishable.azw3",
      compressedSize: distinguishable.byteLength,
    }));
    store.objectData.set(11, distinguishable);

    const snapshot = await device(store).inventory();

    expect(snapshot.bookMetadata).toMatchObject({
      status: "complete",
      parsedObjectCount: 1,
      enrichedObjectCount: 1,
      indistinguishableObjectCount: 0,
    });
  });

  it("recognizes KFX, AZW, AZW8, and PRC book objects while ignoring TXT metadata", async () => {
    const store = new FakeKindleObjectStore();
    const book = makeKindleBookFixture({
      exthTitle: "Extension coverage",
      authors: ["Known Author"],
    });
    const extensions = ["kfx", "AZW", "azw8", "PrC"] as const;
    for (const [index, extension] of extensions.entries()) {
      const handle = 11 + index;
      store.objects.set(handle, objectInfo(handle, {
        parentHandle: 10,
        filename: `book-${handle}.${extension}`,
        compressedSize: book.byteLength,
      }));
      store.objectData.set(handle, book);
    }
    store.objects.set(15, objectInfo(15, {
      parentHandle: 10,
      filename: "notes.txt",
      compressedSize: book.byteLength,
    }));
    store.objectData.set(15, book);

    const snapshot = await device(store).inventory();

    expect(snapshot.bookMetadata).toMatchObject({
      status: "complete",
      eligibleObjectCount: 4,
      attemptedObjectCount: 4,
      parsedObjectCount: 4,
      enrichedObjectCount: 4,
    });
    expect(store.readRequests.map(({ handle }) => handle)).toEqual([11, 12, 13, 14]);
    expect(snapshot.objects.find(({ handle }) => handle === 15)?.bookMetadataState).toBeUndefined();
  });

  it("enriches more than 128 ordinary Kindle books by default without making absence globally unknown", async () => {
    const store = new FakeKindleObjectStore();
    const book = makeKindleBookFixture({
      exthTitle: "Household-scale metadata",
      authors: ["Known Author"],
    });
    for (let index = 0; index < 129; index += 1) {
      const handle = 11 + index;
      store.objects.set(handle, objectInfo(handle, {
        parentHandle: 10,
        filename: `book-${index}.azw3`,
        compressedSize: book.byteLength,
      }));
      store.objectData.set(handle, book);
    }

    const snapshot = await device(store).inventory();

    expect(snapshot.bookMetadata).toMatchObject({
      status: "complete",
      eligibleObjectCount: 129,
      attemptedObjectCount: 129,
      parsedObjectCount: 129,
      skippedObjectCount: 0,
      truncated: false,
    });
    expect(store.readRequests).toHaveLength(129);
  });

  it("enforces per-object, total-byte, and object-count enrichment budgets separately", async () => {
    const store = new FakeKindleObjectStore();
    const first = makeKindleBookFixture({ exthTitle: "First" });
    const second = makeKindleBookFixture({ exthTitle: "Second" });
    const oversized = makeKindleBookFixture({ exthTitle: "Oversized" });
    const fourth = makeKindleBookFixture({ exthTitle: "Fourth" });
    for (const [handle, filename, data] of [
      [11, "first.azw3", first],
      [12, "second.azw3", second],
      [13, "oversized.azw3", oversized],
      [14, "fourth.mobi", fourth],
    ] as const) {
      store.objects.set(handle, objectInfo(handle, {
        parentHandle: 10,
        filename,
        compressedSize: data.byteLength,
      }));
      store.objectData.set(handle, data);
    }

    const byteLimited = await device(store).inventory({
      bookMetadata: {
        maxObjects: 4,
        maxObjectBytes: Math.max(first.byteLength, second.byteLength),
        maxTotalBytes: first.byteLength,
      },
    });

    expect(byteLimited.status).toBe("complete");
    expect(byteLimited.bookMetadata).toMatchObject({
      status: "partial",
      eligibleObjectCount: 4,
      attemptedObjectCount: 1,
      parsedObjectCount: 1,
      skippedObjectCount: 3,
      budgetedByteCount: first.byteLength,
      truncated: true,
    });
    expect(byteLimited.bookMetadata?.truncationReasons).toEqual(expect.arrayContaining([
      "total-bytes",
      "object-size",
    ]));
    expect(byteLimited.objects.find(({ handle }) => handle === 12)).toMatchObject({
      bookMetadataState: "skipped-total-bytes",
    });
    expect(byteLimited.objects.find(({ handle }) => handle === 13)).toMatchObject({
      bookMetadataState: "skipped-object-size",
    });

    store.readRequests.length = 0;
    const countLimited = await device(store).inventory({
      bookMetadata: {
        maxObjects: 1,
        maxObjectBytes: 1_024,
        maxTotalBytes: 4_096,
      },
    });
    expect(countLimited.bookMetadata).toMatchObject({
      attemptedObjectCount: 1,
      skippedObjectCount: 3,
      truncationReasons: ["object-count"],
    });
    expect(store.readRequests).toHaveLength(1);
  });

  it("tolerates individual read and parser failures without weakening hierarchy completeness", async () => {
    const store = new FakeKindleObjectStore();
    const invalid = new Uint8Array(128);
    const valid = makeKindleBookFixture({
      exthTitle: "Recovered",
      authors: ["Careful Reader"],
      asin504: "B0RECOVERED",
    });
    store.objects.set(11, objectInfo(11, {
      parentHandle: 10,
      filename: "read-failure.azw3",
      compressedSize: valid.byteLength,
    }));
    store.objects.set(12, objectInfo(12, {
      parentHandle: 10,
      filename: "parse-failure.mobi",
      compressedSize: invalid.byteLength,
    }));
    store.objects.set(13, objectInfo(13, {
      parentHandle: 10,
      filename: "valid.azw3",
      compressedSize: valid.byteLength,
    }));
    store.objectData.set(12, invalid);
    store.objectData.set(13, valid);
    store.readFailures.set(11, new Error("private device failure text"));

    const snapshot = await device(store).inventory();

    expect(snapshot.status).toBe("complete");
    expect(snapshot.issueCount).toBe(0);
    expect(snapshot.bookMetadata).toMatchObject({
      status: "partial",
      attemptedObjectCount: 3,
      parsedObjectCount: 1,
      enrichedObjectCount: 1,
      failedObjectCount: 2,
      skippedObjectCount: 0,
      truncated: false,
    });
    expect(snapshot.objects.find(({ handle }) => handle === 11)).toMatchObject({
      bookMetadataState: "failed",
    });
    expect(snapshot.objects.find(({ handle }) => handle === 12)).toMatchObject({
      bookMetadataState: "failed",
    });
    expect(snapshot.objects.find(({ handle }) => handle === 13)).toMatchObject({
      bookMetadataState: "enriched",
      title: "Recovered",
    });
    expect(JSON.stringify(snapshot)).not.toContain("private device failure text");
  });

  it("propagates a transport failure during enrichment instead of returning false readiness", async () => {
    const store = new FakeKindleObjectStore();
    const book = makeKindleBookFixture({ exthTitle: "Book" });
    for (const handle of [11, 12]) {
      store.objects.set(handle, objectInfo(handle, {
        parentHandle: 10,
        filename: `${handle}.azw3`,
        compressedSize: book.byteLength,
      }));
      store.objectData.set(handle, book);
    }
    store.readFailures.set(11, Object.assign(new Error("USB detail"), {
      code: "MTP_TRANSPORT_ERROR",
    }));

    await expect(device(store).inventory()).rejects.toMatchObject({ code: "MTP_TRANSPORT_ERROR" });
    expect(store.readRequests.map(({ handle }) => handle)).toEqual([11]);
  });

  it("can disable byte enrichment while retaining a complete hierarchy inventory", async () => {
    const store = new FakeKindleObjectStore();
    const book = makeKindleBookFixture({ exthTitle: "Book" });
    store.objects.set(11, objectInfo(11, {
      parentHandle: 10,
      filename: "book.azw3",
      compressedSize: book.byteLength,
    }));
    store.objectData.set(11, book);

    const snapshot = await device(store).inventory({ bookMetadata: false });

    expect(snapshot.status).toBe("complete");
    expect(snapshot.bookMetadata).toMatchObject({
      status: "disabled",
      eligibleObjectCount: 1,
      attemptedObjectCount: 0,
    });
    expect(store.readRequests).toEqual([]);
  });

  it("confirms a previously unmanaged book only from exact parsed identifier, title, and author", async () => {
    const store = new FakeKindleObjectStore();
    const book = makeKindleBookFixture({
      exthTitle: "The Left Hand of Darkness",
      authors: ["Ursula K. Le Guin"],
      isbn: "978-0-441-47812-5",
    });
    store.objects.set(11, objectInfo(11, {
      parentHandle: 10,
      filename: "unmanaged-random-name.azw3",
      compressedSize: book.byteLength,
    }));
    store.objectData.set(11, book);

    const snapshot = await device(store).inventory();
    const candidate = kindleInventoryObjectToMatchInput(snapshot.objects[0]!);
    expect(candidate.managedToken).toBeUndefined();
    expect(matchCatalogBookToKindle({
      title: "The Left Hand of Darkness",
      authors: ["Ursula K Le Guin"],
      identifiers: ["isbn:9780441478125"],
    }, [candidate], snapshot.status)).toMatchObject({
      status: "confirmed",
      evidence: "identifier-title-author",
      matchedObject: { handle: 11 },
      ambiguous: false,
    });
  });
});
