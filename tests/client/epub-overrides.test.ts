// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import initBoko, { book_info, convert } from "../../client/vendor/boko/boko.js";
import { prepareKindleSideload } from "../../client/src/api/azw3-sideload";
import { createEphemeralEpubDerivative } from "../../client/src/api/epub-overrides";

function plausiblePng(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function includesBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let offset = 0; offset <= haystack.byteLength - needle.byteLength; offset += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

beforeAll(async () => {
  const wasm = await readFile(resolve("client/vendor/boko/boko_bg.wasm"));
  await initBoko(wasm);
});

describe("ephemeral EPUB metadata derivatives", () => {
  it("embeds edited metadata and a cover for boko without mutating the source", async () => {
    const source = new Uint8Array(await readFile(resolve("tests/fixtures/epictetus.epub")));
    const original = source.slice();

    const replacementCover = plausiblePng(1_400, 2_100);
    const derivative = await createEphemeralEpubDerivative(source, {
      title: "The Edited Discourses",
      titleSort: "Edited Discourses, The",
      authors: ["A New Author", "Second Author"],
      authorSort: "New Author, A",
      language: "sv",
      publisher: "Kindle Bridge Press",
      publishedAt: "2026-09-01",
      series: "Household Classics",
      seriesIndex: 2.5,
      subjects: ["Philosophy", "Edited locally"],
      identifiers: ["isbn:9780000000002"],
      description: "A deliberately edited catalog description.",
      cover: { bytes: replacementCover, mediaType: "image/png" },
    });

    expect(source).toEqual(original);
    expect(derivative).not.toEqual(source);
    const metadata = JSON.parse(String(book_info(derivative, "epub"))) as {
      title: string;
      authors: string[];
      language: string;
    };
    expect(metadata).toMatchObject({
      title: "The Edited Discourses",
      authors: ["A New Author", "Second Author"],
      language: "sv",
    });

    const derivativeNames = new TextDecoder("windows-1252").decode(derivative);
    expect(derivativeNames).toContain("epub/images/cover.jpg");
    expect(derivativeNames).not.toContain("kindle-bridge-cover");
    expect(includesBytes(derivative, replacementCover)).toBe(true);

    const prepared = prepareKindleSideload(convert(derivative, "epub", "azw3"));
    expect(prepared.metadata).toEqual({ documentType: "PDOC", embeddedCover: true });
    expect(includesBytes(prepared.bytes, replacementCover)).toBe(true);
    const artifactText = new TextDecoder("windows-1252").decode(prepared.bytes);
    expect(artifactText).toContain("The Edited Discourses");
    expect(artifactText).toContain("Kindle Bridge Press");
  });
});
