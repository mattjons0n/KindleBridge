import { describe, expect, it } from "vitest";
import {
  captureDescriptorSnapshot,
  maskSerialNumber,
  selectMtpInterface,
} from "../../client/src/usb/descriptors";
import { UsbTransportError } from "../../client/src/usb/errors";
import { FakeUsbDevice, mtpAlternate, mtpConfiguration } from "./fakes";

describe("USB descriptor selection", () => {
  it("derives configuration, interface, alternate, and endpoints by descriptor", () => {
    const device = new FakeUsbDevice([mtpConfiguration(7)]);

    expect(selectMtpInterface(device)).toEqual({
      configurationValue: 7,
      interfaceNumber: 4,
      alternateSetting: 2,
      bulkInEndpoint: 5,
      bulkOutEndpoint: 6,
      interruptInEndpoint: 7,
      packetSize: { bulkIn: 512, bulkOut: 512 },
    });
  });

  it("recognizes the vendor-specific MTP interface used by current Kindles", () => {
    const vendorMtp = {
      alternateSetting: 0,
      interfaceClass: 0xff,
      interfaceSubclass: 0xff,
      interfaceProtocol: 0,
      interfaceName: "MTP",
      endpoints: [
        { endpointNumber: 1, direction: "in" as const, type: "bulk" as const, packetSize: 512 },
        { endpointNumber: 2, direction: "out" as const, type: "bulk" as const, packetSize: 512 },
        { endpointNumber: 3, direction: "in" as const, type: "interrupt" as const, packetSize: 64 },
      ],
    };
    const device = new FakeUsbDevice([{
      configurationValue: 1,
      interfaces: [{ interfaceNumber: 0, alternate: vendorMtp, alternates: [vendorMtp] }],
    }]);

    expect(selectMtpInterface(device)).toEqual({
      configurationValue: 1,
      interfaceNumber: 0,
      alternateSetting: 0,
      bulkInEndpoint: 1,
      bulkOutEndpoint: 2,
      interruptInEndpoint: 3,
      packetSize: { bulkIn: 512, bulkOut: 512 },
    });
  });

  it("recognizes the current Kindle endpoint shape when Chrome omits the MTP name", () => {
    const vendorMtp = {
      alternateSetting: 0,
      interfaceClass: 0xff,
      interfaceSubclass: 0xff,
      interfaceProtocol: 0,
      endpoints: [
        { endpointNumber: 1, direction: "in" as const, type: "bulk" as const, packetSize: 512 },
        { endpointNumber: 2, direction: "out" as const, type: "bulk" as const, packetSize: 512 },
        { endpointNumber: 3, direction: "in" as const, type: "interrupt" as const, packetSize: 64 },
      ],
    };
    const device = new FakeUsbDevice([{
      configurationValue: 1,
      interfaces: [{ interfaceNumber: 0, alternate: vendorMtp, alternates: [vendorMtp] }],
    }]);

    expect(selectMtpInterface(device)).toMatchObject({
      configurationValue: 1,
      interfaceNumber: 0,
      bulkInEndpoint: 1,
      bulkOutEndpoint: 2,
      interruptInEndpoint: 3,
    });

    Object.defineProperty(device, "vendorId", { value: 0x1234 });
    expect(() => selectMtpInterface(device)).toThrowError(
      expect.objectContaining({ code: "USB_MTP_INTERFACE_NOT_FOUND" }),
    );
  });

  it("does not treat unnamed vendor bulk interfaces as MTP", () => {
    const vendorDebug = {
      alternateSetting: 0,
      interfaceClass: 0xff,
      interfaceSubclass: 0xff,
      interfaceProtocol: 0,
      interfaceName: "Vendor Debug",
      endpoints: [
        { endpointNumber: 1, direction: "in" as const, type: "bulk" as const, packetSize: 512 },
        { endpointNumber: 2, direction: "out" as const, type: "bulk" as const, packetSize: 512 },
      ],
    };
    const device = new FakeUsbDevice([{
      configurationValue: 1,
      interfaces: [{ interfaceNumber: 0, alternate: vendorDebug, alternates: [vendorDebug] }],
    }]);

    expect(() => selectMtpInterface(device)).toThrowError(
      expect.objectContaining({ code: "USB_MTP_INTERFACE_NOT_FOUND" }),
    );
  });

  it("rejects equally plausible interfaces rather than guessing", () => {
    const base = mtpConfiguration();
    const duplicate = mtpAlternate({ alternateSetting: 3 });
    const config = {
      ...base,
      interfaces: [
        ...base.interfaces,
        {
          interfaceNumber: 8,
          alternate: duplicate,
          alternates: [duplicate],
        },
      ],
    };
    const device = new FakeUsbDevice([config]);

    expect(() => selectMtpInterface(device)).toThrowError(
      expect.objectContaining<Partial<UsbTransportError>>({
        code: "USB_MTP_INTERFACE_AMBIGUOUS",
      }),
    );
  });

  it("captures all descriptors but masks the serial number", () => {
    const device = new FakeUsbDevice();
    const snapshot = captureDescriptorSnapshot(device);

    expect(snapshot.maskedSerialNumber).toBe("********1234");
    expect(JSON.stringify(snapshot)).not.toContain(device.serialNumber);
    expect(snapshot.configurations[0]?.interfaces).toHaveLength(2);
  });

  it("masks even very short serial values", () => {
    expect(maskSerialNumber("1234")).toBe("****");
  });

  it("classifies charging/vendor-only descriptors as lacking MTP", () => {
    const device = new FakeUsbDevice([
      {
        configurationValue: 3,
        interfaces: [
          {
            interfaceNumber: 0,
            alternate: {
              alternateSetting: 0,
              interfaceClass: 0xff,
              interfaceSubclass: 0,
              interfaceProtocol: 0,
              endpoints: [],
            },
            alternates: [],
          },
        ],
      },
    ]);

    expect(() => selectMtpInterface(device)).toThrowError(
      expect.objectContaining({ code: "USB_MTP_INTERFACE_NOT_FOUND" }),
    );
  });

  it("does not guess when an imaging alternate has multiple bulk IN endpoints", () => {
    const alternate = mtpAlternate({
      endpoints: [
        ...mtpAlternate().endpoints,
        {
          endpointNumber: 9,
          direction: "in",
          type: "bulk",
          packetSize: 512,
        },
      ],
    });
    const device = new FakeUsbDevice([
      {
        configurationValue: 2,
        interfaces: [
          {
            interfaceNumber: 3,
            alternate,
            alternates: [alternate],
          },
        ],
      },
    ]);

    expect(() => selectMtpInterface(device)).toThrowError(
      expect.objectContaining({ code: "USB_MTP_INTERFACE_NOT_FOUND" }),
    );
  });
});
