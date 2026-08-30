import { describe, expect, it, vi } from "vitest";
import {
  decodeContainer,
  decodeContainerParameters,
  encodeContainerHeader,
  encodeDataContainer,
  encodeResponseContainer,
} from "../../client/src/mtp/codec";
import {
  MtpContainerType,
  MtpOperationCode,
  MtpResponseCode,
} from "../../client/src/mtp/constants";
import { encodeDeviceInfo } from "../../client/src/mtp/datasets";
import {
  MtpResponseError,
  MtpSession,
  MtpSessionError,
} from "../../client/src/mtp/session";
import { UsbTransportError } from "../../client/src/usb/errors";
import {
  FakeMtpBulkTransport,
  splitContainerStream,
  splitReadPhase,
} from "./fake-transport";

const DEVICE_INFO = {
  standardVersion: 100,
  vendorExtensionId: 6,
  vendorExtensionVersion: 100,
  vendorExtensionDescription: "microsoft.com: 1.0;",
  functionalMode: 0,
  operationsSupported: [
    MtpOperationCode.GetDeviceInfo,
    MtpOperationCode.OpenSession,
    MtpOperationCode.GetStorageIDs,
  ],
  eventsSupported: [],
  devicePropertiesSupported: [],
  captureFormats: [],
  imageFormats: [],
  manufacturer: "Amazon",
  model: "Kindle test fixture",
  deviceVersion: "1.0",
  serialNumber: "TEST-SERIAL",
} as const;

function ok(transactionId: number, parameters: readonly number[] = []): Uint8Array {
  return encodeResponseContainer(MtpResponseCode.OK, transactionId, parameters);
}

function patternedPayload(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 29 + 7) % 251);
}

function commandContainers(transport: FakeMtpBulkTransport) {
  return splitContainerStream(transport.allWrittenBytes())
    .map((bytes) => decodeContainer(bytes))
    .filter((container) => container.type === MtpContainerType.Command);
}

describe("MtpSession", () => {
  it("runs GetDeviceInfo before OpenSession at transaction 0 and resets OpenSession to 0", async () => {
    const infoData = encodeDataContainer(
      MtpOperationCode.GetDeviceInfo,
      0,
      encodeDeviceInfo(DEVICE_INFO),
    );
    // Deliberately split the data phase in the middle of both its header and
    // payload; command response phases remain physically distinct.
    const transport = new FakeMtpBulkTransport([
      ...splitReadPhase(infoData, 3, 11, 29),
      ok(0),
      ok(0),
    ]);
    const session = new MtpSession(transport);

    await expect(session.getDeviceInfo()).resolves.toEqual(DEVICE_INFO);
    expect(session.state).toBe("idle");
    await session.open(7);
    expect(session.state).toBe("open");
    expect(session.sessionId).toBe(7);

    const commands = commandContainers(transport);
    expect(commands.map(({ code, transactionId }) => ({ code, transactionId }))).toEqual([
      { code: MtpOperationCode.GetDeviceInfo, transactionId: 0 },
      { code: MtpOperationCode.OpenSession, transactionId: 0 },
    ]);
    expect(decodeContainerParameters(commands[1].payload)).toEqual([7]);
  });

  it("caps GetDeviceInfo data before reading or allocating a malicious declared payload", async () => {
    const maliciousHeader = encodeContainerHeader(
      MtpContainerType.Data,
      MtpOperationCode.GetDeviceInfo,
      0,
      2 * 1024 * 1024,
    );
    const transport = new FakeMtpBulkTransport([
      { data: maliciousHeader, phaseEnded: false },
    ]);
    const session = new MtpSession(transport, {
      commandTimeoutMs: 250,
      inactivityTimeoutMs: 100,
    });

    await expect(session.getDeviceInfo()).rejects.toMatchObject({
      code: "MTP_INCOMING_DATA_TOO_LARGE",
      context: {
        receivedContainerType: MtpContainerType.Data,
        receivedTransactionId: 0,
      },
    });
    expect(transport.readTimeouts).toHaveLength(1);
    expect(session.state).toBe("faulted");
  });

  it("uses monotonically increasing in-session transaction IDs and serializes callers", async () => {
    const transport = new FakeMtpBulkTransport([ok(0), ok(1), ok(2), ok(3)]);
    const session = new MtpSession(transport);
    await session.open();

    const first = session.execute({
      operationCode: MtpOperationCode.DeleteObject,
      parameters: [0x10, 0],
    });
    const second = session.execute({
      operationCode: MtpOperationCode.DeleteObject,
      parameters: [0x11, 0],
    });
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { transactionId: 1 },
      { transactionId: 2 },
    ]);
    await session.close();
    expect(session.state).toBe("idle");

    expect(commandContainers(transport).map((container) => container.transactionId))
      .toEqual([0, 1, 2, 3]);
  });

  it("frames streamed data once while preserving arbitrary USB write chunks", async () => {
    const transport = new FakeMtpBulkTransport([ok(0), ok(1)]);
    const session = new MtpSession(transport);
    await session.open();
    const progress = vi.fn();

    await session.execute({
      operationCode: MtpOperationCode.SendObject,
      dataOut: {
        length: 6,
        chunks: (async function* chunks() {
          yield Uint8Array.of(0, 1);
          yield new Uint8Array();
          yield Uint8Array.of(2, 3, 4, 5);
        })(),
        onProgress: progress,
      },
    });

    const containers = splitContainerStream(transport.allWrittenBytes())
      .map((bytes) => decodeContainer(bytes));
    expect(containers).toHaveLength(3);
    expect(containers[1]).toMatchObject({
      type: MtpContainerType.Command,
      code: MtpOperationCode.SendObject,
      transactionId: 1,
    });
    expect(containers[2]).toMatchObject({
      length: 18,
      type: MtpContainerType.Data,
      code: MtpOperationCode.SendObject,
      transactionId: 1,
    });
    expect([...containers[2].payload]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(progress.mock.calls).toEqual([[2, 6], [6, 6]]);

    // OpenSession command, SendObject command, and SendObject data are three
    // distinct wire phases. The data header is never a phase by itself.
    expect(transport.phases.map((phase) => phase.byteLength)).toEqual([16, 12, 18]);
    expect(decodeContainer(transport.phases[2]).payload).toEqual(
      Uint8Array.of(0, 1, 2, 3, 4, 5),
    );
  });

  it("faults the session when streamed bytes do not match the declared length", async () => {
    const transport = new FakeMtpBulkTransport([ok(0)]);
    const session = new MtpSession(transport);
    await session.open();

    await expect(session.execute({
      operationCode: MtpOperationCode.SendObject,
      dataOut: {
        length: 3,
        chunks: (async function* chunks() {
          yield Uint8Array.of(1, 2);
        })(),
      },
    })).rejects.toMatchObject({ code: "MTP_OUTGOING_LENGTH_MISMATCH" });
    expect(session.state).toBe("faulted");
  });

  it("faults the session when a streamed source overruns its declared length", async () => {
    const transport = new FakeMtpBulkTransport([ok(0)]);
    const session = new MtpSession(transport);
    await session.open();

    await expect(session.execute({
      operationCode: MtpOperationCode.SendObject,
      dataOut: {
        length: 2,
        chunks: (async function* chunks() {
          yield Uint8Array.of(1, 2, 3);
        })(),
      },
    })).rejects.toMatchObject({ code: "MTP_OUTGOING_LENGTH_MISMATCH" });
    expect(session.state).toBe("faulted");
  });

  it("rejects a transaction mismatch and preserves diagnostic context", async () => {
    const transport = new FakeMtpBulkTransport([ok(0), ok(99)]);
    const session = new MtpSession(transport);
    await session.open();

    try {
      await session.execute({ operationCode: MtpOperationCode.GetStorageIDs });
      throw new Error("expected mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(MtpSessionError);
      expect(error).toMatchObject({
        code: "MTP_UNEXPECTED_TRANSACTION",
        context: {
          operationCode: MtpOperationCode.GetStorageIDs,
          expectedTransactionId: 1,
          receivedTransactionId: 99,
          receivedContainerType: MtpContainerType.Response,
          responseCode: MtpResponseCode.OK,
        },
      });
    }
    expect(session.state).toBe("faulted");
  });

  it("rejects a data container whose code does not match the operation", async () => {
    const wrongData = encodeDataContainer(MtpOperationCode.GetObject, 1, Uint8Array.of(1));
    const transport = new FakeMtpBulkTransport([ok(0), wrongData]);
    const session = new MtpSession(transport);
    await session.open();

    await expect(session.execute({
      operationCode: MtpOperationCode.GetStorageIDs,
      expectData: true,
    })).rejects.toMatchObject({ code: "MTP_UNEXPECTED_OPERATION" });
    expect(session.state).toBe("faulted");
  });

  it("preserves a non-OK response code without poisoning a synchronized session", async () => {
    const storeFull = encodeResponseContainer(MtpResponseCode.StoreFull, 1, [0xfeed]);
    const transport = new FakeMtpBulkTransport([ok(0), storeFull, ok(2)]);
    const session = new MtpSession(transport);
    await session.open();

    try {
      await session.execute({ operationCode: MtpOperationCode.SendObject });
      throw new Error("expected response error");
    } catch (error) {
      expect(error).toBeInstanceOf(MtpResponseError);
      expect(error).toMatchObject({
        responseCode: MtpResponseCode.StoreFull,
        responseParameters: [0xfeed],
        transactionId: 1,
      });
    }
    expect(session.state).toBe("open");
    await expect(session.execute({ operationCode: MtpOperationCode.GetStorageIDs }))
      .resolves.toMatchObject({ transactionId: 2 });
  });

  it("caps a declared incoming length before waiting for or allocating its payload", async () => {
    const oversizedHeader = encodeDataContainer(
      MtpOperationCode.GetObject,
      1,
      new Uint8Array(),
    );
    new DataView(oversizedHeader.buffer).setUint32(0, 65, true);
    const transport = new FakeMtpBulkTransport([ok(0), oversizedHeader]);
    const session = new MtpSession(transport, { maxIncomingContainerBytes: 64 });
    await session.open();

    await expect(session.execute({
      operationCode: MtpOperationCode.GetObject,
      expectData: true,
    })).rejects.toMatchObject({ code: "MTP_INVALID_CONTAINER" });
    expect(transport.reads).toHaveLength(0);
  });

  it("caps a header-only Response at 32 bytes before reading or allocating its declared payload", async () => {
    const maliciousResponseHeader = encodeContainerHeader(
      MtpContainerType.Response,
      MtpResponseCode.OK,
      1,
      0xffff_ffff - 12,
    );
    const transport = new FakeMtpBulkTransport([
      ok(0),
      { data: maliciousResponseHeader, phaseEnded: false },
    ]);
    const session = new MtpSession(transport, {
      commandTimeoutMs: 250,
      inactivityTimeoutMs: 100,
    });
    await session.open();

    await expect(session.execute({ operationCode: MtpOperationCode.GetStorageIDs }))
      .rejects.toMatchObject({
        code: "MTP_INVALID_CONTAINER",
        context: {
          receivedContainerType: MtpContainerType.Response,
          receivedTransactionId: 1,
        },
      });
    // One read consumed OpenSession's response and one consumed the malicious
    // header. No third read was attempted for its claimed payload.
    expect(transport.readTimeouts).toHaveLength(2);
    expect(session.state).toBe("faulted");
  });

  it("accepts the protocol maximum of five Response parameters", async () => {
    const parameters = [1, 2, 3, 4, 5];
    const transport = new FakeMtpBulkTransport([ok(0), ok(1, parameters)]);
    const session = new MtpSession(transport);
    await session.open();

    await expect(session.execute({ operationCode: MtpOperationCode.GetStorageIDs }))
      .resolves.toMatchObject({ responseParameters: parameters });
    expect(session.state).toBe("open");
  });

  it.each([
    ["Command", MtpContainerType.Command],
    ["Event", MtpContainerType.Event],
  ] as const)("rejects a header-only %s container on the bulk response path", async (_label, type) => {
    const wrongTypeHeader = encodeContainerHeader(
      type,
      MtpOperationCode.GetStorageIDs,
      1,
      0xffff_ffff - 12,
    );
    const transport = new FakeMtpBulkTransport([
      ok(0),
      { data: wrongTypeHeader, phaseEnded: false },
    ]);
    const session = new MtpSession(transport, {
      commandTimeoutMs: 250,
      inactivityTimeoutMs: 100,
    });
    await session.open();

    await expect(session.execute({ operationCode: MtpOperationCode.GetStorageIDs }))
      .rejects.toMatchObject({
        code: "MTP_UNEXPECTED_CONTAINER",
        context: {
          receivedContainerType: type,
          receivedTransactionId: 1,
        },
      });
    expect(transport.readTimeouts).toHaveLength(2);
    expect(session.state).toBe("faulted");
  });

  it("consumes an exact-boundary inbound phase ZLP before reading the response", async () => {
    const boundaryLength = 512;
    const payload = patternedPayload(boundaryLength - 12);
    const data = encodeDataContainer(MtpOperationCode.GetObject, 1, payload);
    const transport = new FakeMtpBulkTransport([
      ok(0),
      { data, phaseEnded: false },
      { data: new Uint8Array(), phaseEnded: true },
      ok(1),
    ]);
    const session = new MtpSession(transport);
    await session.open();

    await expect(session.execute({
      operationCode: MtpOperationCode.GetObject,
      expectData: true,
    })).resolves.toMatchObject({ data: payload });
    expect(transport.reads).toHaveLength(0);
  });

  it("assembles a realistically multi-chunk inbound book container in linear time", async () => {
    const payload = patternedPayload(16 * 1024 * 1024);
    const container = encodeDataContainer(MtpOperationCode.GetObject, 1, payload);
    const chunkSize = 64 * 1024;
    const chunks = Array.from(
      { length: Math.ceil(container.byteLength / chunkSize) },
      (_unused, index) => {
        const start = index * chunkSize;
        const end = Math.min(container.byteLength, start + chunkSize);
        return {
          data: container.slice(start, end),
          phaseEnded: end === container.byteLength,
        };
      },
    );
    const transport = new FakeMtpBulkTransport([ok(0), ...chunks, ok(1)]);
    const session = new MtpSession(transport, {
      commandTimeoutMs: 5_000,
      inactivityTimeoutMs: 1_000,
      maxIncomingContainerBytes: container.byteLength,
    });
    await session.open();

    const startedAt = performance.now();
    const result = await session.execute({
      operationCode: MtpOperationCode.GetObject,
      expectData: true,
      maxDataBytes: payload.byteLength,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.data?.byteLength).toBe(payload.byteLength);
    expect(result.data?.subarray(0, 32)).toEqual(payload.subarray(0, 32));
    expect(result.data?.subarray(-32)).toEqual(payload.subarray(-32));
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("rejects positive bytes where an exact-boundary inbound ZLP is required", async () => {
    const payload = patternedPayload(500);
    const data = encodeDataContainer(MtpOperationCode.GetObject, 1, payload);
    const transport = new FakeMtpBulkTransport([
      ok(0),
      { data, phaseEnded: false },
      ok(1),
    ]);
    const session = new MtpSession(transport);
    await session.open();

    await expect(session.execute({
      operationCode: MtpOperationCode.GetObject,
      expectData: true,
    })).rejects.toMatchObject({ code: "MTP_INVALID_CONTAINER" });
    expect(session.state).toBe("faulted");
  });

  it("rejects short USB writes immediately", async () => {
    const transport = new FakeMtpBulkTransport();
    transport.shortWriteAt = 0;
    const session = new MtpSession(transport);
    await expect(session.open()).rejects.toMatchObject({ code: "MTP_SHORT_WRITE" });
    expect(session.state).toBe("faulted");
  });

  it("preserves structured USB failure details through the MTP error layer", async () => {
    const transport = new FakeMtpBulkTransport();
    const usbFailure = new UsbTransportError(
      "USB_ENDPOINT_STALLED",
      "bulk OUT stalled",
      {
        endpointNumber: 6,
        direction: "out",
        interfaceNumber: 4,
        configurationValue: 7,
      },
    );
    transport.writeErrorAt = 0;
    transport.writeError = usbFailure;
    const session = new MtpSession(transport);

    try {
      await session.open();
      throw new Error("expected transport failure");
    } catch (error) {
      expect(error).toBeInstanceOf(MtpSessionError);
      expect(error).toMatchObject({
        code: "MTP_TRANSPORT_ERROR",
        cause: usbFailure,
        context: {
          transportCode: "USB_ENDPOINT_STALLED",
          transportDetails: {
            endpointNumber: 6,
            direction: "out",
            interfaceNumber: 4,
            configurationValue: 7,
          },
        },
      });
    }
  });

  it("distinguishes inactivity and whole-command timeouts", async () => {
    const inactivityTransport = new FakeMtpBulkTransport([ok(0)]);
    const inactivitySession = new MtpSession(inactivityTransport, {
      commandTimeoutMs: 250,
      inactivityTimeoutMs: 10,
    });
    await inactivitySession.open();
    await expect(inactivitySession.execute({ operationCode: MtpOperationCode.GetStorageIDs }))
      .rejects.toMatchObject({ code: "MTP_INACTIVITY_TIMEOUT" });

    const commandTransport = new FakeMtpBulkTransport([ok(0)]);
    const commandSession = new MtpSession(commandTransport, {
      commandTimeoutMs: 10,
      inactivityTimeoutMs: 250,
    });
    await commandSession.open();
    await expect(commandSession.execute({ operationCode: MtpOperationCode.GetStorageIDs }))
      .rejects.toMatchObject({ code: "MTP_COMMAND_TIMEOUT" });
  });

  it("keeps the hard command deadline while outbound phase activity resets inactivity", async () => {
    const transport = new FakeMtpBulkTransport([ok(0)]);
    const session = new MtpSession(transport);
    await session.open();
    transport.writeDelayMs = 10;

    await expect(session.execute({
      operationCode: MtpOperationCode.SendObject,
      dataOut: {
        length: 8,
        chunks: (async function* chunks() {
          for (let value = 0; value < 8; value += 1) {
            yield Uint8Array.of(value);
          }
        })(),
      },
    }, {
      commandTimeoutMs: 35,
      inactivityTimeoutMs: 30,
    })).rejects.toMatchObject({ code: "MTP_COMMAND_TIMEOUT" });
  });

  it("rejects response payloads with an invalid parameter count", async () => {
    const malformedResponse = new Uint8Array(12 + 24);
    const view = new DataView(malformedResponse.buffer);
    view.setUint32(0, malformedResponse.byteLength, true);
    view.setUint16(4, MtpContainerType.Response, true);
    view.setUint16(6, MtpResponseCode.OK, true);
    view.setUint32(8, 1, true);
    const transport = new FakeMtpBulkTransport([ok(0), malformedResponse]);
    const session = new MtpSession(transport);
    await session.open();

    await expect(session.execute({ operationCode: MtpOperationCode.GetStorageIDs }))
      .rejects.toMatchObject({ code: "MTP_INVALID_CONTAINER" });
  });
});
