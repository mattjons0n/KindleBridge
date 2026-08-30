import { describe, expect, it } from "vitest";
import {
  MtpCodecError,
  MtpDatasetReader,
  MtpDatasetWriter,
  decodeContainer,
  decodeContainerParameters,
  encodeCommandContainer,
  encodeContainer,
  encodeContainerParameters,
} from "../../client/src/mtp/codec";
import { MtpContainerType, MtpOperationCode } from "../../client/src/mtp/constants";

describe("MTP primitive codec", () => {
  it("writes integers exactly in little-endian order", () => {
    const encoded = new MtpDatasetWriter()
      .uint8(0xab)
      .uint16(0x1234)
      .uint32(0x89ab_cdef)
      .uint64(0x0123_4567_89ab_cdefn)
      .finish();

    expect([...encoded]).toEqual([
      0xab,
      0x34, 0x12,
      0xef, 0xcd, 0xab, 0x89,
      0xef, 0xcd, 0xab, 0x89, 0x67, 0x45, 0x23, 0x01,
    ]);
    const reader = new MtpDatasetReader(encoded);
    expect(reader.uint8()).toBe(0xab);
    expect(reader.uint16()).toBe(0x1234);
    expect(reader.uint32()).toBe(0x89ab_cdef);
    expect(reader.uint64()).toBe(0x0123_4567_89ab_cdefn);
    reader.expectEnd();
  });

  it("encodes PTP strings by UTF-16 code units, including the terminator", () => {
    const encoded = new MtpDatasetWriter().string("A😀").string("").finish();
    // A is one code unit and the emoji is a surrogate pair: 3 + terminator.
    expect([...encoded]).toEqual([
      4,
      0x41, 0x00,
      0x3d, 0xd8,
      0x00, 0xde,
      0x00, 0x00,
      0,
    ]);
    const reader = new MtpDatasetReader(encoded);
    expect(reader.string()).toBe("A😀");
    expect(reader.string()).toBe("");
    reader.expectEnd();
  });

  it("rejects unterminated, early-terminated, embedded-NUL, and oversized strings", () => {
    expect(() => new MtpDatasetReader(Uint8Array.of(2, 0x41, 0, 0x42, 0)).string())
      .toThrow(/final NUL/);
    expect(() => new MtpDatasetReader(Uint8Array.of(3, 0x41, 0, 0, 0, 0, 0)).string())
      .toThrow(/early NUL/);
    expect(() => new MtpDatasetWriter().string("a\0b")).toThrow(/embedded NUL/);
    expect(() => new MtpDatasetWriter().string("x".repeat(255))).toThrow(/254/);
  });

  it("validates array counts before reading or allocating", () => {
    const truncated = new MtpDatasetWriter().uint32(3).uint16(1).finish();
    expect(() => new MtpDatasetReader(truncated).uint16Array()).toThrow(/truncated/);

    const excessive = new MtpDatasetWriter().uint32(11).finish();
    expect(() => new MtpDatasetReader(excessive).uint32Array(10)).toThrow(/exceeds/);
  });
});

describe("MTP USB bulk containers", () => {
  it("encodes a known command container byte-for-byte", () => {
    const command = encodeCommandContainer(
      MtpOperationCode.GetStorageInfo,
      0x1122_3344,
      [0x0001_0001],
    );
    expect([...command]).toEqual([
      0x10, 0x00, 0x00, 0x00,
      0x01, 0x00,
      0x05, 0x10,
      0x44, 0x33, 0x22, 0x11,
      0x01, 0x00, 0x01, 0x00,
    ]);
    const decoded = decodeContainer(command);
    expect(decoded).toMatchObject({
      length: 16,
      type: MtpContainerType.Command,
      code: MtpOperationCode.GetStorageInfo,
      transactionId: 0x1122_3344,
    });
    expect(decodeContainerParameters(decoded.payload)).toEqual([0x0001_0001]);
  });

  it("preserves an arbitrary data payload", () => {
    const payload = Uint8Array.of(0, 1, 2, 0xff, 0, 8);
    const container = encodeContainer(MtpContainerType.Data, 0x1009, 7, payload);
    expect(decodeContainer(container).payload).toEqual(payload);
  });

  it("rejects declared-length mismatch, invalid types, and oversized containers", () => {
    const valid = encodeContainer(MtpContainerType.Response, 0x2001, 1);
    const badLength = valid.slice();
    new DataView(badLength.buffer).setUint32(0, 13, true);
    expect(() => decodeContainer(badLength)).toThrow(/declares 13/);

    const badType = valid.slice();
    new DataView(badType.buffer).setUint16(4, 9, true);
    expect(() => decodeContainer(badType)).toThrow(/unknown.*type/);
    expect(() => decodeContainer(valid, 11)).toThrow(/exceeds/);
  });

  it("enforces the five-parameter limit and four-byte response alignment", () => {
    expect(() => encodeContainerParameters([1, 2, 3, 4, 5, 6])).toThrow(/at most 5/);
    expect(() => decodeContainerParameters(Uint8Array.of(1, 2, 3))).toThrow(/divisible by four/);
    expect(() => decodeContainerParameters(new Uint8Array(24))).toThrow(/maximum is 5/);
  });

  it("reports truncated primitive reads with their byte offset", () => {
    try {
      new MtpDatasetReader(Uint8Array.of(1)).uint32();
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MtpCodecError);
      expect((error as MtpCodecError).offset).toBe(0);
    }
  });
});
