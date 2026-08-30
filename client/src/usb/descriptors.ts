import { UsbTransportError } from "./errors";
import type {
  UsbAlternateInterfaceLike,
  UsbConfigurationLike,
  UsbDeviceLike,
  UsbEndpointLike,
  UsbInterfaceLike,
} from "./types";

export const USB_CLASS_STILL_IMAGE = 0x06;
export const USB_SUBCLASS_STILL_IMAGE = 0x01;
export const USB_PROTOCOL_PTP = 0x01;
export const USB_CLASS_VENDOR_SPECIFIC = 0xff;
const AMAZON_KINDLE_USB_VENDOR_ID = 0x1949;

export interface UsbInterfaceSelection {
  configurationValue: number;
  interfaceNumber: number;
  alternateSetting: number;
  bulkInEndpoint: number;
  bulkOutEndpoint: number;
  interruptInEndpoint?: number;
  packetSize: {
    bulkIn: number;
    bulkOut: number;
  };
}

export interface EndpointDescriptorSnapshot {
  endpointNumber: number;
  direction: UsbEndpointLike["direction"];
  type: UsbEndpointLike["type"];
  packetSize: number;
}

export interface AlternateDescriptorSnapshot {
  alternateSetting: number;
  interfaceClass: number;
  interfaceSubclass: number;
  interfaceProtocol: number;
  interfaceName?: string;
  endpoints: EndpointDescriptorSnapshot[];
}

export interface InterfaceDescriptorSnapshot {
  interfaceNumber: number;
  claimed: boolean;
  selectedAlternateSetting: number;
  alternates: AlternateDescriptorSnapshot[];
}

export interface ConfigurationDescriptorSnapshot {
  configurationValue: number;
  configurationName?: string;
  active: boolean;
  interfaces: InterfaceDescriptorSnapshot[];
}

export interface UsbDescriptorSnapshot {
  vendorId: number;
  productId: number;
  manufacturerName?: string;
  productName?: string;
  maskedSerialNumber?: string;
  deviceClass?: number;
  deviceSubclass?: number;
  deviceProtocol?: number;
  configurations: ConfigurationDescriptorSnapshot[];
}

interface Candidate extends UsbInterfaceSelection {
  score: number;
}

function alternateEndpoints(alternate: UsbAlternateInterfaceLike): {
  bulkIn?: UsbEndpointLike;
  bulkOut?: UsbEndpointLike;
  interruptIn?: UsbEndpointLike;
} {
  const bulkIn = alternate.endpoints.filter(
    (endpoint) => endpoint.type === "bulk" && endpoint.direction === "in",
  );
  const bulkOut = alternate.endpoints.filter(
    (endpoint) => endpoint.type === "bulk" && endpoint.direction === "out",
  );
  const interruptIn = alternate.endpoints.filter(
    (endpoint) =>
      endpoint.type === "interrupt" && endpoint.direction === "in",
  );
  return {
    // Endpoint order carries no MTP meaning. Refuse to guess if a descriptor
    // exposes more than one endpoint for either bulk direction.
    bulkIn: bulkIn.length === 1 ? bulkIn[0] : undefined,
    bulkOut: bulkOut.length === 1 ? bulkOut[0] : undefined,
    interruptIn: interruptIn.length === 1 ? interruptIn[0] : undefined,
  };
}

function isImagingAlternate(alternate: UsbAlternateInterfaceLike): boolean {
  return (
    alternate.interfaceClass === USB_CLASS_STILL_IMAGE &&
    alternate.interfaceSubclass === USB_SUBCLASS_STILL_IMAGE
  );
}

function hasExplicitMtpName(alternate: UsbAlternateInterfaceLike): boolean {
  return /\bmtp\b/iu.test(alternate.interfaceName?.trim() ?? "");
}

/**
 * Recent Kindles expose their MTP function as a vendor-specific interface
 * (class/subclass 0xff) whose USB string descriptor is exactly MTP. The name is
 * required for this fallback so an unrelated vendor/debug interface with bulk
 * endpoints is never guessed to be MTP.
 */
function isVendorNamedMtpAlternate(alternate: UsbAlternateInterfaceLike): boolean {
  return alternate.interfaceClass === USB_CLASS_VENDOR_SPECIFIC
    && hasExplicitMtpName(alternate);
}

function isCurrentKindleVendorMtpAlternate(
  alternate: UsbAlternateInterfaceLike,
  vendorId: number,
): boolean {
  if (
    vendorId !== AMAZON_KINDLE_USB_VENDOR_ID
    || alternate.interfaceClass !== USB_CLASS_VENDOR_SPECIFIC
    || alternate.interfaceSubclass !== USB_CLASS_VENDOR_SPECIFIC
    || alternate.interfaceProtocol !== 0
  ) return false;

  const { bulkIn, bulkOut, interruptIn } = alternateEndpoints(alternate);
  return Boolean(bulkIn && bulkOut && interruptIn);
}

function isMtpCandidate(
  alternate: UsbAlternateInterfaceLike,
  vendorId: number,
): boolean {
  return isImagingAlternate(alternate)
    || isVendorNamedMtpAlternate(alternate)
    || isCurrentKindleVendorMtpAlternate(alternate, vendorId);
}

function scoreAlternate(alternate: UsbAlternateInterfaceLike): number {
  let score = 0;
  if (hasExplicitMtpName(alternate)) score += 8;
  if (alternate.interfaceProtocol === USB_PROTOCOL_PTP) score += 4;
  if (/\bptp\b/iu.test(alternate.interfaceName ?? "")) score += 2;
  if (
    alternate.endpoints.some(
      (endpoint) =>
        endpoint.type === "interrupt" && endpoint.direction === "in",
    )
  ) {
    score += 1;
  }
  return score;
}

function candidatesForConfiguration(
  configuration: UsbConfigurationLike,
  vendorId: number,
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const usbInterface of configuration.interfaces) {
    for (const alternate of usbInterface.alternates) {
      if (!isMtpCandidate(alternate, vendorId)) continue;

      const { bulkIn, bulkOut, interruptIn } = alternateEndpoints(alternate);
      if (!bulkIn || !bulkOut) continue;

      candidates.push({
        configurationValue: configuration.configurationValue,
        interfaceNumber: usbInterface.interfaceNumber,
        alternateSetting: alternate.alternateSetting,
        bulkInEndpoint: bulkIn.endpointNumber,
        bulkOutEndpoint: bulkOut.endpointNumber,
        interruptInEndpoint: interruptIn?.endpointNumber,
        packetSize: {
          bulkIn: bulkIn.packetSize,
          bulkOut: bulkOut.packetSize,
        },
        score: scoreAlternate(alternate),
      });
    }
  }

  return candidates;
}

/** Selects the MTP/PTP alternate from descriptors instead of positional guesses. */
export function selectMtpInterface(device: UsbDeviceLike): UsbInterfaceSelection {
  const candidates = device.configurations.flatMap((configuration) =>
    candidatesForConfiguration(configuration, device.vendorId));

  if (candidates.length === 0) {
    const interfaces = device.configurations.flatMap((configuration) =>
      configuration.interfaces.flatMap((usbInterface) =>
        usbInterface.alternates.map((alternate) => ({
          configurationValue: configuration.configurationValue,
          interfaceNumber: usbInterface.interfaceNumber,
          alternateSetting: alternate.alternateSetting,
          class: alternate.interfaceClass,
          subclass: alternate.interfaceSubclass,
          protocol: alternate.interfaceProtocol,
          name: alternate.interfaceName ?? "",
          endpoints: alternate.endpoints.map((endpoint) =>
            `${endpoint.type}:${endpoint.direction}:${endpoint.endpointNumber}:${endpoint.packetSize}`),
        }))));
    throw new UsbTransportError(
      "USB_MTP_INTERFACE_NOT_FOUND",
      "No MTP/PTP interface with both bulk IN and bulk OUT endpoints was found.",
      { vendorId: device.vendorId, productId: device.productId, interfaces },
    );
  }

  const highestScore = Math.max(...candidates.map(({ score }) => score));
  const best = candidates.filter(({ score }) => score === highestScore);
  if (best.length !== 1) {
    throw new UsbTransportError(
      "USB_MTP_INTERFACE_AMBIGUOUS",
      "More than one equally plausible MTP interface was found.",
      {
        candidates: best.map(({ score: _score, ...candidate }) => candidate),
      },
    );
  }

  const { score: _score, ...selection } = best[0];
  return selection;
}

export function maskSerialNumber(serialNumber?: string): string | undefined {
  if (!serialNumber) return undefined;
  if (serialNumber.length <= 4) return "*".repeat(serialNumber.length);
  return `${"*".repeat(Math.min(8, serialNumber.length - 4))}${serialNumber.slice(-4)}`;
}

function snapshotAlternate(
  alternate: UsbAlternateInterfaceLike,
): AlternateDescriptorSnapshot {
  return {
    alternateSetting: alternate.alternateSetting,
    interfaceClass: alternate.interfaceClass,
    interfaceSubclass: alternate.interfaceSubclass,
    interfaceProtocol: alternate.interfaceProtocol,
    ...(alternate.interfaceName
      ? { interfaceName: alternate.interfaceName }
      : {}),
    endpoints: alternate.endpoints.map((endpoint) => ({
      endpointNumber: endpoint.endpointNumber,
      direction: endpoint.direction,
      type: endpoint.type,
      packetSize: endpoint.packetSize,
    })),
  };
}

function snapshotInterface(
  usbInterface: UsbInterfaceLike,
): InterfaceDescriptorSnapshot {
  return {
    interfaceNumber: usbInterface.interfaceNumber,
    claimed: usbInterface.claimed ?? false,
    selectedAlternateSetting: usbInterface.alternate.alternateSetting,
    alternates: usbInterface.alternates.map(snapshotAlternate),
  };
}

function snapshotConfiguration(
  configuration: UsbConfigurationLike,
  activeConfigurationValue?: number,
): ConfigurationDescriptorSnapshot {
  return {
    configurationValue: configuration.configurationValue,
    ...(configuration.configurationName
      ? { configurationName: configuration.configurationName }
      : {}),
    active: configuration.configurationValue === activeConfigurationValue,
    interfaces: configuration.interfaces.map(snapshotInterface),
  };
}

export function captureDescriptorSnapshot(
  device: UsbDeviceLike,
): UsbDescriptorSnapshot {
  return {
    vendorId: device.vendorId,
    productId: device.productId,
    ...(device.manufacturerName
      ? { manufacturerName: device.manufacturerName }
      : {}),
    ...(device.productName ? { productName: device.productName } : {}),
    ...(device.serialNumber
      ? { maskedSerialNumber: maskSerialNumber(device.serialNumber) }
      : {}),
    ...(device.deviceClass === undefined
      ? {}
      : { deviceClass: device.deviceClass }),
    ...(device.deviceSubclass === undefined
      ? {}
      : { deviceSubclass: device.deviceSubclass }),
    ...(device.deviceProtocol === undefined
      ? {}
      : { deviceProtocol: device.deviceProtocol }),
    configurations: device.configurations.map((configuration) =>
      snapshotConfiguration(
        configuration,
        device.configuration?.configurationValue,
      ),
    ),
  };
}
