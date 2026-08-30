import { describe, expect, it } from "vitest";

import { prepareKindleSideload } from "../../client/src/api/azw3-sideload";

describe("AZW3 sideload preparation", () => {
  it("accepts only cover metadata whose referenced PalmDB records contain plausible images", () => {
    const fixture = azw3WithEmbeddedCover();
    const prepared = prepareKindleSideload(fixture.bytes);

    expect(prepared.metadata).toEqual({ documentType: "PDOC", embeddedCover: true });
    expect(ascii(prepared.bytes, fixture.documentTypeOffset, 4)).toBe("PDOC");
    expect(ascii(fixture.bytes, fixture.documentTypeOffset, 4)).toBe("EBOK");

    const missingReference = fixture.bytes.slice();
    new DataView(missingReference.buffer).setUint32(fixture.coverValueOffset, 999, false);
    expect(prepareKindleSideload(missingReference).metadata.embeddedCover).toBe(false);

    const corruptImage = fixture.bytes.slice();
    corruptImage[fixture.coverRecordOffset] = 0;
    expect(prepareKindleSideload(corruptImage).metadata.embeddedCover).toBe(false);
  });

  it("rejects AZW3 sources with a non-zero PalmDOC encryption word", () => {
    const fixture = azw3WithEmbeddedCover();
    const encrypted = fixture.bytes.slice();
    const view = new DataView(encrypted.buffer);
    const recordZero = view.getUint32(78, false);
    view.setUint16(recordZero + 12, 1, false);

    expect(() => prepareKindleSideload(encrypted)).toThrow(/Encrypted AZW3 sources are not supported/u);
  });

  it("rejects a non-book PalmDB with missing, out-of-range, or unreadable KF8 text", () => {
    const fixture = azw3WithEmbeddedCover();
    const recordZero = new DataView(fixture.bytes.buffer).getUint32(78, false);

    const noText = fixture.bytes.slice();
    new DataView(noText.buffer).setUint32(recordZero + 4, 0, false);
    expect(() => prepareKindleSideload(noText)).toThrow(/text length is zero/u);

    const missingTextRecords = fixture.bytes.slice();
    new DataView(missingTextRecords.buffer).setUint16(recordZero + 8, 0, false);
    expect(() => prepareKindleSideload(missingTextRecords)).toThrow(/text record count/u);

    const outOfRangeTextRecords = fixture.bytes.slice();
    new DataView(outOfRangeTextRecords.buffer).setUint16(recordZero + 8, 4, false);
    expect(() => prepareKindleSideload(outOfRangeTextRecords)).toThrow(/text record count/u);

    const zeroRecordSize = fixture.bytes.slice();
    new DataView(zeroRecordSize.buffer).setUint16(recordZero + 10, 0, false);
    expect(() => prepareKindleSideload(zeroRecordSize)).toThrow(/record size/u);

    const legacyMobi = fixture.bytes.slice();
    new DataView(legacyMobi.buffer).setUint32(recordZero + 16 + 20, 6, false);
    expect(() => prepareKindleSideload(legacyMobi)).toThrow(/not KF8 version 8/u);

    const unreadable = fixture.bytes.slice();
    unreadable.fill(0, fixture.textRecordOffset, fixture.coverRecordOffset);
    expect(() => prepareKindleSideload(unreadable)).toThrow(/no readable book content/u);
  });

  it("fails closed for HUFF/CDIC text because the browser does not implement that decompressor", () => {
    const fixture = azw3WithEmbeddedCover();
    const huffClaim = fixture.bytes.slice();
    const recordZero = new DataView(huffClaim.buffer).getUint32(78, false);
    new DataView(huffClaim.buffer).setUint16(recordZero, 17_480, false);

    expect(() => prepareKindleSideload(huffClaim)).toThrow(
      /Unsupported AZW3 PalmDOC compression: 17480/u,
    );
  });

  it("bounds logical text expansion and EXTH iteration before synchronous parsing", () => {
    const fixture = azw3WithEmbeddedCover();
    const recordZero = new DataView(fixture.bytes.buffer).getUint32(78, false);

    const expandedText = fixture.bytes.slice();
    new DataView(expandedText.buffer).setUint32(recordZero + 4, 128 * 1024 * 1024 + 1, false);
    expect(() => prepareKindleSideload(expandedText)).toThrow(/decoded text exceeds the 128 MiB/u);

    const excessiveExth = fixture.bytes.slice();
    const view = new DataView(excessiveExth.buffer);
    const mobi = recordZero + 16;
    const exth = mobi + view.getUint32(mobi + 4, false);
    view.setUint32(exth + 8, 10_001, false);
    expect(() => prepareKindleSideload(excessiveExth)).toThrow(/10000-record limit/u);
  });
});

interface CoverFixture {
  bytes: Uint8Array;
  documentTypeOffset: number;
  coverValueOffset: number;
  textRecordOffset: number;
  coverRecordOffset: number;
}

function azw3WithEmbeddedCover(): CoverFixture {
  const recordZeroOffset = 112;
  const mobiHeaderLength = 132;
  const exthRecords = [
    { type: 201, value: uint32(0) },
    { type: 202, value: uint32(1) },
    { type: 129, value: new TextEncoder().encode("kindle:embed:0001") },
    { type: 501, value: new TextEncoder().encode("EBOK") },
  ];
  const exthLength = 12 + exthRecords.reduce((total, record) => total + 8 + record.value.byteLength, 0);
  const recordZeroLength = 16 + mobiHeaderLength + exthLength;
  const text = new TextEncoder().encode("<html><body>Readable KF8 content</body></html>");
  const cover = jpegHeader(600, 800);
  const thumbnail = pngHeader(300, 400);
  const recordOffsets = [
    recordZeroOffset,
    recordZeroOffset + recordZeroLength,
    recordZeroOffset + recordZeroLength + text.byteLength,
    recordZeroOffset + recordZeroLength + text.byteLength + cover.byteLength,
  ];
  const bytes = new Uint8Array(recordOffsets[3]! + thumbnail.byteLength);
  const view = new DataView(bytes.buffer);

  setAscii(bytes, 60, "BOOKMOBI");
  view.setUint16(76, recordOffsets.length, false);
  recordOffsets.forEach((offset, index) => view.setUint32(78 + index * 8, offset, false));

  const recordZero = recordOffsets[0]!;
  view.setUint16(recordZero, 2, false);
  view.setUint32(recordZero + 4, text.byteLength, false);
  view.setUint16(recordZero + 8, 1, false);
  view.setUint16(recordZero + 10, 4096, false);
  setAscii(bytes, recordZero + 16, "MOBI");
  view.setUint32(recordZero + 20, mobiHeaderLength, false);
  view.setUint32(recordZero + 16 + 8, 2, false);
  view.setUint32(recordZero + 16 + 12, 65001, false);
  view.setUint32(recordZero + 16 + 20, 8, false);
  view.setUint32(recordZero + 0x6c, 2, false);

  const exth = recordZero + 16 + mobiHeaderLength;
  setAscii(bytes, exth, "EXTH");
  view.setUint32(exth + 4, exthLength, false);
  view.setUint32(exth + 8, exthRecords.length, false);
  let cursor = exth + 12;
  let coverValueOffset = -1;
  let documentTypeOffset = -1;
  for (const record of exthRecords) {
    view.setUint32(cursor, record.type, false);
    view.setUint32(cursor + 4, 8 + record.value.byteLength, false);
    bytes.set(record.value, cursor + 8);
    if (record.type === 201) coverValueOffset = cursor + 8;
    if (record.type === 501) documentTypeOffset = cursor + 8;
    cursor += 8 + record.value.byteLength;
  }
  bytes.set(text, recordOffsets[1]);
  bytes.set(cover, recordOffsets[2]);
  bytes.set(thumbnail, recordOffsets[3]);

  return {
    bytes,
    documentTypeOffset,
    coverValueOffset,
    textRecordOffset: recordOffsets[1]!,
    coverRecordOffset: recordOffsets[2]!,
  };
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function jpegHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8, 0xff, 0xc0]);
  view.setUint16(4, 7, false);
  bytes[6] = 8;
  view.setUint16(7, height, false);
  view.setUint16(9, width, false);
  bytes.set([0xff, 0xd9], 11);
  return bytes;
}

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  view.setUint32(8, 13, false);
  setAscii(bytes, 12, "IHDR");
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function setAscii(bytes: Uint8Array, offset: number, value: string): void {
  bytes.set(new TextEncoder().encode(value), offset);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder("ascii").decode(bytes.subarray(offset, offset + length));
}
