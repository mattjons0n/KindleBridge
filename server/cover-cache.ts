import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const COVER_EXTRACTOR_VERSION = "v1";

const CACHE_KEY_PATTERN = /^v[1-9]\d*-[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/u;

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

export class CoverCacheError extends Error {
  constructor(
    readonly code: "invalid_cover" | "cover_too_large" | "invalid_cache_key" | "cache_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CoverCacheError";
  }
}

export interface CoverSourceSnapshot {
  filename: string;
  dispose(): Promise<void>;
}

export class CoverCache {
  private readonly coversDirectory: string;
  private readonly snapshotsDirectory: string;

  constructor(
    cacheDirectory: string,
    private readonly maxCoverBytes = 12 * 1024 * 1024,
  ) {
    const resolvedCacheDirectory = path.resolve(cacheDirectory);
    this.coversDirectory = path.join(resolvedCacheDirectory, "covers");
    this.snapshotsDirectory = path.join(resolvedCacheDirectory, ".source-snapshots");
  }

  async initialize(): Promise<void> {
    await mkdir(this.coversDirectory, { recursive: true, mode: 0o755 });
    // Snapshots are derived, process-local scratch files. A clean startup can
    // safely remove anything left by a prior crash before accepting scans.
    await rm(this.snapshotsDirectory, { recursive: true, force: true });
    await mkdir(this.snapshotsDirectory, { recursive: true, mode: 0o700 });
  }

  async createSourceSnapshot(sourceFilename: string): Promise<CoverSourceSnapshot> {
    const directory = await mkdtemp(path.join(this.snapshotsDirectory, "source-"));
    const filename = path.join(directory, path.basename(sourceFilename));
    let disposed = false;
    return {
      filename,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await rm(directory, { recursive: true, force: true });
      },
    };
  }

  async store(sourceHash: string, data: Buffer, mediaType: string): Promise<string> {
    const extension = EXTENSIONS[mediaType];
    if (!/^[a-f0-9]{64}$/u.test(sourceHash) || !extension || !matchesMediaType(data, mediaType)) {
      throw new CoverCacheError("invalid_cover", "Cover bytes or cache identity are invalid.");
    }
    if (data.length === 0 || data.length > this.maxCoverBytes) {
      throw new CoverCacheError("cover_too_large", "Cover exceeds the configured cache limit.");
    }
    const key = `${COVER_EXTRACTOR_VERSION}-${sourceHash}.${extension}`;
    const destination = this.pathForKey(key);
    try {
      const existing = await stat(destination);
      if (existing.isFile() && existing.size === data.length) {
        return key;
      }
    } catch {
      // A cache miss is expected on first extraction.
    }
    const temporary = path.join(
      this.coversDirectory,
      `.${key}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      const handle = await open(temporary, "wx", 0o644);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, destination);
      return key;
    } catch (error) {
      throw new CoverCacheError("cache_unavailable", "Cover cache could not be updated atomically.");
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async read(key: string): Promise<Buffer> {
    const filename = this.pathForKey(key);
    const details = await stat(filename);
    if (!details.isFile() || details.size <= 0 || details.size > this.maxCoverBytes) {
      throw new CoverCacheError("invalid_cover", "Cached cover is unavailable or invalid.");
    }
    const data = await readFile(filename);
    if (data.length !== details.size) {
      throw new CoverCacheError("cache_unavailable", "Cached cover changed while being read.");
    }
    return data;
  }

  /** Validate cache-key syntax and bounded file metadata without reading cover bytes. */
  async has(key: string): Promise<boolean> {
    const filename = this.pathForKey(key);
    try {
      const details = await stat(filename);
      return details.isFile() && details.size > 0 && details.size <= this.maxCoverBytes;
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw new CoverCacheError("cache_unavailable", "Cached cover could not be inspected.");
    }
  }

  /**
   * Remove only well-formed cache objects that are no longer referenced by the
   * catalog and have aged past the configured retention window. The age guard
   * prevents a concurrent extractor's freshly-renamed cover from being removed
   * in the short interval before its database transaction commits.
   */
  async pruneUnused(
    referencedKeys: ReadonlySet<string>,
    retentionMs: number,
    currentTimeMs = Date.now(),
  ): Promise<{ removed: number; retained: number }> {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) {
      throw new CoverCacheError("cache_unavailable", "Cover cache retention is invalid.");
    }
    let removed = 0;
    let retained = 0;
    const entries = await readdir(this.coversDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !CACHE_KEY_PATTERN.test(entry.name)) continue;
      if (referencedKeys.has(entry.name)) {
        retained += 1;
        continue;
      }
      const filename = path.join(this.coversDirectory, entry.name);
      try {
        const details = await stat(filename);
        if (currentTimeMs - details.mtimeMs < retentionMs) {
          retained += 1;
          continue;
        }
        await unlink(filename);
        removed += 1;
      } catch (error) {
        const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (code !== "ENOENT") {
          throw new CoverCacheError("cache_unavailable", "Cover cache retention could not be completed.");
        }
      }
    }
    return { removed, retained };
  }

  pathForKey(key: string): string {
    if (!CACHE_KEY_PATTERN.test(key)) {
      throw new CoverCacheError("invalid_cache_key", "Cover cache key is invalid.");
    }
    return path.join(this.coversDirectory, key);
  }
}

function matchesMediaType(data: Buffer, mediaType: string): boolean {
  if (mediaType === "image/jpeg") return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mediaType === "image/png") {
    return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mediaType === "image/gif") {
    return data.length >= 6 && ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"));
  }
  return (
    mediaType === "image/webp" &&
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  );
}
