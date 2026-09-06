import { afterEach, describe, expect, it, vi } from "vitest";
import { CoverProviderClient } from "../../server/cover-providers.js";
import { hardcoverMetadataCandidates } from "../../server/hardcover-provider.js";

const ISBN = "9780140328721";
const book = (id = 12, memberships: unknown[] = [{ series_id: 50, position: 1.5, series: { name: "The Example Cycle" } }]) => ({
  id,
  title: "Example Book",
  contributions: [{ contribution: null, author: { name: "Example Author" } }, { contribution: "Narrator", author: { name: "Not the author" } }],
  book_series: memberships,
  editions: [{ isbn_13: ISBN, isbn_10: "0140328726" }],
});
const dataResponse = (data: unknown, headers?: Record<string, string>) => new Response(JSON.stringify({ data }), { headers });
const requestBody = (init?: RequestInit) => JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Hardcover series metadata provider", () => {
  it("looks up ISBN first and returns a distinct choice for every series with fractional and zero positions", async () => {
    const fetcher = vi.fn(async () => dataResponse({ editions: [{ isbn_13: ISBN, book: book(12, [
      { series_id: 50, position: 1.5, series: { name: "The Example Cycle" } },
      { series_id: 51, position: 0, series: { name: "Prequels" } },
    ]) }] }));
    const client = new CoverProviderClient(fetcher, undefined, 1_000, "Bearer saved-token");
    const items = await client.searchMetadata("hardcover", { identifier: "ISBN:978-0-14-032872-1", title: "Example Book" }, 12);
    expect(items).toEqual([
      { provider: "hardcover", candidateId: "book-12-series-50", confidence: "high", metadata: { title: "Example Book", authors: ["Example Author"], identifiers: [`ISBN:${ISBN}`], series: "The Example Cycle", seriesIndex: 1.5 } },
      { provider: "hardcover", candidateId: "book-12-series-51", confidence: "high", metadata: { title: "Example Book", authors: ["Example Author"], identifiers: [`ISBN:${ISBN}`], series: "Prequels", seriesIndex: 0 } },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.hardcover.app/v1/graphql");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer saved-token", "User-Agent": "ShelfSend self-hosted series lookup" } });
    expect(requestBody(init)).toMatchObject({ variables: { isbn: ISBN, limit: 12 } });
    expect(requestBody(init).query).toContain("isbn_13: {_eq: $isbn}");
    expect(JSON.stringify(items)).not.toContain("saved-token");
    expect(items.every((item) => item.coverCandidateId === undefined)).toBe(true);
  });

  it("falls back from unmatched ISBN to title and author search and restores relevance ordering", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const requests: { query: string; variables: Record<string, unknown> }[] = [];
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = requestBody(init);
      requests.push(body);
      now += 1_000;
      if (body.query.includes("SeriesByIsbn")) return dataResponse({ editions: [] });
      if (body.query.includes("SeriesSearch")) return dataResponse({ search: { ids: [42, 12, 42, -1, "bad", 2_147_483_648], error: null } });
      return dataResponse({ books: [book(12), book(42), book(999)] });
    });
    const client = new CoverProviderClient(fetcher, undefined, 1_000, "token");
    const items = await client.searchMetadata("hardcover", { title: " Example  Book ", author: "Example Author", identifier: ISBN }, 12);
    expect(requests).toHaveLength(3);
    expect(requests[1]?.variables).toEqual({ query: "Example Book Example Author", limit: 12 });
    expect(requests[1]?.query).toContain('query_type: "book"');
    expect(requests[1]?.query).toContain("{ ids error }");
    expect(requests[2]?.variables).toEqual({ ids: [42, 12], limit: 12 });
    expect(requests.every((request) => !request.query.includes("_ilike") && !request.query.includes("mutation"))).toBe(true);
    expect(items.map((item) => item.candidateId)).toEqual(["book-42-series-50", "book-12-series-50"]);
  });

  it("bounds and deduplicates candidates, skips invalid series and never guesses a missing position", () => {
    const entries = [
      { series_id: 50, position: null, series: { name: "Unknown position" } },
      { series_id: 50, position: 5, series: { name: "Duplicate" } },
      { series_id: 51, position: -1, series: { name: "Negative position" } },
      { series_id: 52, position: Infinity, series: { name: "Nonfinite position" } },
      { series_id: 53, position: "1.5", series: { name: "String position" } },
      { series_id: 54, position: 1, series: { name: "\n" } },
      { series_id: 55, position: 1, series: { name: "Bad\u0000name" } },
    ];
    const items = hardcoverMetadataCandidates([book(12, entries), null, book(12, entries)], { title: "Example Book", author: "Example Author" }, 20);
    expect(items).toHaveLength(4);
    expect(items.every((item) => item.metadata.seriesIndex === null && item.confidence === "high")).toBe(true);
    expect(hardcoverMetadataCandidates([book(12, entries)], {}, 2)).toHaveLength(2);
  });

  it("does not fall back to a different title when the exact ISBN has no series data", async () => {
    const fetcher = vi.fn(async () => dataResponse({ editions: [{ isbn_13: ISBN, book: book(12, []) }] }));
    await expect(new CoverProviderClient(fetcher, undefined, 1_000, "token").searchMetadata("hardcover", { identifier: ISBN, title: "Example Book" }, 12)).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not expose Hardcover as a cover provider and requires a configured token before a request", async () => {
    const fetcher = vi.fn();
    const client = new CoverProviderClient(fetcher);
    await expect(client.searchMetadata("hardcover", { title: "Example" }, 12)).rejects.toMatchObject({ code: "provider_not_configured" });
    await expect(client.fetchCover("hardcover" as never, "book-12-series-50")).rejects.toMatchObject({ code: "invalid_provider" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [401, "provider_invalid_token", "invalid-or-expired-token"],
    [403, "provider_insufficient_permissions", "insufficient-permissions"],
    [429, "provider_rate_limited", "quota-exhausted"],
    [503, "provider_unavailable", "provider-unavailable"],
  ])("reports HTTP %s without including provider bodies or tokens", async (status, code, credentialCode) => {
    const fetcher = vi.fn(async () => new Response("untrusted token-bearing provider error", { status }));
    const client = new CoverProviderClient(fetcher, undefined, 1_000, "secret-token");
    await expect(client.searchMetadata("hardcover", { identifier: ISBN }, 1)).rejects.toMatchObject({ code });
    const credentialClient = new CoverProviderClient(fetcher, undefined, 1_000, "secret-token");
    await expect(credentialClient.testHardcoverCredential()).resolves.toBe(credentialCode);
  });

  it("tests catalog data and search permissions with an override without replacing the saved token", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const seen: string[] = [];
    let token = "saved-token";
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      now += 1_000;
      seen.push(new Headers(init?.headers).get("Authorization") ?? "");
      return requestBody(init).query.includes("SeriesSearch") ? dataResponse({ search: { ids: [], error: null } }) : dataResponse({ editions: [] });
    });
    const client = new CoverProviderClient(fetcher, undefined, 1_000, () => token);
    await expect(client.testHardcoverCredential("new-token")).resolves.toBeNull();
    token = "rotated-token";
    await client.searchMetadata("hardcover", { identifier: ISBN }, 1);
    expect(seen).toEqual(["Bearer new-token", "Bearer new-token", "Bearer rotated-token"]);
  });

  it("fails credential testing when catalog works but search scope is missing", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      now += 1_000;
      return requestBody(init).query.includes("SeriesSearch") ? new Response("denied", { status: 403 }) : dataResponse({ editions: [] });
    });
    await expect(new CoverProviderClient(fetcher, undefined, 1_000, "token").testHardcoverCredential()).resolves.toBe("insufficient-permissions");
  });

  it.each([
    { errors: [{ extensions: { code: "invalid-jwt" }, message: "secret" }], data: { editions: [] } },
    { data: null },
    { data: { editions: "not-an-array" } },
  ])("rejects GraphQL errors and malformed envelopes instead of claiming an empty successful lookup", async (body) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(body)));
    await expect(new CoverProviderClient(fetcher, undefined, 1_000, "token").searchMetadata("hardcover", { identifier: ISBN }, 1)).rejects.toThrow();
  });

  it("honors Retry-After across callers without repeated requests while cooling down", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetcher = vi.fn(async () => new Response("limited", { status: 429, headers: { "Retry-After": "120" } }));
    const client = new CoverProviderClient(fetcher, undefined, 1_000, "token");
    await expect(client.searchMetadata("hardcover", { identifier: ISBN }, 1)).rejects.toMatchObject({ code: "provider_rate_limited" });
    now += 119_999;
    await expect(client.searchMetadata("hardcover", { identifier: ISBN }, 1)).rejects.toMatchObject({ code: "provider_rate_limited" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 1;
    await expect(client.searchMetadata("hardcover", { identifier: ISBN }, 1)).rejects.toMatchObject({ code: "provider_rate_limited" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("respects a depleted rate-limit header on successful replies", async () => {
    const fetcher = vi.fn(async () => dataResponse({ editions: [] }, { RateLimit: '"Free";r=3;t=2, "daily";r=0;t=500' }));
    const client = new CoverProviderClient(fetcher, undefined, 1_000, "token");
    await client.searchMetadata("hardcover", { identifier: ISBN }, 1);
    await expect(client.searchMetadata("hardcover", { identifier: ISBN }, 1)).rejects.toMatchObject({ code: "provider_rate_limited" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("paces concurrent callers at one request per second and cancels a waiting caller without making its request", async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    const fetcher = vi.fn(async () => { times.push(Date.now()); return dataResponse({ editions: [] }); });
    const client = new CoverProviderClient(fetcher, undefined, 1_000, "token");
    const cancelled = new AbortController();
    const first = client.searchMetadata("hardcover", { identifier: ISBN }, 1);
    await vi.advanceTimersByTimeAsync(0);
    await first;
    const waiting = client.searchMetadata("hardcover", { identifier: ISBN }, 1, cancelled.signal);
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    cancelled.abort();
    await rejected;
    const next = client.searchMetadata("hardcover", { identifier: ISBN }, 1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(times).toHaveLength(2);
    expect(times[1]! - times[0]!).toBe(1_000);
  });

  it("bounds streamed response bytes and propagates abort while a body is stalled", async () => {
    const large = new CoverProviderClient(async () => new Response("{}", { headers: { "Content-Length": String(2 * 1024 * 1024 + 1) } }), undefined, 1_000, "token");
    await expect(large.searchMetadata("hardcover", { identifier: ISBN }, 1)).rejects.toMatchObject({ code: "provider_response_too_large" });
    const controller = new AbortController();
    let bodyStarted!: () => void;
    const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start() { bodyStarted(); } })));
    const promise = new CoverProviderClient(fetcher, undefined, 1_000, "token").searchMetadata("hardcover", { identifier: ISBN }, 1, controller.signal);
    const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await started;
    controller.abort();
    await rejected;
  });

  it("applies the request deadline to a stalled body", async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream()));
    const client = new CoverProviderClient(fetcher, undefined, 20, "token");
    await expect(client.searchMetadata("hardcover", { identifier: ISBN }, 1)).rejects.toMatchObject({ code: "provider_timeout" });
  });
});
