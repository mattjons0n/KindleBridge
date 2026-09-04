import { describe, expect, it } from "vitest";
import {
  KindleKrdsReadingError,
  parseKindleKrdsReadingEvidence,
} from "../../client/src/kindle/krds-reading-state";
import { concatBytes } from "./kfx-fixtures";
import {
  krdsContainer,
  krdsDouble,
  krdsInt,
  krdsLong,
  krdsObject,
  krdsString,
  lpr,
  readingKrdsFixture,
  timerModel,
} from "./krds-fixtures";

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected parser to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(KindleKrdsReadingError);
    expect((error as KindleKrdsReadingError).code).toBe(code);
  }
}

describe("bounded KRDS reading evidence", () => {
  it("extracts documented timer percentage and lpr time without asserting Read/Unread", () => {
    expect(parseKindleKrdsReadingEvidence(readingKrdsFixture(), "azw3f")).toEqual({
      status: "in-progress",
      progressPercent: 42,
      lastReadAt: "2026-09-03T12:00:00.000Z",
      provenance: "azw3f",
      freshness: "live",
      explicitState: false,
    });
    expect(parseKindleKrdsReadingEvidence(readingKrdsFixture(1), "yjf")).toMatchObject({
      status: "in-progress",
      progressPercent: 100,
      explicitState: false,
    });
    expect(parseKindleKrdsReadingEvidence(readingKrdsFixture(0), "mbs")).toMatchObject({
      status: "unknown",
      progressPercent: 0,
      explicitState: false,
    });
  });

  it("returns unknown, not unread, when only a documented last-read time exists", () => {
    expect(parseKindleKrdsReadingEvidence(
      krdsContainer(lpr(Date.UTC(2026, 0, 2))),
      "azw3r",
    )).toEqual({
      status: "unknown",
      lastReadAt: "2026-01-02T00:00:00.000Z",
      provenance: "azw3r",
      freshness: "live",
      explicitState: false,
    });
  });

  it("rejects bad signatures, unsupported container versions, and truncation", () => {
    const signature = readingKrdsFixture();
    signature[0] = 1;
    expectCode(() => parseKindleKrdsReadingEvidence(signature, "azw3f"), "KRDS_READING_INVALID_SIGNATURE");

    const version = readingKrdsFixture();
    new DataView(version.buffer).setInt32(9, 2, false);
    expectCode(() => parseKindleKrdsReadingEvidence(version, "azw3f"), "KRDS_READING_UNSUPPORTED_VERSION");

    const truncated = readingKrdsFixture().subarray(0, readingKrdsFixture().byteLength - 1);
    expectCode(() => parseKindleKrdsReadingEvidence(truncated, "azw3f"), "KRDS_READING_TRUNCATED");
  });

  it("enforces input, object, value, field, depth, string, and decoded-total limits", () => {
    const fixture = readingKrdsFixture();
    expectCode(
      () => parseKindleKrdsReadingEvidence(fixture, "azw3f", { maxInputBytes: fixture.byteLength - 1 }),
      "KRDS_READING_INPUT_LIMIT",
    );
    expectCode(
      () => parseKindleKrdsReadingEvidence(fixture, "azw3f", { maxTopLevelObjects: 1 }),
      "KRDS_READING_OBJECT_LIMIT",
    );
    expectCode(
      () => parseKindleKrdsReadingEvidence(fixture, "azw3f", { maxObjects: 2 }),
      "KRDS_READING_OBJECT_LIMIT",
    );
    expectCode(
      () => parseKindleKrdsReadingEvidence(fixture, "azw3f", { maxValues: 4 }),
      "KRDS_READING_VALUE_LIMIT",
    );
    expectCode(
      () => parseKindleKrdsReadingEvidence(fixture, "azw3f", { maxObjectValues: 3 }),
      "KRDS_READING_VALUE_LIMIT",
    );

    let nested = krdsObject("bottom", krdsInt(1));
    for (let count = 0; count < 4; count += 1) nested = krdsObject(`level-${count}`, nested);
    expectCode(
      () => parseKindleKrdsReadingEvidence(krdsContainer(nested), "azw3f", { maxDepth: 2 }),
      "KRDS_READING_DEPTH_LIMIT",
    );

    const longString = krdsContainer(krdsObject("payload", krdsString("a long value")));
    expectCode(
      () => parseKindleKrdsReadingEvidence(longString, "azw3f", { maxStringBytes: 5 }),
      "KRDS_READING_STRING_LIMIT",
    );
    expectCode(
      () => parseKindleKrdsReadingEvidence(longString, "azw3f", { maxDecodedBytes: 40 }),
      "KRDS_READING_DECODED_TOTAL_LIMIT",
    );
  });

  it("rejects duplicate/conflicting progress, invalid values, and unsupported field versions", () => {
    expectCode(
      () => parseKindleKrdsReadingEvidence(
        krdsContainer(timerModel(0.2), timerModel(0.2)),
        "azw3f",
      ),
      "KRDS_READING_CONFLICT",
    );
    const conflict = krdsContainer(
      krdsObject("outer-one", timerModel(0.2)),
      krdsObject("outer-two", timerModel(0.3)),
    );
    expectCode(() => parseKindleKrdsReadingEvidence(conflict, "azw3f"), "KRDS_READING_CONFLICT");
    expectCode(
      () => parseKindleKrdsReadingEvidence(krdsContainer(timerModel(1.1)), "azw3f"),
      "KRDS_READING_TYPE_INVALID",
    );
    const invalidLpr = krdsContainer(krdsObject(
      "lpr",
      krdsInt(3),
      krdsString("position"),
      krdsLong(1_700_000_000_000),
    ));
    expectCode(() => parseKindleKrdsReadingEvidence(invalidLpr, "azw3r"), "KRDS_READING_UNSUPPORTED_VERSION");
  });

  it("rejects invalid UTF-8, misplaced terminators, trailing bytes, and non-finite numbers", () => {
    const invalidUtf = krdsContainer(krdsObject("outer", Uint8Array.of(3, 0, 0, 1, 0xff)));
    expectCode(() => parseKindleKrdsReadingEvidence(invalidUtf, "azw3f"), "KRDS_READING_TYPE_INVALID");

    const misplaced = concatBytes(
      Uint8Array.of(0, 0, 0, 0, 0, 0x1a, 0xb1, 0x26),
      krdsInt(1),
      krdsInt(1),
      Uint8Array.of(0xff),
    );
    expectCode(() => parseKindleKrdsReadingEvidence(misplaced, "azw3f"), "KRDS_READING_TYPE_INVALID");

    expectCode(
      () => parseKindleKrdsReadingEvidence(concatBytes(krdsContainer(), Uint8Array.of(0)), "azw3f"),
      "KRDS_READING_CONFLICT",
    );

    const nan = krdsContainer(krdsObject(
      "timer.model",
      krdsLong(1),
      krdsLong(1),
      krdsLong(1),
      krdsDouble(Number.NaN),
    ));
    expectCode(() => parseKindleKrdsReadingEvidence(nan, "azw3f"), "KRDS_READING_TYPE_INVALID");
  });
});
