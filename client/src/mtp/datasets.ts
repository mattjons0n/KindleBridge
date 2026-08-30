import { MTP_ROOT_PARENT, MtpAssociationType, MtpObjectFormat } from "./constants";
import { MtpCodecError, MtpDatasetReader, MtpDatasetWriter } from "./codec";

export interface MtpDeviceInfo {
  readonly standardVersion: number;
  readonly vendorExtensionId: number;
  readonly vendorExtensionVersion: number;
  readonly vendorExtensionDescription: string;
  readonly functionalMode: number;
  readonly operationsSupported: readonly number[];
  readonly eventsSupported: readonly number[];
  readonly devicePropertiesSupported: readonly number[];
  readonly captureFormats: readonly number[];
  readonly imageFormats: readonly number[];
  readonly manufacturer: string;
  readonly model: string;
  readonly deviceVersion: string;
  readonly serialNumber: string;
}

export interface MtpStorageInfo {
  readonly storageType: number;
  readonly filesystemType: number;
  readonly accessCapability: number;
  readonly maxCapacity: bigint;
  readonly freeSpaceInBytes: bigint;
  readonly freeSpaceInImages: number;
  readonly storageDescription: string;
  readonly volumeLabel: string;
}

export interface MtpObjectInfo {
  readonly storageId: number;
  readonly objectFormat: number;
  readonly protectionStatus: number;
  readonly compressedSize: number;
  readonly thumbFormat: number;
  readonly thumbCompressedSize: number;
  readonly thumbPixelWidth: number;
  readonly thumbPixelHeight: number;
  readonly imagePixelWidth: number;
  readonly imagePixelHeight: number;
  readonly imageBitDepth: number;
  readonly parentHandle: number;
  readonly associationType: number;
  readonly associationDescription: number;
  readonly sequenceNumber: number;
  readonly filename: string;
  /** Raw PTP date/time text, normally YYYYMMDDThhmmss[.s][Z]. */
  readonly captureDate: string;
  /** Raw PTP date/time text, normally YYYYMMDDThhmmss[.s][Z]. */
  readonly modificationDate: string;
  readonly keywords: string;
}

export interface MtpStoredObjectInfo extends MtpObjectInfo {
  readonly handle: number;
}

export function decodeDeviceInfo(payload: ArrayBuffer | ArrayBufferView): MtpDeviceInfo {
  const reader = new MtpDatasetReader(payload);
  const result: MtpDeviceInfo = {
    standardVersion: reader.uint16(),
    vendorExtensionId: reader.uint32(),
    vendorExtensionVersion: reader.uint16(),
    vendorExtensionDescription: reader.string(),
    functionalMode: reader.uint16(),
    operationsSupported: reader.uint16Array(),
    eventsSupported: reader.uint16Array(),
    devicePropertiesSupported: reader.uint16Array(),
    captureFormats: reader.uint16Array(),
    imageFormats: reader.uint16Array(),
    manufacturer: reader.string(),
    model: reader.string(),
    deviceVersion: reader.string(),
    serialNumber: reader.string(),
  };
  reader.expectEnd("DeviceInfo dataset");
  return result;
}

export function encodeDeviceInfo(info: MtpDeviceInfo): Uint8Array {
  return new MtpDatasetWriter()
    .uint16(info.standardVersion)
    .uint32(info.vendorExtensionId)
    .uint16(info.vendorExtensionVersion)
    .string(info.vendorExtensionDescription)
    .uint16(info.functionalMode)
    .uint16Array(info.operationsSupported)
    .uint16Array(info.eventsSupported)
    .uint16Array(info.devicePropertiesSupported)
    .uint16Array(info.captureFormats)
    .uint16Array(info.imageFormats)
    .string(info.manufacturer)
    .string(info.model)
    .string(info.deviceVersion)
    .string(info.serialNumber)
    .finish();
}

export function decodeStorageIds(payload: ArrayBuffer | ArrayBufferView): number[] {
  const reader = new MtpDatasetReader(payload);
  const result = reader.uint32Array();
  reader.expectEnd("StorageIDs dataset");
  return result;
}

export function encodeStorageIds(storageIds: readonly number[]): Uint8Array {
  return new MtpDatasetWriter().uint32Array(storageIds).finish();
}

export function decodeStorageInfo(payload: ArrayBuffer | ArrayBufferView): MtpStorageInfo {
  const reader = new MtpDatasetReader(payload);
  const result: MtpStorageInfo = {
    storageType: reader.uint16(),
    filesystemType: reader.uint16(),
    accessCapability: reader.uint16(),
    maxCapacity: reader.uint64(),
    freeSpaceInBytes: reader.uint64(),
    freeSpaceInImages: reader.uint32(),
    storageDescription: reader.string(),
    volumeLabel: reader.string(),
  };
  reader.expectEnd("StorageInfo dataset");
  return result;
}

export function encodeStorageInfo(info: MtpStorageInfo): Uint8Array {
  return new MtpDatasetWriter()
    .uint16(info.storageType)
    .uint16(info.filesystemType)
    .uint16(info.accessCapability)
    .uint64(info.maxCapacity)
    .uint64(info.freeSpaceInBytes)
    .uint32(info.freeSpaceInImages)
    .string(info.storageDescription)
    .string(info.volumeLabel)
    .finish();
}

export function decodeObjectHandles(payload: ArrayBuffer | ArrayBufferView): number[] {
  const reader = new MtpDatasetReader(payload);
  const result = reader.uint32Array();
  reader.expectEnd("ObjectHandles dataset");
  return result;
}

export function encodeObjectHandles(handles: readonly number[]): Uint8Array {
  return new MtpDatasetWriter().uint32Array(handles).finish();
}

export function decodeObjectInfo(payload: ArrayBuffer | ArrayBufferView): MtpObjectInfo {
  const reader = new MtpDatasetReader(payload);
  const result: MtpObjectInfo = {
    storageId: reader.uint32(),
    objectFormat: reader.uint16(),
    protectionStatus: reader.uint16(),
    compressedSize: reader.uint32(),
    thumbFormat: reader.uint16(),
    thumbCompressedSize: reader.uint32(),
    thumbPixelWidth: reader.uint32(),
    thumbPixelHeight: reader.uint32(),
    imagePixelWidth: reader.uint32(),
    imagePixelHeight: reader.uint32(),
    imageBitDepth: reader.uint32(),
    parentHandle: reader.uint32(),
    associationType: reader.uint16(),
    associationDescription: reader.uint32(),
    sequenceNumber: reader.uint32(),
    filename: reader.string(),
    captureDate: reader.string(),
    modificationDate: reader.string(),
    keywords: reader.string(),
  };
  reader.expectEnd("ObjectInfo dataset");
  return result;
}

export function encodeObjectInfo(info: MtpObjectInfo): Uint8Array {
  return new MtpDatasetWriter()
    .uint32(info.storageId)
    .uint16(info.objectFormat)
    .uint16(info.protectionStatus)
    .uint32(info.compressedSize)
    .uint16(info.thumbFormat)
    .uint32(info.thumbCompressedSize)
    .uint32(info.thumbPixelWidth)
    .uint32(info.thumbPixelHeight)
    .uint32(info.imagePixelWidth)
    .uint32(info.imagePixelHeight)
    .uint32(info.imageBitDepth)
    .uint32(info.parentHandle)
    .uint16(info.associationType)
    .uint32(info.associationDescription)
    .uint32(info.sequenceNumber)
    .string(info.filename)
    .string(info.captureDate)
    .string(info.modificationDate)
    .string(info.keywords)
    .finish();
}

export interface UploadObjectInfoInput {
  readonly storageId: number;
  readonly parentHandle: number;
  readonly objectFormat?: number;
  readonly compressedSize: number;
  readonly filename: string;
  readonly captureDate?: string;
  readonly modificationDate?: string;
  readonly keywords?: string;
}

export function makeUploadObjectInfo(input: UploadObjectInfoInput): MtpObjectInfo {
  if (input.filename.length === 0) {
    throw new MtpCodecError("ObjectInfo filename cannot be empty");
  }
  return {
    storageId: input.storageId,
    objectFormat: input.objectFormat ?? MtpObjectFormat.Undefined,
    protectionStatus: 0,
    compressedSize: input.compressedSize,
    // A zero ThumbFormat denotes that no thumbnail is supplied. 0x3000 is an
    // undefined *object* format and would incorrectly claim a thumbnail exists.
    thumbFormat: 0,
    thumbCompressedSize: 0,
    thumbPixelWidth: 0,
    thumbPixelHeight: 0,
    imagePixelWidth: 0,
    imagePixelHeight: 0,
    imageBitDepth: 0,
    // GetObjectHandles/SendObjectInfo use 0xFFFFFFFF to name the storage root,
    // while ObjectInfo.ParentObject encodes a root object as zero.
    parentHandle: input.parentHandle === MTP_ROOT_PARENT ? 0 : input.parentHandle,
    associationType: MtpAssociationType.Undefined,
    associationDescription: 0,
    sequenceNumber: 0,
    filename: input.filename,
    captureDate: input.captureDate ?? "",
    modificationDate: input.modificationDate ?? "",
    keywords: input.keywords ?? "",
  };
}

export function formatMtpDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new MtpCodecError("cannot encode an invalid Date as an MTP timestamp");
  }
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const seconds = date.getUTCSeconds().toString().padStart(2, "0");
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}
