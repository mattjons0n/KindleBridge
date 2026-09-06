import { describe, expect, it } from "vitest";
import { parseRecordedKindleReadingFile } from "../../client/src/kindle/recorded-reading-data";
import { renderRecordedReadingData } from "../../client/src/recorded-reading-view";
import { KindleDevice } from "../../client/src/kindle/kindle-device";
import { FakeKindleObjectStore, objectInfo } from "../kindle/fake-store";
import { krdsContainer, krdsDouble, krdsInt, krdsLong, krdsObject, krdsString, readingKrdsFixture } from "../kindle/krds-fixtures";
import type { CatalogKindleInventory } from "../../client/src/catalog-browser";

function fixture() {
  const store = new FakeKindleObjectStore();
  store.objects.set(11, objectInfo(11, { parentHandle: 10, filename: "Book.azw3", compressedSize: 1000 }));
  store.objects.set(12, objectInfo(12, { parentHandle: 10, filename: "Book.sdr", objectFormat: 0x3001, associationType: 1 }));
  const bytes = readingKrdsFixture();
  store.objects.set(13, objectInfo(13, { parentHandle: 12, filename: "Book.azw3f", compressedSize: bytes.length }));
  store.objectData.set(13, bytes);
  return store;
}

describe("recorded Kindle data, separate from reading status", () => {
  it("collects data through real inventory without emitting semantic evidence or writing", async () => {
    const store = fixture();
    const inventory = await new KindleDevice(store).inventory({ bookMetadata: false, deviceMetadataCache: false, recordedReadingData: true });
    const book = inventory.objects.find((item) => item.handle === 11)!;
    expect(book.recordedReadingData?.[0].fields).toContainEqual({ label: "Counted words", value: "250" });
    expect(book.readingEvidence).toBeUndefined();
    expect(store.readRequests.map((request) => request.handle)).toEqual([13]);
    expect(store.createRequests).toEqual([]);
    expect(store.deletedHandles).toEqual([]);
  });
  it("reports malformed files without losing the rest of the inventory", async () => {
    const store = fixture();
    store.objectData.set(13, new Uint8Array(store.objects.get(13)!.compressedSize));
    const inventory = await new KindleDevice(store).inventory({ bookMetadata: false, deviceMetadataCache: false, recordedReadingData: true });
    expect(inventory.objects.find((item) => item.handle === 11)?.recordedReadingData?.[0].error).toContain("signature");
  });
  it("presents cumulative fractions above one without pretending they are progress or Read status", () => {
    const data = parseRecordedKindleReadingFile(krdsContainer(
      krdsObject("timer.model", krdsLong(0), krdsLong(3_661_000), krdsLong(900), krdsDouble(1.2), krdsObject("timer.average.calculator", krdsInt(0))),
      krdsObject("lpr", Uint8Array.of(7, 2), krdsString("1234"), krdsLong(1_787_921_252_850)),
      krdsObject("fpr", krdsString("5678"), krdsLong(-1)),
    ), "Book.azw3f");
    expect(data.fields).toContainEqual({ label: "Recorded reading time", value: "1 h 1 min 1 s" });
    expect(data.fields).toContainEqual({ label: "Timer activity fraction (not completion)", value: "1.2" });
    expect(data.fields).toContainEqual({ label: "Last saved position", value: "1234" });
    expect(data.fields).toContainEqual({ label: "Furthest saved position", value: "5678" });
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("progressPercent");
  });
  it("renders escaped data, missing and ambiguous cases, and last-seen labels", () => {
    const inventory: CatalogKindleInventory = { deviceLabel: "Kindle", scannedAt: "2026-09-06T12:00:00Z", completeness: "complete", truncated: false, total: 1,
      items: [{ id: "mtp-1", filename: "Book.azw3", size: 1, managed: false, match: "confirmed", bookId: "book_one",
        recordedReadingData: [{ filename: "<img>.azw3f", size: 2, fields: [{ label: "Last saved position", value: "<script>" }], technical: "<b>raw</b>", technicalTruncated: true }] }] };
    const html = renderRecordedReadingData("book_one", inventory);
    expect(html).toContain("Kindle reading data");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img>");
    expect(html).toContain("Technical preview truncated");
    expect(renderRecordedReadingData("book_one", { ...inventory, completeness: "last-seen" })).toContain("Last seen");
    expect(renderRecordedReadingData("book_other", inventory)).toContain("No data available");
    expect(renderRecordedReadingData("book_one", undefined)).toContain("Connect a Kindle");
    expect(renderRecordedReadingData("book_one", { ...inventory, items: [...inventory.items, ...inventory.items] })).not.toContain("&lt;script&gt;");
    expect(renderRecordedReadingData("book_one", { ...inventory, items: [{ ...inventory.items[0]!, match: "possible" }] })).toContain("single confirmed");
  });
});
