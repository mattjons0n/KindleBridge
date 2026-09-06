import { describe, expect, it } from "vitest";
import { collectReadingDiagnostic } from "../../client/src/kindle/reading-diagnostic";
import { FakeKindleObjectStore, objectInfo } from "./fake-store";
import { readingKrdsFixture } from "./krds-fixtures";

function fixture(): FakeKindleObjectStore {
  const store = new FakeKindleObjectStore();
  store.objects.set(11, objectInfo(11, { parentHandle: 10, filename: "Example.azw3", compressedSize: 1000 }));
  store.objects.set(12, objectInfo(12, { parentHandle: 10, filename: "Example.sdr", objectFormat: 0x3001, associationType: 1 }));
  const bytes = readingKrdsFixture(0.42, Date.UTC(2026, 8, 3));
  store.objects.set(13, objectInfo(13, { parentHandle: 12, filename: "Example.azw3f", compressedSize: bytes.length }));
  store.objectData.set(13, bytes);
  store.objects.set(14, objectInfo(14, { parentHandle: 12, filename: "unknown.state", compressedSize: 3 }));
  store.objectData.set(14, Uint8Array.of(1, 2, 3));
  return store;
}
describe("development reading evidence collection", () => {
  it("captures exact raw known and unknown sidecars, not book bytes, without writes", async () => {
    const store = fixture();
    const report = await collectReadingDiagnostic(store, 1, 10);
    const file = report.objects.find((entry) => entry.info.handle === 13)!;
    expect(file.path).toBe("documents/Example.sdr/Example.azw3f");
    expect(file.parsed).toMatchObject({ progressPercent: 42, explicitState: false });
    expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.from(file.base64!, "base64")).toEqual(Buffer.from(store.objectData.get(13)!));
    expect(report.objects.find((entry) => entry.info.handle === 14)?.base64).toBe("AQID");
    expect(store.readRequests.map((request) => request.handle)).toEqual([13, 14]);
    expect(store.createRequests).toEqual([]);
    expect(store.deletedHandles).toEqual([]);
    expect(report.issues).toEqual([]);
  });
  it("retains bytes when parsing fails and reports oversized files and read errors", async () => {
    const store = fixture();
    store.objectData.set(13, new Uint8Array(store.objects.get(13)!.compressedSize));
    store.readFailures.set(14, new Error("read failed"));
    store.objects.set(15, objectInfo(15, { parentHandle: 12, filename: "large.yjf", compressedSize: 9 * 1024 * 1024 }));
    const report = await collectReadingDiagnostic(store, 1, 10);
    expect(report.objects.find((entry) => entry.info.handle === 13)).toMatchObject({ outcome: "captured", error: expect.stringContaining("signature"), base64: expect.any(String) });
    expect(report.objects.find((entry) => entry.info.handle === 15)?.outcome).toBe("skipped-size-limit");
    expect(report.issues).toEqual([expect.stringContaining("read failed")]);
    expect(store.readRequests.some((request) => request.handle === 15)).toBe(false);
  });
  it("honors cancellation without reading or writing", async () => {
    const store = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(collectReadingDiagnostic(store, 1, 10, { signal: controller.signal })).rejects.toThrow();
    expect(store.readRequests).toEqual([]);
    expect(store.createRequests).toEqual([]);
  });
});
