import { describe, expect, it, vi } from "vitest";
import {
  createKindleMetadataCache,
  type KindleMetadataCacheEvidence,
  type KindleMetadataCachePersistence,
  type KindleMetadataCacheStoredRecord,
} from "../../client/src/kindle/metadata-cache";

class MemoryPersistence implements KindleMetadataCachePersistence {
  readonly values = new Map<string, unknown>();
  readonly readMany = vi.fn(async (cacheKeys: readonly string[]) => new Map(
    cacheKeys
      .filter((cacheKey) => this.values.has(cacheKey))
      .map((cacheKey) => [cacheKey, this.values.get(cacheKey)]),
  ));
  readonly putMany = vi.fn(async (
    records: readonly KindleMetadataCacheStoredRecord[],
    limits: { readonly maxEntries: number; readonly expireBefore: number },
  ) => {
    for (const record of records) this.values.set(record.cacheKey, structuredClone(record));
    for (const [cacheKey, value] of this.values) {
      const lastUsedAt = Number((value as Partial<KindleMetadataCacheStoredRecord>)?.lastUsedAt);
      if (Number.isFinite(lastUsedAt) && lastUsedAt < limits.expireBefore) this.values.delete(cacheKey);
    }
    const oldest = [...this.values.entries()].sort((left, right) => {
      const leftTime = Number((left[1] as Partial<KindleMetadataCacheStoredRecord>)?.lastUsedAt ?? 0);
      const rightTime = Number((right[1] as Partial<KindleMetadataCacheStoredRecord>)?.lastUsedAt ?? 0);
      return leftTime - rightTime || left[0].localeCompare(right[0]);
    });
    for (let index = 0; index < oldest.length - limits.maxEntries; index += 1) {
      this.values.delete(oldest[index]![0]);
    }
  });
  readonly deleteMany = vi.fn(async (cacheKeys: readonly string[]) => {
    for (const cacheKey of cacheKeys) this.values.delete(cacheKey);
  });
  readonly clear = vi.fn(async () => this.values.clear());
}

const installationIdentity = Object.freeze({
  key: "a".repeat(64),
  stability: "installation" as const,
});

const sessionIdentity = Object.freeze({
  key: "b".repeat(64),
  stability: "session" as const,
});

function evidence(
  relativePath: string,
  overrides: Partial<KindleMetadataCacheEvidence> = {},
): KindleMetadataCacheEvidence {
  return {
    identity: installationIdentity,
    storageId: 0x0001_0001,
    relativePath,
    metadataAdjusted: false,
    size: 12_345,
    modificationDate: "20260830T120000Z",
    ...overrides,
  };
}

const metadata = Object.freeze({
  title: "A cached title",
  authors: Object.freeze(["An Author"]),
  identifiers: Object.freeze(["asin:B012345678"]),
  language: "en",
});

describe("browser-local Kindle metadata cache", () => {
  it("preserves batch ordering and requires an exact live evidence tuple", async () => {
    const persistence = new MemoryPersistence();
    const cache = createKindleMetadataCache({ persistence, now: () => 1_000 });
    const exact = evidence("Author/Book.azw3");
    expect(await cache.remember({ evidence: exact, metadata })).toBe(true);

    const results = await cache.lookupMany([
      evidence("Author/Other.azw3"),
      exact,
      evidence("Author/Book.azw3", { size: exact.size + 1 }),
      evidence("Author/Book.azw3", { modificationDate: "20260830T120001Z" }),
      evidence("Author/Book.azw3", { storageId: exact.storageId + 1 }),
      evidence("Author/Book.azw3", {
        identity: { key: "c".repeat(64), stability: "installation" },
      }),
    ]);

    expect(results.map((result) => result?.metadata.title)).toEqual([
      undefined,
      "A cached title",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(results[1]).toMatchObject({
      provenance: "browser-metadata-cache",
      authoritative: false,
      storedAt: 1_000,
      metadata,
    });
  });

  it("persists only a digest key and bounded parsed fields, never raw object evidence", async () => {
    const persistence = new MemoryPersistence();
    const cache = createKindleMetadataCache({ persistence, now: () => 2_000 });
    const secretPath = "Private Author/Private Book.azw3";
    const input = evidence(secretPath);

    expect(await cache.remember({ evidence: input, metadata })).toBe(true);
    expect(persistence.values.size).toBe(1);
    const serialized = JSON.stringify([...persistence.values.values()]);
    expect(serialized).not.toContain(secretPath);
    expect(serialized).not.toContain(input.modificationDate);
    expect(serialized).not.toContain(input.identity.key);
    const stored = [...persistence.values.values()][0] as Record<string, unknown>;
    expect(stored).not.toHaveProperty("relativePath");
    expect(stored).not.toHaveProperty("modificationDate");
    expect(stored).not.toHaveProperty("identity");
    expect(stored).not.toHaveProperty("storageId");
    expect(stored).not.toHaveProperty("size");
    expect([...persistence.values.keys()][0]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps session-stable device identities memory-only", async () => {
    const persistence = new MemoryPersistence();
    const input = evidence("Book.azw3", { identity: sessionIdentity });
    const cache = createKindleMetadataCache({ persistence, now: () => 3_000 });

    expect(await cache.remember({ evidence: input, metadata })).toBe(true);
    expect(persistence.putMany).not.toHaveBeenCalled();
    expect((await cache.lookup(input))?.metadata).toEqual(metadata);

    const freshPage = createKindleMetadataCache({ persistence, now: () => 3_001 });
    await expect(freshPage.lookup(input)).resolves.toBeUndefined();
    expect(persistence.readMany).not.toHaveBeenCalled();
  });

  it("rejects missing or malformed evidence and oversized decoded metadata", async () => {
    const persistence = new MemoryPersistence();
    const cache = createKindleMetadataCache({ persistence, now: () => 4_000 });
    const invalidInputs = [
      evidence("Book.azw3", { modificationDate: "" }),
      evidence("Book.azw3", { modificationDate: "not-a-date" }),
      evidence("../Book.azw3"),
      evidence("/Book.azw3"),
      evidence("Book.azw3", { size: -1 }),
      evidence("Book.azw3", { storageId: 0 }),
      { ...evidence("Book.azw3"), metadataAdjusted: true } as unknown as KindleMetadataCacheEvidence,
    ];
    for (const input of invalidInputs) {
      expect(await cache.remember({ evidence: input, metadata })).toBe(false);
      await expect(cache.lookup(input)).resolves.toBeUndefined();
    }
    expect(await cache.remember({
      evidence: evidence("Book.azw3"),
      metadata: {
        authors: ["A".repeat(4_097)],
        identifiers: [],
      },
    })).toBe(false);
    expect(persistence.putMany).not.toHaveBeenCalled();
  });

  it("treats corrupted and version-mismatched persistent records as misses", async () => {
    const persistence = new MemoryPersistence();
    const input = evidence("Book.azw3");
    const writer = createKindleMetadataCache({ persistence, now: () => 5_000 });
    await writer.remember({ evidence: input, metadata });
    const cacheKey = [...persistence.values.keys()][0]!;
    persistence.values.set(cacheKey, {
      ...(persistence.values.get(cacheKey) as object),
      version: 2,
      title: "Forged title",
    });

    const reader = createKindleMetadataCache({ persistence, now: () => 5_001 });
    await expect(reader.lookup(input)).resolves.toBeUndefined();
    expect(persistence.deleteMany).toHaveBeenCalledWith([cacheKey]);
    expect(persistence.values.has(cacheKey)).toBe(false);
  });

  it("falls back to the bounded memory copy when persistent storage fails", async () => {
    const persistence: KindleMetadataCachePersistence = {
      readMany: vi.fn(async () => { throw new Error("IndexedDB unavailable"); }),
      putMany: vi.fn(async () => { throw new Error("IndexedDB unavailable"); }),
      deleteMany: vi.fn(async () => { throw new Error("IndexedDB unavailable"); }),
      clear: vi.fn(async () => { throw new Error("IndexedDB unavailable"); }),
    };
    const input = evidence("Book.azw3");
    const cache = createKindleMetadataCache({ persistence, now: () => 6_000 });

    expect(await cache.remember({ evidence: input, metadata })).toBe(true);
    expect((await cache.lookup(input))?.metadata.title).toBe("A cached title");
    expect(persistence.putMany).toHaveBeenCalledOnce();
    expect(persistence.readMany).not.toHaveBeenCalled();
  });

  it("bounds a never-settling persistent read and disables that backend", async () => {
    const readMany = vi.fn(() => new Promise<ReadonlyMap<string, unknown>>(() => undefined));
    const persistence: KindleMetadataCachePersistence = {
      readMany,
      putMany: vi.fn(async () => undefined),
      deleteMany: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const cache = createKindleMetadataCache({
      persistence,
      operationTimeoutMs: 5,
      now: () => 6_500,
    });

    await expect(cache.lookup(evidence("Book.azw3"))).resolves.toBeUndefined();
    await expect(cache.lookup(evidence("Book.azw3"))).resolves.toBeUndefined();
    expect(readMany).toHaveBeenCalledOnce();
  });

  it("bounds a never-settling persistent write while retaining its memory copy", async () => {
    const putMany = vi.fn(() => new Promise<void>(() => undefined));
    const persistence: KindleMetadataCachePersistence = {
      readMany: vi.fn(async () => new Map()),
      putMany,
      deleteMany: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
    const input = evidence("Book.azw3");
    const cache = createKindleMetadataCache({
      persistence,
      operationTimeoutMs: 5,
      now: () => 6_600,
    });

    await expect(cache.remember({ evidence: input, metadata })).resolves.toBe(true);
    expect((await cache.lookup(input))?.metadata.title).toBe("A cached title");
    expect(putMany).toHaveBeenCalledOnce();
  });

  it("evicts least-recently-used memory entries and expires old entries", async () => {
    let now = 10_000;
    const cache = createKindleMetadataCache({
      persistence: null,
      maxEntries: 2,
      maxAgeMs: 100,
      now: () => now,
    });
    const first = evidence("First.azw3");
    const second = evidence("Second.azw3");
    const third = evidence("Third.azw3");

    await cache.remember({ evidence: first, metadata });
    now += 1;
    await cache.remember({ evidence: second, metadata });
    now += 1;
    await cache.lookup(first);
    now += 1;
    await cache.remember({ evidence: third, metadata });

    await expect(cache.lookup(second)).resolves.toBeUndefined();
    expect(await cache.lookup(first)).toBeDefined();
    expect(await cache.lookup(third)).toBeDefined();

    now += 101;
    await expect(cache.lookup(first)).resolves.toBeUndefined();
    await expect(cache.lookup(third)).resolves.toBeUndefined();
  });

  it("clears both memory and persistent records", async () => {
    const persistence = new MemoryPersistence();
    const input = evidence("Book.azw3");
    const cache = createKindleMetadataCache({ persistence, now: () => 7_000 });
    await cache.remember({ evidence: input, metadata });

    await cache.clear();
    expect(persistence.clear).toHaveBeenCalledOnce();
    expect(persistence.values.size).toBe(0);
    await expect(cache.lookup(input)).resolves.toBeUndefined();
  });

  it("uses the no-cache path when cryptographic evidence keys are unavailable", async () => {
    const persistence = new MemoryPersistence();
    const input = evidence("Book.azw3");
    const cache = createKindleMetadataCache({
      persistence,
      subtleCrypto: null,
      now: () => 8_000,
    });

    await expect(cache.remember({ evidence: input, metadata })).resolves.toBe(false);
    await expect(cache.lookup(input)).resolves.toBeUndefined();
    expect(persistence.putMany).not.toHaveBeenCalled();
  });

  it("rejects batches beyond the inventory enrichment ceiling before storage work", async () => {
    const persistence = new MemoryPersistence();
    const cache = createKindleMetadataCache({ persistence, now: () => 9_000 });
    const oversizedEvidence = Array.from(
      { length: 2_001 },
      (_unused, index) => evidence(`Book-${index}.azw3`),
    );
    const oversizedEntries = oversizedEvidence.map((item) => ({ evidence: item, metadata }));

    await expect(cache.lookupMany(oversizedEvidence)).rejects.toThrow(/limited to 2000/u);
    await expect(cache.rememberMany(oversizedEntries)).rejects.toThrow(/limited to 2000/u);
    expect(persistence.readMany).not.toHaveBeenCalled();
    expect(persistence.putMany).not.toHaveBeenCalled();
  });
});
