import { KindleDeviceError } from "./errors";

const DEFAULT_MAX_FILENAME_LENGTH = 120;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MANAGED_TOKEN_HEX_LENGTH = 20;
const MANAGED_TOKEN_PATTERN = /^kb-[0-9a-f]{20}$/iu;
const MANAGED_TOKEN_SEARCH_PATTERN = /(?:^|[^a-z0-9])(kb-[0-9a-f]{20})(?=$|[^a-z0-9])/giu;

function asciiStem(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "-")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/[\s._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extensionWithoutDot(extension: string): string {
  const clean = extension.toLowerCase().replace(/^\.+/, "");
  if (!/^[a-z0-9]{1,10}$/.test(clean)) {
    throw new KindleDeviceError(
      "MTP_FILENAME_INVALID",
      `Invalid filename extension: ${extension}`,
    );
  }
  return clean;
}

function originalStem(filename: string): string {
  const leaf = filename.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const lastDot = leaf.lastIndexOf(".");
  return lastDot > 0 ? leaf.slice(0, lastDot) : leaf;
}

export function sanitizeKindleFilename(
  filename: string,
  extension: string,
  maxLength = DEFAULT_MAX_FILENAME_LENGTH,
): string {
  const cleanExtension = extensionWithoutDot(extension);
  const suffix = `.${cleanExtension}`;
  if (!Number.isSafeInteger(maxLength) || maxLength <= suffix.length + 1) {
    throw new RangeError("maxLength is too small for a safe filename.");
  }

  let stem = asciiStem(originalStem(filename));
  if (!stem || WINDOWS_RESERVED_BASENAME.test(stem)) stem = "book";
  stem = stem.slice(0, maxLength - suffix.length).replace(/[-. ]+$/g, "");
  if (!stem) stem = "book";
  return `${stem}${suffix}`;
}

function timestampToken(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid date.");
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function randomHex(random: () => number): string {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("random() must return a number in [0, 1). ");
  }
  return Math.floor(value * 0x1000000)
    .toString(16)
    .padStart(6, "0");
}

export function createCollisionResistantFilename(
  originalFilename: string,
  extension: string,
  options: {
    now?: Date;
    random?: () => number;
    maxLength?: number;
  } = {},
): string {
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;
  const token = `${timestampToken(now)}-${randomHex(random)}`;
  const cleanExtension = extensionWithoutDot(extension);
  const suffix = `-${token}.${cleanExtension}`;
  const maxLength = options.maxLength ?? DEFAULT_MAX_FILENAME_LENGTH;
  const base = sanitizeKindleFilename(
    originalFilename,
    cleanExtension,
    maxLength,
  ).slice(0, -(cleanExtension.length + 1));
  const stem = base
    .slice(0, Math.max(1, maxLength - suffix.length))
    .replace(/[-. ]+$/g, "");
  return `${stem || "book"}${suffix}`;
}

export function normalizeManagedFilenameToken(token: string): string {
  const normalized = token.trim().toLocaleLowerCase("en-US");
  if (!MANAGED_TOKEN_PATTERN.test(normalized)) {
    throw new KindleDeviceError(
      "MTP_FILENAME_INVALID",
      "Managed filename token must use the form kb- followed by 20 hexadecimal characters.",
    );
  }
  return normalized;
}

/**
 * Derives a source-version-scoped, filename-safe 80-bit token without exposing
 * the catalog ID or content hash. Rotating when source bytes change prevents a
 * replaced path slot from inheriting the prior book version's green match.
 */
export async function createManagedFilenameToken(stableCatalogId: string, contentHash: string): Promise<string> {
  const normalized = stableCatalogId.normalize("NFC").trim();
  if (normalized.length === 0 || normalized.length > 512) {
    throw new RangeError("stableCatalogId must contain from 1 to 512 characters");
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required to derive a managed filename token");
  }
  const normalizedHash = contentHash.trim().toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/u.test(normalizedHash)) {
    throw new RangeError("contentHash must be a lowercase or uppercase SHA-256 hex digest");
  }
  const material = new TextEncoder().encode(
    `kindle-bridge-managed-file-v2\u0000${normalized}\u0000${normalizedHash}`,
  );
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", material));
  const hex = Array.from(
    digest.subarray(0, MANAGED_TOKEN_HEX_LENGTH / 2),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `kb-${hex}`;
}

/** Returns one unambiguous managed token, or undefined for none/conflicting tokens. */
export function extractManagedFilenameToken(filename: string): string | undefined {
  const tokens = new Set<string>();
  for (const match of filename.matchAll(MANAGED_TOKEN_SEARCH_PATTERN)) {
    const token = match[1];
    if (token) tokens.add(token.toLocaleLowerCase("en-US"));
  }
  return tokens.size === 1 ? [...tokens][0] : undefined;
}

export function createManagedCollisionResistantFilename(
  originalFilename: string,
  extension: string,
  managedToken: string,
  options: {
    now?: Date;
    random?: () => number;
    maxLength?: number;
  } = {},
): string {
  const token = normalizeManagedFilenameToken(managedToken);
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;
  const unique = `${timestampToken(now)}-${randomHex(random)}`;
  const cleanExtension = extensionWithoutDot(extension);
  const suffix = `-${token}-${unique}.${cleanExtension}`;
  const maxLength = options.maxLength ?? DEFAULT_MAX_FILENAME_LENGTH;
  if (!Number.isSafeInteger(maxLength) || maxLength <= suffix.length) {
    throw new RangeError("maxLength is too small for a managed collision-resistant filename");
  }
  const base = sanitizeKindleFilename(originalFilename, cleanExtension, maxLength)
    .slice(0, -(cleanExtension.length + 1));
  const stem = base
    .slice(0, Math.max(1, maxLength - suffix.length))
    .replace(/[-. ]+$/g, "");
  return `${stem || "book"}${suffix}`;
}

export function createSelfTestFilename(
  now = new Date(),
  random: () => number = Math.random,
): string {
  return createCollisionResistantFilename("kindle-webusb-poc", "txt", {
    now,
    random,
  });
}

export function filenamesEqual(left: string, right: string): boolean {
  return left.normalize("NFC").toLocaleLowerCase("en-US") ===
    right.normalize("NFC").toLocaleLowerCase("en-US");
}
