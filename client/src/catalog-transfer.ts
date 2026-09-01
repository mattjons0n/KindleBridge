import { AppError } from "./app-error";
import { prepareKindleSideload } from "./api/azw3-sideload";
import type { ConversionResult } from "./api/convert";
import {
  hasConversionOverrides,
  type ConversionOverrides,
} from "./api/conversion-overrides";
import { MAX_KINDLE_ARTIFACT_BYTES } from "./book-limits";
import { MAX_CATALOG_SOURCE_BYTES } from "./catalog-client";

export { MAX_CATALOG_SOURCE_BYTES } from "./catalog-client";

export type CatalogTransferPhase = "preparing" | "converting" | "validating" | "ready";

export interface CatalogTransferBook {
  readonly id: string;
  readonly title: string;
  readonly format: string;
  readonly size: number;
  readonly contentHash?: string;
  readonly sourceFilename?: string;
}

export interface PreparedCatalogArtifact {
  readonly blob: Blob;
  readonly filename: string;
  readonly sourceHash: string;
  readonly artifactHash: string;
  readonly sourceFormat: "EPUB" | "AZW3";
  readonly converted: boolean;
  readonly embeddedCover: boolean;
  readonly kindleDocumentType: "PDOC";
  readonly overridesApplied: boolean;
}

export interface PrepareCatalogArtifactOptions {
  readonly signal?: AbortSignal;
  readonly convertEpub: (
    file: File,
    signal?: AbortSignal,
    overrides?: ConversionOverrides,
  ) => Promise<ConversionResult>;
  readonly overrides?: ConversionOverrides;
  readonly onPhase?: (phase: CatalogTransferPhase) => void;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AppError("CONVERSION_ABORTED", "Book preparation was cancelled");
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return hex(new Uint8Array(digest));
}

function normalizedExpectedHash(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLocaleLowerCase().replace(/^sha256[:-]/u, "");
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : undefined;
}

function safeSourceFilename(book: CatalogTransferBook, extension: "epub" | "azw3"): string {
  const supplied = book.sourceFilename?.trim();
  if (supplied && !/[\u0000-\u001f\u007f/\\]/u.test(supplied)) {
    const stem = supplied.replace(/\.[^.]*$/u, "").slice(0, 160).trim();
    return `${stem || "book"}.${extension}`;
  }
  const title = book.title.trim().replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/gu, "-").slice(0, 120).trim();
  return `${title || "book"}.${extension}`;
}

async function detectedFormat(source: Blob): Promise<"EPUB" | "AZW3" | "UNKNOWN"> {
  const head = new Uint8Array(await source.slice(0, 78).arrayBuffer());
  if (
    head.byteLength >= 4
    && head[0] === 0x50
    && head[1] === 0x4b
    && head[2] === 0x03
    && head[3] === 0x04
  ) {
    return "EPUB";
  }
  if (
    head.byteLength >= 68
    && new TextDecoder("ascii").decode(head.subarray(60, 68)) === "BOOKMOBI"
  ) {
    return "AZW3";
  }
  return "UNKNOWN";
}

function validateSourceSize(book: CatalogTransferBook, source: Blob): void {
  if (source.size === 0) {
    throw new AppError("CONVERSION_INVALID_INPUT", "The catalog source is empty");
  }
  if (source.size > MAX_CATALOG_SOURCE_BYTES) {
    throw new AppError("REQUEST_TOO_LARGE", "The catalog source exceeds the 200 MB limit", {
      details: { inputBytes: source.size, maximumBytes: MAX_CATALOG_SOURCE_BYTES },
    });
  }
  if (!Number.isSafeInteger(book.size) || book.size < 0 || source.size !== book.size) {
    throw new AppError("CATALOG_SOURCE_CHANGED", "The source size changed after it was indexed", {
      details: { indexedBytes: book.size, receivedBytes: source.size },
    });
  }
}

export async function prepareCatalogArtifact(
  book: CatalogTransferBook,
  source: Blob,
  options: PrepareCatalogArtifactOptions,
): Promise<PreparedCatalogArtifact> {
  options.onPhase?.("preparing");
  assertNotAborted(options.signal);
  validateSourceSize(book, source);

  const actualFormat = await detectedFormat(source);
  const indexedFormat = book.format.trim().toLocaleUpperCase();
  if (actualFormat === "UNKNOWN" || actualFormat !== indexedFormat) {
    throw new AppError("CATALOG_FORMAT_MISMATCH", "The source format does not match the indexed book", {
      details: { indexedFormat, detectedFormat: actualFormat },
    });
  }

  const sourceHash = await sha256(source);
  assertNotAborted(options.signal);
  const expectedHash = normalizedExpectedHash(book.contentHash);
  if (!expectedHash) {
    throw new AppError("CATALOG_HASH_MISSING", "The catalog did not provide a valid source hash");
  }
  if (sourceHash !== expectedHash) {
    throw new AppError("CATALOG_SOURCE_CHANGED", "The source bytes changed after they were indexed", {
      details: { hashMatched: false },
    });
  }

  let artifact: Blob;
  let filename: string;
  let converted: boolean;
  let embeddedCover: boolean;

  if (actualFormat === "EPUB") {
    options.onPhase?.("converting");
    const input = new File(
      [source],
      safeSourceFilename(book, "epub"),
      { type: source.type || "application/epub+zip", lastModified: Date.now() },
    );
    const result = await options.convertEpub(input, options.signal, options.overrides);
    artifact = result.blob;
    filename = result.filename;
    converted = true;
    embeddedCover = result.diagnostics.embeddedCover;
  } else {
    if (hasConversionOverrides(options.overrides)) {
      throw new AppError(
        "CONVERSION_INVALID_INPUT",
        "Metadata or cover overrides cannot yet be embedded safely in an existing AZW3. The original remains unchanged; use an EPUB source for edited Kindle metadata.",
      );
    }
    options.onPhase?.("validating");
    const prepared = prepareKindleSideload(new Uint8Array(await source.arrayBuffer()));
    // Copy into an ArrayBuffer-backed view. TypeScript's newer typed-array
    // definitions permit SharedArrayBuffer-backed views, while BlobPart does
    // not; the derivative is deliberately copied here anyway.
    artifact = new Blob([Uint8Array.from(prepared.bytes)], { type: "application/vnd.amazon.mobi8-ebook" });
    filename = safeSourceFilename(book, "azw3").replace(/\.epub$/iu, ".azw3");
    converted = false;
    embeddedCover = prepared.metadata.embeddedCover;
  }

  assertNotAborted(options.signal);
  if (artifact.size > MAX_KINDLE_ARTIFACT_BYTES) {
    throw new AppError(
      "CONVERSION_OUTPUT_TOO_LARGE",
      "The prepared Kindle artifact exceeds the 200 MB browser limit",
      { details: { outputBytes: artifact.size, maximumBytes: MAX_KINDLE_ARTIFACT_BYTES } },
    );
  }
  const artifactHash = await sha256(artifact);
  options.onPhase?.("ready");
  return {
    blob: artifact,
    filename,
    sourceHash,
    artifactHash,
    sourceFormat: actualFormat,
    converted,
    embeddedCover,
    kindleDocumentType: "PDOC",
    overridesApplied: hasConversionOverrides(options.overrides),
  };
}

export type { ConversionOverrides } from "./api/conversion-overrides";
