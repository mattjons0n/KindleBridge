export interface KindleBookFixtureOptions {
  readonly databaseTitle?: string;
  readonly mobiTitle?: string;
  readonly exthTitle?: string;
  readonly authors?: readonly string[];
  readonly isbn?: string;
  readonly source?: string;
  readonly asin113?: string;
  readonly asin504?: string;
  readonly language?: string;
  readonly extraExthRecords?: readonly {
    readonly type: number;
    readonly value: string | Uint8Array;
  }[];
}

const RECORD0_OFFSET = 96;
const MOBI_HEADER_LENGTH = 0xe4;
const TEXT_RECORD = new TextEncoder().encode("<html><body>Fixture book content</body></html>");

function setAscii(bytes: Uint8Array, offset: number, value: string): void {
  bytes.set(new TextEncoder().encode(value), offset);
}

export function makeKindleBookFixture(
  options: KindleBookFixtureOptions = {},
): Uint8Array {
  const encoder = new TextEncoder();
  const records: Array<{ type: number; value: Uint8Array }> = [];
  const add = (type: number, value: string | Uint8Array | undefined): void => {
    if (value === undefined) return;
    records.push({ type, value: typeof value === "string" ? encoder.encode(value) : value });
  };
  for (const author of options.authors ?? []) add(100, author);
  add(104, options.isbn);
  add(112, options.source);
  add(113, options.asin113);
  add(503, options.exthTitle);
  add(504, options.asin504);
  add(524, options.language);
  for (const record of options.extraExthRecords ?? []) add(record.type, record.value);

  const exthLength = records.length === 0
    ? 0
    : 12 + records.reduce((sum, record) => sum + 8 + record.value.byteLength, 0);
  const exthOffset = 16 + MOBI_HEADER_LENGTH;
  const mobiTitle = encoder.encode(options.mobiTitle ?? "Fallback MOBI title");
  const titleOffset = exthOffset + exthLength;
  const record0Length = titleOffset + mobiTitle.byteLength;
  const bytes = new Uint8Array(RECORD0_OFFSET + record0Length + TEXT_RECORD.byteLength);
  const view = new DataView(bytes.buffer);

  setAscii(bytes, 0, options.databaseTitle ?? "Palm database title");
  setAscii(bytes, 60, "BOOKMOBI");
  view.setUint16(76, 2, false);
  view.setUint32(78, RECORD0_OFFSET, false);
  view.setUint32(86, RECORD0_OFFSET + record0Length, false);

  const record0 = RECORD0_OFFSET;
  view.setUint16(record0, 2, false);
  view.setUint32(record0 + 4, TEXT_RECORD.byteLength, false);
  view.setUint16(record0 + 8, 1, false);
  view.setUint16(record0 + 10, 4096, false);
  setAscii(bytes, record0 + 16, "MOBI");
  view.setUint32(record0 + 20, MOBI_HEADER_LENGTH, false);
  view.setUint32(record0 + 24, 2, false);
  view.setUint32(record0 + 28, 65001, false);
  view.setUint32(record0 + 36, 8, false);
  view.setUint32(record0 + 0x54, titleOffset, false);
  view.setUint32(record0 + 0x58, mobiTitle.byteLength, false);
  if (records.length > 0) view.setUint32(record0 + 0x80, 0x40, false);

  if (records.length > 0) {
    let cursor = record0 + exthOffset;
    setAscii(bytes, cursor, "EXTH");
    view.setUint32(cursor + 4, exthLength, false);
    view.setUint32(cursor + 8, records.length, false);
    cursor += 12;
    for (const record of records) {
      view.setUint32(cursor, record.type, false);
      view.setUint32(cursor + 4, 8 + record.value.byteLength, false);
      bytes.set(record.value, cursor + 8);
      cursor += 8 + record.value.byteLength;
    }
  }
  bytes.set(mobiTitle, record0 + titleOffset);
  bytes.set(TEXT_RECORD, record0 + record0Length);
  return bytes;
}
