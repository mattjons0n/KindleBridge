import { describe, expect, it } from "vitest";
import { MtpDatasetWriter } from "../../client/src/mtp/codec";
import {
  decodeDeviceInfo,
  decodeObjectHandles,
  decodeObjectInfo,
  decodeStorageIds,
  decodeStorageInfo,
  encodeDeviceInfo,
  encodeObjectHandles,
  encodeObjectInfo,
  encodeStorageIds,
  encodeStorageInfo,
  formatMtpDateTime,
  makeUploadObjectInfo,
} from "../../client/src/mtp/datasets";
import {
  MtpAssociationType,
  MtpFilesystemType,
  MtpObjectFormat,
  MtpOperationCode,
  MtpStorageAccessCapability,
  MtpStorageType,
} from "../../client/src/mtp/constants";

describe("MTP datasets", () => {
  it("round-trips a complete DeviceInfo dataset", () => {
    const fixture = {
      standardVersion: 100,
      vendorExtensionId: 6,
      vendorExtensionVersion: 100,
      vendorExtensionDescription: "microsoft.com: 1.0;",
      functionalMode: 0,
      operationsSupported: [MtpOperationCode.GetDeviceInfo, MtpOperationCode.OpenSession],
      eventsSupported: [0x4002],
      devicePropertiesSupported: [0x5001],
      captureFormats: [],
      imageFormats: [MtpObjectFormat.Text, MtpObjectFormat.EXIF_JPEG],
      manufacturer: "Amazon",
      model: "Kindle fixture",
      deviceVersion: "5.0",
      serialNumber: "SERIAL",
    } as const;
    expect(decodeDeviceInfo(encodeDeviceInfo(fixture))).toEqual(fixture);
  });

  it("round-trips 32-bit StorageIDs and ObjectHandles arrays", () => {
    const values = [0, 1, 0x1234_5678, 0xffff_ffff];
    expect(decodeStorageIds(encodeStorageIds(values))).toEqual(values);
    expect(decodeObjectHandles(encodeObjectHandles(values))).toEqual(values);
  });

  it("round-trips 64-bit storage capacity without precision loss", () => {
    const fixture = {
      storageType: MtpStorageType.FixedRAM,
      filesystemType: MtpFilesystemType.GenericHierarchical,
      accessCapability: MtpStorageAccessCapability.ReadWrite,
      maxCapacity: 0xfedc_ba98_7654_3210n,
      freeSpaceInBytes: 0x0123_4567_89ab_cdefn,
      freeSpaceInImages: 0xffff_ffff,
      storageDescription: "Internal storage",
      volumeLabel: "Kindle",
    } as const;
    expect(decodeStorageInfo(encodeStorageInfo(fixture))).toEqual(fixture);
  });

  it("encodes ObjectInfo fields at the protocol-defined offsets", () => {
    const fixture = makeUploadObjectInfo({
      storageId: 0x0001_0001,
      parentHandle: 0x1020_3040,
      objectFormat: MtpObjectFormat.Text,
      compressedSize: 0x5566_7788,
      filename: "poc.txt",
      captureDate: "20260826T120102Z",
      modificationDate: "20260826T130203Z",
      keywords: "test",
    });
    const bytes = encodeObjectInfo(fixture);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x0001_0001);
    expect(view.getUint16(4, true)).toBe(MtpObjectFormat.Text);
    expect(view.getUint32(8, true)).toBe(0x5566_7788);
    expect(view.getUint32(38, true)).toBe(0x1020_3040);
    expect(view.getUint16(42, true)).toBe(MtpAssociationType.Undefined);
    expect(bytes[52]).toBe(8); // seven filename code units plus terminator
    expect(decodeObjectInfo(bytes)).toEqual(fixture);
  });

  it("rejects trailing bytes in every strict dataset decoder", () => {
    const storageIds = encodeStorageIds([1]);
    const withJunk = new Uint8Array(storageIds.byteLength + 1);
    withJunk.set(storageIds);
    expect(() => decodeStorageIds(withJunk)).toThrow(/trailing/);

    const minimalObjectInfo = new MtpDatasetWriter()
      .bytes(new Uint8Array(52))
      .string("")
      .string("")
      .string("")
      .string("")
      .uint8(1)
      .finish();
    expect(() => decodeObjectInfo(minimalObjectInfo)).toThrow(/trailing/);
  });

  it("formats MTP timestamps deterministically in UTC", () => {
    expect(formatMtpDateTime(new Date("2026-08-26T01:02:03.999Z")))
      .toBe("20260826T010203Z");
    expect(() => formatMtpDateTime(new Date(Number.NaN))).toThrow(/invalid Date/);
  });
});
