// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogApiError, HttpCatalogClient, MAX_CATALOG_SOURCE_BYTES } from "../../client/src/catalog-client";
import {
  MAX_CATALOG_JSON_RESPONSE_BYTES,
  MAX_MATCH_INDEX_RESPONSE_BYTES,
  METADATA_CLAIM_BITMAP_BYTES,
} from "../../shared/catalog-contracts";

const EMPTY_METADATA_CLAIM_BITMAP = btoa("\0".repeat(METADATA_CLAIM_BITMAP_BYTES));

afterEach(() => {
  vi.useRealTimers();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("HttpCatalogClient", () => {
  it("replaces an unopened event stream and renews a finite stream lease independently of request deadlines", async () => {
    vi.useFakeTimers();
    const streams: Array<{
      onopen: (() => void) | null;
      onmessage: null;
      onerror: (() => void) | null;
      close: ReturnType<typeof vi.fn>;
    }> = [];
    const createEventSource = vi.fn(() => {
      const stream = { onopen: null, onmessage: null, onerror: null, close: vi.fn() };
      streams.push(stream);
      return stream;
    });
    const onOpen = vi.fn();
    const onError = vi.fn();
    const client = new HttpCatalogClient({
      createEventSource,
      eventStreamOpenTimeoutMs: 10,
      eventStreamLeaseMs: 20,
      eventStreamReconnectMs: 5,
    });
    const unsubscribe = client.subscribeEvents(vi.fn(), onError, onOpen);

    await vi.advanceTimersByTimeAsync(10);
    expect(streams[0]?.close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5);
    expect(streams).toHaveLength(2);

    streams[1]?.onopen?.();
    expect(onOpen).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20);
    expect(streams[1]?.close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(streams).toHaveLength(3);

    unsubscribe();
    expect(streams[2]?.close).toHaveBeenCalledOnce();
  });

  it("bounds a blackholed fetch, aborts its transport signal, and cancels a response that arrives late", async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    const transportSignals: AbortSignal[] = [];
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      transportSignals.push(init?.signal as AbortSignal);
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    });
    const client = new HttpCatalogClient({ fetch, requestTimeoutMs: 20 });
    const pending = client.listProfiles();
    const rejected = expect(pending).rejects.toMatchObject({
      status: 408,
      code: "CATALOG_REQUEST_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(transportSignals[0]?.aborted).toBe(true);

    const lateResponse = jsonResponse([]);
    const cancel = vi.spyOn(lateResponse.body!, "cancel");
    resolveFetch(lateResponse);
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses one aggregate deadline when response headers arrive but JSON body reads blackhole", async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined));
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;
    const client = new HttpCatalogClient({ fetch: vi.fn(async () => response), requestTimeoutMs: 20 });
    const pending = client.listProfiles();
    const rejected = expect(pending).rejects.toMatchObject({ code: "CATALOG_REQUEST_TIMEOUT" });

    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("bounds and observes the body-less source blob fallback", async () => {
    vi.useFakeTimers();
    const blob = vi.fn(() => new Promise<Blob>(() => undefined));
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({
        "Content-Type": "application/epub+zip",
        "Content-Length": "4",
      }),
      body: null,
      blob,
    } as unknown as Response;
    const client = new HttpCatalogClient({ fetch: vi.fn(async () => response), sourceRequestTimeoutMs: 20 });
    const pending = client.getBookSource("prf_1", "book_1");
    const rejected = expect(pending).rejects.toMatchObject({ code: "CATALOG_REQUEST_TIMEOUT" });

    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(blob).toHaveBeenCalledOnce();
  });

  it("honors caller cancellation even when the fetch implementation ignores its signal", async () => {
    const transportSignals: AbortSignal[] = [];
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      transportSignals.push(init?.signal as AbortSignal);
      return new Promise<Response>(() => undefined);
    });
    const client = new HttpCatalogClient({ fetch });
    const controller = new AbortController();
    const reason = new DOMException("profile changed", "AbortError");
    const pending = client.listBooks("prf_1", {}, controller.signal);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(transportSignals[0]?.aborted).toBe(true);
  });

  it("reports SSE connection establishment separately from later errors", () => {
    const stream = { onopen: null as (() => void) | null, onmessage: null, onerror: null as (() => void) | null, close: vi.fn() };
    const onOpen = vi.fn();
    const onError = vi.fn();
    const client = new HttpCatalogClient({ createEventSource: vi.fn(() => stream) });
    const unsubscribe = client.subscribeEvents(vi.fn(), onError, onOpen);

    stream.onopen?.();
    expect(onOpen).toHaveBeenCalledOnce();
    stream.onerror?.();
    expect(onError).toHaveBeenCalledOnce();
    unsubscribe();
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it("parses service mode and nullable profile fields from direct API bodies", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ service: "kindle-bridge-catalog", live: true, ready: false, settingsMode: "read-only" }))
      .mockResolvedValueOnce(jsonResponse([{ id: "prf_1", name: "Home", description: null, initial: "H", sourceLabel: null, enabled: true, rootCount: 1, availableRootCount: 0, bookCount: 12 }]));
    const client = new HttpCatalogClient({ fetch });

    await expect(client.getStatus()).resolves.toMatchObject({ available: true, state: "indexing", settingsMode: "read-only" });
    await expect(client.listProfiles()).resolves.toEqual([expect.objectContaining({ id: "prf_1", name: "Home", description: "Household collection", bookCount: 12 })]);
  });

  it("maps durable database failure and recoverable cache degradation distinctly", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ live: true, ready: false, database: "error", cache: "ready" }))
      .mockResolvedValueOnce(jsonResponse({ live: true, ready: true, database: "ready", cache: "degraded" }));
    const client = new HttpCatalogClient({ fetch });

    await expect(client.getStatus()).resolves.toMatchObject({
      available: false,
      state: "unavailable",
      database: "error",
      cache: "ready",
    });
    await expect(client.getStatus()).resolves.toMatchObject({
      available: true,
      state: "degraded",
      database: "ready",
      cache: "degraded",
    });
  });

  it("encodes profile-scoped discovery filters, year, sort, and pagination", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ items: [], total: 0, limit: 24, offset: 48 }));
    const client = new HttpCatalogClient({ fetch });
    await client.listBooks("profile/one", { q: "wells & time", author: "H. G. Wells", year: "1895", metadata: "partial", sort: "published", order: "desc", limit: 24, offset: 48 });

    const url = new URL(String(fetch.mock.calls[0][0]), "http://127.0.0.1");
    expect(url.pathname).toBe("/api/profiles/profile%2Fone/books");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ q: "wells & time", author: "H. G. Wells", year: "1895", metadata: "partial", sort: "published", order: "desc", limit: "24", offset: "48" });
  });

  it("posts large include/exclude match sets before server pagination", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ items: [], total: 0, limit: 24, offset: 0 }));
    const client = new HttpCatalogClient({ fetch });
    await client.queryBooks("prf_1", { includeBookIds: ["book_a", "book_b"], excludeBookIds: ["book_c"], limit: 24 });

    expect(fetch).toHaveBeenCalledWith("/api/profiles/prf_1/books/query", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body))).toMatchObject({ includeBookIds: ["book_a", "book_b"], excludeBookIds: ["book_c"] });
  });

  it("loads and updates durable metadata overlays without changing the source hash", async () => {
    const sourceHash = "a".repeat(64);
    const metadataState = {
      book: {
        id: "book_1", profileId: "prf_1", rootId: "root_1", sourceFilename: "book.epub",
        title: "Edited title", authors: ["Edited author"], authorSort: "Author, Edited",
        language: "en", publisher: null, publishedAt: "2026", series: null, seriesIndex: null,
        description: null, subjects: [], identifiers: ["isbn:123"], format: "epub", size: 12,
        contentHash: sourceHash, presentationVersion: "b".repeat(64), addedAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z", metadataComplete: true, available: true,
        coverUrl: null, sourceUrl: "/api/source", metadataEdited: true, coverEdited: false,
        metadataRevision: 2,
      },
      sourceMetadata: {
        title: "Source title", authors: ["Source author"], authorSort: "Author, Source",
        language: "en", publisher: null, publishedAt: "2026", series: null, seriesIndex: null,
        description: null, subjects: [], identifiers: ["isbn:123"],
      },
      overrides: { title: "Edited title", authors: ["Edited author"] },
      revision: 2,
      basedOnContentHash: sourceHash,
      sourceChanged: false,
      coverOverride: null,
    };
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(metadataState));
    const client = new HttpCatalogClient({ fetch });

    await expect(client.getBookMetadata("prf_1", "book_1")).resolves.toMatchObject({
      revision: 2,
      basedOnContentHash: sourceHash,
      book: { title: "Edited title", contentHash: sourceHash, metadataEdited: true },
      overrides: { title: "Edited title" },
    });
    await client.updateBookMetadata("prf_1", "book_1", {
      expectedRevision: 2,
      expectedContentHash: sourceHash,
      changes: { publisher: "New publisher" },
    });

    expect(fetch.mock.calls[1]?.[0]).toBe("/api/profiles/prf_1/books/book_1/metadata");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String((fetch.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      expectedRevision: 2,
      expectedContentHash: sourceHash,
      changes: { publisher: "New publisher" },
    });
  });

  it("uses bounded same-origin cover search and raw cover upload routes", async () => {
    const sourceHash = "c".repeat(64);
    const search = {
      provider: "google-books",
      items: [{
        candidateId: "volume-1",
        title: "Book",
        authors: ["Author"],
        publishedAt: "2024",
        identifiers: ["ISBN_13:123"],
        thumbnailUrl: "/api/profiles/prf_1/books/book_1/cover-search/preview?candidate=volume-1",
      }],
    };
    const state = {
      book: {
        id: "book_1", profileId: "prf_1", rootId: "root_1", sourceFilename: "book.epub",
        title: "Book", authors: ["Author"], authorSort: "Author", language: "en", publisher: null,
        publishedAt: null, series: null, seriesIndex: null, description: null, subjects: [], identifiers: [],
        format: "epub", size: 12, contentHash: sourceHash, presentationVersion: "d".repeat(64),
        addedAt: "", updatedAt: "", metadataComplete: true, available: true,
        coverUrl: "/api/profiles/prf_1/books/book_1/cover", sourceUrl: "/api/source",
        metadataEdited: false, coverEdited: true, metadataRevision: 1,
      },
      sourceMetadata: { title: "Book", authors: ["Author"], authorSort: "Author", language: "en", publisher: null, publishedAt: null, series: null, seriesIndex: null, description: null, subjects: [], identifiers: [] },
      overrides: {}, revision: 1, basedOnContentHash: sourceHash, sourceChanged: false,
      coverOverride: { assetKey: "asset", mediaType: "image/jpeg", byteLength: 4, width: 1, height: 1, sourceKind: "upload", provider: null, providerReference: null, sourceUrl: null },
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(search))
      .mockResolvedValueOnce(jsonResponse(state));
    const client = new HttpCatalogClient({ fetch });

    const found = await client.searchBookCovers("prf_1", "book_1", "google-books", "Book Author");
    expect(found.items[0]?.thumbnailUrl).toContain("/api/profiles/");
    await client.uploadBookCover("prf_1", "book_1", new Blob(["jpeg"], { type: "image/jpeg" }), 0, sourceHash);

    expect(String(fetch.mock.calls[0]?.[0])).toContain("cover-search?provider=google-books&q=Book+Author&limit=12");
    expect(String(fetch.mock.calls[1]?.[0])).toContain(`cover?expectedRevision=0&expectedContentHash=${sourceHash}`);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "PUT", body: expect.any(Blob) });
  });

  it("saves profile and roots atomically with an idempotency key", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      profile: { id: "prf_new", name: "Research", description: null, initial: "R", sourceLabel: "research", enabled: true, rootCount: 1, availableRootCount: 0, bookCount: 0 },
      roots: [{ id: "root_new", profileId: "prf_new", label: "research", path: "/libraries/research", recursive: true, watch: true, enabled: true, status: "pending", lastScanAt: null, lastErrorCode: null }],
    }));
    const client = new HttpCatalogClient({ fetch });
    const saved = await client.saveConfiguration({ profile: { name: "Research", enabled: true }, roots: [{ label: "research", path: "/libraries/research", recursive: true, watch: true, enabled: true }] }, "idem-123");

    expect(saved.profile.id).toBe("prf_new");
    expect(saved.roots[0].status).toBe("pending");
    expect(fetch).toHaveBeenCalledWith("/api/profiles/configuration", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ "Idempotency-Key": "idem-123" }) }));
  });

  it("requires the caller's stable idempotency key for direct profile creation", async () => {
    const fetch = vi.fn(async () => jsonResponse({
      id: "prf_direct",
      name: "Direct",
      description: null,
      initial: "D",
      sourceLabel: null,
      enabled: true,
      rootCount: 0,
      availableRootCount: 0,
      bookCount: 0,
    }));
    const client = new HttpCatalogClient({ fetch });

    await expect(client.createProfile({ name: "Direct" }, "profile-create-123")).resolves.toMatchObject({
      id: "prf_direct",
      name: "Direct",
    });
    expect(fetch).toHaveBeenCalledWith("/api/profiles", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "Idempotency-Key": "profile-create-123" }),
    }));
  });

  it("round-trips a mount sentinel and opaque mount identity in Settings configuration", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { roots: Array<Record<string, unknown>> };
      return jsonResponse({
        profile: { id: "prf_guarded", name: "Guarded", initial: "G", enabled: true, rootCount: 1, availableRootCount: 1, bookCount: 0 },
        roots: [{
          id: "root_guarded",
          profileId: "prf_guarded",
          ...body.roots[0],
          status: "available",
        }],
      });
    });
    const client = new HttpCatalogClient({ fetch });
    const configuration = await client.saveConfiguration({
      profileId: "prf_guarded",
      profile: { name: "Guarded", enabled: true },
      roots: [{
        id: "root_guarded",
        label: "NAS books",
        path: "/libraries/guarded",
        recursive: true,
        watch: true,
        enabled: true,
        sentinel: ".kindle-bridge-volume",
        mountIdentity: "opaque-device-identity",
      }],
    }, "guarded-1");

    expect(JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit).body)).roots[0]).toMatchObject({
      sentinel: ".kindle-bridge-volume",
      mountIdentity: "opaque-device-identity",
    });
    expect(configuration.roots[0]).toMatchObject({
      sentinel: ".kindle-bridge-volume",
      mountIdentity: "opaque-device-identity",
    });
  });

  it("parses match-index data without requiring raw device identity", async () => {
    const fetch = vi.fn(async () => jsonResponse({ profileId: "prf_1", generatedAt: "2026-08-29T12:00:00Z", metadataClaims: { complete: true, collisionBitmap: EMPTY_METADATA_CLAIM_BITMAP }, entries: [{ bookId: "book_1", sourceFilename: "book.epub", sourceFormat: "epub", sourceSize: 100, contentHash: "hash", identifiers: ["isbn:1"], title: "Book", authors: ["Author"], authorSort: "Author, Test", staleManagedTokens: ["kb-0123456789abcdefabcd"], deliveries: [{ deviceKey: "digest", filename: "book.azw3", artifactHash: "artifact", artifactSize: 120, objectIdentity: "persistent", managedToken: "kb-token", status: "delivered", deliveredAt: "2026-08-29T12:05:00Z" }] }] }));
    const client = new HttpCatalogClient({ fetch });
    await expect(client.getMatchIndex("prf_1")).resolves.toEqual(expect.objectContaining({ metadataClaims: { complete: true, collisionBitmap: EMPTY_METADATA_CLAIM_BITMAP }, entries: [expect.objectContaining({ sourceFilename: "book.epub", sourceFormat: "EPUB", authorSort: "Author, Test", staleManagedTokens: ["kb-0123456789abcdefabcd"], deliveries: [expect.objectContaining({ managedToken: "kb-token" })] })] }));
  });

  it.each([
    ["missing", undefined],
    ["short", "AAAA"],
    ["invalid characters", `${EMPTY_METADATA_CLAIM_BITMAP.slice(0, -3)}!==`],
    ["non-canonical padding bits", `${EMPTY_METADATA_CLAIM_BITMAP.slice(0, -3)}B==`],
  ])("fails closed on a %s match-index claimant bitmap", async (_label, collisionBitmap) => {
    const fetch = vi.fn(async () => jsonResponse({
      profileId: "prf_1",
      generatedAt: "2026-08-29T12:00:00Z",
      metadataClaims: { complete: true, ...(collisionBitmap === undefined ? {} : { collisionBitmap }) },
      entries: [],
    }));
    const client = new HttpCatalogClient({ fetch });
    await expect(client.getMatchIndex("prf_1")).rejects.toMatchObject({
      code: "INVALID_MATCH_INDEX_SUMMARY",
    });
  });

  it("refuses an oversized match-index response before reading its body", async () => {
    const body = JSON.stringify({ profileId: "prf_1", generatedAt: "2026-08-29T12:00:00Z", entries: [] });
    const response = new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(MAX_MATCH_INDEX_RESPONSE_BYTES + 1),
      },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    const client = new HttpCatalogClient({ fetch: vi.fn(async () => response) });

    await expect(client.getMatchIndex("prf_1")).rejects.toMatchObject({
      status: 413,
      code: "MATCH_INDEX_TOO_LARGE",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("refuses every oversized catalog JSON response from Content-Length before reading its body", async () => {
    const response = new Response("[]", {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(MAX_CATALOG_JSON_RESPONSE_BYTES + 1),
      },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    const client = new HttpCatalogClient({ fetch: vi.fn(async () => response) });

    await expect(client.listProfiles()).rejects.toMatchObject({
      status: 413,
      code: "CATALOG_RESPONSE_TOO_LARGE",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels chunked catalog JSON before retaining a byte beyond the generic ceiling", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: { byteLength: MAX_CATALOG_JSON_RESPONSE_BYTES + 1 } })
      .mockResolvedValue({ done: true });
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;
    const client = new HttpCatalogClient({ fetch: vi.fn(async () => response) });

    await expect(client.listProfiles()).rejects.toMatchObject({
      status: 413,
      code: "CATALOG_RESPONSE_TOO_LARGE",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("rejects an oversized source from headers before buffering response bytes", async () => {
    const cancel = vi.fn(async () => undefined);
    const response = new Response("small placeholder", {
      headers: { "Content-Length": String(MAX_CATALOG_SOURCE_BYTES + 1) },
    });
    Object.defineProperty(response, "body", { value: { cancel } });
    const client = new HttpCatalogClient({ fetch: vi.fn(async () => response) });

    await expect(client.getBookSource("prf_1", "book_1")).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE",
      status: 413,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retains the source response presentation version for pre-transfer race checks", async () => {
    const presentationVersion = "e".repeat(64);
    const response = new Response(Uint8Array.from([1, 2, 3]), {
      headers: {
        "Content-Type": "application/epub+zip",
        "Content-Length": "3",
        ETag: `"sha256-${"a".repeat(64)}"`,
        "X-Kindle-Bridge-Presentation-Version": presentationVersion,
      },
    });
    const client = new HttpCatalogClient({ fetch: vi.fn(async () => response) });

    await expect(client.getBookSource("prf_1", "book_1")).resolves.toMatchObject({
      contentLength: 3,
      presentationVersion,
    });
  });

  it("cancels a source stream that exceeds the limit even when length headers are absent", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: { byteLength: MAX_CATALOG_SOURCE_BYTES + 1 } })
      .mockResolvedValue({ done: true });
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/epub+zip" }),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;
    const client = new HttpCatalogClient({ fetch: vi.fn(async () => response) });

    await expect(client.getBookSource("prf_1", "book_1")).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("uses the structured error envelope and never exposes arbitrary response text", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: { code: "ROOT_OUTSIDE_MOUNT", message: "The configured folder is outside an allowed container mount." }, debug: "/secret/path" }, 400));
    const client = new HttpCatalogClient({ fetch });
    const error = await client.listRoots("prf_1").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CatalogApiError);
    expect(error).toMatchObject({ status: 400, code: "ROOT_OUTSIDE_MOUNT", message: "The configured folder is outside an allowed container mount." });
    expect(String(error)).not.toContain("/secret/path");
  });
});
