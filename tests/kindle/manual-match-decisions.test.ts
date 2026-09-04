import { describe, expect, it, vi } from "vitest";
import {
  createKindleManualMatchDecisionStore,
  type KindleManualMatchDecisionPersistence,
  type KindleManualMatchDecisionRecord,
  type KindleManualMatchEvidence,
} from "../../client/src/kindle/manual-match-decisions";

class MemoryPersistence implements KindleManualMatchDecisionPersistence {
  readonly values = new Map<string, unknown>();
  readonly read = vi.fn(async (key: string) => this.values.get(key));
  readonly put = vi.fn(async (
    record: KindleManualMatchDecisionRecord,
    limits: { readonly maxEntries: number; readonly expireBefore: number },
  ) => {
    this.values.set(record.decisionKey, structuredClone(record));
    for (const [key, value] of this.values) {
      if (Number((value as Partial<KindleManualMatchDecisionRecord>).updatedAt ?? 0) < limits.expireBefore) {
        this.values.delete(key);
      }
    }
    const ordered = [...this.values.entries()].sort((left, right) =>
      Number((left[1] as Partial<KindleManualMatchDecisionRecord>).updatedAt ?? 0)
      - Number((right[1] as Partial<KindleManualMatchDecisionRecord>).updatedAt ?? 0));
    for (let index = 0; index < ordered.length - limits.maxEntries; index += 1) {
      this.values.delete(ordered[index]![0]);
    }
  });
  readonly delete = vi.fn(async (key: string) => { this.values.delete(key); });
  readonly clearProfile = vi.fn(async (profileId: string) => {
    for (const [key, value] of this.values) {
      if ((value as Partial<KindleManualMatchDecisionRecord>).profileId === profileId) this.values.delete(key);
    }
  });
}

function evidence(overrides: Partial<KindleManualMatchEvidence> = {}): KindleManualMatchEvidence {
  return {
    identity: { key: "a".repeat(64), stability: "installation" },
    storageId: 0x0001_0001,
    profileId: "prf-household",
    bookId: "book-one",
    catalogPresentationVersion: "d".repeat(64),
    relativePath: "Author/Book.azw3",
    metadataAdjusted: false,
    objectFormat: 0xb0_03,
    size: 123_456,
    modificationDate: "20260830T120000.",
    title: "Book",
    authors: ["An Author"],
    identifiers: ["asin:B012345678"],
    ...overrides,
  };
}

describe("manual Kindle match decisions", () => {
  it("persists a decision under digested exact live evidence and supports undo", async () => {
    const persistence = new MemoryPersistence();
    const store = createKindleManualMatchDecisionStore({ persistence, now: () => 1_000 });
    const input = evidence();

    await expect(store.remember(input, "same-book")).resolves.toBe(true);
    await expect(store.lookup(input)).resolves.toMatchObject({
      decision: "same-book",
      provenance: "manual-live-evidence",
      authoritativeForPresence: true,
      authoritativeForDeletion: false,
    });
    expect(persistence.values.size).toBe(1);
    const serialized = JSON.stringify([...persistence.values.values()]);
    expect(serialized).not.toContain(input.relativePath);
    expect(serialized).not.toContain(input.identity.key);
    expect([...persistence.values.keys()][0]).toMatch(/^[a-f0-9]{64}$/u);

    await store.forget(input);
    await expect(store.lookup(input)).resolves.toBeUndefined();
  });

  it("does not apply a saved choice when any current object evidence changes", async () => {
    const persistence = new MemoryPersistence();
    const writer = createKindleManualMatchDecisionStore({ persistence, now: () => 2_000 });
    await writer.remember(evidence(), "not-this-book");
    const reader = createKindleManualMatchDecisionStore({ persistence, now: () => 2_001 });

    await expect(reader.lookup(evidence({ size: 123_457 }))).resolves.toBeUndefined();
    await expect(reader.lookup(evidence({ relativePath: "Author/Replacement.azw3" }))).resolves.toBeUndefined();
    await expect(reader.lookup(evidence({ modificationDate: "20260830T120001." }))).resolves.toBeUndefined();
    await expect(reader.lookup(evidence({ title: "Different title" }))).resolves.toBeUndefined();
    await expect(reader.lookup(evidence({ catalogPresentationVersion: "e".repeat(64) }))).resolves.toBeUndefined();
    await expect(reader.lookup(evidence({ profileId: "prf-other" }))).resolves.toBeUndefined();
    await expect(reader.lookup(evidence({ identity: { key: "b".repeat(64), stability: "installation" } })))
      .resolves.toBeUndefined();
  });

  it("keeps session-only device identities out of durable persistence", async () => {
    const persistence = new MemoryPersistence();
    const store = createKindleManualMatchDecisionStore({ persistence, now: () => 3_000 });
    const input = evidence({ identity: { key: "c".repeat(64), stability: "session" } });

    await expect(store.remember(input, "same-book")).resolves.toBe(true);
    await expect(store.lookup(input)).resolves.toMatchObject({ decision: "same-book" });
    expect(persistence.put).not.toHaveBeenCalled();

    const nextPage = createKindleManualMatchDecisionStore({ persistence, now: () => 3_001 });
    await expect(nextPage.lookup(input)).resolves.toBeUndefined();
  });

  it("rejects malformed evidence and expires or evicts bounded records", async () => {
    const persistence = new MemoryPersistence();
    const store = createKindleManualMatchDecisionStore({
      persistence,
      maxEntries: 2,
      maxAgeMs: 100,
      now: (() => {
        let current = 4_000;
        return () => current++;
      })(),
    });
    await expect(store.remember(evidence({ metadataAdjusted: true as false }), "same-book"))
      .resolves.toBe(false);
    await expect(store.remember(evidence({ relativePath: "../Book.azw3" }), "same-book"))
      .resolves.toBe(false);
    await store.remember(evidence({ bookId: "book-one" }), "same-book");
    await store.remember(evidence({ bookId: "book-two" }), "same-book");
    await store.remember(evidence({ bookId: "book-three" }), "same-book");
    expect(persistence.values.size).toBe(2);
  });

  it("does not claim a persistent decision was saved when IndexedDB fails", async () => {
    const persistence: KindleManualMatchDecisionPersistence = {
      read: vi.fn(async () => { throw new Error("unavailable"); }),
      put: vi.fn(async () => { throw new Error("unavailable"); }),
      delete: vi.fn(async () => { throw new Error("unavailable"); }),
      clearProfile: vi.fn(async () => { throw new Error("unavailable"); }),
    };
    const store = createKindleManualMatchDecisionStore({ persistence, now: () => 5_000 });
    await expect(store.remember(evidence(), "same-book")).resolves.toBe(false);
    await expect(store.lookup(evidence())).resolves.toBeUndefined();
  });
});
