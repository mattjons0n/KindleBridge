import { AppError } from "../app-error";

export const MAX_CONVERSION_OVERRIDE_MANIFEST_BYTES = 64 * 1024;
export const MAX_CONVERSION_COVER_BYTES = 12 * 1024 * 1024;

export type ConversionCoverMediaType = "image/jpeg" | "image/png" | "image/webp";

/**
 * A sparse, effective-metadata overlay. An omitted key inherits the EPUB
 * value; null (or an empty array) deliberately clears an optional value.
 * The source archive is never changed: this manifest is applied to a
 * short-lived in-browser EPUB derivative immediately before conversion.
 */
export interface ConversionMetadataOverrides {
  readonly title?: string;
  readonly titleSort?: string | null;
  readonly authors?: readonly string[];
  readonly authorSort?: string | null;
  readonly language?: string | null;
  readonly publisher?: string | null;
  readonly publishedAt?: string | null;
  readonly series?: string | null;
  readonly seriesIndex?: number | null;
  readonly subjects?: readonly string[];
  readonly identifiers?: readonly string[];
  readonly description?: string | null;
  readonly rights?: string | null;
}

export interface ConversionCoverOverride {
  readonly blob: Blob;
  readonly mediaType: ConversionCoverMediaType;
}

export interface ConversionOverrides extends ConversionMetadataOverrides {
  readonly cover?: ConversionCoverOverride;
}

export interface ResolvedConversionOverrides extends ConversionMetadataOverrides {
  readonly cover?: {
    readonly bytes: Uint8Array;
    readonly mediaType: ConversionCoverMediaType;
  };
}

const encoder = new TextEncoder();

function invalid(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new AppError("CONVERSION_INVALID_INPUT", message, details ? { details } : undefined);
}

function validateText(value: string | null | undefined, field: string, maximumBytes: number): void {
  if (value === undefined || value === null) return;
  if (value.includes("\u0000")) invalid(`The ${field} override contains an invalid null character`);
  const bytes = encoder.encode(value).byteLength;
  if (bytes > maximumBytes) {
    invalid(`The ${field} override is too large`, { field, bytes, maximumBytes });
  }
}

function validateList(
  values: readonly string[] | undefined,
  field: string,
  maximumItems: number,
  maximumItemBytes: number,
): void {
  if (values === undefined) return;
  if (values.length > maximumItems) {
    invalid(`The ${field} override contains too many values`, {
      field,
      items: values.length,
      maximumItems,
    });
  }
  values.forEach((value, index) => validateText(value, `${field}[${index}]`, maximumItemBytes));
}

function validateManifest(overrides: ConversionMetadataOverrides): void {
  validateText(overrides.title, "title", 4 * 1024);
  if (overrides.title !== undefined && overrides.title.trim() === "") {
    invalid("The title override cannot be empty");
  }
  validateText(overrides.titleSort, "title sort", 4 * 1024);
  validateList(overrides.authors, "authors", 64, 4 * 1024);
  validateText(overrides.authorSort, "author sort", 4 * 1024);
  validateText(overrides.language, "language", 256);
  validateText(overrides.publisher, "publisher", 4 * 1024);
  validateText(overrides.publishedAt, "publication date", 1_024);
  validateText(overrides.series, "series", 4 * 1024);
  if (
    overrides.seriesIndex !== undefined
    && overrides.seriesIndex !== null
    && (!Number.isFinite(overrides.seriesIndex) || Math.abs(overrides.seriesIndex) > 1_000_000)
  ) {
    invalid("The series position override is invalid");
  }
  validateList(overrides.subjects, "subjects", 256, 4 * 1024);
  validateList(overrides.identifiers, "identifiers", 64, 4 * 1024);
  validateText(overrides.description, "description", 32 * 1024);
  validateText(overrides.rights, "rights", 8 * 1024);

  const bytes = encoder.encode(JSON.stringify(overrides)).byteLength;
  if (bytes > MAX_CONVERSION_OVERRIDE_MANIFEST_BYTES) {
    invalid("The metadata override manifest is too large", {
      bytes,
      maximumBytes: MAX_CONVERSION_OVERRIDE_MANIFEST_BYTES,
    });
  }
}

function assertCoverSignature(bytes: Uint8Array, mediaType: ConversionCoverMediaType): void {
  const jpeg = bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.byteLength >= 24
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
    && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, false) === 13;
  const webp = bytes.byteLength >= 20
    && new TextDecoder("ascii").decode(bytes.subarray(0, 4)) === "RIFF"
    && new TextDecoder("ascii").decode(bytes.subarray(8, 12)) === "WEBP";
  if (
    (mediaType === "image/jpeg" && !jpeg)
    || (mediaType === "image/png" && !png)
    || (mediaType === "image/webp" && !webp)
  ) {
    invalid("The replacement cover bytes do not match their declared image format", { mediaType });
  }
}

export function hasConversionOverrides(overrides: ConversionOverrides | undefined): boolean {
  return overrides !== undefined
    && Object.values(overrides).some((value) => value !== undefined);
}

export async function resolveConversionOverrides(
  overrides: ConversionOverrides | undefined,
  signal?: AbortSignal,
): Promise<ResolvedConversionOverrides | undefined> {
  if (!hasConversionOverrides(overrides)) return undefined;
  const { cover, ...metadata } = overrides as ConversionOverrides;
  validateManifest(metadata);
  if (!cover) return metadata;
  if (!(cover.blob instanceof Blob)) invalid("The replacement cover is not a browser Blob");
  if (cover.blob.size === 0) invalid("The replacement cover is empty");
  if (cover.blob.size > MAX_CONVERSION_COVER_BYTES) {
    invalid("The replacement cover exceeds the 12 MB limit", {
      bytes: cover.blob.size,
      maximumBytes: MAX_CONVERSION_COVER_BYTES,
    });
  }
  if (signal?.aborted) throw new AppError("CONVERSION_ABORTED", "Conversion was cancelled");
  const bytes = new Uint8Array(await cover.blob.arrayBuffer());
  if (signal?.aborted) throw new AppError("CONVERSION_ABORTED", "Conversion was cancelled");
  assertCoverSignature(bytes, cover.mediaType);
  return { ...metadata, cover: { bytes, mediaType: cover.mediaType } };
}
