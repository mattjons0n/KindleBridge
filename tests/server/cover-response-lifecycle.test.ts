import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogDatabase } from "../../server/catalog-database.js";
import { CatalogIndexer } from "../../server/catalog-indexer.js";
import { CatalogService } from "../../server/catalog-service.js";
import { CoverCache } from "../../server/cover-cache.js";
import { CatalogEventHub } from "../../server/event-hub.js";
import { CatalogHttpServer } from "../../server/http-server.js";
import { AllowedRootPolicy } from "../../server/root-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

async function coverFixture(coverResponseTimeoutMs: number): Promise<{
  database: CatalogDatabase;
  coverCache: CoverCache;
  indexer: CatalogIndexer;
  http: CatalogHttpServer;
  service: CatalogService;
  coverUrl: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "kindle-cover-response-"));
  temporaryDirectories.push(directory);
  const allowed = path.join(directory, "libraries");
  const source = path.join(allowed, "books");
  await mkdir(source, { recursive: true });
  const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
  const profile = database.createProfile({ name: "Cover lifecycle" });
  const root = database.createRoot(profile.id, { label: "Books", path: source, watch: false });
  const indexed = database.upsertCatalogFile({
    rootId: root.id,
    relativePath: "cover.epub",
    format: "epub",
    size: 12,
    mtimeMs: 1,
    contentHash: "b".repeat(64),
    scanToken: "cover-lifecycle",
    metadata: {
      title: "Cover lifecycle",
      authors: ["Test Author"],
      authorSort: "Author, Test",
      language: "en",
      publisher: null,
      publishedAt: null,
      series: null,
      subjects: [],
      identifiers: [],
      metadataComplete: true,
      coverKey: "cover-lifecycle.jpg",
      coverMediaType: "image/jpeg",
    },
  });
  const rootPolicy = await AllowedRootPolicy.create([allowed]);
  const coverCache = new CoverCache(path.join(directory, "cache"));
  await coverCache.initialize();
  const events = new CatalogEventHub();
  const indexer = new CatalogIndexer(database, rootPolicy, coverCache, () => undefined, {
    quietWindowMs: 60_000,
    watcherHints: false,
    reconciliationIntervalMs: 60_000,
  });
  const http = new CatalogHttpServer(database, indexer, rootPolicy, coverCache, events, {
    hostname: "127.0.0.1",
    port: 0,
    allowedHosts: ["127.0.0.1"],
    coverResponseTimeoutMs,
    shutdownDrainTimeoutMs: 5_000,
  });
  const service = new CatalogService(database, indexer, http, events);
  const address = await http.listen();
  return {
    database,
    coverCache,
    indexer,
    http,
    service,
    coverUrl: `http://127.0.0.1:${address.port}/api/profiles/${profile.id}/books/${indexed.bookId}/cover`,
  };
}

describe("cover response lifecycle", () => {
  it("bounds stalled reads, releases buffered slots, and serves a later cover", async () => {
    const fixture = await coverFixture(20);
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    let calls = 0;
    vi.spyOn(fixture.coverCache, "read").mockImplementation(async () => {
      calls += 1;
      if (calls <= 2) return new Promise<Buffer>(() => undefined);
      return bytes;
    });
    const requestRescan = vi.spyOn(fixture.indexer, "requestRescan");

    try {
      const first = fetch(fixture.coverUrl);
      const second = fetch(fixture.coverUrl);
      await waitUntil(() => calls === 2, 1_000);
      const third = fetch(fixture.coverUrl);
      const [firstResponse, secondResponse, thirdResponse] = await within(
        Promise.all([first, second, third]),
        1_000,
      );
      expect(firstResponse.status).toBe(503);
      expect(secondResponse.status).toBe(503);
      expect(await firstResponse.json()).toMatchObject({ error: { code: "cover_timeout" } });
      expect(await secondResponse.json()).toMatchObject({ error: { code: "cover_timeout" } });
      expect(thirdResponse.status).toBe(200);
      expect(Buffer.from(await thirdResponse.arrayBuffer())).toEqual(bytes);
      expect(requestRescan).not.toHaveBeenCalled();
    } finally {
      await fixture.service.close().catch(() => undefined);
    }
  });

  it("retires a stalled cover on shutdown and observes its late rejection without database work", async () => {
    const fixture = await coverFixture(10_000);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let rejectRead!: (error: Error) => void;
    const read = new Promise<Buffer>((_resolve, reject) => { rejectRead = reject; });
    vi.spyOn(fixture.coverCache, "read").mockImplementation(() => {
      markStarted();
      return read;
    });
    const requestRescan = vi.spyOn(fixture.indexer, "requestRescan");
    const request = fetch(fixture.coverUrl).catch((error: unknown) => error);

    try {
      await within(started, 1_000);
      await within(fixture.service.close(), 1_000);
      expect(requestRescan).not.toHaveBeenCalled();
      expect(() => fixture.database.listProfiles()).toThrow();
      rejectRead(new Error("late cover failure"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(requestRescan).not.toHaveBeenCalled();
      await within(request, 1_000);
    } finally {
      rejectRead(new Error("late cover cleanup"));
      await fixture.service.close().catch(() => undefined);
    }
  });

  it("retires a stalled cover when its response socket closes", async () => {
    const fixture = await coverFixture(10_000);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let rejectRead!: (error: Error) => void;
    const read = new Promise<Buffer>((_resolve, reject) => { rejectRead = reject; });
    vi.spyOn(fixture.coverCache, "read").mockImplementation(() => {
      markStarted();
      return read;
    });
    const requestRescan = vi.spyOn(fixture.indexer, "requestRescan");
    const client = startAbandonedGet(fixture.coverUrl);

    try {
      await within(started, 1_000);
      client.request.destroy();
      await within(client.settled, 1_000);
      await waitUntil(
        () => (fixture.http as unknown as { activeRequests: number }).activeRequests === 0,
        1_000,
      );
      rejectRead(new Error("late disconnected cover failure"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(requestRescan).not.toHaveBeenCalled();
    } finally {
      rejectRead(new Error("late cover cleanup"));
      await fixture.service.close().catch(() => undefined);
    }
  });
});

function startAbandonedGet(endpoint: string): { request: ClientRequest; settled: Promise<void> } {
  const target = new URL(endpoint);
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
  const request = httpRequest(
    { hostname: target.hostname, port: target.port, path: target.pathname },
    (response) => {
      response.resume();
      response.once("end", resolveSettled);
    },
  );
  request.once("error", resolveSettled);
  request.end();
  return { request, settled };
}

async function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation exceeded ${timeoutMs} ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition exceeded ${timeoutMs} ms.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
