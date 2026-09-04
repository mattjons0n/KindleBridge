import { describe, expect, it } from "vitest";
import {
  KindleKfxMetadataError,
  parseKindleKfxMetadata,
} from "../../client/src/kindle/kfx-metadata";
import {
  concatBytes,
  ionList,
  ionObject,
  ionString,
  kfxContainer,
  kfxEntity,
  matchingKfxMetadataFixture,
  varUInt,
} from "./kfx-fixtures";

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected parser to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(KindleKfxMetadataError);
    expect((error as KindleKfxMetadataError).code).toBe(code);
  }
}

describe("bounded KFX metadata parser", () => {
  it("extracts only matching-relevant direct and nested metadata", () => {
    expect(parseKindleKfxMetadata(matchingKfxMetadataFixture())).toEqual({
      title: "The Example",
      authors: ["Ada Author", "Ben Writer"],
      identifiers: ["asin:B012345678", "isbn:9781234567890"],
      language: "en",
    });
  });

  it("rejects unsupported block versions and invalid entity bounds", () => {
    const version = matchingKfxMetadataFixture();
    version[4] = 2;
    expectCode(() => parseKindleKfxMetadata(version), "KFX_METADATA_UNSUPPORTED_VERSION");

    const bounds = matchingKfxMetadataFixture();
    new DataView(bounds.buffer).setBigUint64(18 + 8, BigInt(bounds.byteLength), true);
    expectCode(() => parseKindleKfxMetadata(bounds), "KFX_METADATA_INVALID_CONTAINER");
  });

  it("enforces input and entity-count limits before decoding", () => {
    const fixture = matchingKfxMetadataFixture();
    expectCode(
      () => parseKindleKfxMetadata(fixture, { maxInputBytes: fixture.byteLength - 1 }),
      "KFX_METADATA_INPUT_LIMIT",
    );
    expectCode(
      () => parseKindleKfxMetadata(fixture, { maxEntities: 1 }),
      "KFX_METADATA_ENTITY_LIMIT",
    );
  });

  it("rejects unterminated variable integers and duplicate fields", () => {
    const unterminated = kfxContainer([
      kfxEntity(258, 1, Uint8Array.of(0xde, 0x88, ...new Uint8Array(8).fill(1))),
    ]);
    expectCode(() => parseKindleKfxMetadata(unterminated), "KFX_METADATA_INVALID_ION");

    const duplicate = kfxContainer([
      kfxEntity(258, 1, ionObject([
        [153, ionString("One")],
        [153, ionString("One")],
      ])),
    ]);
    expectCode(() => parseKindleKfxMetadata(duplicate), "KFX_METADATA_CONFLICT");
  });

  it("enforces field, depth, string, and decoded-total bounds", () => {
    const fields = kfxContainer([kfxEntity(258, 1, ionObject([
      [153, ionString("Title")],
      [222, ionString("Author")],
    ]))]);
    expectCode(() => parseKindleKfxMetadata(fields, { maxFields: 3 }), "KFX_METADATA_FIELD_LIMIT");

    let nested = ionString("bottom");
    for (let count = 0; count < 4; count += 1) nested = ionList(nested);
    const depth = kfxContainer([kfxEntity(258, 1, nested)]);
    expectCode(() => parseKindleKfxMetadata(depth, { maxDepth: 2 }), "KFX_METADATA_DEPTH_LIMIT");

    const longString = kfxContainer([kfxEntity(258, 1, ionObject([
      [153, ionString("long title")],
    ]))]);
    expectCode(() => parseKindleKfxMetadata(longString, { maxStringBytes: 4 }), "KFX_METADATA_STRING_LIMIT");
    expectCode(() => parseKindleKfxMetadata(longString, { maxDecodedBytes: 20 }), "KFX_METADATA_DECODED_TOTAL_LIMIT");
  });

  it("rejects hostile UTF-8, trailing fields, and conflicting metadata", () => {
    const invalidUtf8String = Uint8Array.of(0x82, 0xc3, 0x28);
    const invalidUtf8 = kfxContainer([kfxEntity(258, 1, ionObject([[153, invalidUtf8String]]))]);
    expectCode(() => parseKindleKfxMetadata(invalidUtf8), "KFX_METADATA_INVALID_ION");

    const trailing = kfxContainer([kfxEntity(258, 1, concatBytes(ionObject([]), ionString("extra")))]);
    expectCode(() => parseKindleKfxMetadata(trailing), "KFX_METADATA_INVALID_ION");

    const metadata = (title: string) => ionObject([
      [492, ionString("title")],
      [307, ionString(title)],
    ] as const);
    const conflict = kfxContainer([
      kfxEntity(258, 1, ionObject([[153, ionString("First")]])),
      kfxEntity(490, 2, ionObject([[491, ionList(ionObject([[258, ionList(metadata("Second"))]]))]])),
    ]);
    expectCode(() => parseKindleKfxMetadata(conflict), "KFX_METADATA_CONFLICT");
  });

  it("rejects oversized or unterminated explicit lengths without allocation", () => {
    const hostileValue = concatBytes(Uint8Array.of(0x8e), varUInt(1_000_000));
    const fixture = kfxContainer([kfxEntity(258, 1, hostileValue)]);
    expectCode(() => parseKindleKfxMetadata(fixture), "KFX_METADATA_INVALID_ION");
  });
});
