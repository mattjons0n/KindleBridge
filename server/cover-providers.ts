import type {
  CatalogMetadataCandidate,
  CoverProviderCredentialErrorCode,
  CoverProvider,
  CoverSearchCandidate,
  EditableBookMetadata,
  MetadataCandidateSearchTerms,
  MetadataProvider,
} from "../shared/catalog-contracts.js";
import { HARDCOVER_BOOKS_QUERY, HARDCOVER_ISBN_QUERY, HARDCOVER_SEARCH_QUERY, hardcoverBookIds, hardcoverIsbn, hardcoverMetadataCandidates } from "./hardcover-provider.js";
import { normalizeKindleMetadataIdentifier, normalizeKindleMetadataWords } from "../shared/kindle-metadata-normalization.js";
import {
  MAX_METADATA_COVER_BYTES,
  type MetadataCoverMediaType,
} from "./metadata-cover-store.js";

const MAX_PROVIDER_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_RESULTS = 20;
const MAX_PROVIDER_REDIRECTS = 3;
const MAX_OPEN_LIBRARY_REDIRECTS = 2;

type GoogleBooksApiKeySource = string | (() => string | undefined);

export interface ProviderCoverBytes {
  data: Buffer;
  mediaType: MetadataCoverMediaType;
  sourceUrl: string;
}

export interface ProviderSearchCandidate extends Omit<CoverSearchCandidate, "thumbnailUrl"> {}

interface TimedProviderResponse {
  readonly response: Response;
  readBody(maximumBytes: number): Promise<Buffer>;
}

export class CoverProviderError extends Error {
  constructor(
    readonly code:
      | "invalid_provider"
      | "invalid_candidate"
      | "provider_not_configured"
      | "provider_unavailable"
      | "provider_timeout"
      | "provider_rate_limited"
      | "provider_invalid_token"
      | "provider_insufficient_permissions"
      | "provider_response_too_large",
    message: string,
  ) {
    super(message);
    this.name = "CoverProviderError";
  }
}

export class CoverProviderClient {
  private hardcoverQueue: Promise<void> = Promise.resolve();
  private hardcoverNextRequestAt = 0;
  private hardcoverCooldownUntil = 0;

  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly googleBooksApiKeySource?: GoogleBooksApiKeySource,
    private readonly timeoutMs = 12_000,
    private readonly hardcoverTokenSource?: GoogleBooksApiKeySource,
  ) {}

  async search(
    provider: CoverProvider,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ProviderSearchCandidate[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), MAX_PROVIDER_RESULTS);
    if (provider === "google-books") return this.searchGoogleBooks(query, boundedLimit, signal);
    if (provider === "open-library") return this.searchOpenLibrary(query, boundedLimit, signal);
    throw new CoverProviderError("invalid_provider", "Cover provider is not supported.");
  }

  /** Explicit metadata lookup. Only normalized title/author/identifier terms
   * are sent to fixed provider endpoints; no book bytes, paths, or URLs enter
   * this adapter. */
  async searchMetadata(
    provider: MetadataProvider,
    terms: MetadataCandidateSearchTerms,
    limit: number,
    signal?: AbortSignal,
  ): Promise<CatalogMetadataCandidate[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), MAX_PROVIDER_RESULTS);
    const normalized = normalizedMetadataTerms(terms);
    if (provider === "google-books") return this.searchGoogleBooksMetadata(normalized, boundedLimit, signal);
    if (provider === "open-library") return this.searchOpenLibraryMetadata(normalized, boundedLimit, signal);
    if (provider === "hardcover") return this.searchHardcoverMetadata(normalized, boundedLimit, signal);
    throw new CoverProviderError("invalid_provider", "Metadata provider is not supported.");
  }

  private async searchHardcoverMetadata(
    terms: MetadataCandidateSearchTerms,
    limit: number,
    signal?: AbortSignal,
  ): Promise<CatalogMetadataCandidate[]> {
    const isbn = hardcoverIsbn(terms.identifier);
    if (isbn) {
      const data = await this.hardcoverRequest(HARDCOVER_ISBN_QUERY, { isbn, limit }, signal);
      if (!Array.isArray(data.editions)) throw hardcoverMalformedResponse();
      if (data.editions.length) return hardcoverMetadataCandidates(data.editions, terms, limit, true);
    }
    const query = [terms.title, terms.author].filter(Boolean).join(" ");
    if (!query) return [];
    const search = await this.hardcoverRequest(HARDCOVER_SEARCH_QUERY, { query, limit }, signal);
    if (!isRecord(search.search) || search.search.error || !Array.isArray(search.search.ids)) throw hardcoverMalformedResponse();
    const ids = hardcoverBookIds(search.search.ids, limit);
    if (!ids.length) return [];
    const data = await this.hardcoverRequest(HARDCOVER_BOOKS_QUERY, { ids, limit }, signal);
    if (!Array.isArray(data.books)) throw hardcoverMalformedResponse();
    // Restore relevance order after the relational query and discard unrequested IDs.
    const books = ids.flatMap((id) => data.books instanceof Array ? data.books.filter((book) => isRecord(book) && book.id === id) : []);
    return hardcoverMetadataCandidates(books, terms, limit);
  }

  async testHardcoverCredential(apiKey?: string, signal?: AbortSignal): Promise<CoverProviderCredentialErrorCode | null> {
    try {
      const data = await this.hardcoverRequest(HARDCOVER_ISBN_QUERY, { isbn: "9780140328721", limit: 1 }, signal, apiKey);
      if (!Array.isArray(data.editions)) throw hardcoverMalformedResponse();
      const search = await this.hardcoverRequest(HARDCOVER_SEARCH_QUERY, { query: "Matilda", limit: 1 }, signal, apiKey);
      if (!isRecord(search.search) || search.search.error || !Array.isArray(search.search.ids)) throw hardcoverMalformedResponse();
      return null;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof CoverProviderError) {
        if (error.code === "provider_not_configured") throw error;
        if (error.code === "provider_invalid_token") return "invalid-or-expired-token";
        if (error.code === "provider_insufficient_permissions") return "insufficient-permissions";
        if (error.code === "provider_rate_limited") return "quota-exhausted";
        if (error.code === "provider_timeout") return "timeout";
      }
      return "provider-unavailable";
    }
  }

  private hardcoverRequest(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
    tokenOverride?: string,
  ): Promise<Record<string, unknown>> {
    // All requests share one provider lane, including searches, jobs and token tests.
    // Cooldowns fail promptly so an exhausted daily quota cannot hold an HTTP request open.
    const operation = this.hardcoverQueue.then(async () => {
      signal?.throwIfAborted();
      if (Date.now() < this.hardcoverCooldownUntil) throw hardcoverQuotaError();
      const remaining = this.hardcoverNextRequestAt - Date.now();
      if (remaining > 0) await providerDelay(remaining, signal);
      signal?.throwIfAborted();
      const token = tokenOverride ?? (typeof this.hardcoverTokenSource === "function" ? this.hardcoverTokenSource() : this.hardcoverTokenSource);
      if (!token?.trim()) throw new CoverProviderError("provider_not_configured", "Add a Hardcover API token in Settings before looking up series.");
      this.hardcoverNextRequestAt = Date.now() + 1_000;
      const timed = await this.fetchWithDeadline(new URL("https://api.hardcover.app/v1/graphql"), {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token.trim().replace(/^Bearer\s+/iu, "")}`,
          "User-Agent": "ShelfSend self-hosted series lookup",
        },
        body: JSON.stringify({ query, variables }),
      }, signal);
      const response = timed.response;
      this.recordHardcoverRateLimit(response);
      if (response.status === 401) throw hardcoverTokenError();
      if (response.status === 403) throw hardcoverPermissionsError();
      if (response.status === 429) throw hardcoverQuotaError();
      if (response.status === 408) throw new CoverProviderError("provider_timeout", "Hardcover took too long to respond. Try again shortly.");
      if (!response.ok) throw new CoverProviderError("provider_unavailable", "Hardcover could not complete the lookup. Try again later.");
      const value = parseProviderJson(await timed.readBody(MAX_PROVIDER_JSON_BYTES));
      if (Array.isArray(value.errors) && value.errors.length) {
        const codes = value.errors.flatMap((error) => isRecord(error) && isRecord(error.extensions) && typeof error.extensions.code === "string" ? [error.extensions.code.toLowerCase()] : []);
        if (codes.some((code) => ["invalid-jwt", "jwt-expired", "invalid_token", "unauthenticated"].includes(code))) throw hardcoverTokenError();
        if (codes.some((code) => ["access-denied", "permission-error", "insufficient_scope", "forbidden"].includes(code))) throw hardcoverPermissionsError();
        throw hardcoverMalformedResponse();
      }
      if (!isRecord(value.data)) throw hardcoverMalformedResponse();
      return value.data;
    });
    this.hardcoverQueue = operation.then(() => undefined, () => undefined);
    return abortableProviderWait(operation, signal);
  }

  private recordHardcoverRateLimit(response: Response): void {
    const now = Date.now();
    const retryAfter = response.headers.get("retry-after");
    if (response.status === 429) {
      const seconds = retryAfter && /^\d+(?:\.\d+)?$/u.test(retryAfter) ? Number(retryAfter) : null;
      const date = retryAfter ? Date.parse(retryAfter) : NaN;
      const waitMs = seconds !== null ? seconds * 1_000 : Number.isFinite(date) ? date - now : 60_000;
      this.hardcoverCooldownUntil = Math.max(this.hardcoverCooldownUntil, now + Math.max(1_000, Math.min(waitMs, 86_400_000)));
    }
    for (const bucket of (response.headers.get("ratelimit") ?? "").split(",")) {
      const remaining = /(?:^|;)\s*r=(\d+)(?:;|$)/u.exec(bucket)?.[1];
      const reset = /(?:^|;)\s*t=(\d+)(?:;|$)/u.exec(bucket)?.[1];
      if (remaining === "0" && reset) this.hardcoverCooldownUntil = Math.max(this.hardcoverCooldownUntil, now + Math.min(Number(reset) * 1_000, 86_400_000));
    }
  }

  async fetchCover(provider: CoverProvider, candidateId: string, signal?: AbortSignal): Promise<ProviderCoverBytes> {
    const url = providerCoverUrl(provider, candidateId);
    const timed = await this.fetchTrusted(url, provider, candidateId, signal);
    const { response } = timed;
    if (!response.ok) {
      throw new CoverProviderError("provider_unavailable", "The selected cover is no longer available.");
    }
    const mediaType = imageMediaType(response.headers.get("content-type"));
    if (!mediaType) throw new CoverProviderError("provider_unavailable", "The provider did not return an image.");
    return {
      data: await timed.readBody(MAX_METADATA_COVER_BYTES),
      mediaType,
      sourceUrl: response.url || url.toString(),
    };
  }

  private async searchGoogleBooks(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ProviderSearchCandidate[]> {
    const apiKey = this.googleBooksApiKey();
    if (!apiKey) {
      throw new CoverProviderError(
        "provider_not_configured",
        "Add a Google Books API key in Settings before searching this provider.",
      );
    }
    const url = new URL("https://www.googleapis.com/books/v1/volumes");
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", String(limit));
    url.searchParams.set("printType", "books");
    url.searchParams.set("projection", "lite");
    url.searchParams.set("key", apiKey);
    const timed = await this.fetchWithDeadline(url, { redirect: "error" }, signal);
    const { response } = timed;
    if (!response.ok) throw googleBooksSearchError(response.status);
    const value = parseProviderJson(await timed.readBody(MAX_PROVIDER_JSON_BYTES));
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

  private async searchGoogleBooksMetadata(
    terms: MetadataCandidateSearchTerms,
    limit: number,
    signal?: AbortSignal,
  ): Promise<CatalogMetadataCandidate[]> {
    const apiKey = this.googleBooksApiKey();
    if (!apiKey) {
      throw new CoverProviderError(
        "provider_not_configured",
        "Add a Google Books API key in Settings before searching this provider.",
      );
    }
    const query = [
      terms.title ? `intitle:${terms.title}` : "",
      terms.author ? `inauthor:${terms.author}` : "",
      terms.identifier ? `isbn:${terms.identifier}` : "",
    ].filter(Boolean).join(" ");
    const url = new URL("https://www.googleapis.com/books/v1/volumes");
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", String(limit));
    url.searchParams.set("printType", "books");
    url.searchParams.set("key", apiKey);
    const timed = await this.fetchWithDeadline(url, { redirect: "error" }, signal);
    const { response } = timed;
    if (!response.ok) throw googleBooksSearchError(response.status);
    const value = parseProviderJson(await timed.readBody(MAX_PROVIDER_JSON_BYTES));
    const items = Array.isArray(value.items) ? value.items : [];
    const results: CatalogMetadataCandidate[] = [];
    for (const item of items) {
      if (results.length >= limit) break;
      if (!isRecord(item)) continue;
      const candidateId = boundedString(item.id, 128);
      const info = isRecord(item.volumeInfo) ? item.volumeInfo : null;
      const title = info ? boundedString(info.title, 500) : null;
      if (!candidateId || !info || !title) continue;
      const metadata: Partial<EditableBookMetadata> = { title };
      const authors = boundedStringArray(info.authors, 20, 300);
      if (authors.length > 0) metadata.authors = authors;
      assignMetadataText(metadata, "publisher", info.publisher, 500);
      assignMetadataText(metadata, "publishedAt", info.publishedDate, 64);
      assignMetadataText(metadata, "description", info.description, 20_000);
      assignMetadataText(metadata, "language", info.language, 64);
      const subjects = boundedStringArray(info.categories, 100, 300);
      if (subjects.length > 0) metadata.subjects = subjects;
      const identifiers = Array.isArray(info.industryIdentifiers)
        ? info.industryIdentifiers.slice(0, 20).flatMap((identifier) => {
            if (!isRecord(identifier)) return [];
            const type = boundedString(identifier.type, 32);
            const identifierValue = boundedString(identifier.identifier, 64);
            return type && identifierValue ? [`${type}:${identifierValue}`] : [];
          })
        : [];
      if (identifiers.length > 0) metadata.identifiers = identifiers;
      results.push({
        provider: "google-books",
        candidateId,
        confidence: metadataCandidateConfidence(terms, metadata),
        metadata,
        ...(isRecord(info.imageLinks) ? { coverCandidateId: candidateId } : {}),
      });
    }
    return results;
  }

  async testGoogleBooksCredential(
    apiKey?: string,
    signal?: AbortSignal,
  ): Promise<CoverProviderCredentialErrorCode | null> {
    const selectedKey = apiKey ?? this.googleBooksApiKey();
    if (!selectedKey) {
      throw new CoverProviderError(
        "provider_not_configured",
        "Add a Google Books API key in Settings before testing this provider.",
      );
    }
    const url = new URL("https://www.googleapis.com/books/v1/volumes");
    url.searchParams.set("q", "isbn:9780140328721");
    url.searchParams.set("maxResults", "1");
    url.searchParams.set("projection", "lite");
    url.searchParams.set("key", selectedKey);
    let timed: TimedProviderResponse;
    try {
      timed = await this.fetchWithDeadline(url, { redirect: "error" }, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return error instanceof CoverProviderError && error.code === "provider_timeout"
        ? "timeout"
        : "provider-unavailable";
    }
    const { response } = timed;
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return "invalid-or-restricted-key";
    }
    if (response.status === 429) return "quota-exhausted";
    if (!response.ok) return "provider-unavailable";
    try {
      parseProviderJson(await timed.readBody(MAX_PROVIDER_JSON_BYTES));
      return null;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return error instanceof CoverProviderError && error.code === "provider_timeout"
        ? "timeout"
        : "provider-unavailable";
    }
  }

  private async searchOpenLibrary(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ProviderSearchCandidate[]> {
    const url = new URL("https://openlibrary.org/search.json");
    url.searchParams.set("q", query);
    url.searchParams.set("fields", "key,title,author_name,first_publish_year,isbn,cover_i");
    url.searchParams.set("limit", String(limit));
    const timed = await this.fetchWithDeadline(url, { redirect: "error" }, signal);
    const { response } = timed;
    if (!response.ok) throw new CoverProviderError("provider_unavailable", "Open Library cover search failed.");
    const value = parseProviderJson(await timed.readBody(MAX_PROVIDER_JSON_BYTES));
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

  private async searchOpenLibraryMetadata(
    terms: MetadataCandidateSearchTerms,
    limit: number,
    signal?: AbortSignal,
  ): Promise<CatalogMetadataCandidate[]> {
    const url = new URL("https://openlibrary.org/search.json");
    if (terms.title) url.searchParams.set("title", terms.title);
    if (terms.author) url.searchParams.set("author", terms.author);
    if (terms.identifier) url.searchParams.set("isbn", terms.identifier);
    url.searchParams.set(
      "fields",
      "key,title,author_name,first_publish_year,publish_date,isbn,cover_i,language,subject,publisher,series,series_index,first_sentence",
    );
    url.searchParams.set("limit", String(limit));
    const timed = await this.fetchWithDeadline(url, { redirect: "error" }, signal);
    const { response } = timed;
    if (!response.ok) throw new CoverProviderError("provider_unavailable", "Open Library metadata search failed.");
    const value = parseProviderJson(await timed.readBody(MAX_PROVIDER_JSON_BYTES));
    const docs = Array.isArray(value.docs) ? value.docs : [];
    const results: CatalogMetadataCandidate[] = [];
    for (const doc of docs) {
      if (results.length >= limit) break;
      if (!isRecord(doc)) continue;
      const candidateId = boundedString(doc.key, 160);
      const title = boundedString(doc.title, 500);
      if (!candidateId || !/^\/(?:works\/OL\d+W|books\/OL\d+M)$/u.test(candidateId) || !title) continue;
      const metadata: Partial<EditableBookMetadata> = { title };
      const authors = boundedStringArray(doc.author_name, 20, 300);
      if (authors.length > 0) metadata.authors = authors;
      const publishers = boundedStringArray(doc.publisher, 20, 500);
      if (publishers[0]) metadata.publisher = publishers[0];
      const dates = boundedStringArray(doc.publish_date, 20, 64);
      const year = Number(doc.first_publish_year);
      const publishedAt = dates[0] ?? (Number.isSafeInteger(year) && year > 0 ? String(year) : null);
      if (publishedAt) metadata.publishedAt = publishedAt;
      const languages = boundedStringArray(doc.language, 20, 64);
      if (languages[0]) metadata.language = languages[0];
      const subjects = boundedStringArray(doc.subject, 100, 300);
      if (subjects.length > 0) metadata.subjects = subjects;
      const series = boundedStringArray(doc.series, 20, 500);
      if (series[0]) metadata.series = series[0];
      const rawSeriesIndex = Array.isArray(doc.series_index) ? doc.series_index[0] : doc.series_index;
      const seriesIndex = Number(rawSeriesIndex);
      if (Number.isFinite(seriesIndex) && seriesIndex > 0 && seriesIndex <= 1_000_000) {
        metadata.seriesIndex = seriesIndex;
      }
      const firstSentences = Array.isArray(doc.first_sentence) ? doc.first_sentence : [doc.first_sentence];
      const description = boundedString(firstSentences[0], 20_000);
      if (description) metadata.description = description;
      const identifiers = boundedStringArray(doc.isbn, 20, 64).map((isbn) => `ISBN:${isbn}`);
      if (identifiers.length > 0) metadata.identifiers = identifiers;
      const coverId = Number(doc.cover_i);
      results.push({
        provider: "open-library",
        candidateId,
        confidence: metadataCandidateConfidence(terms, metadata),
        metadata,
        ...(Number.isSafeInteger(coverId) && coverId > 0 ? { coverCandidateId: String(coverId) } : {}),
      });
    }
    return results;
  }

  private async fetchTrusted(
    url: URL,
    provider: CoverProvider,
    candidateId: string,
    signal?: AbortSignal,
  ): Promise<TimedProviderResponse> {
    let current = url;
    const maximumRedirects = provider === "open-library" ? MAX_OPEN_LIBRARY_REDIRECTS : MAX_PROVIDER_REDIRECTS;
    for (let redirects = 0; redirects <= maximumRedirects; redirects += 1) {
      if (!trustedCoverLocation(current, provider, candidateId, redirects)) {
        throw new CoverProviderError("provider_unavailable", "The cover provider returned an untrusted location.");
      }
      const timed = await this.fetchWithDeadline(current, { redirect: "manual" }, signal);
      const { response } = timed;
      if (![301, 302, 303, 307, 308].includes(response.status)) return timed;
      const location = response.headers.get("location");
      if (!location || redirects === maximumRedirects) {
        throw new CoverProviderError("provider_unavailable", "The cover provider redirected unexpectedly.");
      }
      current = new URL(location, current);
      if (!safeHttpsLocation(current)) {
        throw new CoverProviderError("provider_unavailable", "The cover provider returned an insecure location.");
      }
    }
    throw new CoverProviderError("provider_unavailable", "The cover provider redirected unexpectedly.");
  }

  private async fetchWithDeadline(
    url: URL,
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<TimedProviderResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const mapFailure = (error: unknown): never => {
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (timeout.aborted) {
        throw new CoverProviderError("provider_timeout", "The cover provider request timed out.");
      }
      if (error instanceof CoverProviderError) throw error;
      throw new CoverProviderError("provider_unavailable", "The cover provider could not be reached.");
    };
    try {
      const response = await this.fetchImplementation(url, { ...init, signal });
      if (callerSignal?.aborted || timeout.aborted) mapFailure(signal.reason);
      return {
        response,
        readBody: async (maximumBytes) => {
          try {
            return await readBoundedBody(response, maximumBytes, signal);
          } catch (error) {
            return mapFailure(error);
          }
        },
      };
    } catch (error) {
      return mapFailure(error);
    }
  }

  private googleBooksApiKey(): string | undefined {
    return typeof this.googleBooksApiKeySource === "function"
      ? this.googleBooksApiKeySource()
      : this.googleBooksApiKeySource;
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

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const declared = response.headers.get("content-length");
  if (declared && (/^\d+$/u.test(declared) && Number(declared) > maximumBytes)) {
    throw new CoverProviderError("provider_response_too_large", "The provider response exceeds the configured limit.");
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let retained = 0;
  const reader = response.body.getReader();
  let abortListener: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(signal.reason);
        signal.addEventListener("abort", abortListener, { once: true });
      })
    : null;
  try {
    while (true) {
      const result = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      if (result.done) break;
      retained += result.value.byteLength;
      if (retained > maximumBytes) {
        await reader.cancel();
        throw new CoverProviderError("provider_response_too_large", "The provider response exceeds the configured limit.");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (signal?.aborted) await reader.cancel(signal.reason).catch(() => undefined);
    throw error;
  } finally {
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), retained);
}

function trustedCoverLocation(url: URL, provider: CoverProvider, candidateId: string, hop: number): boolean {
  if (!safeHttpsLocation(url)) return false;
  if (provider === "open-library") return trustedOpenLibraryLocation(url, candidateId, hop);
  const hostname = url.hostname.toLocaleLowerCase();
  return hostname === "books.google.com"
    || hostname === "books.googleusercontent.com"
    || hostname.endsWith(".googleusercontent.com");
}

function safeHttpsLocation(url: URL): boolean {
  return url.protocol === "https:"
    && url.username === ""
    && url.password === ""
    && url.port === ""
    && url.hash === "";
}

function trustedOpenLibraryLocation(url: URL, candidateId: string, hop: number): boolean {
  const bucket = (BigInt(candidateId) / 10_000n).toString();
  const filename = `${candidateId}-L.jpg`;
  const archiveName = `olcovers${bucket}`;
  if (hop === 0) {
    return url.hostname.toLocaleLowerCase() === "covers.openlibrary.org"
      && url.pathname === `/b/id/${filename}`
      && exactSearchParams(url, [["default", "false"]]);
  }
  if (hop === 1) {
    return url.hostname.toLocaleLowerCase() === "archive.org"
      && url.pathname === `/download/${archiveName}/${archiveName}-L.zip/${filename}`
      && url.search === "";
  }
  if (hop === 2) {
    return /^ia\d{6}\.us\.archive\.org$/u.test(url.hostname.toLocaleLowerCase())
      && url.pathname === "/view_archive.php"
      && exactSearchParams(url, [
        ["archive", new RegExp(`^/\\d{1,3}/items/${archiveName}/${archiveName}-L\\.zip$`, "u")],
        ["file", filename],
      ]);
  }
  return false;
}

function exactSearchParams(
  url: URL,
  expected: ReadonlyArray<readonly [string, string | RegExp]>,
): boolean {
  const entries = [...url.searchParams.entries()];
  if (entries.length !== expected.length) return false;
  return expected.every(([key, expectedValue]) => {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1) return false;
    return typeof expectedValue === "string"
      ? values[0] === expectedValue
      : expectedValue.test(values[0] ?? "");
  });
}

function googleBooksSearchError(status: number): CoverProviderError {
  if (status === 400 || status === 401 || status === 403) {
    return new CoverProviderError(
      "provider_unavailable",
      "Google Books rejected its configured API key. Check it in Settings.",
    );
  }
  if (status === 429) {
    return new CoverProviderError(
      "provider_unavailable",
      "Google Books quota is currently exhausted. Check the key in Settings or try again later.",
    );
  }
  return new CoverProviderError("provider_unavailable", "Google Books cover search failed.");
}

function hardcoverTokenError(): CoverProviderError {
  return new CoverProviderError("provider_invalid_token", "Hardcover rejected the token or it has expired. Replace it in Settings.");
}

function hardcoverPermissionsError(): CoverProviderError {
  return new CoverProviderError("provider_insufficient_permissions", "Hardcover needs catalog data and search permissions. Check your token in Settings.");
}

function hardcoverQuotaError(): CoverProviderError {
  return new CoverProviderError("provider_rate_limited", "Hardcover's request limit has been reached. Wait before retrying the lookup.");
}

function hardcoverMalformedResponse(): CoverProviderError {
  return new CoverProviderError("provider_unavailable", "Hardcover returned an incomplete response. No suggestions were applied; try again later.");
}

async function abortableProviderWait<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function providerDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await abortableProviderWait(new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds); }), signal);
  } finally {
    clearTimeout(timer);
  }
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
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized && normalized.length <= maximum && !/\p{Cc}/u.test(normalized) ? normalized : null;
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

function normalizedMetadataTerms(terms: MetadataCandidateSearchTerms): MetadataCandidateSearchTerms {
  const normalize = (value: string | undefined, maximum: number): string | undefined => {
    if (value === undefined) return undefined;
    const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!normalized || normalized.length > maximum || /\p{Cc}/u.test(normalized)) {
      throw new CoverProviderError("invalid_candidate", "Metadata search terms are invalid.");
    }
    return normalized;
  };
  const normalized = {
    title: normalize(terms.title, 500),
    author: normalize(terms.author, 500),
    identifier: normalize(terms.identifier, 128),
  };
  if (!normalized.title && !normalized.author && !normalized.identifier) {
    throw new CoverProviderError("invalid_candidate", "At least one metadata search term is required.");
  }
  return normalized;
}

function assignMetadataText(
  metadata: Partial<EditableBookMetadata>,
  field: "publisher" | "publishedAt" | "description" | "language",
  value: unknown,
  maximum: number,
): void {
  const normalized = boundedString(value, maximum);
  if (normalized) metadata[field] = normalized;
}

function metadataCandidateConfidence(
  terms: MetadataCandidateSearchTerms,
  metadata: Partial<EditableBookMetadata>,
): "high" | "medium" | "low" {
  const searchedIdentifier = normalizeKindleMetadataIdentifier(terms.identifier ?? "");
  const identifiers = (metadata.identifiers ?? []).map(normalizeKindleMetadataIdentifier);
  if (searchedIdentifier.length >= 4 && identifiers.includes(searchedIdentifier)) return "high";
  const searchedTitle = normalizeKindleMetadataWords(terms.title ?? "");
  const title = normalizeKindleMetadataWords(metadata.title ?? "");
  const searchedAuthor = normalizeKindleMetadataWords(terms.author ?? "");
  const authors = (metadata.authors ?? []).map(normalizeKindleMetadataWords);
  if (searchedTitle && title === searchedTitle && searchedAuthor && authors.includes(searchedAuthor)) return "high";
  if ((searchedTitle && title === searchedTitle) || (searchedAuthor && authors.includes(searchedAuthor))) return "medium";
  return "low";
}
