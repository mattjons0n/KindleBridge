import { describe, expect, it } from "vitest";
import {
  classifyKindleModificationDate,
  createKindleModificationDateProbe,
} from "../../client/src/kindle/modification-date-diagnostics";

const identity = "d".repeat(64);

function candidate(
  relativePath: string,
  rawModificationDate: string,
  overrides: Partial<{
    readonly objectFormat: number;
    readonly size: number;
    readonly metadataAdjusted: boolean;
    readonly uniquePath: boolean;
  }> = {},
) {
  return {
    relativePath,
    rawModificationDate,
    objectFormat: 0x3000,
    size: 123,
    metadataAdjusted: false,
    uniquePath: true,
    ...overrides,
  };
}

describe("privacy-safe Kindle modification-date diagnostics", () => {
  it("classifies fixed timestamp shapes without returning raw values", () => {
    expect(classifyKindleModificationDate("20260830T123456Z")).toBe("canonical-mtp");
    expect(classifyKindleModificationDate("20260830T123456+02:00")).toBe("basic-colon-offset");
    expect(classifyKindleModificationDate("2026-08-30T12:34:56Z")).toBe("extended-iso");
    expect(classifyKindleModificationDate("2026-08-30 12:34:56Z")).toBe("extended-iso-space");
    expect(classifyKindleModificationDate("20260830t123456z")).toBe("lowercase-marker");
    expect(classifyKindleModificationDate(" 20260830T123456Z ")).toBe("surrounding-whitespace");
    expect(classifyKindleModificationDate("20260830T123456Z\0")).toBe("trailing-null");
    expect(classifyKindleModificationDate("1725021296000")).toBe("digits-only");
  });

  it("reports aggregate shape and exact reconnect stability only", () => {
    const probe = createKindleModificationDateProbe();
    const privateDate = "2026-08-30T12:34:56Z";
    probe.recordSelfTest({
      deviceKey: identity,
      storageId: 1,
      requestedModificationDate: new Date("2026-08-30T12:34:56Z"),
      returnedModificationDate: privateDate,
    });

    const first = probe.observe({
      deviceKey: identity,
      storageId: 1,
      candidates: [
        candidate("Private/One.azw3", privateDate),
        candidate("Private/Two.azw3", privateDate),
        candidate("Private/Missing.azw3", ""),
      ],
    });
    expect(first).toMatchObject({
      candidateObjectCount: 3,
      sampledObjectCount: 3,
      nonemptyValueObjectCount: 2,
      distinctValueCount: 1,
      mostCommonValueObjectCount: 2,
      minimumCodeUnitLength: 20,
      maximumCodeUnitLength: 20,
      shapes: { extendedIso: 2 },
      features: { hyphen: 2, colon: 2 },
      reconnect: {
        outcome: "no-previous-snapshot",
        comparableObjectCount: 0,
      },
      selfTest: {
        returnedShape: "extended-iso",
        returnedCodeUnitLength: 20,
        exactRequestedValueMatch: false,
      },
    });

    const second = probe.observe({
      deviceKey: identity,
      storageId: 1,
      candidates: [
        candidate("Private/One.azw3", privateDate),
        candidate("Private/Two.azw3", "2026-08-30T12:34:57Z"),
        candidate("Private/New.azw3", privateDate),
      ],
    });
    expect(second.reconnect).toEqual({
      outcome: "compared",
      comparableObjectCount: 2,
      unchangedValueObjectCount: 1,
      changedValueObjectCount: 1,
      currentOnlyObjectCount: 1,
      previousOnlyObjectCount: 0,
    });
    const serialized = JSON.stringify({ first, second });
    expect(serialized).not.toContain(privateDate);
    expect(serialized).not.toContain("Private/One.azw3");
    expect(serialized).not.toContain(identity);
  });
});
