import type {
  CoverProvider,
  CoverSearchCandidate,
} from "../shared/catalog-contracts.js";
import {
  MAX_METADATA_COVER_BYTES,
  type MetadataCoverMediaType,
} from "./metadata-cover-store.js";

const MAX_PROVIDER_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_RESULTS = 20;
const MAX_PROVIDER_REDIRECTS = 3;

export interface ProviderCoverBytes {
  data: Buffer;
  mediaType: MetadataCoverMediaType;
  sourceUrl: string;
}

export interface ProviderSearchCandidate extends Omit<CoverSearchCandidate, "thumbnailUrl"> {}

export class CoverProviderError extends Error {
  constructor(
    readonly code: "invalid_provider" | "invalid_candidate" | "provider_unavailable" | "provider_response_too_large",
    message: string,
  ) {
    super(message);
    this.name = "CoverProviderError";
  }
}

export class CoverProviderClient {
  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly googleBooksApiKey?: string,
    private readonly timeoutMs = 12_000,
  ) {}

  async search(provider: CoverProvider, query: string, limit: number): Promise<ProviderSearchCandidate[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), MAX_PROVIDER_RESULTS);
    if (provider === "google-books") return this.searchGoogleBooks(query, boundedLimit);
    if (provider === "open-library") return this.searchOpenLibrary(query, boundedLimit);
    throw new CoverProviderError("invalid_provider", "Cover provider is not supported.");
  }

  async fetchCover(provider: CoverProvider, candidateId: string): Promise<ProviderCoverBytes> {
    const url = providerCoverUrl(provider, candidateId);
    const response = await this.fetchTrusted(url, provider);
    if (!response.ok) {
      throw new CoverProviderError("provider_unavailable", "The selected cover is no longer available.");
    }
    const mediaType = imageMediaType(response.headers.get("content-type"));
    if (!mediaType) throw new CoverProviderError("provider_unavailable", "The provider did not return an image.");
    return {
      data: await readBoundedBody(response, MAX_METADATA_COVER_BYTES),
      mediaType,
      sourceUrl: response.url || url.toString(),
    };
  }

  private async searchGoogleBooks(query: string, limit: number): Promise<ProviderSearchCandidate[]> {
    const url = new URL("https://www.googleapis.com/books/v1/volumes");
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", String(limit));
    url.searchParams.set("printType", "books");
    url.searchParams.set("projection", "lite");
    if (this.googleBooksApiKey) url.searchParams.set("key", this.googleBooksApiKey);
    const response = await this.fetchWithDeadline(url, { redirect: "error" });
    if (!response.ok) throw new CoverProviderError("provider_unavailable", "Google Books cover search failed.");
    const value = parseProviderJson(await readBoundedBody(response, MAX_PROVIDER_JSON_BYTES));
    const items = Array.isArray(value.items) ? value.items : [];
    const results: ProviderSearchCandidate[] = [];
    for (const item of items) {
      if (results.length >= limit) break;
      if (!isRecord(item)) continue;
      const id = boundedString(item.id, 128);
      const info = isRecord(item.volumeInfo) ? item.volumeInfo : null;
      if (!id || !info || !isRecord(info.imageLinks)) continue;
      const title = boundedString(info.title, 500);
      if (!title) continue;
      results.push({
        candidateId: id,
        title,
        authors: boundedStringArray(info.authors, 20, 300),
        publishedAt: boundedNullableString(info.publishedDate, 64),
        identifiers: Array.isArray(info.industryIdentifiers)
          ? info.industryIdentifiers
              .slice(0, 20)
              .flatMap((identifier) => {
                if (!isRecord(identifier)) return [];
                const type = boundedString(identifier.type, 32);
                const value = boundedString(identifier.identifier, 64);
                return type && value ? [`${type}:${value}`] : [];
              })
          : [],
      });
    }
    return results;
  }

  private async searchOpenLibrary(query: string, limit: number): Promise<ProviderSearchCandidate[]> {
    const url = new URL("https://openlibrary.org/search.json");
    url.searchParams.set("q", query);
    url.searchParams.set("fields", "key,title,author_name,first_publish_year,isbn,cover_i");
    url.searchParams.set("limit", String(limit));
    const response = await this.fetchWithDeadline(url, { redirect: "error" });
    if (!response.ok) throw new CoverProviderError("provider_unavailable", "Open Library cover search failed.");
    const value = parseProviderJson(await readBoundedBody(response, MAX_PROVIDER_JSON_BYTES));
    const docs = Array.isArray(value.docs) ? value.docs : [];
    const results: ProviderSearchCandidate[] = [];
    for (const doc of docs) {
      if (results.length >= limit) break;
      if (!isRecord(doc)) continue;
      const coverId = Number(doc.cover_i);
      const title = boundedString(doc.title, 500);
      if (!Number.isSafeInteger(coverId) || coverId <= 0 || !title) continue;
      const year = Number(doc.first_publish_year);
      results.push({
        candidateId: String(coverId),
        title,
        authors: boundedStringArray(doc.author_name, 20, 300),
        publishedAt: Number.isSafeInteger(year) && year > 0 ? String(year) : null,
        identifiers: boundedStringArray(doc.isbn, 20, 64).map((isbn) => `ISBN:${isbn}`),
      });
    }
    return results;
  }

  private async fetchTrusted(url: URL, provider: CoverProvider): Promise<Response> {
    let current = url;
    for (let redirects = 0; redirects <= MAX_PROVIDER_REDIRECTS; redirects += 1) {
      if (!trustedCoverHost(current, provider)) {
        throw new CoverProviderError("provider_unavailable", "The cover provider returned an untrusted location.");
      }
      const response = await this.fetchWithDeadline(current, { redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location || redirects === MAX_PROVIDER_REDIRECTS) {
        throw new CoverProviderError("provider_unavailable", "The cover provider redirected unexpectedly.");
      }
      current = new URL(location, current);
      if (current.protocol !== "https:") {
        throw new CoverProviderError("provider_unavailable", "The cover provider returned an insecure location.");
      }
    }
    throw new CoverProviderError("provider_unavailable", "The cover provider redirected unexpectedly.");
  }

  private async fetchWithDeadline(url: URL, init: RequestInit): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      return await this.fetchImplementation(url, { ...init, signal: timeout });
    } catch {
      throw new CoverProviderError("provider_unavailable", "The cover provider could not be reached.");
    }
  }
}

export function providerCoverUrl(provider: CoverProvider, candidateId: string): URL {
  if (provider === "google-books") {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(candidateId)) {
      throw new CoverProviderError("invalid_candidate", "Google Books cover candidate is invalid.");
    }
    const url = new URL("https://books.google.com/books/content");
    url.searchParams.set("id", candidateId);
    url.searchParams.set("printsec", "frontcover");
    url.searchParams.set("img", "1");
    url.searchParams.set("zoom", "2");
    url.searchParams.set("source", "gbs_api");
    return url;
  }
  if (provider === "open-library") {
    if (!/^[1-9]\d{0,18}$/u.test(candidateId)) {
      throw new CoverProviderError("invalid_candidate", "Open Library cover candidate is invalid.");
    }
    return new URL(`https://covers.openlibrary.org/b/id/${candidateId}-L.jpg?default=false`);
  }
  throw new CoverProviderError("invalid_provider", "Cover provider is not supported.");
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared && (/^\d+$/u.test(declared) && Number(declared) > maximumBytes)) {
    throw new CoverProviderError("provider_response_too_large", "The provider response exceeds the configured limit.");
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let retained = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      retained += result.value.byteLength;
      if (retained > maximumBytes) {
        await reader.cancel();
        throw new CoverProviderError("provider_response_too_large", "The provider response exceeds the configured limit.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), retained);
}

function trustedCoverHost(url: URL, provider: CoverProvider): boolean {
  if (url.protocol !== "https:") return false;
  const hostname = url.hostname.toLocaleLowerCase();
  if (provider === "open-library") return hostname === "covers.openlibrary.org";
  return hostname === "books.google.com"
    || hostname === "books.googleusercontent.com"
    || hostname.endsWith(".googleusercontent.com");
}

function imageMediaType(value: string | null): MetadataCoverMediaType | null {
  const type = value?.split(";", 1)[0]?.trim().toLocaleLowerCase();
  return type === "image/jpeg" || type === "image/png" || type === "image/webp" ? type : null;
}

function parseProviderJson(data: Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data.toString("utf8"));
    if (isRecord(parsed)) return parsed;
  } catch {
    // Mapped to a fixed provider error below.
  }
  throw new CoverProviderError("provider_unavailable", "The cover provider returned malformed data.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= maximum ? value.trim() : null;
}

function boundedNullableString(value: unknown, maximum: number): string | null {
  return boundedString(value, maximum);
}

function boundedStringArray(value: unknown, maximumItems: number, maximumLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maximumItems)
    .flatMap((item) => {
      const string = boundedString(item, maximumLength);
      return string ? [string] : [];
    });
}
