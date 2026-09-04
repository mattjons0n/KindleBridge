import { describe, expect, it } from "vitest";

import {
  CoverProviderClient,
  CoverProviderError,
  providerCoverUrl,
} from "../../server/cover-providers.js";

describe("fixed cover providers", () => {
  it("maps bounded Google Books and Open Library results without exposing remote preview URLs", async () => {
    const requests: URL[] = [];
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input));
      requests.push(url);
      if (url.hostname === "www.googleapis.com") {
        return new Response(JSON.stringify({
          items: [null, {
            id: "volume_1",
            volumeInfo: {
              title: "A Google result",
              authors: ["Ada Author"],
              publishedDate: "2026",
              imageLinks: { thumbnail: "https://untrusted.example/hotlink.jpg" },
              industryIdentifiers: [{ type: "ISBN_13", identifier: "9780000000001" }],
            },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        docs: [null, {
          title: "An Open Library result",
          author_name: ["Grace Author"],
          first_publish_year: 2025,
          isbn: ["9780000000002"],
          cover_i: 42,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const providers = new CoverProviderClient(fetcher, "secret-key", 1_000);

    await expect(providers.search("google-books", "ISBN", 5)).resolves.toEqual([{
      candidateId: "volume_1",
      title: "A Google result",
      authors: ["Ada Author"],
      publishedAt: "2026",
      identifiers: ["ISBN_13:9780000000001"],
    }]);
    await expect(providers.search("open-library", "Title Author", 5)).resolves.toEqual([{
      candidateId: "42",
      title: "An Open Library result",
      authors: ["Grace Author"],
      publishedAt: "2025",
      identifiers: ["ISBN:9780000000002"],
    }]);
    expect(requests[0]?.hostname).toBe("www.googleapis.com");
    expect(requests[0]?.searchParams.get("key")).toBe("secret-key");
    expect(requests[1]?.hostname).toBe("openlibrary.org");
  });

  it("constructs cover downloads only from validated provider identifiers", () => {
    expect(providerCoverUrl("google-books", "safe_ID-1").hostname).toBe("books.google.com");
    expect(providerCoverUrl("open-library", "1234").hostname).toBe("covers.openlibrary.org");
    expect(() => providerCoverUrl("google-books", "https://127.0.0.1/private")).toThrow(CoverProviderError);
    expect(() => providerCoverUrl("open-library", "../private")).toThrow(CoverProviderError);
  });

  it("resolves the current Google Books key for every search and fails early when none is configured", async () => {
    let key: string | undefined;
    const requests: URL[] = [];
    const fetcher = (async (input: URL | RequestInfo) => {
      requests.push(input instanceof URL ? input : new URL(String(input)));
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;
    const providers = new CoverProviderClient(fetcher, () => key, 1_000);

    await expect(providers.search("google-books", "Title", 1)).rejects.toMatchObject({
      code: "provider_not_configured",
    });
    expect(requests).toEqual([]);

    key = "first-key";
    await providers.search("google-books", "Title", 1);
    key = "replacement-key";
    await providers.search("google-books", "Title", 1);
    expect(requests.map((url) => url.searchParams.get("key"))).toEqual(["first-key", "replacement-key"]);
  });

  it("searches normalized metadata fields on fixed provider endpoints", async () => {
    const requests: URL[] = [];
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input));
      requests.push(url);
      if (url.hostname === "www.googleapis.com") {
        return new Response(JSON.stringify({
          items: [{
            id: "google-volume",
            volumeInfo: {
              title: "Exact Book",
              authors: ["Exact Author"],
              publisher: "Provider Press",
              publishedDate: "2026-03-01",
              description: "Provider description",
              language: "en",
              categories: ["Fiction"],
              imageLinks: { thumbnail: "https://ignored.invalid/cover" },
              industryIdentifiers: [{ type: "ISBN_13", identifier: "9780000000001" }],
            },
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        docs: [{
          key: "/works/OL123W",
          title: "Exact Book",
          author_name: ["Exact Author"],
          publisher: ["Archive Press"],
          first_publish_year: 2020,
          language: ["eng"],
          subject: ["Space opera"],
          series: ["Archive Cycle"],
          series_index: [2.5],
          first_sentence: ["A provider-supplied description."],
          isbn: ["9780000000001"],
          cover_i: 284362,
        }],
      }), { status: 200 });
    }) as typeof fetch;
    const providers = new CoverProviderClient(fetcher, "secret-key", 1_000);

    await expect(providers.searchMetadata("google-books", {
      title: "  Exact   Book ", author: "Exact Author", identifier: "9780000000001",
    }, 12)).resolves.toEqual([expect.objectContaining({
      provider: "google-books",
      candidateId: "google-volume",
      confidence: "high",
      coverCandidateId: "google-volume",
      metadata: expect.objectContaining({ title: "Exact Book", publisher: "Provider Press", subjects: ["Fiction"] }),
    })]);
    await expect(providers.searchMetadata("open-library", {
      title: "Exact Book", author: "Exact Author", identifier: "9780000000001",
    }, 12)).resolves.toEqual([expect.objectContaining({
      provider: "open-library",
      candidateId: "/works/OL123W",
      coverCandidateId: "284362",
      metadata: expect.objectContaining({
        publisher: "Archive Press",
        language: "eng",
        subjects: ["Space opera"],
        series: "Archive Cycle",
        seriesIndex: 2.5,
        description: "A provider-supplied description.",
      }),
    })]);

    expect(requests[0]?.pathname).toBe("/books/v1/volumes");
    expect(requests[0]?.searchParams.get("q")).toBe("intitle:Exact Book inauthor:Exact Author isbn:9780000000001");
    expect(requests[1]?.pathname).toBe("/search.json");
    expect(requests[1]?.searchParams.get("q")).toBeNull();
    expect(Object.fromEntries(requests[1]!.searchParams)).toMatchObject({
      title: "Exact Book",
      author: "Exact Author",
      isbn: "9780000000001",
    });
  });

  it.each([
    [200, null],
    [400, "invalid-or-restricted-key"],
    [401, "invalid-or-restricted-key"],
    [403, "invalid-or-restricted-key"],
    [429, "quota-exhausted"],
    [503, "provider-unavailable"],
  ] as const)("maps a Google Books credential test response %s to %s", async (status, expected) => {
    const fetcher = (async () => new Response(status === 200 ? JSON.stringify({ items: [] }) : "", { status })) as typeof fetch;
    const providers = new CoverProviderClient(fetcher, undefined, 1_000);
    await expect(providers.testGoogleBooksCredential("test-key")).resolves.toBe(expected);
  });

  it("distinguishes a bounded provider timeout from temporary unavailability", async () => {
    const fetcher = ((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const providers = new CoverProviderClient(fetcher, undefined, 5);
    await expect(providers.testGoogleBooksCredential("test-key")).resolves.toBe("timeout");

    const stalledBody = (async () => new Response(new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    }), { status: 200 })) as typeof fetch;
    const bodyProviders = new CoverProviderClient(stalledBody, undefined, 5);
    await expect(bodyProviders.testGoogleBooksCredential("test-key")).resolves.toBe("timeout");
  });

  it("preserves an explicit caller cancellation instead of converting it to a provider failure", async () => {
    const fetcher = ((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const providers = new CoverProviderClient(fetcher, "test-key", 10_000);
    const cancellation = new Error("caller-cancelled");
    const controller = new AbortController();
    const pending = providers.search("google-books", "Title", 1, controller.signal);
    controller.abort(cancellation);
    await expect(pending).rejects.toBe(cancellation);
  });

  it("accepts only the exact observed Open Library archive redirect chain", async () => {
    const requests: URL[] = [];
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input));
      requests.push(url);
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://archive.org/download/olcovers28/olcovers28-L.zip/284362-L.jpg" },
        });
      }
      if (requests.length === 2) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://ia902908.us.archive.org/view_archive.php?archive=/24/items/olcovers28/olcovers28-L.zip&file=284362-L.jpg",
          },
        });
      }
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    }) as typeof fetch;
    const providers = new CoverProviderClient(fetcher, undefined, 1_000);

    await expect(providers.fetchCover("open-library", "284362")).resolves.toMatchObject({
      mediaType: "image/jpeg",
      data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    expect(requests.map((url) => url.hostname)).toEqual([
      "covers.openlibrary.org",
      "archive.org",
      "ia902908.us.archive.org",
    ]);
  });

  it.each([
    "http://archive.org/download/olcovers28/olcovers28-L.zip/284362-L.jpg",
    "https://archive.org.evil.example/download/olcovers28/olcovers28-L.zip/284362-L.jpg",
    "https://user@archive.org/download/olcovers28/olcovers28-L.zip/284362-L.jpg",
    "https://archive.org:444/download/olcovers28/olcovers28-L.zip/284362-L.jpg",
    "https://archive.org/download/olcovers27/olcovers27-L.zip/284362-L.jpg",
    "https://archive.org/download/olcovers28/olcovers28-L.zip/284363-L.jpg",
    "https://archive.org/download/olcovers28/olcovers28-M.zip/284362-M.jpg",
    "https://archive.org/download/olcovers28/olcovers28-L.zip/284362-L.jpg?extra=true",
  ])("rejects an untrusted first Open Library redirect: %s", async (location) => {
    const fetcher = (async () => new Response(null, { status: 302, headers: { Location: location } })) as typeof fetch;
    const providers = new CoverProviderClient(fetcher, undefined, 1_000);
    await expect(providers.fetchCover("open-library", "284362")).rejects.toBeInstanceOf(CoverProviderError);
  });

  it.each([
    "https://evil.example/view_archive.php?archive=/24/items/olcovers28/olcovers28-L.zip&file=284362-L.jpg",
    "https://ia902908.us.archive.org/other?archive=/24/items/olcovers28/olcovers28-L.zip&file=284362-L.jpg",
    "https://ia902908.us.archive.org/view_archive.php?archive=/24/items/olcovers27/olcovers27-L.zip&file=284362-L.jpg",
    "https://ia902908.us.archive.org/view_archive.php?archive=/24/items/olcovers28/olcovers28-L.zip&file=284363-L.jpg",
    "https://ia902908.us.archive.org/view_archive.php?archive=/24/items/olcovers28/olcovers28-L.zip&file=284362-L.jpg&extra=true",
    "https://ia902908.us.archive.org/view_archive.php?archive=/24/items/olcovers28/olcovers28-L.zip&file=284362-L.jpg&file=284362-L.jpg",
  ])("rejects an untrusted Archive.org data-node redirect: %s", async (location) => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: {
          Location: calls === 1
            ? "https://archive.org/download/olcovers28/olcovers28-L.zip/284362-L.jpg"
            : location,
        },
      });
    }) as typeof fetch;
    const providers = new CoverProviderClient(fetcher, undefined, 1_000);
    await expect(providers.fetchCover("open-library", "284362")).rejects.toBeInstanceOf(CoverProviderError);
  });

  it("rejects redirects beyond the exact two-hop Open Library chain", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: {
          Location: calls === 1
            ? "https://archive.org/download/olcovers28/olcovers28-L.zip/284362-L.jpg"
            : "https://ia902908.us.archive.org/view_archive.php?archive=/24/items/olcovers28/olcovers28-L.zip&file=284362-L.jpg",
        },
      });
    }) as typeof fetch;
    const providers = new CoverProviderClient(fetcher, undefined, 1_000);
    await expect(providers.fetchCover("open-library", "284362")).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    expect(calls).toBe(3);
  });
});
