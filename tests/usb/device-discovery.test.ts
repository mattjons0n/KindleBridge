import { describe, expect, it } from "vitest";
import {
  AMAZON_USB_VENDOR_ID,
  requestKindleDevice,
} from "../../client/src/usb/device-discovery";
import { FakeUsbDevice, FakeUsbManager } from "./fakes";

describe("Kindle WebUSB discovery", () => {
  it("uses the Amazon vendor filter and optional confirmed product IDs", async () => {
    const usb = new FakeUsbManager();
    usb.requestResult = new FakeUsbDevice();

    await requestKindleDevice({ usb, productIds: [0x9981] });

    expect(usb.requestedOptions?.filters).toEqual([
      { vendorId: AMAZON_USB_VENDOR_ID, productId: 0x9981 },
    ]);
  });

  it("allows an unfiltered chooser only when broad discovery is explicit", async () => {
    const usb = new FakeUsbManager();
    usb.requestResult = new FakeUsbDevice();

    await requestKindleDevice({ usb, broadDiscovery: true });

    expect(usb.requestedOptions?.filters).toEqual([]);
  });

  it("turns chooser cancellation into a stable error code", async () => {
    const usb = new FakeUsbManager();
    usb.requestError = new DOMException("cancelled", "NotFoundError");

    await expect(requestKindleDevice({ usb })).rejects.toMatchObject({
      code: "USB_PERMISSION_CANCELLED",
    });
  });

  it("rejects a non-Amazon device even if a fake chooser returns one", async () => {
    const usb = new FakeUsbManager();
    const device = new FakeUsbDevice();
    Object.defineProperty(device, "vendorId", { value: 0x1234 });
    usb.requestResult = device;

    await expect(requestKindleDevice({ usb })).rejects.toMatchObject({
      code: "USB_WRONG_DEVICE",
      details: {
        expectedVendorId: AMAZON_USB_VENDOR_ID,
        actualVendorId: 0x1234,
      },
    });
  });
});
