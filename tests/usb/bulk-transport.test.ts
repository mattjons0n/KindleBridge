import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { WebUsbBulkTransport } from "../../client/src/usb/bulk-transport";
import type { MtpBulkTransport } from "../../client/src/mtp/session";
import {
  FakeUsbDevice,
  FakeUsbManager,
  deferred,
} from "./fakes";

const BULK_PACKET_SIZE = 512;

function patternedBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 17 + 3) % 251);
}

async function* awkwardChunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  const cuts = [1, 13, 127, 509, 513, 997, bytes.byteLength];
  let offset = 0;
  yield new Uint8Array();
  for (const cut of cuts) {
    const end = Math.min(cut, bytes.byteLength);
    if (end > offset) yield bytes.slice(offset, end);
    offset = end;
  }
  if (offset < bytes.byteLength) yield bytes.slice(offset);
}

function concatenateWrites(writes: readonly Uint8Array[]): Uint8Array {
  const length = writes.reduce((sum, write) => sum + write.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const write of writes) {
    result.set(write, offset);
    offset += write.byteLength;
  }
  return result;
}

describe("WebUsbBulkTransport", () => {
  it("is structurally compatible with the MTP session transport", () => {
    expectTypeOf<WebUsbBulkTransport>().toMatchTypeOf<MtpBulkTransport>();
  });

  it("claims the derived interface and keeps a short write final", async () => {
    const device = new FakeUsbDevice();
    const usb = new FakeUsbManager();
    const progress = vi.fn();
    const transport = await WebUsbBulkTransport.connect(device, {
      usb,
      chunkSize: 4,
    });

    await expect(
      transport.write(Uint8Array.from({ length: 10 }, (_, index) => index), {
        onProgress: progress,
      }),
    ).resolves.toEqual({ bytesWritten: 10 });

    expect(device.calls.slice(0, 4)).toEqual([
      "open",
      "configuration:7",
      "claim:4",
      "alternate:4:2",
    ]);
    // chunkSize=4 is smaller than wMaxPacketSize=512, so splitting at four
    // bytes would create illegal non-final short USB transfers.
    expect(device.writes.map((chunk) => chunk.byteLength)).toEqual([10]);
    expect(progress.mock.calls).toEqual([[10, 10]]);

    await transport.close();
    expect(device.calls.slice(-2)).toEqual(["release:4", "close"]);
  });

  it.each([
    {
      label: "M-1",
      length: BULK_PACKET_SIZE - 1,
      expectedTransfers: [BULK_PACKET_SIZE - 1],
    },
    {
      label: "M",
      length: BULK_PACKET_SIZE,
      expectedTransfers: [BULK_PACKET_SIZE, 0],
    },
    {
      label: "M+1",
      length: BULK_PACKET_SIZE + 1,
      expectedTransfers: [BULK_PACKET_SIZE, 1],
    },
    {
      label: "large exact multiple",
      length: BULK_PACKET_SIZE * 7,
      expectedTransfers: [
        BULK_PACKET_SIZE,
        BULK_PACKET_SIZE,
        BULK_PACKET_SIZE,
        BULK_PACKET_SIZE,
        BULK_PACKET_SIZE,
        BULK_PACKET_SIZE,
        BULK_PACKET_SIZE,
        0,
      ],
    },
  ])(
    "frames $label bytes as one phase with packet-safe transferOut calls",
    async ({ length, expectedTransfers }) => {
      const device = new FakeUsbDevice();
      const transport = await WebUsbBulkTransport.connect(device, {
        chunkSize: BULK_PACKET_SIZE,
      });
      const bytes = patternedBytes(length);

      await expect(transport.writePhase({
        length,
        chunks: awkwardChunks(bytes),
      })).resolves.toEqual({ bytesWritten: length });

      const transferSizes = device.writes.map((write) => write.byteLength);
      expect(transferSizes).toEqual(expectedTransfers);
      expect(concatenateWrites(device.writes)).toEqual(bytes);
      for (const nonFinal of transferSizes.slice(0, -1)) {
        expect(nonFinal).toBeGreaterThan(0);
        expect(nonFinal % BULK_PACKET_SIZE).toBe(0);
      }
      await transport.close();
    },
  );

  it("bounds large phases to the configured packet-aligned transfer size", async () => {
    const device = new FakeUsbDevice();
    const transport = await WebUsbBulkTransport.connect(device, {
      chunkSize: BULK_PACKET_SIZE * 3 + 17,
    });
    const bytes = patternedBytes(BULK_PACKET_SIZE * 8);

    await transport.writePhase({
      length: bytes.byteLength,
      chunks: (async function* oneLargeProducerChunk() {
        yield bytes;
      })(),
    });

    expect(device.writes.map((write) => write.byteLength)).toEqual([
      BULK_PACKET_SIZE * 3,
      BULK_PACKET_SIZE * 3,
      BULK_PACKET_SIZE * 2,
      0,
    ]);
    expect(concatenateWrites(device.writes)).toEqual(bytes);
    await transport.close();
  });

  it.each([
    { label: "underrun", declared: 5, actual: 4 },
    { label: "overrun", declared: 5, actual: 6 },
  ])("rejects a phase source $label before sending a short terminator", async ({ declared, actual }) => {
    const device = new FakeUsbDevice();
    const transport = await WebUsbBulkTransport.connect(device);

    await expect(transport.writePhase({
      length: declared,
      chunks: awkwardChunks(patternedBytes(actual)),
    })).rejects.toMatchObject({
      code: "USB_OUTGOING_LENGTH_MISMATCH",
      details: { declaredBytes: declared, producedBytes: actual },
    });
    expect(device.writes).toEqual([]);
    await transport.close();
  });

  it("validates bytesWritten on the explicit terminating ZLP", async () => {
    const device = new FakeUsbDevice();
    device.outResults.push(
      { status: "ok", bytesWritten: BULK_PACKET_SIZE },
      { status: "ok" },
    );
    const transport = await WebUsbBulkTransport.connect(device, {
      chunkSize: BULK_PACKET_SIZE,
    });

    await expect(transport.write(patternedBytes(BULK_PACKET_SIZE)))
      .rejects.toMatchObject({
        code: "USB_SHORT_WRITE",
        details: { expectedBytes: 0, bytesWritten: undefined },
      });
    expect(device.writes.map((write) => write.byteLength)).toEqual([
      BULK_PACKET_SIZE,
      0,
    ]);
    await transport.close();
  });

  it("rejects a short write with the exact byte counts", async () => {
    const device = new FakeUsbDevice();
    device.outResults.push({ status: "ok", bytesWritten: 3 });
    const transport = await WebUsbBulkTransport.connect(device, { chunkSize: 4 });

    await expect(transport.write(new Uint8Array(4))).rejects.toMatchObject({
      code: "USB_SHORT_WRITE",
      details: {
        expectedBytes: 4,
        bytesWritten: 3,
        totalBytesWrittenBeforeFailure: 0,
      },
    });
    await transport.close();
  });

  it("reports stalls and clears only the requested endpoint explicitly", async () => {
    const device = new FakeUsbDevice();
    device.outResults.push({ status: "stall", bytesWritten: 0 });
    const transport = await WebUsbBulkTransport.connect(device);

    await expect(transport.write(new Uint8Array([1]))).rejects.toMatchObject({
      code: "USB_ENDPOINT_STALLED",
    });
    expect(device.calls).not.toContain("clear:out:6");

    await transport.clearHalt("out");
    expect(device.calls).toContain("clear:out:6");
    await transport.close();
  });

  it("copies exactly the DataView window returned by bulk IN", async () => {
    const device = new FakeUsbDevice();
    const backing = Uint8Array.from([99, 1, 2, 3, 88]);
    device.inResults.push({
      status: "ok",
      data: new DataView(backing.buffer, 1, 3),
    });
    const transport = await WebUsbBulkTransport.connect(device, { readSize: 4096 });

    await expect(transport.read()).resolves.toEqual({
      data: Uint8Array.from([1, 2, 3]),
      phaseEnded: true,
    });
    expect(device.calls).toContain("in:5:4096");
    await transport.close();
  });

  it("exposes a full IN transfer and its following ZLP as one phase boundary", async () => {
    const device = new FakeUsbDevice();
    const bytes = patternedBytes(BULK_PACKET_SIZE);
    device.inResults.push(
      { status: "ok", data: new DataView(bytes.buffer) },
      { status: "ok", data: new DataView(new ArrayBuffer(0)) },
    );
    const transport = await WebUsbBulkTransport.connect(device, {
      readSize: BULK_PACKET_SIZE,
    });

    await expect(transport.read()).resolves.toEqual({
      data: bytes,
      phaseEnded: false,
    });
    await expect(transport.read()).resolves.toEqual({
      data: new Uint8Array(),
      phaseEnded: true,
    });
    expect(device.calls.filter((call) => call.startsWith("in:"))).toEqual([
      "in:5:512",
      "in:5:512",
    ]);
    await transport.close();
  });

  it("rejects an in-flight transfer immediately on physical disconnect", async () => {
    const pending = deferred<{
      status: "ok";
      data: DataView;
    }>();
    const device = new FakeUsbDevice();
    device.transferInImpl = () => pending.promise;
    const usb = new FakeUsbManager();
    const transport = await WebUsbBulkTransport.connect(device, { usb });

    const read = transport.read({ timeoutMs: 1_000 });
    usb.disconnect(device);

    await expect(read).rejects.toMatchObject({
      code: "USB_DEVICE_DISCONNECTED",
    });
    await transport.close();
  });

  it("applies an inactivity timeout to a stuck transfer", async () => {
    const pending = deferred<{
      status: "ok";
      bytesWritten: number;
    }>();
    const device = new FakeUsbDevice();
    device.transferOutImpl = () => pending.promise;
    const transport = await WebUsbBulkTransport.connect(device);

    await expect(
      transport.write(new Uint8Array([1]), { timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: "USB_TRANSFER_TIMEOUT" });
    await transport.close();
    expect(transport.hasPendingNativeOperations).toBe(true);
    pending.resolve({ status: "ok", bytesWritten: 1 });
    await transport.waitForNativeOperations();
    expect(transport.hasPendingNativeOperations).toBe(false);
  });

  it("classifies an interface ownership conflict and closes the device", async () => {
    const device = new FakeUsbDevice();
    device.claimInterface = async () => {
      throw new DOMException("busy", "NetworkError");
    };

    await expect(WebUsbBulkTransport.connect(device)).rejects.toMatchObject({
      code: "USB_INTERFACE_CLAIM_FAILED",
    });
    expect(device.opened).toBe(false);
    expect(device.calls).toContain("close");
  });

  it("still closes the device after releaseInterface fails", async () => {
    const device = new FakeUsbDevice();
    const transport = await WebUsbBulkTransport.connect(device);
    device.releaseInterface = async (interfaceNumber) => {
      device.calls.push(`release:${interfaceNumber}`);
      throw new Error("release refused");
    };

    await expect(transport.close()).rejects.toMatchObject({
      code: "USB_CLOSE_FAILED",
      message: expect.stringContaining("release refused"),
    });
    expect(device.calls.slice(-2)).toEqual(["release:4", "close"]);
    expect(device.opened).toBe(false);
  });

  it("bounds a stuck releaseInterface and still attempts device.close", async () => {
    const neverReleased = deferred<void>();
    const device = new FakeUsbDevice();
    const transport = await WebUsbBulkTransport.connect(device, {
      defaultTimeoutMs: 5,
    });
    device.releaseInterface = async (interfaceNumber) => {
      device.calls.push(`release:${interfaceNumber}`);
      await neverReleased.promise;
    };

    await expect(transport.close()).rejects.toMatchObject({
      code: "USB_CLOSE_FAILED",
      message: expect.stringContaining("release interface timed out after 5 ms"),
    });
    expect(device.calls.slice(-2)).toEqual(["release:4", "close"]);
    expect(device.opened).toBe(false);
  });

  it("bounds a stuck device.close cleanup step", async () => {
    const neverClosed = deferred<void>();
    const device = new FakeUsbDevice();
    const transport = await WebUsbBulkTransport.connect(device, {
      defaultTimeoutMs: 5,
    });
    device.close = async () => {
      device.calls.push("close");
      await neverClosed.promise;
    };

    await expect(transport.close()).rejects.toMatchObject({
      code: "USB_CLOSE_FAILED",
      message: expect.stringContaining("close device timed out after 5 ms"),
    });
    expect(device.calls.slice(-2)).toEqual(["release:4", "close"]);
  });

  it("bounds a stuck open operation", async () => {
    const lateOpen = deferred<void>();
    const device = new FakeUsbDevice();
    device.open = async () => {
      await lateOpen.promise;
      device.opened = true;
    };

    await expect(
      WebUsbBulkTransport.connect(device, { defaultTimeoutMs: 5 }),
    ).rejects.toMatchObject({ code: "USB_TRANSFER_TIMEOUT" });
    expect(device.opened).toBe(false);

    lateOpen.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(device.opened).toBe(false);
    expect(device.calls).toContain("close");
  });
});
