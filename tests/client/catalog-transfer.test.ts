// @vitest-environment jsdom

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MAX_KINDLE_ARTIFACT_BYTES } from "../../client/src/book-limits";
import { MAX_CATALOG_SOURCE_BYTES, prepareCatalogArtifact } from "../../client/src/catalog-transfer";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function epubBytes(): Uint8Array {
  return Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);
}

describe("catalog transfer preparation", () => {
  it("verifies the indexed source before converting an immutable EPUB copy", async () => {
    const bytes = epubBytes();
    const source = new Blob([Uint8Array.from(bytes)], { type: "application/epub+zip" });
    const output = new Blob([Uint8Array.from([9, 8, 7])]);
    const convertEpub = vi.fn(async (
      file: File,
      _signal?: AbortSignal,
      _overrides?: { readonly title?: string; readonly authors?: readonly string[] },
    ) => ({
      filename: "Example.azw3",
      blob: output,
      metadata: { title: "Example", authors: ["Author"], language: "en", chapters: 1, toc_entries: 1 },
      diagnostics: {
        engine: "boko-wasm" as const,
        runsLocally: true as const,
        inputBytes: file.size,
        outputBytes: output.size,
        kindleDocumentType: "PDOC" as const,
        embeddedCover: true,
      },
    }));
    const phases: string[] = [];
    const overrides = { title: "Edited Example", authors: ["Edited Author"] } as const;

    const result = await prepareCatalogArtifact({
      id: "book-1",
      title: "Example",
      format: "EPUB",
      size: source.size,
      contentHash: hash(bytes),
    }, source, { convertEpub, overrides, onPhase: (phase) => phases.push(phase) });

    expect(result.filename).toBe("Example.azw3");
    expect(result.sourceHash).toBe(hash(bytes));
    expect(result.converted).toBe(true);
    expect(result.embeddedCover).toBe(true);
    expect(result.overridesApplied).toBe(true);
    expect(phases).toEqual(["preparing", "converting", "ready"]);
    expect(convertEpub).toHaveBeenCalledOnce();
    expect(convertEpub.mock.calls[0]?.[2]).toBe(overrides);
    expect(new Uint8Array(await source.arrayBuffer())).toEqual(bytes);
  });

  it("normalizes a structurally detected EPUB to an .epub worker filename even when the source was mislabeled", async () => {
    const bytes = epubBytes();
    const source = new Blob([Uint8Array.from(bytes)]);
    const output = new Blob([Uint8Array.from([9, 8, 7])]);
    const convertEpub = vi.fn(async (_file: File) => ({
      filename: "Mislabeled.azw3",
      blob: output,
      metadata: { title: "Mislabeled", authors: ["Author"], language: "en", chapters: 1, toc_entries: 1 },
      diagnostics: {
        engine: "boko-wasm" as const,
        runsLocally: true as const,
        inputBytes: source.size,
        outputBytes: output.size,
        kindleDocumentType: "PDOC" as const,
        embeddedCover: true,
      },
    }));

    await prepareCatalogArtifact({
      id: "book-mislabeled",
      title: "Mislabeled",
      sourceFilename: "Mislabeled.azw3",
      format: "EPUB",
      size: source.size,
      contentHash: hash(bytes),
    }, source, { convertEpub });

    expect(convertEpub.mock.calls[0]?.[0].name).toBe("Mislabeled.epub");
  });

  it("blocks sources whose size, hash, or structure no longer match the index", async () => {
    const bytes = epubBytes();
    const source = new Blob([Uint8Array.from(bytes)]);
    const convertEpub = vi.fn();

    await expect(prepareCatalogArtifact({
      id: "book-1", title: "Example", format: "EPUB", size: source.size + 1, contentHash: hash(bytes),
    }, source, { convertEpub })).rejects.toMatchObject({ code: "CATALOG_SOURCE_CHANGED" });

    await expect(prepareCatalogArtifact({
      id: "book-1", title: "Example", format: "EPUB", size: source.size, contentHash: "0".repeat(64),
    }, source, { convertEpub })).rejects.toMatchObject({ code: "CATALOG_SOURCE_CHANGED" });

    await expect(prepareCatalogArtifact({
      id: "book-1", title: "Example", format: "AZW3", size: source.size, contentHash: hash(bytes),
    }, source, { convertEpub })).rejects.toMatchObject({ code: "CATALOG_FORMAT_MISMATCH" });
    expect(convertEpub).not.toHaveBeenCalled();
  });

  it("requires a catalog SHA-256 instead of trusting an unverified source", async () => {
    const bytes = epubBytes();
    const source = new Blob([Uint8Array.from(bytes)]);

    await expect(prepareCatalogArtifact({
      id: "book-1", title: "Example", format: "EPUB", size: source.size,
    }, source, { convertEpub: vi.fn() })).rejects.toMatchObject({ code: "CATALOG_HASH_MISSING" });
  });

  it("fails clearly instead of applying variable-length overrides to a copied AZW3", async () => {
    const bytes = new Uint8Array(78);
    bytes.set(new TextEncoder().encode("BOOKMOBI"), 60);
    const source = new Blob([bytes]);

    await expect(prepareCatalogArtifact({
      id: "book-azw3",
      title: "Original",
      format: "AZW3",
      size: source.size,
      contentHash: hash(bytes),
    }, source, {
      convertEpub: vi.fn(),
      overrides: { title: "Edited" },
    })).rejects.toMatchObject({
      code: "CONVERSION_INVALID_INPUT",
      message: expect.stringContaining("cannot yet be embedded safely"),
    });

    expect(new Uint8Array(await source.arrayBuffer())).toEqual(bytes);
  });

  it("rejects a source above the browser memory boundary before reading or hashing it", async () => {
    const source = new Blob([Uint8Array.from(epubBytes())]);
    Object.defineProperty(source, "size", { value: MAX_CATALOG_SOURCE_BYTES + 1 });
    const read = vi.spyOn(source, "arrayBuffer");

    await expect(prepareCatalogArtifact({
      id: "book-large",
      title: "Too large",
      format: "EPUB",
      size: source.size,
      contentHash: "0".repeat(64),
    }, source, { convertEpub: vi.fn() })).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" });

    expect(read).not.toHaveBeenCalled();
  });

  it("rejects an oversized converter result before reading or hashing the derivative", async () => {
    const bytes = epubBytes();
    const source = new Blob([Uint8Array.from(bytes)]);
    const output = new Blob([Uint8Array.from([9, 8, 7])]);
    Object.defineProperty(output, "size", { value: MAX_KINDLE_ARTIFACT_BYTES + 1 });
    const read = vi.spyOn(output, "arrayBuffer");
    const convertEpub = vi.fn(async () => ({
      filename: "Expanded.azw3",
      blob: output,
      metadata: { title: "Expanded", authors: ["Author"], language: "en", chapters: 1, toc_entries: 1 },
      diagnostics: {
        engine: "boko-wasm" as const,
        runsLocally: true as const,
        inputBytes: source.size,
        outputBytes: output.size,
        kindleDocumentType: "PDOC" as const,
        embeddedCover: true,
      },
    }));

    await expect(prepareCatalogArtifact({
      id: "book-expanded",
      title: "Expanded",
      format: "EPUB",
      size: source.size,
      contentHash: hash(bytes),
    }, source, { convertEpub })).rejects.toMatchObject({
      code: "CONVERSION_OUTPUT_TOO_LARGE",
      details: { outputBytes: MAX_KINDLE_ARTIFACT_BYTES + 1, maximumBytes: MAX_KINDLE_ARTIFACT_BYTES },
    });

    expect(read).not.toHaveBeenCalled();
  });
});
