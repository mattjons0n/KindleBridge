import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCatalogService, type CatalogService } from "../../server/catalog-service.js";

const temporaryDirectories: string[] = [];
const services: CatalogService[] = [];

afterEach(async () => {
  while (services.length) await services.pop()?.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("durable library HTTP routes", () => {
  it("serves queue, selection, shelf, annotation, and series contracts with coalesced events", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-durable-http-"));
    temporaryDirectories.push(directory);
    const library = path.join(directory, "library");
    await mkdir(library);
    const service = await createCatalogService({
      databasePath: path.join(directory, "catalog.sqlite"),
      cacheDirectory: path.join(directory, "cache"),
      allowedRootPaths: [library],
      http: {
        hostname: "127.0.0.1",
        port: 0,
        allowedHosts: ["127.0.0.1"],
        allowedOrigins: [],
        requireOriginForMutations: false,
      },
      scanner: { watcherHints: false, reconciliationIntervalMs: 60_000 },
    });
    services.push(service);
    const address = await service.start();
    const base = `http://127.0.0.1:${address.port}`;
    const profile = service.database.createProfile({ name: "HTTP Reader" });
    const root = service.database.createRoot(profile.id, { label: "Books", path: library });
    const addBook = (name: string, seriesIndex: number | null) => service.database.upsertCatalogFile({
      rootId: root.id,
      relativePath: `${name}.epub`,
      format: "epub",
      size: 100,
      mtimeMs: 1,
      contentHash: (name === "One" ? "a" : "b").repeat(64),
      scanToken: "http-scan",
      metadata: {
        title: name,
        authors: ["Author"],
        authorSort: "Author",
        language: "en",
        publisher: null,
        publishedAt: null,
        series: "Saga!",
        seriesIndex,
        subjects: [],
        identifiers: [],
        metadataComplete: true,
        coverKey: null,
        coverMediaType: null,
      },
    });
    const one = addBook("One", 1);
    const two = addBook("Two", 2);
    const publish = vi.spyOn(service.events, "publish");

    const queueRequest = () => fetch(`${base}/api/profiles/${profile.id}/send-queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "http-queue-1" },
      body: JSON.stringify({ expectedRevision: 0, bookIds: [one.bookId, two.bookId] }),
    });
    expect((await queueRequest()).status).toBe(201);
    expect((await queueRequest()).status).toBe(200);
    expect(publish.mock.calls.filter(([event]) => event.type === "queue.updated")).toHaveLength(1);

    const selected = await fetch(`${base}/api/profiles/${profile.id}/books/selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "Saga", sort: "series-index", order: "asc" }),
    });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ profileId: profile.id, bookIds: [one.bookId, two.bookId], total: 2 });
    const invalidSelection = await fetch(`${base}/api/profiles/${profile.id}/books/selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "Saga", offset: 10 }),
    });
    expect(invalidSelection.status).toBe(400);

    const annotation = await fetch(`${base}/api/profiles/${profile.id}/books/${one.bookId}/annotation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, favorite: true }),
    });
    expect(await annotation.json()).toMatchObject({ favorite: true, revision: 1 });
    expect(publish.mock.calls.filter(([event]) => event.type === "annotation.updated")).toHaveLength(1);

    const shelfRequest = () => fetch(`${base}/api/profiles/${profile.id}/shelves`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "http-shelf-1" },
      body: JSON.stringify({
        name: "Favorites",
        query: { version: 1, personal: { favorite: true } },
        pinned: true,
      }),
    });
    expect((await shelfRequest()).status).toBe(201);
    expect((await shelfRequest()).status).toBe(200);
    expect(publish.mock.calls.filter(([event]) => event.type === "shelf.updated")).toHaveLength(1);
    const shelves = await fetch(`${base}/api/profiles/${profile.id}/shelves`);
    expect(await shelves.json()).toMatchObject({ items: [{ name: "Favorites", serverCount: 1 }] });

    const summaries = await fetch(`${base}/api/profiles/${profile.id}/series`);
    expect(await summaries.json()).toMatchObject({ total: 1, items: [{ key: "saga", bookCount: 2 }] });
    const detail = await fetch(`${base}/api/profiles/${profile.id}/series/saga?limit=1&offset=1`);
    expect(await detail.json()).toMatchObject({
      key: "saga",
      books: { total: 2, limit: 1, offset: 1, items: [{ title: "Two" }] },
    });
  });
});
