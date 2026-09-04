const encoder = new TextEncoder();
const ION_MAGIC = Uint8Array.of(0xe0, 0x01, 0x00, 0xea);

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function le16(value: number): Uint8Array {
  const result = new Uint8Array(2);
  new DataView(result.buffer).setUint16(0, value, true);
  return result;
}

function le32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, true);
  return result;
}

function le64(value: number): Uint8Array {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, BigInt(value), true);
  return result;
}

export function varUInt(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid varuint fixture");
  const groups = [value & 0x7f];
  let remaining = Math.floor(value / 128);
  while (remaining > 0) {
    groups.unshift(remaining & 0x7f);
    remaining = Math.floor(remaining / 128);
  }
  groups[groups.length - 1] = groups.at(-1)! | 0x80;
  return Uint8Array.from(groups);
}

function typed(type: number, payload: Uint8Array): Uint8Array {
  const length = payload.byteLength;
  return length < 14
    ? concatBytes(Uint8Array.of((type << 4) | length), payload)
    : concatBytes(Uint8Array.of((type << 4) | 14), varUInt(length), payload);
}

export function ionString(value: string): Uint8Array {
  return typed(8, encoder.encode(value));
}

export function ionList(...values: readonly Uint8Array[]): Uint8Array {
  return typed(12, concatBytes(...values));
}

export function ionObject(entries: readonly (readonly [number, Uint8Array])[]): Uint8Array {
  return typed(13, concatBytes(...entries.flatMap(([key, value]) => [varUInt(key), value])));
}

export function ionTyped(value: Uint8Array): Uint8Array {
  return typed(14, concatBytes(varUInt(1), varUInt(1), value));
}

export function kfxEntity(type: number, id: number, value: Uint8Array): {
  readonly type: number;
  readonly id: number;
  readonly bytes: Uint8Array;
} {
  return {
    type,
    id,
    bytes: concatBytes(encoder.encode("ENTY"), le16(1), le32(10), ION_MAGIC, value),
  };
}

export function kfxContainer(
  entities: readonly { readonly type: number; readonly id: number; readonly bytes: Uint8Array }[],
): Uint8Array {
  const headerLength = 18 + entities.length * 24 + ION_MAGIC.byteLength;
  let entityOffset = 0;
  const descriptors = entities.map((entity) => {
    const descriptor = concatBytes(
      le32(entity.id),
      le32(entity.type),
      le64(entityOffset),
      le64(entity.bytes.byteLength),
    );
    entityOffset += entity.bytes.byteLength;
    return descriptor;
  });
  return concatBytes(
    encoder.encode("CONT"),
    le16(1),
    le32(headerLength),
    new Uint8Array(8),
    ...descriptors,
    ION_MAGIC,
    ...entities.map(({ bytes }) => bytes),
  );
}

export function matchingKfxMetadataFixture(): Uint8Array {
  const direct = kfxEntity(258, 1, ionTyped(ionObject([
    [153, ionString("The Example")],
    [222, ionList(ionString("Ada Author"), ionString("Ben Writer"))],
    [10, ionList(ionString("en"))],
  ])));
  const metadata = (key: string, value: Uint8Array): Uint8Array => ionObject([
    [492, ionString(key)],
    [307, value],
  ]);
  const nested = kfxEntity(490, 2, ionObject([
    [491, ionList(ionObject([
      [258, ionList(
        metadata("title", ionString("The Example")),
        metadata("ASIN", ionString("B012345678")),
        metadata("isbn", ionString("9781234567890")),
      )],
    ]))],
  ]));
  return kfxContainer([direct, nested]);
}
