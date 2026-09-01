import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const MAX_METADATA_COVER_BYTES = 12 * 1024 * 1024;
export const MAX_METADATA_COVER_DIMENSION = 12_000;
export const MAX_METADATA_COVER_PIXELS = 48_000_000;

const ASSET_KEY_PATTERN = /^[a-f0-9]{64}\.(?:jpg|png|webp)$/u;

const EXTENSIONS: Readonly<Record<MetadataCoverMediaType, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export type MetadataCoverMediaType = "image/jpeg" | "image/png" | "image/webp";

export interface MetadataCoverAssetBytes {
  assetKey: string;
  checksum: string;
  mediaType: MetadataCoverMediaType;
  byteLength: number;
  width: number;
  height: number;
}

export class MetadataCoverStoreError extends Error {
  constructor(
    readonly code:
      | "invalid_cover"
      | "cover_too_large"
      | "invalid_asset_key"
      | "asset_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "MetadataCoverStoreError";
  }
}

export class MetadataCoverStore {
  private readonly directory: string;

  constructor(
    dataDirectory: string,
    private readonly maximumBytes = MAX_METADATA_COVER_BYTES,
  ) {
    this.directory = path.join(path.resolve(dataDirectory), "metadata-covers");
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o750 });
  }

  async store(data: Buffer, mediaType: string): Promise<MetadataCoverAssetBytes> {
    if (data.length === 0 || data.length > this.maximumBytes) {
      throw new MetadataCoverStoreError("cover_too_large", "Cover exceeds the durable metadata-cover limit.");
    }
    if (!(mediaType in EXTENSIONS)) {
      throw new MetadataCoverStoreError("invalid_cover", "Cover must be a JPEG, PNG, or WebP image.");
    }
    const typedMediaType = mediaType as MetadataCoverMediaType;
    const dimensions = imageDimensions(data, typedMediaType);
    if (
      dimensions.width <= 0
      || dimensions.height <= 0
      || dimensions.width > MAX_METADATA_COVER_DIMENSION
      || dimensions.height > MAX_METADATA_COVER_DIMENSION
      || dimensions.width * dimensions.height > MAX_METADATA_COVER_PIXELS
    ) {
      throw new MetadataCoverStoreError("invalid_cover", "Cover dimensions are invalid or exceed the image limit.");
    }
    const checksum = createHash("sha256").update(data).digest("hex");
    const assetKey = `${checksum}.${EXTENSIONS[typedMediaType]}`;
    const destination = this.pathForKey(assetKey);
    try {
      const existing = await stat(destination);
      if (existing.isFile() && existing.size === data.length) {
        const existingData = await readFile(destination);
        if (createHash("sha256").update(existingData).digest("hex") === checksum) {
          return { assetKey, checksum, mediaType: typedMediaType, byteLength: data.length, ...dimensions };
        }
      }
    } catch {
      // A miss is expected for the first copy of a selected cover.
    }
    const temporary = path.join(
      this.directory,
      `.${assetKey}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      const handle = await open(temporary, "wx", 0o640);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, destination);
    } catch {
      throw new MetadataCoverStoreError("asset_unavailable", "The durable cover could not be stored atomically.");
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return { assetKey, checksum, mediaType: typedMediaType, byteLength: data.length, ...dimensions };
  }

  async read(assetKey: string): Promise<Buffer> {
    const filename = this.pathForKey(assetKey);
    let details;
    try {
      details = await stat(filename);
    } catch {
      throw new MetadataCoverStoreError("asset_unavailable", "The selected durable cover is unavailable.");
    }
    if (!details.isFile() || details.size <= 0 || details.size > this.maximumBytes) {
      throw new MetadataCoverStoreError("asset_unavailable", "The selected durable cover is invalid.");
    }
    const data = await readFile(filename);
    if (data.length !== details.size) {
      throw new MetadataCoverStoreError("asset_unavailable", "The selected durable cover changed while being read.");
    }
    const expectedChecksum = assetKey.slice(0, 64);
    if (createHash("sha256").update(data).digest("hex") !== expectedChecksum) {
      throw new MetadataCoverStoreError("asset_unavailable", "The selected durable cover failed its checksum.");
    }
    const mediaType: MetadataCoverMediaType = assetKey.endsWith(".jpg")
      ? "image/jpeg"
      : assetKey.endsWith(".png")
        ? "image/png"
        : "image/webp";
    let dimensions: { width: number; height: number };
    try {
      dimensions = imageDimensions(data, mediaType);
    } catch {
      throw new MetadataCoverStoreError("asset_unavailable", "The selected durable cover is malformed.");
    }
    if (
      dimensions.width > MAX_METADATA_COVER_DIMENSION
      || dimensions.height > MAX_METADATA_COVER_DIMENSION
      || dimensions.width * dimensions.height > MAX_METADATA_COVER_PIXELS
    ) {
      throw new MetadataCoverStoreError("asset_unavailable", "The selected durable cover has invalid dimensions.");
    }
    return data;
  }

  async removeIfUnreferenced(assetKey: string, referenced: boolean): Promise<void> {
    if (referenced) return;
    await unlink(this.pathForKey(assetKey)).catch((error: unknown) => {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        throw new MetadataCoverStoreError("asset_unavailable", "The unused durable cover could not be removed.");
      }
    });
  }

  async pruneOrphans(
    referencedKeys: ReadonlySet<string>,
    isCurrentlyReferenced?: (assetKey: string) => boolean | Promise<boolean>,
  ): Promise<number> {
    let removed = 0;
    const entries = await readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !ASSET_KEY_PATTERN.test(entry.name) || referencedKeys.has(entry.name)) continue;
      if (isCurrentlyReferenced && await isCurrentlyReferenced(entry.name)) continue;
      await unlink(path.join(this.directory, entry.name));
      removed += 1;
    }
    return removed;
  }

  pathForKey(assetKey: string): string {
    if (!ASSET_KEY_PATTERN.test(assetKey)) {
      throw new MetadataCoverStoreError("invalid_asset_key", "Durable cover key is invalid.");
    }
    return path.join(this.directory, assetKey);
  }
}

function imageDimensions(data: Buffer, mediaType: MetadataCoverMediaType): { width: number; height: number } {
  if (mediaType === "image/png") {
    if (
      data.length < 24
      || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || data.subarray(12, 16).toString("ascii") !== "IHDR"
    ) throw new MetadataCoverStoreError("invalid_cover", "PNG cover data is malformed.");
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (mediaType === "image/jpeg") return jpegDimensions(data);
  return webpDimensions(data);
}

function jpegDimensions(data: Buffer): { width: number; height: number } {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    throw new MetadataCoverStoreError("invalid_cover", "JPEG cover data is malformed.");
  }
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= data.length) {
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    if (offset >= data.length) break;
    const marker = data[offset] as number;
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 2 > data.length) break;
    const segmentLength = data.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > data.length) break;
    if (startOfFrame.has(marker)) {
      if (segmentLength < 7) break;
      return { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  throw new MetadataCoverStoreError("invalid_cover", "JPEG cover dimensions could not be read.");
}

function webpDimensions(data: Buffer): { width: number; height: number } {
  if (
    data.length < 30
    || data.subarray(0, 4).toString("ascii") !== "RIFF"
    || data.subarray(8, 12).toString("ascii") !== "WEBP"
  ) throw new MetadataCoverStoreError("invalid_cover", "WebP cover data is malformed.");
  const chunk = data.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    return {
      width: 1 + data.readUIntLE(24, 3),
      height: 1 + data.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8L" && data[20] === 0x2f) {
    const b0 = data[21] as number;
    const b1 = data[22] as number;
    const b2 = data[23] as number;
    const b3 = data[24] as number;
    return {
      width: 1 + b0 + ((b1 & 0x3f) << 8),
      height: 1 + (b1 >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10),
    };
  }
  if (chunk === "VP8 " && data.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  }
  throw new MetadataCoverStoreError("invalid_cover", "WebP cover dimensions could not be read.");
}
