// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgePendingDelivery,
  flushPendingDeliveries,
  queuePendingDelivery,
  readPendingDeliveries,
} from "../../client/src/delivery-journal";

const delivery = {
  profileId: "profile-1",
  bookId: "book-1",
  deviceKey: "opaque-installation-hmac",
  status: "delivered",
  artifactHash: "a".repeat(64),
  filename: "Book-kb-0123456789abcdef0123.azw3",
  size: 1234,
  managedToken: "kb-0123456789abcdef0123",
};

beforeEach(() => window.localStorage.clear());

describe("pending delivery journal", () => {
  it("stores only bounded metadata and de-duplicates operation IDs", async () => {
    expect(await queuePendingDelivery({ version: 1, operationId: "operation-1", delivery, recordedAt: 1 })).toBe(true);
    expect(await queuePendingDelivery({ version: 1, operationId: "operation-1", delivery, recordedAt: 2 })).toBe(true);
    expect(readPendingDeliveries()).toHaveLength(1);
    expect(JSON.stringify(readPendingDeliveries())).not.toContain("book bytes");
    expect(await acknowledgePendingDelivery("operation-1")).toBe(true);
    expect(readPendingDeliveries()).toHaveLength(0);
  });

  it("retries idempotently and retains only failed records", async () => {
    await queuePendingDelivery({ version: 1, operationId: "operation-1", delivery, recordedAt: 1 });
    const createDelivery = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({});
    expect(await flushPendingDeliveries({ createDelivery } as never)).toEqual({ delivered: 0, remaining: 1 });
    expect(await flushPendingDeliveries({ createDelivery } as never)).toEqual({ delivered: 1, remaining: 0 });
    expect(createDelivery).toHaveBeenCalledWith(delivery, "operation-1");
  });

  it("does not erase a delivery queued while an older startup flush is awaiting the API", async () => {
    const secondDelivery = { ...delivery, bookId: "book-2", managedToken: "kb-abcdef0123456789abcd" };
    await queuePendingDelivery({ version: 1, operationId: "operation-old", delivery, recordedAt: 1 });
    let releaseOld!: () => void;
    const createDelivery = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseOld = resolve; });
      return {};
    });

    const flushing = flushPendingDeliveries({ createDelivery } as never);
    await vi.waitFor(() => expect(createDelivery).toHaveBeenCalledOnce());
    expect(await queuePendingDelivery({
      version: 1,
      operationId: "operation-new",
      delivery: secondDelivery,
      recordedAt: 2,
    })).toBe(true);
    releaseOld();

    expect(await flushing).toEqual({ delivered: 1, remaining: 1 });
    expect(readPendingDeliveries()).toMatchObject([{ operationId: "operation-new", delivery: secondDelivery }]);
  });
});
