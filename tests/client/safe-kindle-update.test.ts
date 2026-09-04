import { describe, expect, it, vi } from "vitest";
import {
  runSafeKindleUpdate,
  type SafeKindleUpdateDependencies,
  type SafeKindleUpdateOldCopy,
  type SafeKindleUpdateStage,
} from "../../client/src/safe-kindle-update";

const oldCopy: SafeKindleUpdateOldCopy = Object.freeze({
  handle: 10,
  filename: "Old-kb-0123456789abcdefabcd.azw3",
  byteLength: 1_000,
  exactIdentity: "old-object-identity",
});

function harness(overrides: Partial<SafeKindleUpdateDependencies> = {}) {
  const order: string[] = [];
  const dependencies: SafeKindleUpdateDependencies = {
    prepare: vi.fn(async () => {
      order.push("prepare");
      return { filename: "New-kb-fedcba9876543210abcd.azw3", byteLength: 2_000, artifactHash: "a".repeat(64), value: {} };
    }),
    withDeviceLock: vi.fn(async (operation) => { order.push("lock"); return operation(); }),
    ensureCurrentConnectionWriteProof: vi.fn(async () => { order.push("proof"); }),
    revalidateOldCopy: vi.fn(async () => { order.push("revalidate-old"); return oldCopy; }),
    readFreeBytes: vi.fn(async () => { order.push("free-space"); return 10_000n; }),
    uploadNewCopy: vi.fn(async (prepared) => {
      order.push("upload-new");
      return { handle: 20, filename: prepared.filename, byteLength: prepared.byteLength };
    }),
    verifyNewCopy: vi.fn(async (uploaded) => {
      order.push("verify-new");
      return { ...uploaded, exactIdentity: "new-object-identity" };
    }),
    recordVerifiedDelivery: vi.fn(async () => { order.push("record-new"); }),
    deleteExactOldCopy: vi.fn(async () => { order.push("delete-old"); }),
    verifyOldCopyAbsent: vi.fn(async () => { order.push("verify-old-absent"); }),
    recordCleanupRequired: vi.fn(async () => { order.push("record-cleanup"); }),
    reconcile: vi.fn(async () => { order.push("reconcile"); }),
    onStage: vi.fn((_stage: SafeKindleUpdateStage) => undefined),
    ...overrides,
  };
  return { dependencies, order };
}

describe("safe Kindle update orchestration", () => {
  it("never deletes the old copy before the new copy is verified and durably recorded", async () => {
    const { dependencies, order } = harness();
    await expect(runSafeKindleUpdate(oldCopy, dependencies)).resolves.toMatchObject({ status: "updated" });
    expect(order).toEqual([
      "prepare", "lock", "proof", "revalidate-old", "free-space", "upload-new", "verify-new",
      "record-new", "revalidate-old", "delete-old", "verify-old-absent", "reconcile",
    ]);
  });

  it("stops without a device write when coexistence capacity is insufficient", async () => {
    const { dependencies, order } = harness({ readFreeBytes: vi.fn(async () => { order.push("free-space"); return 1_999n; }) });
    await expect(runSafeKindleUpdate(oldCopy, dependencies)).rejects.toMatchObject({
      code: "INSUFFICIENT_COEXISTENCE_SPACE",
    });
    expect(order).not.toContain("upload-new");
    expect(order).not.toContain("delete-old");
  });

  it.each(["prepare", "proof", "upload", "verify"] as const)(
    "leaves the old copy untouched when %s fails",
    async (failure) => {
      const injected = new Error(`${failure} failed`);
      const overrides: Partial<SafeKindleUpdateDependencies> = failure === "prepare"
        ? { prepare: vi.fn(async () => { throw injected; }) }
        : failure === "proof"
          ? { ensureCurrentConnectionWriteProof: vi.fn(async () => { throw injected; }) }
          : failure === "upload"
            ? { uploadNewCopy: vi.fn(async () => { throw injected; }) }
            : failure === "verify"
            ? { verifyNewCopy: vi.fn(async () => { throw injected; }) }
              : {};
      const { dependencies } = harness(overrides);
      await expect(runSafeKindleUpdate(oldCopy, dependencies)).rejects.toBe(injected);
      expect(dependencies.deleteExactOldCopy).not.toHaveBeenCalled();
    },
  );

  it("retains both exact copies, journals intervention, and reconciles when durable recording fails", async () => {
    const deliveryRecordError = new Error("record failed");
    const { dependencies, order } = harness({
      recordVerifiedDelivery: vi.fn(async () => { order.push("record-new"); throw deliveryRecordError; }),
    });
    await expect(runSafeKindleUpdate(oldCopy, dependencies)).resolves.toMatchObject({
      status: "new-copy-kept-old-recording-required",
      deliveryRecordError,
      newCopy: { handle: 20, exactIdentity: "new-object-identity" },
      oldCopy,
    });
    expect(dependencies.deleteExactOldCopy).not.toHaveBeenCalled();
    expect(order.slice(-2)).toEqual(["record-cleanup", "reconcile"]);
  });

  it("keeps the verified new copy and reports exact cleanup when old deletion fails", async () => {
    const cleanupError = new Error("delete failed");
    const { dependencies, order } = harness({ deleteExactOldCopy: vi.fn(async () => { throw cleanupError; }) });
    await expect(runSafeKindleUpdate(oldCopy, dependencies)).resolves.toMatchObject({
      status: "new-copy-kept-old-cleanup-required",
      cleanupError,
      newCopy: { handle: 20, exactIdentity: "new-object-identity" },
      oldCopy,
    });
    expect(dependencies.recordVerifiedDelivery).toHaveBeenCalledBefore(dependencies.deleteExactOldCopy as ReturnType<typeof vi.fn>);
    expect(order.slice(-2)).toEqual(["record-cleanup", "reconcile"]);
    expect(dependencies.reconcile).toHaveBeenCalledOnce();
  });

  it("keeps cleanup and journal failures separately visible after the new delivery is durable", async () => {
    const cleanupError = new Error("delete failed");
    const cleanupRecordError = new Error("storage unavailable");
    const { dependencies } = harness({
      deleteExactOldCopy: vi.fn(async () => { throw cleanupError; }),
      recordCleanupRequired: vi.fn(async () => { throw cleanupRecordError; }),
    });
    await expect(runSafeKindleUpdate(oldCopy, dependencies)).resolves.toMatchObject({
      status: "new-copy-kept-old-cleanup-required",
      cleanupError,
      cleanupRecordError,
    });
    expect(dependencies.reconcile).toHaveBeenCalledOnce();
  });

  it.each(["delete", "absence"] as const)(
    "keeps the verified replacement explicit when old-copy %s fails",
    async (failure) => {
      const injected = new Error(`${failure} failed`);
      const { dependencies } = harness(failure === "delete"
        ? { deleteExactOldCopy: vi.fn(async () => { throw injected; }) }
        : { verifyOldCopyAbsent: vi.fn(async () => { throw injected; }) });
      await expect(runSafeKindleUpdate(oldCopy, dependencies)).resolves.toMatchObject({
        status: "new-copy-kept-old-cleanup-required",
        cleanupError: injected,
      });
      expect(dependencies.recordCleanupRequired).toHaveBeenCalledOnce();
    },
  );

  it("reports final reconciliation failure without obscuring the completed exact replacement", async () => {
    const reconciliationError = new Error("reconcile failed");
    const { dependencies } = harness({ reconcile: vi.fn(async () => { throw reconciliationError; }) });
    await expect(runSafeKindleUpdate(oldCopy, dependencies)).resolves.toMatchObject({
      status: "updated-reconciliation-required",
      reconciliationError,
      newCopy: { handle: 20 },
      oldCopy,
    });
    expect(dependencies.deleteExactOldCopy).toHaveBeenCalledOnce();
    expect(dependencies.verifyOldCopyAbsent).toHaveBeenCalledOnce();
  });

  it("treats a changed old object as cleanup-required only after new delivery is durable", async () => {
    let reads = 0;
    const { dependencies } = harness({
      revalidateOldCopy: vi.fn(async () => (++reads === 1 ? oldCopy : { ...oldCopy, byteLength: 999 })),
    });
    await expect(runSafeKindleUpdate(oldCopy, dependencies)).resolves.toMatchObject({
      status: "new-copy-kept-old-cleanup-required",
      cleanupError: { code: "OLD_COPY_CHANGED" },
    });
    expect(dependencies.deleteExactOldCopy).not.toHaveBeenCalled();
  });
});
