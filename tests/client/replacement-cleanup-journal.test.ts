import { describe, expect, it } from "vitest";
import {
  acknowledgeReplacementCleanupRecord,
  persistReplacementCleanupRecord,
  readReplacementCleanupRecords,
  type ReplacementCleanupRecord,
} from "../../client/src/replacement-cleanup-journal";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function record(operationId = "replace-1", recordedAt = 10): ReplacementCleanupRecord {
  return {
    version: 1,
    operationId,
    recordedAt,
    vendorId: 0x1949,
    productId: 0x9981,
    reason: "old-copy-cleanup",
    deviceKey: "pseudonymous-device",
    oldCopy: {
      handle: 10,
      storageId: 0x10001,
      parentHandle: 42,
      filename: "old-kb-0123456789abcdefabcd.azw3",
      byteLength: 100,
      managedToken: "kb-0123456789abcdefabcd",
      exactIdentity: "old-exact",
    },
    newCopy: {
      handle: 20,
      storageId: 0x10001,
      parentHandle: 42,
      filename: "new-kb-fedcba9876543210abcd.azw3",
      byteLength: 120,
      managedToken: "kb-fedcba9876543210abcd",
      exactIdentity: "new-exact",
    },
  };
}

describe("replacement cleanup journal", () => {
  it("persists a bounded versioned exact duplicate reminder", () => {
    const storage = new MemoryStorage();
    expect(persistReplacementCleanupRecord(record(), storage)).toBe(true);
    expect(readReplacementCleanupRecords(storage)).toEqual([record()]);
  });

  it("rejects hostile fields and bounds retained operations", () => {
    const storage = new MemoryStorage();
    expect(persistReplacementCleanupRecord({
      ...record(),
      oldCopy: { ...record().oldCopy, filename: "../old.azw3" },
    }, storage)).toBe(false);
    for (let index = 0; index < 24; index += 1) {
      expect(persistReplacementCleanupRecord(record(`replace-${index}`, index), storage)).toBe(true);
    }
    const retained = readReplacementCleanupRecords(storage);
    expect(retained).toHaveLength(16);
    expect(retained[0]?.operationId).toBe("replace-8");
  });

  it("compare-removes only the exact record and preserves newer evidence", () => {
    const storage = new MemoryStorage();
    const first = record();
    const newer = record("replace-1", 11);
    expect(persistReplacementCleanupRecord(first, storage)).toBe(true);
    expect(persistReplacementCleanupRecord(newer, storage)).toBe(true);
    expect(acknowledgeReplacementCleanupRecord(first, storage)).toBe(false);
    expect(readReplacementCleanupRecords(storage)).toEqual([newer]);
    expect(acknowledgeReplacementCleanupRecord(newer, storage)).toBe(true);
    expect(readReplacementCleanupRecords(storage)).toEqual([]);
  });

  it("drops malformed or oversized persisted input without throwing", () => {
    const storage = new MemoryStorage();
    storage.setItem("kindle-bridge.replacement-cleanup-v1", JSON.stringify([{ ...record(), version: 2 }]));
    expect(readReplacementCleanupRecords(storage)).toEqual([]);
    storage.setItem("kindle-bridge.replacement-cleanup-v1", "x".repeat(24_001));
    expect(readReplacementCleanupRecords(storage)).toEqual([]);
  });
});
