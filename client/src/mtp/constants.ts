/** The fixed header size of a USB MTP bulk container. */
export const MTP_CONTAINER_HEADER_SIZE = 12;

/** PTP/MTP operation and response containers carry at most five parameters. */
export const MTP_MAX_CONTAINER_PARAMETERS = 5;

/** A response is its fixed header plus at most five 32-bit parameters. */
export const MTP_MAX_RESPONSE_CONTAINER_BYTES = MTP_CONTAINER_HEADER_SIZE
  + MTP_MAX_CONTAINER_PARAMETERS * 4;

/** Sentinels defined by PTP for operations that address all stores or formats. */
export const MTP_ALL_STORAGE_IDS = 0xffff_ffff;
export const MTP_ALL_OBJECT_FORMATS = 0x0000;
export const MTP_ALL_ASSOCIATIONS = 0x0000_0000;
export const MTP_ROOT_PARENT = 0xffff_ffff;

export enum MtpContainerType {
  Command = 0x0001,
  Data = 0x0002,
  Response = 0x0003,
  Event = 0x0004,
}

export enum MtpOperationCode {
  GetDeviceInfo = 0x1001,
  OpenSession = 0x1002,
  CloseSession = 0x1003,
  GetStorageIDs = 0x1004,
  GetStorageInfo = 0x1005,
  GetNumObjects = 0x1006,
  GetObjectHandles = 0x1007,
  GetObjectInfo = 0x1008,
  GetObject = 0x1009,
  GetThumb = 0x100a,
  DeleteObject = 0x100b,
  SendObjectInfo = 0x100c,
  SendObject = 0x100d,
}

export enum MtpResponseCode {
  Undefined = 0x2000,
  OK = 0x2001,
  GeneralError = 0x2002,
  SessionNotOpen = 0x2003,
  InvalidTransactionID = 0x2004,
  OperationNotSupported = 0x2005,
  ParameterNotSupported = 0x2006,
  IncompleteTransfer = 0x2007,
  InvalidStorageID = 0x2008,
  InvalidObjectHandle = 0x2009,
  DevicePropNotSupported = 0x200a,
  InvalidObjectFormatCode = 0x200b,
  StoreFull = 0x200c,
  ObjectWriteProtected = 0x200d,
  StoreReadOnly = 0x200e,
  AccessDenied = 0x200f,
  NoThumbnailPresent = 0x2010,
  SelfTestFailed = 0x2011,
  PartialDeletion = 0x2012,
  StoreNotAvailable = 0x2013,
  SpecificationByFormatUnsupported = 0x2014,
  NoValidObjectInfo = 0x2015,
  InvalidCodeFormat = 0x2016,
  UnknownVendorCode = 0x2017,
  CaptureAlreadyTerminated = 0x2018,
  DeviceBusy = 0x2019,
  InvalidParentObject = 0x201a,
  InvalidDevicePropFormat = 0x201b,
  InvalidDevicePropValue = 0x201c,
  InvalidParameter = 0x201d,
  SessionAlreadyOpen = 0x201e,
  TransactionCanceled = 0x201f,
  SpecificationOfDestinationUnsupported = 0x2020,
}

export enum MtpObjectFormat {
  Undefined = 0x3000,
  Association = 0x3001,
  Script = 0x3002,
  Executable = 0x3003,
  Text = 0x3004,
  HTML = 0x3005,
  DPOF = 0x3006,
  AIFF = 0x3007,
  WAV = 0x3008,
  MP3 = 0x3009,
  AVI = 0x300a,
  MPEG = 0x300b,
  ASF = 0x300c,
  EXIF_JPEG = 0x3801,
  TIFF_EP = 0x3802,
  BMP = 0x3804,
  GIF = 0x3807,
  JFIF = 0x3808,
  PNG = 0x380b,
  TIFF = 0x380d,
}

export enum MtpAssociationType {
  Undefined = 0x0000,
  GenericFolder = 0x0001,
  Album = 0x0002,
  TimeSequence = 0x0003,
  HorizontalPanoramic = 0x0004,
  VerticalPanoramic = 0x0005,
  TwoDimensionalPanoramic = 0x0006,
  AncillaryData = 0x0007,
}

export enum MtpStorageType {
  Undefined = 0x0000,
  FixedROM = 0x0001,
  RemovableROM = 0x0002,
  FixedRAM = 0x0003,
  RemovableRAM = 0x0004,
}

export enum MtpFilesystemType {
  Undefined = 0x0000,
  GenericFlat = 0x0001,
  GenericHierarchical = 0x0002,
  DCF = 0x0003,
}

export enum MtpStorageAccessCapability {
  ReadWrite = 0x0000,
  ReadOnlyWithoutObjectDeletion = 0x0001,
  ReadOnlyWithObjectDeletion = 0x0002,
}

export function formatMtpCode(code: number): string {
  return `0x${code.toString(16).padStart(4, "0")}`;
}
