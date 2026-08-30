import {
  MTP_CONTAINER_HEADER_SIZE,
  MTP_MAX_CONTAINER_PARAMETERS,
  MtpContainerType,
} from "./constants";

const UINT8_MAX = 0xff;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

export class MtpCodecError extends Error {
  readonly offset?: number;

  constructor(message: string, offset?: number) {
    super(message);
    this.name = "MtpCodecError";
    this.offset = offset;
  }
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new MtpCodecError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
}

export function asUint8Array(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export class MtpDatasetWriter {
  private readonly chunks: Uint8Array[] = [];
  private byteLength = 0;

  get length(): number {
    return this.byteLength;
  }

  uint8(value: number): this {
    assertIntegerInRange(value, 0, UINT8_MAX, "uint8");
    const bytes = new Uint8Array(1);
    bytes[0] = value;
    return this.append(bytes);
  }

  uint16(value: number): this {
    assertIntegerInRange(value, 0, UINT16_MAX, "uint16");
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    return this.append(bytes);
  }

  uint32(value: number): this {
    assertIntegerInRange(value, 0, UINT32_MAX, "uint32");
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return this.append(bytes);
  }

  uint64(value: bigint): this {
    if (value < 0n || value > UINT64_MAX) {
      throw new MtpCodecError(`uint64 must be from 0 to ${UINT64_MAX}`);
    }
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return this.append(bytes);
  }

  bytes(value: ArrayBuffer | ArrayBufferView): this {
    return this.append(asUint8Array(value));
  }

  /**
   * Encodes a PTP string: a one-byte count of UTF-16 code units including the
   * terminator, followed by little-endian UTF-16. An empty string is one zero
   * count byte and has no terminator bytes.
   */
  string(value: string): this {
    if (value.includes("\0")) {
      throw new MtpCodecError("PTP strings cannot contain an embedded NUL");
    }
    if (value.length === 0) {
      return this.uint8(0);
    }
    const encodedCodeUnits = value.length + 1;
    if (encodedCodeUnits > UINT8_MAX) {
      throw new MtpCodecError("PTP strings are limited to 254 UTF-16 code units");
    }

    this.uint8(encodedCodeUnits);
    const bytes = new Uint8Array(encodedCodeUnits * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < value.length; index += 1) {
      view.setUint16(index * 2, value.charCodeAt(index), true);
    }
    view.setUint16(value.length * 2, 0, true);
    return this.append(bytes);
  }

  uint16Array(values: readonly number[]): this {
    this.uint32(values.length);
    for (const value of values) {
      this.uint16(value);
    }
    return this;
  }

  uint32Array(values: readonly number[]): this {
    this.uint32(values.length);
    for (const value of values) {
      this.uint32(value);
    }
    return this;
  }

  finish(): Uint8Array {
    const result = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  private append(bytes: Uint8Array): this {
    // Copy views here so callers cannot mutate a completed dataset indirectly.
    const copy = bytes.slice();
    this.chunks.push(copy);
    this.byteLength += copy.byteLength;
    return this;
  }
}

export class MtpDatasetReader {
  private readonly bytesValue: Uint8Array;
  private readonly view: DataView;
  private offsetValue = 0;

  constructor(value: ArrayBuffer | ArrayBufferView) {
    this.bytesValue = asUint8Array(value);
    this.view = new DataView(
      this.bytesValue.buffer,
      this.bytesValue.byteOffset,
      this.bytesValue.byteLength,
    );
  }

  get offset(): number {
    return this.offsetValue;
  }

  get remaining(): number {
    return this.bytesValue.byteLength - this.offsetValue;
  }

  uint8(): number {
    this.require(1, "uint8");
    const value = this.view.getUint8(this.offsetValue);
    this.offsetValue += 1;
    return value;
  }

  uint16(): number {
    this.require(2, "uint16");
    const value = this.view.getUint16(this.offsetValue, true);
    this.offsetValue += 2;
    return value;
  }

  uint32(): number {
    this.require(4, "uint32");
    const value = this.view.getUint32(this.offsetValue, true);
    this.offsetValue += 4;
    return value;
  }

  uint64(): bigint {
    this.require(8, "uint64");
    const value = this.view.getBigUint64(this.offsetValue, true);
    this.offsetValue += 8;
    return value;
  }

  bytes(length: number): Uint8Array {
    assertIntegerInRange(length, 0, UINT32_MAX, "byte length");
    this.require(length, "byte sequence");
    const value = this.bytesValue.slice(this.offsetValue, this.offsetValue + length);
    this.offsetValue += length;
    return value;
  }

  string(): string {
    const encodedCodeUnits = this.uint8();
    if (encodedCodeUnits === 0) {
      return "";
    }
    this.require(encodedCodeUnits * 2, "PTP string");

    let result = "";
    for (let index = 0; index < encodedCodeUnits; index += 1) {
      const codeUnit = this.uint16();
      const isTerminator = index === encodedCodeUnits - 1;
      if (isTerminator) {
        if (codeUnit !== 0) {
          throw new MtpCodecError("PTP string is missing its final NUL terminator", this.offsetValue - 2);
        }
      } else {
        if (codeUnit === 0) {
          throw new MtpCodecError("PTP string contains an early NUL terminator", this.offsetValue - 2);
        }
        result += String.fromCharCode(codeUnit);
      }
    }
    return result;
  }

  uint16Array(maxItems = 65_536): number[] {
    return this.integerArray(2, maxItems, () => this.uint16());
  }

  uint32Array(maxItems = 1_000_000): number[] {
    return this.integerArray(4, maxItems, () => this.uint32());
  }

  expectEnd(label = "dataset"): void {
    if (this.remaining !== 0) {
      throw new MtpCodecError(`${label} has ${this.remaining} unexpected trailing byte(s)`, this.offsetValue);
    }
  }

  private integerArray(itemSize: number, maxItems: number, readItem: () => number): number[] {
    assertIntegerInRange(maxItems, 0, UINT32_MAX, "maximum array items");
    const count = this.uint32();
    if (count > maxItems) {
      throw new MtpCodecError(`array count ${count} exceeds the configured limit ${maxItems}`, this.offsetValue - 4);
    }
    if (count > Math.floor(this.remaining / itemSize)) {
      throw new MtpCodecError(`array declares ${count} item(s), but its payload is truncated`, this.offsetValue);
    }
    const result = new Array<number>(count);
    for (let index = 0; index < count; index += 1) {
      result[index] = readItem();
    }
    return result;
  }

  private require(length: number, label: string): void {
    if (length > this.remaining) {
      throw new MtpCodecError(
        `cannot read ${label}: need ${length} byte(s), only ${this.remaining} remain`,
        this.offsetValue,
      );
    }
  }
}

export interface MtpContainer {
  readonly length: number;
  readonly type: MtpContainerType;
  readonly code: number;
  readonly transactionId: number;
  readonly payload: Uint8Array;
}

export interface MtpContainerHeader {
  readonly length: number;
  readonly type: number;
  readonly code: number;
  readonly transactionId: number;
}

export function decodeContainerHeader(value: ArrayBuffer | ArrayBufferView): MtpContainerHeader {
  const bytes = asUint8Array(value);
  if (bytes.byteLength < MTP_CONTAINER_HEADER_SIZE) {
    throw new MtpCodecError(
      `MTP container header is truncated: expected ${MTP_CONTAINER_HEADER_SIZE} bytes, received ${bytes.byteLength}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    length: view.getUint32(0, true),
    type: view.getUint16(4, true),
    code: view.getUint16(6, true),
    transactionId: view.getUint32(8, true),
  };
}

export function decodeContainer(
  value: ArrayBuffer | ArrayBufferView,
  maximumLength = UINT32_MAX,
): MtpContainer {
  const bytes = asUint8Array(value);
  const header = decodeContainerHeader(bytes);
  if (header.length < MTP_CONTAINER_HEADER_SIZE) {
    throw new MtpCodecError(`invalid MTP container length ${header.length}`);
  }
  if (header.length > maximumLength) {
    throw new MtpCodecError(
      `MTP container length ${header.length} exceeds the configured limit ${maximumLength}`,
    );
  }
  if (header.length !== bytes.byteLength) {
    throw new MtpCodecError(
      `MTP container declares ${header.length} byte(s), but received ${bytes.byteLength}`,
    );
  }
  if (!Object.values(MtpContainerType).includes(header.type as MtpContainerType)) {
    throw new MtpCodecError(`unknown MTP container type ${header.type}`);
  }
  return {
    ...header,
    type: header.type as MtpContainerType,
    payload: bytes.slice(MTP_CONTAINER_HEADER_SIZE),
  };
}

export function encodeContainerHeader(
  type: MtpContainerType,
  code: number,
  transactionId: number,
  payloadLength: number,
): Uint8Array {
  assertIntegerInRange(code, 0, UINT16_MAX, "container code");
  assertIntegerInRange(transactionId, 0, UINT32_MAX, "transaction ID");
  assertIntegerInRange(payloadLength, 0, UINT32_MAX - MTP_CONTAINER_HEADER_SIZE, "container payload length");
  const writer = new MtpDatasetWriter();
  return writer
    .uint32(MTP_CONTAINER_HEADER_SIZE + payloadLength)
    .uint16(type)
    .uint16(code)
    .uint32(transactionId)
    .finish();
}

export function encodeContainer(
  type: MtpContainerType,
  code: number,
  transactionId: number,
  payload: ArrayBuffer | ArrayBufferView = new Uint8Array(),
): Uint8Array {
  const payloadBytes = asUint8Array(payload);
  const header = encodeContainerHeader(type, code, transactionId, payloadBytes.byteLength);
  const result = new Uint8Array(header.byteLength + payloadBytes.byteLength);
  result.set(header, 0);
  result.set(payloadBytes, header.byteLength);
  return result;
}

export function encodeContainerParameters(parameters: readonly number[]): Uint8Array {
  if (parameters.length > MTP_MAX_CONTAINER_PARAMETERS) {
    throw new MtpCodecError(
      `MTP command/response containers support at most ${MTP_MAX_CONTAINER_PARAMETERS} parameters`,
    );
  }
  const writer = new MtpDatasetWriter();
  for (const parameter of parameters) {
    writer.uint32(parameter);
  }
  return writer.finish();
}

export function decodeContainerParameters(payload: ArrayBuffer | ArrayBufferView): number[] {
  const reader = new MtpDatasetReader(payload);
  if (reader.remaining % 4 !== 0) {
    throw new MtpCodecError(
      `MTP parameter payload length ${reader.remaining} is not divisible by four`,
    );
  }
  const count = reader.remaining / 4;
  if (count > MTP_MAX_CONTAINER_PARAMETERS) {
    throw new MtpCodecError(
      `MTP container carries ${count} parameters; maximum is ${MTP_MAX_CONTAINER_PARAMETERS}`,
    );
  }
  const parameters: number[] = [];
  while (reader.remaining > 0) {
    parameters.push(reader.uint32());
  }
  return parameters;
}

export function encodeCommandContainer(
  operationCode: number,
  transactionId: number,
  parameters: readonly number[] = [],
): Uint8Array {
  return encodeContainer(
    MtpContainerType.Command,
    operationCode,
    transactionId,
    encodeContainerParameters(parameters),
  );
}

export function encodeResponseContainer(
  responseCode: number,
  transactionId: number,
  parameters: readonly number[] = [],
): Uint8Array {
  return encodeContainer(
    MtpContainerType.Response,
    responseCode,
    transactionId,
    encodeContainerParameters(parameters),
  );
}

export function encodeDataContainer(
  operationCode: number,
  transactionId: number,
  payload: ArrayBuffer | ArrayBufferView,
): Uint8Array {
  return encodeContainer(MtpContainerType.Data, operationCode, transactionId, payload);
}
