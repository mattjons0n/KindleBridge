import { describe, expect, it } from "vitest";
import {
  KINDLE_BRIDGE_DEVICE_METADATA_CACHE_FILENAME_NAMESPACE,
  KINDLE_BRIDGE_DEVICE_METADATA_CACHE_MAGIC,
  KindleBridgeDeviceMetadataCacheCodecError,
  createKindleBridgeDeviceMetadataCacheFilename,
  decodeKindleBridgeDeviceMetadataCache,
  encodeKindleBridgeDeviceMetadataCache,
  isKindleBridgeDeviceMetadataCacheFilename,
  parseKindleBridgeDeviceMetadataCacheFilename,
  type KindleBridgeDeviceMetadataCache,
  type KindleBridgeDeviceMetadataCacheEntry,
} from "../../client/src/kindle/device-metadata-cache-codec";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function entry(
  relativePath: string,
  overrides: Partial<KindleBridgeDeviceMetadataCacheEntry> = {},
): KindleBridgeDeviceMetadataCacheEntry {
  return {
    relativePath,
    size: 12_345,
    modificationDate: "20260830T120000Z",
    objectFormat: 0xb00a,
    metadata: {
      title: "A portable title",
      authors: ["An Author"],
      identifiers: ["source:urn:uuid:book", "asin:B012345678"],
      language: "en",
    },
    ...overrides,
  };
}

function cache(
  entries: readonly KindleBridgeDeviceMetadataCacheEntry[],
  generation = 7,
): KindleBridgeDeviceMetadataCache {
  return { version: 1, parserRevision: 1, generation, entries };
}

async function expectCodecError(
  operation: Promise<unknown>,
  code: KindleBridgeDeviceMetadataCacheCodecError["code"],
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code });
}

describe("portable on-device Kindle metadata cache codec", () => {
  it("creates and parses exactly two deterministic root cache slots", () => {
    const slotA = createKindleBridgeDeviceMetadataCacheFilename("a");
    const slotB = createKindleBridgeDeviceMetadataCacheFilename("b");
    expect(slotA).toBe(`${KINDLE_BRIDGE_DEVICE_METADATA_CACHE_FILENAME_NAMESPACE}v1-a.json`);
    expect(slotB).toBe(`${KINDLE_BRIDGE_DEVICE_METADATA_CACHE_FILENAME_NAMESPACE}v1-b.json`);
    expect(parseKindleBridgeDeviceMetadataCacheFilename(slotA)).toBe("a");
    expect(parseKindleBridgeDeviceMetadataCacheFilename(slotB)).toBe("b");
    expect(isKindleBridgeDeviceMetadataCacheFilename(slotA)).toBe(true);
    expect(isKindleBridgeDeviceMetadataCacheFilename(slotB)).toBe(true);
    expect(() => createKindleBridgeDeviceMetadataCacheFilename("c" as "a")).toThrow(RangeError);
  });

  it.each([
    "Documents/.kindle-bridge-device-metadata-cache-v1-a.json",
    ".KINDLE-BRIDGE-DEVICE-METADATA-CACHE-v1-a.json",
    ".kindle-bridge-device-metadata-cache-v1.json",
    ".kindle-bridge-device-metadata-cache-v1-c.json",
    ".kindle-bridge-device-metadata-cache-v2-a.json",
    ".kindle-bridge-device-metadata-cache-v1-a.json.bak",
    "a-kindle-bridge-device-metadata-cache-v1-a.json",
    "ordinary-book.azw3",
  ])("does not recognize non-current or non-root cache lookalike %s", (filename) => {
    expect(parseKindleBridgeDeviceMetadataCacheFilename(filename)).toBeNull();
    expect(isKindleBridgeDeviceMetadataCacheFilename(filename)).toBe(false);
  });

  it("serializes deterministically, visibly, and round-trips without session identity", async () => {
    const first = cache([
      entry("Zed/Second.azw3", {
        metadata: {
          title: "Cafe\u0301",
          authors: ["Second Author", "First Author"],
          identifiers: ["source:z", "asin:a"],
        },
      }),
      entry("Alpha/First.azw3"),
    ]);
    const sameSemanticCache = cache([
      entry("Alpha/First.azw3"),
      entry("Zed/Second.azw3", {
        metadata: {
          title: "Caf\u00e9",
          authors: ["Second Author", "First Author"],
          identifiers: ["asin:a", "source:z"],
        },
      }),
    ]);

    const encoded = await encodeKindleBridgeDeviceMetadataCache(first);
    const repeated = await encodeKindleBridgeDeviceMetadataCache(sameSemanticCache);
    expect(encoded).toEqual(repeated);

    const text = decoder.decode(encoded);
    expect(text).toContain(`"magic":"${KINDLE_BRIDGE_DEVICE_METADATA_CACHE_MAGIC}"`);
    expect(text).toContain('"parserRevision":1');
    expect(text).toContain('"generation":7');
    expect(text).toContain('"objectFormat":45066');
    expect(text).toContain("Alpha/First.azw3");
    expect(text).toContain("A portable title");
    expect(text).not.toContain("storageId");
    expect(text).not.toContain("handle");
    expect(text).not.toContain("deviceKey");
    expect(text).toMatch(/"checksum":"[a-f0-9]{64}"/u);

    const decoded = await decodeKindleBridgeDeviceMetadataCache(encoded);
    expect(decoded).toEqual({
      version: 1,
      parserRevision: 1,
      generation: 7,
      entries: [
        entry("Alpha/First.azw3", {
          metadata: {
            title: "A portable title",
            authors: ["An Author"],
            identifiers: ["asin:B012345678", "source:urn:uuid:book"],
            language: "en",
          },
        }),
        entry("Zed/Second.azw3", {
          metadata: {
            title: "Caf\u00e9",
            authors: ["Second Author", "First Author"],
            identifiers: ["asin:a", "source:z"],
          },
        }),
      ],
    });
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.entries)).toBe(true);
    expect(Object.isFrozen(decoded.entries[0]?.metadata)).toBe(true);
  });

  it("preserves MTP relative-path code points byte-for-byte while normalizing display metadata", async () => {
    const decomposedPath = "Cafe\u0301/Book.azw3";
    const encoded = await encodeKindleBridgeDeviceMetadataCache(cache([
      entry(decomposedPath, {
        metadata: {
          title: "Cafe\u0301",
          authors: ["Author"],
          identifiers: [],
        },
      }),
    ]));
    const decoded = await decodeKindleBridgeDeviceMetadataCache(encoded);
    expect(decoded.entries[0]?.relativePath).toBe(decomposedPath);
    expect(decoded.entries[0]?.relativePath).not.toBe(decomposedPath.normalize("NFC"));
    expect(decoded.entries[0]?.metadata.title).toBe("Caf\u00e9");
  });

  it("detects content corruption and rejects alternate JSON representations", async () => {
    const encoded = await encodeKindleBridgeDeviceMetadataCache(cache([entry("Book.azw3")]));
    const text = decoder.decode(encoded);
    const corrupted = encoder.encode(text.replace("A portable title", "A portxble title"));
    await expectCodecError(
      decodeKindleBridgeDeviceMetadataCache(corrupted),
      "KINDLE_DEVICE_CACHE_CHECKSUM_MISMATCH",
    );

    const changedGeneration = encoder.encode(text.replace('"generation":7', '"generation":8'));
    await expectCodecError(
      decodeKindleBridgeDeviceMetadataCache(changedGeneration),
      "KINDLE_DEVICE_CACHE_CHECKSUM_MISMATCH",
    );

    const changedObjectFormat = encoder.encode(text.replace('"objectFormat":45066', '"objectFormat":45067'));
    await expectCodecError(
      decodeKindleBridgeDeviceMetadataCache(changedObjectFormat),
      "KINDLE_DEVICE_CACHE_CHECKSUM_MISMATCH",
    );

    const nonCanonical = encoder.encode(text.replace("{", "{ "));
    await expectCodecError(
      decodeKindleBridgeDeviceMetadataCache(nonCanonical),
      "KINDLE_DEVICE_CACHE_NON_CANONICAL",
    );
  });

  it("rejects invalid UTF-8, JSON, magic, version, and unknown fields with typed errors", async () => {
    await expectCodecError(
      decodeKindleBridgeDeviceMetadataCache(Uint8Array.of(0xff, 0xfe)),
      "KINDLE_DEVICE_CACHE_INVALID_UTF8",
    );
    await expectCodecError(
      decodeKindleBridgeDeviceMetadataCache(encoder.encode("{")),
      "KINDLE_DEVICE_CACHE_INVALID_JSON",
    );

    const validText = decoder.decode(
      await encodeKindleBridgeDeviceMetadataCache(cache([entry("Book.azw3")])),
    );
    await expectCodecError(
      decodeKindleBridgeDeviceMetadataCache(encoder.encode(validText.replace(
        KINDLE_BRIDGE_DEVICE_METADATA_CACHE_MAGIC,
        "NOT-KINDLE-BRIDGE",
      ))),
      "KINDLE_DEVICE_CACHE_INVALID_SCHEMA",
    );
    await expectCodecError(
      decodeKindleBridgeDeviceMetadataCache(encoder.encode(validText.replace('"version":1', '"version":2'))),
      "KINDLE_DEVICE_CACHE_UNSUPPORTED_VERSION",
    );
    await expectCodecError(
      decodeKindleBridgeDeviceMetadataCache(encoder.encode(
        validText.replace('"parserRevision":1', '"parserRevision":2'),
      )),
      "KINDLE_DEVICE_CACHE_INVALID_SCHEMA",
    );
    await expectCodecError(
      decodeKindleBridgeDeviceMetadataCache(encoder.encode(validText.replace('"generation":7', '"generation":-1'))),
      "KINDLE_DEVICE_CACHE_INVALID_SCHEMA",
    );
    await expectCodecError(
      decodeKindleBridgeDeviceMetadataCache(encoder.encode(validText.replace(
        '"version":1',
        '"version":1,"unexpected":true',
      ))),
      "KINDLE_DEVICE_CACHE_INVALID_SCHEMA",
    );
  });

  it("enforces entry and encoded-byte limits before accepting a cache", async () => {
    const twoEntries = cache([entry("One.azw3"), entry("Two.azw3")]);
    await expectCodecError(
      encodeKindleBridgeDeviceMetadataCache(twoEntries, { maxEntries: 1 }),
      "KINDLE_DEVICE_CACHE_ENTRY_LIMIT",
    );

    const encoded = await encodeKindleBridgeDeviceMetadataCache(twoEntries);
    await expectCodecError(
      decodeKindleBridgeDeviceMetadataCache(encoded, { maxEntries: 1 }),
      "KINDLE_DEVICE_CACHE_ENTRY_LIMIT",
    );
    await expectCodecError(
      decodeKindleBridgeDeviceMetadataCache(encoded, { maxBytes: encoded.byteLength - 1 }),
      "KINDLE_DEVICE_CACHE_INPUT_LIMIT",
    );
  });

  it.each([
    ["../Book.azw3", "KINDLE_DEVICE_CACHE_INVALID_PATH"],
    ["/Book.azw3", "KINDLE_DEVICE_CACHE_INVALID_PATH"],
    ["Folder\\Book.azw3", "KINDLE_DEVICE_CACHE_INVALID_PATH"],
    ["Folder//Book.azw3", "KINDLE_DEVICE_CACHE_INVALID_PATH"],
    [
      ".kindle-bridge-device-metadata-cache-v1-a.json",
      "KINDLE_DEVICE_CACHE_INVALID_PATH",
    ],
    [
      "Documents/.KINDLE-BRIDGE-DEVICE-METADATA-CACHE-future-format.json",
      "KINDLE_DEVICE_CACHE_INVALID_PATH",
    ],
  ] as const)("rejects unsafe or reserved portable path %s", async (relativePath, code) => {
    await expectCodecError(encodeKindleBridgeDeviceMetadataCache(cache([entry(relativePath)])), code);
  });

  it("rejects ambiguous paths and hostile metadata fields", async () => {
    await expectCodecError(
      encodeKindleBridgeDeviceMetadataCache(cache([entry("Book.azw3"), entry("book.AZW3")])),
      "KINDLE_DEVICE_CACHE_DUPLICATE_PATH",
    );
    await expectCodecError(
      encodeKindleBridgeDeviceMetadataCache(cache([entry("Book.azw3", { size: 0x1_0000_0000 })])),
      "KINDLE_DEVICE_CACHE_INVALID_SCHEMA",
    );
    for (const objectFormat of [-1, 0x1_0000, 1.5]) {
      await expectCodecError(
        encodeKindleBridgeDeviceMetadataCache(cache([entry("Book.azw3", { objectFormat })])),
        "KINDLE_DEVICE_CACHE_INVALID_SCHEMA",
      );
    }
    await expectCodecError(
      encodeKindleBridgeDeviceMetadataCache(cache([entry("Book.azw3", {
        modificationDate: "not-an-mtp-date",
      })])),
      "KINDLE_DEVICE_CACHE_INVALID_SCHEMA",
    );
    await expectCodecError(
      encodeKindleBridgeDeviceMetadataCache(cache([entry("Book.azw3", {
        metadata: {
          authors: Array.from({ length: 65 }, (_unused, index) => `Author ${index}`),
          identifiers: [],
        },
      })])),
      "KINDLE_DEVICE_CACHE_FIELD_LIMIT",
    );
    await expectCodecError(
      encodeKindleBridgeDeviceMetadataCache(cache([entry("Book.azw3", {
        metadata: {
          title: "x".repeat(4_097),
          authors: [],
          identifiers: [],
        },
      })])),
      "KINDLE_DEVICE_CACHE_FIELD_LIMIT",
    );
  });

  it("accepts only bounded nonnegative safe-integer generations and parser revision 1", async () => {
    for (const generation of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expectCodecError(
        encodeKindleBridgeDeviceMetadataCache(cache([], generation)),
        "KINDLE_DEVICE_CACHE_INVALID_SCHEMA",
      );
    }
    await expect(
      decodeKindleBridgeDeviceMetadataCache(
        await encodeKindleBridgeDeviceMetadataCache(cache([], Number.MAX_SAFE_INTEGER)),
      ),
    ).resolves.toMatchObject({ generation: Number.MAX_SAFE_INTEGER, parserRevision: 1 });

    await expectCodecError(
      encodeKindleBridgeDeviceMetadataCache({
        ...cache([]),
        parserRevision: 2,
      } as unknown as KindleBridgeDeviceMetadataCache),
      "KINDLE_DEVICE_CACHE_INVALID_SCHEMA",
    );
  });

  it("requires a working SHA-256 implementation rather than accepting unchecked data", async () => {
    await expectCodecError(
      encodeKindleBridgeDeviceMetadataCache(cache([]), { subtleCrypto: null }),
      "KINDLE_DEVICE_CACHE_CHECKSUM_UNAVAILABLE",
    );
    await expectCodecError(
      encodeKindleBridgeDeviceMetadataCache(cache([]), {
        subtleCrypto: {
          digest: async () => new ArrayBuffer(1),
        },
      }),
      "KINDLE_DEVICE_CACHE_CHECKSUM_UNAVAILABLE",
    );
  });
});
