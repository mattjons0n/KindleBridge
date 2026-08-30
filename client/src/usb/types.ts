export type UsbTransferStatus = "ok" | "stall" | "babble";

export type UsbDirection = "in" | "out";

export interface UsbEndpointLike {
  endpointNumber: number;
  direction: UsbDirection;
  type: "bulk" | "interrupt" | "isochronous";
  packetSize: number;
}

export interface UsbAlternateInterfaceLike {
  alternateSetting: number;
  interfaceClass: number;
  interfaceSubclass: number;
  interfaceProtocol: number;
  interfaceName?: string;
  endpoints: readonly UsbEndpointLike[];
}

export interface UsbInterfaceLike {
  interfaceNumber: number;
  alternate: UsbAlternateInterfaceLike;
  alternates: readonly UsbAlternateInterfaceLike[];
  claimed?: boolean;
}

export interface UsbConfigurationLike {
  configurationValue: number;
  configurationName?: string;
  interfaces: readonly UsbInterfaceLike[];
}

export interface UsbInTransferResultLike {
  data?: DataView;
  status: UsbTransferStatus;
}

export interface UsbOutTransferResultLike {
  bytesWritten?: number;
  status: UsbTransferStatus;
}

export interface UsbDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly manufacturerName?: string;
  readonly productName?: string;
  readonly serialNumber?: string;
  readonly deviceClass?: number;
  readonly deviceSubclass?: number;
  readonly deviceProtocol?: number;
  readonly usbVersionMajor?: number;
  readonly usbVersionMinor?: number;
  readonly usbVersionSubminor?: number;
  readonly deviceVersionMajor?: number;
  readonly deviceVersionMinor?: number;
  readonly deviceVersionSubminor?: number;
  readonly configurations: readonly UsbConfigurationLike[];
  readonly configuration?: UsbConfigurationLike;
  readonly opened: boolean;

  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  selectAlternateInterface(
    interfaceNumber: number,
    alternateSetting: number,
  ): Promise<void>;
  transferIn(
    endpointNumber: number,
    length: number,
  ): Promise<UsbInTransferResultLike>;
  transferOut(
    endpointNumber: number,
    data: BufferSource,
  ): Promise<UsbOutTransferResultLike>;
  clearHalt(direction: UsbDirection, endpointNumber: number): Promise<void>;
}

export interface UsbDeviceFilterLike {
  vendorId?: number;
  productId?: number;
  classCode?: number;
  subclassCode?: number;
  protocolCode?: number;
  serialNumber?: string;
}

export interface UsbRequestDeviceOptionsLike {
  filters: readonly UsbDeviceFilterLike[];
  exclusionFilters?: readonly UsbDeviceFilterLike[];
}

export interface UsbConnectionEventLike extends Event {
  readonly device: UsbDeviceLike;
}

export interface UsbManagerLike {
  requestDevice(options: UsbRequestDeviceOptionsLike): Promise<UsbDeviceLike>;
  getDevices(): Promise<UsbDeviceLike[]>;
  addEventListener(
    type: "connect" | "disconnect",
    listener: (event: UsbConnectionEventLike) => void,
  ): void;
  removeEventListener(
    type: "connect" | "disconnect",
    listener: (event: UsbConnectionEventLike) => void,
  ): void;
}

export interface MtpTransportIoOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface UsbBulkOutPhase {
  length: number;
  chunks: AsyncIterable<Uint8Array>;
  onProgress?: (bytesWritten: number, totalBytes: number) => void;
}

export interface UsbBulkInChunk {
  data: Uint8Array;
  /** True when this transfer consumed a short packet (a ZLP has zero bytes). */
  phaseEnded: boolean;
}

/**
 * Structural counterpart of MtpBulkTransport. Keeping this contract in the USB
 * layer prevents the packet/session code from depending on browser globals.
 */
export interface UsbBulkTransport {
  writePhase(
    phase: UsbBulkOutPhase,
    options?: MtpTransportIoOptions,
  ): Promise<{ bytesWritten: number }>;
  /** Convenience wrapper that sends `data` as one complete USB phase. */
  write(
    data: Uint8Array,
    options?: MtpTransportIoOptions & {
      onProgress?: (bytesWritten: number, totalBytes: number) => void;
    },
  ): Promise<{ bytesWritten: number }>;
  read(options?: MtpTransportIoOptions): Promise<UsbBulkInChunk>;
  clearHalt(
    direction: UsbDirection,
    options?: MtpTransportIoOptions,
  ): Promise<void>;
  close(): Promise<void>;
}

export function getUsbManager(
  source?: Navigator,
): UsbManagerLike | undefined {
  const activeNavigator =
    source ?? (typeof navigator === "undefined" ? undefined : navigator);
  return (activeNavigator as (Navigator & { usb?: UsbManagerLike }) | undefined)
    ?.usb;
}
