import { captureDescriptorSnapshot } from "./descriptors";
import {
  describeUnknownError,
  isAbortError,
  UsbTransportError,
} from "./errors";
import {
  getUsbManager,
  type UsbDeviceFilterLike,
  type UsbDeviceLike,
  type UsbManagerLike,
} from "./types";

export const AMAZON_USB_VENDOR_ID = 0x1949;

export interface RequestKindleOptions {
  /** Use only while recording an unknown device's descriptors. */
  broadDiscovery?: boolean;
  productIds?: readonly number[];
  usb?: UsbManagerLike;
}

function filtersForOptions(
  options: RequestKindleOptions,
): UsbDeviceFilterLike[] {
  if (options.broadDiscovery) return [];
  if (!options.productIds?.length) {
    return [{ vendorId: AMAZON_USB_VENDOR_ID }];
  }
  return options.productIds.map((productId) => ({
    vendorId: AMAZON_USB_VENDOR_ID,
    productId,
  }));
}

function classifyRequestFailure(error: unknown): UsbTransportError {
  if (
    isAbortError(error) ||
    (error instanceof DOMException && error.name === "NotFoundError")
  ) {
    return new UsbTransportError(
      "USB_PERMISSION_CANCELLED",
      "No USB device was selected.",
      {},
      { cause: error },
    );
  }
  return new UsbTransportError(
    "USB_DEVICE_NOT_FOUND",
    `The USB device chooser failed: ${describeUnknownError(error)}`,
    {},
    { cause: error },
  );
}

/** Must be called synchronously from the user's Connect-button handler. */
export async function requestKindleDevice(
  options: RequestKindleOptions = {},
): Promise<UsbDeviceLike> {
  const usb = options.usb ?? getUsbManager();
  if (!usb) {
    throw new UsbTransportError(
      "USB_NOT_SUPPORTED",
      "WebUSB is unavailable. Use a current Chromium browser in a secure context.",
    );
  }

  let device: UsbDeviceLike;
  try {
    device = await usb.requestDevice({ filters: filtersForOptions(options) });
  } catch (error) {
    throw classifyRequestFailure(error);
  }

  if (!options.broadDiscovery && device.vendorId !== AMAZON_USB_VENDOR_ID) {
    throw new UsbTransportError(
      "USB_WRONG_DEVICE",
      "The selected USB device is not an Amazon device.",
      {
        expectedVendorId: AMAZON_USB_VENDOR_ID,
        actualVendorId: device.vendorId,
        productId: device.productId,
      },
    );
  }

  if (
    options.productIds?.length &&
    !options.productIds.includes(device.productId)
  ) {
    throw new UsbTransportError(
      "USB_WRONG_DEVICE",
      "The selected Amazon device does not have an approved product ID.",
      {
        expectedProductIds: [...options.productIds],
        actualProductId: device.productId,
      },
    );
  }

  return device;
}

export async function getPermittedKindles(
  usb: UsbManagerLike | undefined = getUsbManager(),
): Promise<UsbDeviceLike[]> {
  if (!usb) return [];
  const devices = await usb.getDevices();
  return devices.filter((device) => device.vendorId === AMAZON_USB_VENDOR_ID);
}

export async function inspectUsbDevice(device: UsbDeviceLike) {
  // Configuration/interface descriptors are populated when WebUSB creates the
  // USBDevice. Inspection itself therefore does not take device ownership.
  return captureDescriptorSnapshot(device);
}
