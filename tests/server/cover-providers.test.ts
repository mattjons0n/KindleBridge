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
});
