import type {
  UsbAlternateInterfaceLike,
  UsbConfigurationLike,
  UsbConnectionEventLike,
  UsbDeviceLike,
  UsbInTransferResultLike,
  UsbManagerLike,
  UsbOutTransferResultLike,
  UsbRequestDeviceOptionsLike,
} from "../../client/src/usb/types";

export function mtpAlternate(
  overrides: Partial<UsbAlternateInterfaceLike> = {},
): UsbAlternateInterfaceLike {
  return {
    alternateSetting: 2,
    interfaceClass: 0x06,
    interfaceSubclass: 0x01,
    interfaceProtocol: 0x01,
    interfaceName: "MTP",
    endpoints: [
      { endpointNumber: 6, direction: "out", type: "bulk", packetSize: 512 },
      { endpointNumber: 5, direction: "in", type: "bulk", packetSize: 512 },
      {
        endpointNumber: 7,
        direction: "in",
        type: "interrupt",
        packetSize: 32,
      },
    ],
    ...overrides,
  };
}

export function mtpConfiguration(
  configurationValue = 7,
): UsbConfigurationLike {
  const inactive = mtpAlternate({
    alternateSetting: 0,
    endpoints: [],
  });
  const active = mtpAlternate();
  return {
    configurationValue,
    configurationName: "Kindle file transfer",
    interfaces: [
      {
        interfaceNumber: 1,
        alternate: {
          alternateSetting: 0,
          interfaceClass: 0xff,
          interfaceSubclass: 0,
          interfaceProtocol: 0,
          endpoints: [
            {
              endpointNumber: 1,
              direction: "in",
              type: "bulk",
              packetSize: 64,
            },
          ],
        },
        alternates: [],
      },
      {
        interfaceNumber: 4,
        alternate: inactive,
        alternates: [inactive, active],
      },
    ],
  };
}

export class FakeUsbDevice implements UsbDeviceLike {
  readonly vendorId = 0x1949;
  readonly productId = 0x9981;
  readonly manufacturerName = "Amazon";
  readonly productName = "Kindle Test";
  readonly serialNumber = "B012345678901234";
  readonly configurations: UsbConfigurationLike[];
  configuration?: UsbConfigurationLike;
  opened = false;

  readonly calls: string[] = [];
  readonly writes: Uint8Array[] = [];
  readonly outResults: UsbOutTransferResultLike[] = [];
  readonly inResults: UsbInTransferResultLike[] = [];
  transferOutImpl?: (
    endpointNumber: number,
    data: BufferSource,
  ) => Promise<UsbOutTransferResultLike>;
  transferInImpl?: (
    endpointNumber: number,
    length: number,
  ) => Promise<UsbInTransferResultLike>;

  constructor(configurations: UsbConfigurationLike[] = [mtpConfiguration()]) {
    this.configurations = configurations;
  }

  async open(): Promise<void> {
    this.calls.push("open");
    this.opened = true;
  }

  async close(): Promise<void> {
    this.calls.push("close");
    this.opened = false;
  }

  async selectConfiguration(configurationValue: number): Promise<void> {
    this.calls.push(`configuration:${configurationValue}`);
    const selected = this.configurations.find(
      (configuration) =>
        configuration.configurationValue === configurationValue,
    );
    if (!selected) throw new Error("Missing configuration");
    this.configuration = selected;
  }

  async claimInterface(interfaceNumber: number): Promise<void> {
    this.calls.push(`claim:${interfaceNumber}`);
  }

  async releaseInterface(interfaceNumber: number): Promise<void> {
    this.calls.push(`release:${interfaceNumber}`);
  }

  async selectAlternateInterface(
    interfaceNumber: number,
    alternateSetting: number,
  ): Promise<void> {
    this.calls.push(`alternate:${interfaceNumber}:${alternateSetting}`);
    const usbInterface = this.configuration?.interfaces.find(
      (candidate) => candidate.interfaceNumber === interfaceNumber,
    );
    const alternate = usbInterface?.alternates.find(
      (candidate) => candidate.alternateSetting === alternateSetting,
    );
    if (!usbInterface || !alternate) throw new Error("Missing alternate");
    (usbInterface as { alternate: UsbAlternateInterfaceLike }).alternate = alternate;
  }

  async transferIn(
    endpointNumber: number,
    length: number,
  ): Promise<UsbInTransferResultLike> {
    this.calls.push(`in:${endpointNumber}:${length}`);
    if (this.transferInImpl) return this.transferInImpl(endpointNumber, length);
    return this.inResults.shift() ?? { status: "ok", data: new DataView(new ArrayBuffer(1)) };
  }

  async transferOut(
    endpointNumber: number,
    data: BufferSource,
  ): Promise<UsbOutTransferResultLike> {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data).slice()
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    this.calls.push(`out:${endpointNumber}:${bytes.byteLength}`);
    this.writes.push(bytes);
    if (this.transferOutImpl) return this.transferOutImpl(endpointNumber, data);
    return this.outResults.shift() ?? {
      status: "ok",
      bytesWritten: bytes.byteLength,
    };
  }

  async clearHalt(
    direction: "in" | "out",
    endpointNumber: number,
  ): Promise<void> {
    this.calls.push(`clear:${direction}:${endpointNumber}`);
  }
}

export class FakeUsbManager implements UsbManagerLike {
  requestedOptions?: UsbRequestDeviceOptionsLike;
  requestResult?: UsbDeviceLike;
  requestError?: unknown;
  devices: UsbDeviceLike[] = [];
  private readonly listeners = new Set<
    (event: UsbConnectionEventLike) => void
  >();

  async requestDevice(
    options: UsbRequestDeviceOptionsLike,
  ): Promise<UsbDeviceLike> {
    this.requestedOptions = options;
    if (this.requestError) throw this.requestError;
    if (!this.requestResult) throw new Error("No request result");
    return this.requestResult;
  }

  async getDevices(): Promise<UsbDeviceLike[]> {
    return [...this.devices];
  }

  addEventListener(
    type: "connect" | "disconnect",
    listener: (event: UsbConnectionEventLike) => void,
  ): void {
    if (type === "disconnect") this.listeners.add(listener);
  }

  removeEventListener(
    type: "connect" | "disconnect",
    listener: (event: UsbConnectionEventLike) => void,
  ): void {
    if (type === "disconnect") this.listeners.delete(listener);
  }

  disconnect(device: UsbDeviceLike): void {
    const event = { device } as UsbConnectionEventLike;
    for (const listener of this.listeners) listener(event);
  }
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
