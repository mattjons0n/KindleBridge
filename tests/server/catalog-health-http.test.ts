import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogDatabase } from "../../server/catalog-database.js";
import { CoverCache } from "../../server/cover-cache.js";
import { CatalogEventHub } from "../../server/event-hub.js";
import { CatalogHttpServer } from "../../server/http-server.js";
import { MetadataCoverStore } from "../../server/metadata-cover-store.js";
import { AllowedRootPolicy } from "../../server/root-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function onePixelPng(): Uint8Array {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
}

describe("catalog health and provider metadata HTTP contracts", () => {
  it("keeps lookup inputs normalized, imports reviewed fields atomically, and coalesces bulk progress", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-health-http-"));
    temporaryDirectories.push(directory);
    const library = path.join(directory, "library");
    const data = path.join(directory, "data");
    const cache = path.join(directory, "cache");
    await mkdir(library);
    await mkdir(data);
    const database = new CatalogDatabase(path.join(data, "catalog.sqlite"));
    const profile = database.createProfile({ name: "HTTP Health" });
    const root = database.createRoot(profile.id, { label: "Books", path: library });
    const indexed = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "book.epub",
      format: "epub",
      size: 100,
      mtimeMs: 1,
      contentHash: "a".repeat(64),
      scanToken: "scan-http-health",
      metadata: {
        title: "Source title",
        authors: ["Source Author"],
        authorSort: null,
        language: "en",
        publisher: null,
        publishedAt: null,
        series: null,
        seriesIndex: null,
        subjects: [],
        identifiers: ["ISBN:9780000000001"],
        metadataComplete: true,
        coverKey: null,
        coverMediaType: null,
      },
    });
    const duplicate = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "preferred.epub",
      format: "epub",
      size: 100,
      mtimeMs: 1,
      contentHash: "a".repeat(64),
      scanToken: "scan-http-health",
      retainedRelativePaths: new Set(["book.epub", "preferred.epub"]),
      metadata: {
        title: "Preferred presentation",
        authors: ["Source Author"],
        authorSort: null,
        language: "en",
        publisher: null,
        publishedAt: null,
        series: null,
        seriesIndex: null,
        subjects: [],
        identifiers: [],
        metadataComplete: true,
        coverKey: "preferred.png",
        coverMediaType: "image/png",
      },
    });
    const requests: URL[] = [];
    const providerFetch = (async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input));
      requests.push(url);
      if (url.hostname === "www.googleapis.com") {
        return new Response(JSON.stringify({ items: [{
          id: "volume_1",
          volumeInfo: {
            title: "Provider title",
            authors: ["Provider Author"],
            publisher: "Provider Press",
            imageLinks: { thumbnail: "https://ignored.invalid/cover" },
            industryIdentifiers: [{ type: "ISBN_13", identifier: "9780000000001" }],
          },
        }] }), { status: 200 });
      }
      if (url.hostname === "books.google.com") {
        if (url.searchParams.get("id") === "invalid") {
          return new Response("not-an-image", { status: 200, headers: { "Content-Type": "image/png" } });
        }
        return new Response(onePixelPng() as BodyInit, { status: 200, headers: { "Content-Type": "image/png" } });
      }
      throw new Error(`Unexpected provider host: ${url.hostname}`);
    }) as typeof fetch;
    const coverCache = new CoverCache(cache);
    await coverCache.initialize();
    const metadataStore = new MetadataCoverStore(data);
    await metadataStore.initialize();
    const events = new CatalogEventHub();
    const publish = vi.spyOn(events, "publish");
    const requestRescan = vi.fn(() => true);
    const server = new CatalogHttpServer(
      database,
      { requestRescan } as never,
      await AllowedRootPolicy.create([library]),
      coverCache,
      events,
      {
        hostname: "127.0.0.1",
        port: 0,
        allowedHosts: ["127.0.0.1"],
        requireOriginForMutations: false,
        googleBooksApiKey: "settings-key",
        coverProviderFetch: providerFetch,
        requestsPerMinutePerAddress: 1_000,
      },
      metadataStore,
    );
    const address = await server.listen();
    const base = `http://127.0.0.1:${address.port}/api/profiles/${profile.id}`;
    const json = { "Content-Type": "application/json" };
    try {
      const health = await (await fetch(`${base}/issues?type=missing-cover`)).json() as {
        items: Array<{ signature: string; disposition: { revision: number } }>;
      };
      expect(health.items).toHaveLength(1);
      expect(await (await fetch(`${base}/books?coverAvailable=false`)).json()).toMatchObject({ total: 1 });
      expect(await (await fetch(`${base}/books?coverAvailable=true`)).json()).toMatchObject({ total: 1 });
      const signature = health.items[0]!.signature;
      const ignored = await fetch(`${base}/issues/${signature}`, {
        method: "PATCH", headers: json, body: JSON.stringify({ expectedRevision: 0, ignored: true }),
      });
      expect(ignored.status).toBe(200);
      const retry = await fetch(`${base}/issues/${signature}/retry`, {
        method: "POST", headers: json, body: JSON.stringify({ expectedRevision: 1 }),
      });
      expect(retry.status).toBe(202);
      expect(await retry.json()).toMatchObject({ acceptedRootIds: [root.id], blockedRootIds: [] });
      expect(requestRescan).toHaveBeenCalledWith(root.id);

      const invalidPreview = await fetch(`${base}/books/${indexed.bookId}/cover-preview?provider=google-books&candidateId=invalid`);
      expect(invalidPreview.status).toBe(502);

      const duplicateHealth = await (await fetch(`${base}/issues?type=suspected-duplicate`)).json() as {
        items: Array<{ signature: string; disposition: { revision: number } }>;
      };
      const duplicateSignature = duplicateHealth.items[0]!.signature;
      const preferred = await fetch(`${base}/issues/${duplicateSignature}/preferred-book`, {
        method: "PATCH",
        headers: json,
        body: JSON.stringify({ expectedRevision: 0, preferredBookId: duplicate.bookId }),
      });
      expect(preferred.status).toBe(200);
      expect(await preferred.json()).toMatchObject({ disposition: { preferredBookId: duplicate.bookId, revision: 1 } });
      const invalidPreferred = await fetch(`${base}/issues/${duplicateSignature}/preferred-book`, {
        method: "PATCH",
        headers: json,
        body: JSON.stringify({ expectedRevision: 1, preferredBookId: "book_not_in_group" }),
      });
      expect(invalidPreferred.status).toBe(409);

      const bookBase = `${base}/books/${indexed.bookId}`;
      const search = await fetch(
        `${bookBase}/metadata-search?provider=google-books&title=${encodeURIComponent("  Provider   title ")}&author=Provider%20Author&identifier=9780000000001`,
      );
      expect(search.status).toBe(200);
      expect(await search.json()).toMatchObject({ items: [{ candidateId: "volume_1", coverCandidateId: "volume_1" }] });
      const metadataRequest = requests.find(({ hostname }) => hostname === "www.googleapis.com");
      expect(metadataRequest?.searchParams.get("q")).toBe(
        "intitle:Provider title inauthor:Provider Author isbn:9780000000001",
      );
      expect(metadataRequest?.toString()).not.toContain(library);

      database.patchBookMetadata(profile.id, indexed.bookId, {
        expectedRevision: 0,
        expectedContentHash: "a".repeat(64),
        changes: { language: "sv" },
      });
      const removeStaged = vi.spyOn(metadataStore, "removeIfUnreferenced");
      const stale = await fetch(`${bookBase}/metadata-import`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          provider: "google-books",
          candidateId: "volume_1",
          selectedFields: ["title"],
          includeCover: true,
          expectedRevision: 0,
          expectedContentHash: "a".repeat(64),
        }),
      });
      expect(stale.status).toBe(409);
      expect(database.getBookMetadataState(profile.id, indexed.bookId)).toMatchObject({ revision: 1, book: { title: "Source title" } });
      expect(database.database.prepare("SELECT count(*) AS count FROM metadata_cover_assets").get()).toEqual({ count: 0 });
      expect(removeStaged).toHaveBeenCalledOnce();

      const imported = await fetch(`${bookBase}/metadata-import`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          provider: "google-books",
          candidateId: "volume_1",
          selectedFields: ["title", "publisher"],
          includeCover: true,
          expectedRevision: 1,
          expectedContentHash: "a".repeat(64),
        }),
      });
      expect(imported.status).toBe(200);
      expect(await imported.json()).toMatchObject({
        revision: 2,
        book: { title: "Provider title", publisher: "Provider Press", coverEdited: true },
        sourceMetadata: { title: "Source title" },
      });
      const unknown = await fetch(`${bookBase}/metadata-import`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          provider: "google-books", candidateId: "not-searched", selectedFields: ["title"], includeCover: false,
          expectedRevision: 2, expectedContentHash: "a".repeat(64),
        }),
      });
      expect(unknown.status).toBe(409);

      const createdResponse = await fetch(`${base}/metadata-lookup-jobs`, {
        method: "POST",
        headers: { ...json, "Idempotency-Key": "bulk-http-1" },
        body: JSON.stringify({ provider: "google-books", bookIds: [indexed.bookId] }),
      });
      const created = await createdResponse.json() as { id: string; revision: number };
      const resumed = await fetch(`${base}/metadata-lookup-jobs/${created.id}/resume`, {
        method: "POST", headers: json, body: JSON.stringify({ expectedRevision: created.revision }),
      });
      const running = await resumed.json() as { revision: number };
      const run = await fetch(`${base}/metadata-lookup-jobs/${created.id}/run`, {
        method: "POST", headers: json, body: "{}",
      });
      expect(run.status).toBe(200);
      const completed = await run.json() as { status: string; entries: Array<{ candidates: unknown[] }> };
      expect(completed).toMatchObject({ status: "completed", entries: [{ status: "ready" }] });
      expect(completed.entries[0]?.candidates).toHaveLength(1);
      expect(database.getBookMetadataState(profile.id, indexed.bookId)?.revision).toBe(2);

      const durableImport = await fetch(`${bookBase}/metadata-import`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          provider: "google-books", candidateId: "volume_1", lookupJobId: created.id,
          selectedFields: ["authors"], includeCover: false,
          expectedRevision: 2, expectedContentHash: "a".repeat(64),
        }),
      });
      expect(durableImport.status).toBe(200);
      expect(await durableImport.json()).toMatchObject({ revision: 3, book: { authors: ["Provider Author"] } });
      expect(running.revision).toBeGreaterThan(created.revision);
      expect(publish.mock.calls.filter(([event]) => event.type === "metadata-lookup.updated")).toHaveLength(4);
    } finally {
      await server.close();
      events.close();
      database.close();
    }
  });
});
