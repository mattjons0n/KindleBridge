import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ExtractedBookMetadata } from "../../server/book-metadata.js";
import { CatalogDatabase } from "../../server/catalog-database.js";
import { CatalogIndexer } from "../../server/catalog-indexer.js";
import { CatalogService } from "../../server/catalog-service.js";
import { CoverCache } from "../../server/cover-cache.js";
import { CatalogEventHub } from "../../server/event-hub.js";
import { CatalogHttpServer } from "../../server/http-server.js";
import { catalogConfigFromEnvironment, runCatalogMain } from "../../server/main.js";
import { AllowedRootPolicy } from "../../server/root-policy.js";

class DeferredFirstSourceReadHttpServer extends CatalogHttpServer {
  private markFirstReadStarted!: () => void;
  private resolveFirstRead!: (result: { bytesRead: number }) => void;
  private markFirstStreamFinished!: () => void;
  private firstStreamFinished = false;
  readonly firstReadStarted = new Promise<void>((resolve) => { this.markFirstReadStarted = resolve; });
  readonly firstStreamReleased = new Promise<void>((resolve) => { this.markFirstStreamFinished = resolve; });
  sourceReadCalls = 0;

  releaseFirstRead(bytesRead = 1): void {
    this.resolveFirstRead({ bytesRead });
  }

  protected override readSourceSnapshotChunk(
    source: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> {
    this.sourceReadCalls += 1;
    if (this.sourceReadCalls === 1) {
      this.markFirstReadStarted();
      return new Promise((resolve) => { this.resolveFirstRead = resolve; });
    }
    return super.readSourceSnapshotChunk(source, buffer, offset, length, position);
  }

  protected override sourceStreamFinished(): void {
    if (this.firstStreamFinished) return;
    this.firstStreamFinished = true;
    this.markFirstStreamFinished();
  }
}

async function stalledSourceFixture(
  shutdownDrainTimeoutMs: number,
  sourceResponseTimeoutMs = 10 * 60 * 1_000,
): Promise<{
  directory: string;
  database: CatalogDatabase;
  indexer: CatalogIndexer;
  http: DeferredFirstSourceReadHttpServer;
  service: CatalogService;
  sourceUrl: string;
  sourceBytes: Buffer;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "kindle-catalog-source-shutdown-"));
  const allowed = path.join(directory, "libraries");
  const sourceRoot = path.join(allowed, "books");
  await mkdir(sourceRoot, { recursive: true });
  const sourceBytes = Buffer.from("source read held across shutdown");
  const sourcePath = path.join(sourceRoot, "shutdown.epub");
  await writeFile(sourcePath, sourceBytes);
  const details = await stat(sourcePath);
  const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
  const profile = database.createProfile({ name: "Source shutdown" });
  const root = database.createRoot(profile.id, { label: "Books", path: sourceRoot, watch: false });
  const indexed = database.upsertCatalogFile({
    rootId: root.id,
    relativePath: "shutdown.epub",
    format: "epub",
    size: sourceBytes.length,
    mtimeMs: details.mtimeMs,
    contentHash: createHash("sha256").update(sourceBytes).digest("hex"),
    scanToken: "source-shutdown",
    metadata: {
      title: "Source shutdown",
      authors: ["Test Author"],
      authorSort: "Author, Test",
      language: "en",
      publisher: null,
      publishedAt: null,
      series: null,
      subjects: [],
      identifiers: [],
      metadataComplete: true,
      coverKey: null,
      coverMediaType: null,
    },
  });
  const rootPolicy = await AllowedRootPolicy.create([allowed]);
  const coverCache = new CoverCache(path.join(directory, "cache"));
  await coverCache.initialize();
  const events = new CatalogEventHub();
  const indexer = new CatalogIndexer(database, rootPolicy, coverCache, () => undefined, {
    watcherHints: false,
    reconciliationIntervalMs: 60_000,
  });
  const http = new DeferredFirstSourceReadHttpServer(database, indexer, rootPolicy, coverCache, events, {
    hostname: "127.0.0.1",
    port: 0,
    allowedHosts: ["127.0.0.1"],
    shutdownDrainTimeoutMs,
    sourceResponseTimeoutMs,
    maxConcurrentSourceStreams: 1,
  });
  const service = new CatalogService(database, indexer, http, events);
  const address = await http.listen();
  return {
    directory,
    database,
    indexer,
    http,
    service,
    sourceUrl: `http://127.0.0.1:${address.port}/api/profiles/${profile.id}/books/${indexed.bookId}/source`,
    sourceBytes,
  };
}

describe("catalog process lifecycle", () => {
  it("defaults to the bounded large-profile body and shutdown limits", () => {
    const config = catalogConfigFromEnvironment({});
    expect(config.http?.maxJsonBodyBytes).toBe(1024 * 1024);
    expect(config.http?.shutdownDrainTimeoutMs).toBe(20_000);
    expect(config.http?.settingsValidationTimeoutMs).toBe(10_000);
    expect(config.http?.sourceResponseTimeoutMs).toBe(10 * 60 * 1_000);
    expect(config.http?.coverResponseTimeoutMs).toBe(30_000);
    expect(config.rootPolicyValidationTimeoutMs).toBe(10_000);
    expect(config.scanner).toMatchObject({
      maxEntriesPerRoot: 1_000_000,
      maxDirectoriesPerRoot: 50_000,
      scanTimeoutMs: 10 * 60 * 1_000,
      deepReconciliationIntervalMs: 24 * 60 * 60 * 1_000,
      coverRetentionMs: 7 * 24 * 60 * 60 * 1_000,
      coverPruneIntervalMs: 24 * 60 * 60 * 1_000,
      shutdownTimeoutMs: 20_000,
    });
    expect(() => catalogConfigFromEnvironment({ CATALOG_SHUTDOWN_TIMEOUT_MS: "26000" })).toThrow(
      "outside its allowed range",
    );
    expect(() => catalogConfigFromEnvironment({ CATALOG_MAX_SCAN_DIRECTORIES: "0" })).toThrow(
      "outside its allowed range",
    );
    expect(() => catalogConfigFromEnvironment({ CATALOG_SCAN_TIMEOUT_MS: "999" })).toThrow(
      "outside its allowed range",
    );
    expect(() => catalogConfigFromEnvironment({ CATALOG_COVER_RETENTION_MS: "0" })).toThrow(
      "outside its allowed range",
    );
    expect(() => catalogConfigFromEnvironment({ CATALOG_DEEP_RECONCILE_MS: "59999" })).toThrow(
      "outside its allowed range",
    );
    expect(() => catalogConfigFromEnvironment({ CATALOG_ROOT_POLICY_TIMEOUT_MS: "999" })).toThrow(
      "outside its allowed range",
    );
    expect(() => catalogConfigFromEnvironment({ CATALOG_SETTINGS_VALIDATION_TIMEOUT_MS: "999" })).toThrow(
      "outside its allowed range",
    );
    expect(() => catalogConfigFromEnvironment({ CATALOG_SOURCE_RESPONSE_TIMEOUT_MS: "999" })).toThrow(
      "outside its allowed range",
    );
    expect(() => catalogConfigFromEnvironment({ CATALOG_COVER_RESPONSE_TIMEOUT_MS: "999" })).toThrow(
      "outside its allowed range",
    );
  });

  it("keeps durable scan scheduling inert after the indexer is retired and SQLite is closed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-catalog-retired-scheduling-"));
    const allowed = path.join(directory, "libraries");
    await mkdir(allowed, { recursive: true });
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Retired" });
    const root = database.createRoot(profile.id, { label: "Books", path: allowed, watch: false });
    const rootPolicy = await AllowedRootPolicy.create([allowed]);
    const indexer = new CatalogIndexer(
      database,
      rootPolicy,
      new CoverCache(path.join(directory, "cache")),
      () => undefined,
      { watcherHints: false },
      async () => {
        throw new Error("metadata extraction should not run");
      },
    );

    try {
      await indexer.stop();
      database.close();

      expect(indexer.requestRescan(root.id)).toBe(false);
      expect(indexer.wakePendingScan(root.id)).toBe(false);
      expect(await indexer.scanNow(root.id)).toBe(false);
      expect(() => indexer.pruneInactiveRoots()).not.toThrow();
    } finally {
      await indexer.stop().catch(() => undefined);
      try {
        database.close();
      } catch {
        // The assertion intentionally closes SQLite before exercising the
        // retired scheduling paths.
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds a never-settling root filesystem operation so startup and later roots still become ready", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-catalog-scan-deadline-"));
    const allowed = path.join(directory, "libraries");
    const firstPath = path.join(allowed, "first");
    const secondPath = path.join(allowed, "second");
    await mkdir(firstPath, { recursive: true });
    await mkdir(secondPath, { recursive: true });
    await writeFile(path.join(firstPath, "first.epub"), "first source bytes");
    await writeFile(path.join(secondPath, "second.epub"), "second source bytes");

    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const firstProfile = database.createProfile({ name: "First" });
    const secondProfile = database.createProfile({ name: "Second" });
    const firstRoot = database.createRoot(firstProfile.id, { label: "First", path: firstPath, watch: false });
    const secondRoot = database.createRoot(secondProfile.id, { label: "Second", path: secondPath, watch: false });
    const configured = [
      { profileId: firstProfile.id, root: firstRoot, filename: "first.epub" },
      { profileId: secondProfile.id, root: secondRoot, filename: "second.epub" },
    ];
    // Root IDs are intentionally opaque. Stall whichever root owns the sole
    // first scan slot so this test proves that its deadline releases the queue.
    const firstScheduledId = database.listScanRoots()[0]!.id;
    const stalled = configured.find((candidate) => candidate.root.id === firstScheduledId)!;
    const healthy = configured.find((candidate) => candidate.root.id !== firstScheduledId)!;
    const stalledSource = path.join(stalled.root.path, stalled.filename);
    const stalledBytes = await readFile(stalledSource);
    const stalledDetails = await stat(stalledSource);
    database.upsertCatalogFile({
      rootId: stalled.root.id,
      relativePath: stalled.filename,
      format: "epub",
      size: stalledBytes.length,
      mtimeMs: stalledDetails.mtimeMs,
      contentHash: createHash("sha256").update(stalledBytes).digest("hex"),
      scanToken: "retained-before-timeout",
      metadata: {
        title: "Retained before timeout",
        authors: ["Test Author"],
        authorSort: "Author, Test",
        language: "en",
        publisher: null,
        publishedAt: null,
        series: null,
        subjects: [],
        identifiers: [],
        metadataComplete: true,
        coverKey: null,
        coverMediaType: null,
      },
    });
    database.setRootStatus(stalled.root.id, "available", null, true);

    const rootPolicy = await AllowedRootPolicy.create([allowed]);
    const validateConfiguredRoot = rootPolicy.validateConfiguredRoot.bind(rootPolicy);
    const validateSpy = vi.spyOn(rootPolicy, "validateConfiguredRoot").mockImplementation((input, allowUnavailable) => {
      if (input === stalled.root.path) return new Promise<never>(() => undefined);
      return validateConfiguredRoot(input, allowUnavailable);
    });
    const coverCache = new CoverCache(path.join(directory, "cache"));
    const events = new CatalogEventHub();
    const indexer = new CatalogIndexer(
      database,
      rootPolicy,
      coverCache,
      (event) => events.publish(event),
      {
        maxConcurrentScans: 1,
        // This is intentionally far below the supported 1 s production
        // minimum while leaving enough budget for the healthy root's real
        // filesystem/SQLite work under the full suite's parallel contention.
        // The never-settling first root still proves deadline-driven slot
        // release well inside the 2 s startup bound below.
        scanTimeoutMs: 250,
        quietWindowMs: 60_000,
        stabilityWindowMs: 0,
        watcherHints: false,
        reconciliationIntervalMs: 60_000,
      },
      async () => ({
        title: "Healthy root indexed",
        authors: ["Test Author"],
        authorSort: "Author, Test",
        language: "en",
        publisher: null,
        publishedAt: null,
        series: null,
        subjects: [],
        identifiers: [],
        metadataComplete: true,
        cover: null,
        coverMediaType: null,
      }),
    );
    const http = new CatalogHttpServer(database, indexer, rootPolicy, coverCache, events, {
      hostname: "127.0.0.1",
      port: 0,
      allowedHosts: ["127.0.0.1"],
    });
    const service = new CatalogService(database, indexer, http, events);

    try {
      const address = await within(service.start(), 2_000);
      const readiness = await fetch(`http://127.0.0.1:${address.port}/api/readyz`);
      expect(readiness.status).toBe(200);
      expect(await readiness.json()).toMatchObject({ ready: true, database: "ready" });
      expect(database.listBooks(healthy.profileId).items).toEqual([
        expect.objectContaining({ title: "Healthy root indexed", available: true }),
      ]);
      expect(database.listBooks(stalled.profileId).items).toEqual([
        expect.objectContaining({ title: "Retained before timeout", available: true }),
      ]);
      expect(database.listRoots(stalled.profileId)[0]).toMatchObject({
        status: "error",
        lastErrorCode: "scan_timeout",
      });
      expect(database.rootScanRequestGeneration(stalled.root.id)).not.toBeNull();
      expect(database.rootScanRequestGeneration(healthy.root.id)).toBeNull();
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      expect(validateSpy.mock.calls.filter(([input]) => input === stalled.root.path)).toHaveLength(1);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("handles SIGTERM during a never-resolving initial scan and retires it before closing SQLite", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-catalog-shutdown-"));
    const allowed = path.join(directory, "libraries");
    const source = path.join(allowed, "books");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "startup.epub"), "startup scan fixture");

    let releaseExtraction!: () => void;
    const extractionBlocked = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    let extractionStarted!: () => void;
    const extractionStart = new Promise<void>((resolve) => {
      extractionStarted = resolve;
    });
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Shutdown" });
    database.createRoot(profile.id, { label: "Books", path: source, watch: false });
    const rootPolicy = await AllowedRootPolicy.create([allowed]);
    const coverCache = new CoverCache(path.join(directory, "cache"));
    const events = new CatalogEventHub();
    const extracted: ExtractedBookMetadata = {
      title: "Startup book",
      authors: ["Test Author"],
      authorSort: "Author, Test",
      language: "en",
      publisher: null,
      publishedAt: null,
      series: null,
      subjects: [],
      identifiers: [],
      metadataComplete: true,
      cover: null,
      coverMediaType: null,
    };
    const indexer = new CatalogIndexer(
      database,
      rootPolicy,
      coverCache,
      (event) => events.publish(event),
      { watcherHints: false, reconciliationIntervalMs: 60_000 },
      async () => {
        extractionStarted();
        await extractionBlocked;
        return extracted;
      },
    );
    const http = new CatalogHttpServer(database, indexer, rootPolicy, coverCache, events, {
      hostname: "127.0.0.1",
      port: 0,
      allowedHosts: ["127.0.0.1"],
      shutdownDrainTimeoutMs: 1_000,
    });
    const service = new CatalogService(database, indexer, http, events);
    const signals = new EventEmitter();
    const logChunks: string[] = [];
    const run = runCatalogMain(
      {},
      {
        signalSource: signals,
        serviceFactory: async () => service,
        output: {
          write(chunk: string | Uint8Array): boolean {
            logChunks.push(String(chunk));
            return true;
          },
        } as Pick<NodeJS.WriteStream, "write">,
      },
    );
    let runSettled = false;
    void run.then(
      () => { runSettled = true; },
      () => { runSettled = true; },
    );

    try {
      await within(extractionStart, 2_000);
      const address = http.address();
      expect(address).not.toBeNull();
      const base = `http://127.0.0.1:${address!.port}`;
      const eventResponse = await fetch(`${base}/api/events`);
      expect(eventResponse.status).toBe(200);
      const reader = eventResponse.body!.getReader();
      expect(Buffer.from((await within(reader.read(), 1_000)).value ?? []).toString()).toContain("retry: 3000");

      signals.emit("SIGTERM");
      // A scan event can already be buffered behind the initial SSE prelude.
      // Shutdown correctness is that the bounded stream reaches EOF, not that
      // EOF is necessarily the very next queued read result.
      expect(await drainsToDone(reader, 1_000)).toBe(true);
      const rejectedWork = await fetch(`${base}/api/healthz`).catch(() => null);
      expect(rejectedWork === null || rejectedWork.status === 503).toBe(true);
      await within(run, 1_000);
      expect(runSettled).toBe(true);
      expect(() => database.listProfiles()).toThrow();
      expect(signals.listenerCount("SIGTERM")).toBe(0);
      expect(signals.listenerCount("SIGINT")).toBe(0);
      const records = logChunks.map((line) => JSON.parse(line) as { event: string; context?: { signal?: string } });
      expect(records).toContainEqual(expect.objectContaining({ event: "catalog.stop", context: { signal: "SIGTERM" } }));
      expect(records.some((record) => record.event === "catalog.listen")).toBe(false);
    } finally {
      releaseExtraction();
      signals.emit("SIGTERM");
      await run.catch(() => undefined);
      await service.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retires a stalled source snapshot before closing SQLite and ignores its late completion", async () => {
    const fixture = await stalledSourceFixture(20);
    const getBookSource = vi.spyOn(fixture.database, "getBookSource");
    const requestRescan = vi.spyOn(fixture.indexer, "requestRescan");
    const sourceRequest = fetch(fixture.sourceUrl).catch((error: unknown) => error);

    try {
      await within(fixture.http.firstReadStarted, 1_000);
      await within(fixture.service.close(), 1_000);

      expect(() => fixture.database.listProfiles()).toThrow();
      expect(getBookSource).toHaveBeenCalledTimes(1);
      expect(requestRescan).not.toHaveBeenCalled();

      fixture.http.releaseFirstRead(fixture.sourceBytes.length);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(getBookSource).toHaveBeenCalledTimes(1);
      expect(requestRescan).not.toHaveBeenCalled();
      await within(sourceRequest, 1_000);
    } finally {
      fixture.http.releaseFirstRead(fixture.sourceBytes.length);
      await fixture.service.close().catch(() => undefined);
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("releases source-stream capacity when the browser disconnects during snapshotting", async () => {
    const fixture = await stalledSourceFixture(1_000);
    const requestRescan = vi.spyOn(fixture.indexer, "requestRescan");
    const client = new AbortController();
    const abandonedRequest = fetch(fixture.sourceUrl, { signal: client.signal }).catch((error: unknown) => error);

    try {
      await within(fixture.http.firstReadStarted, 1_000);
      client.abort();
      await within(abandonedRequest, 1_000);
      await within(fixture.http.firstStreamReleased, 1_000);
      expect(requestRescan).not.toHaveBeenCalled();

      const retry = await within(fetch(fixture.sourceUrl), 1_000);
      expect(retry.status).toBe(200);
      expect(Buffer.from(await retry.arrayBuffer())).toEqual(fixture.sourceBytes);
      expect(fixture.http.sourceReadCalls).toBe(2);

      fixture.http.releaseFirstRead(fixture.sourceBytes.length);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(requestRescan).not.toHaveBeenCalled();
    } finally {
      fixture.http.releaseFirstRead(fixture.sourceBytes.length);
      await fixture.service.close().catch(() => undefined);
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("bounds a stalled source response while the client remains connected and ignores late completion", async () => {
    const fixture = await stalledSourceFixture(1_000, 20);
    const getBookSource = vi.spyOn(fixture.database, "getBookSource");
    const requestRescan = vi.spyOn(fixture.indexer, "requestRescan");
    const sourceRequest = fetch(fixture.sourceUrl);

    try {
      await within(fixture.http.firstReadStarted, 1_000);
      const response = await within(sourceRequest, 1_000);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "source_timeout" } });
      await within(fixture.http.firstStreamReleased, 1_000);
      expect(getBookSource).toHaveBeenCalledTimes(1);
      expect(requestRescan).not.toHaveBeenCalled();

      fixture.http.releaseFirstRead(fixture.sourceBytes.length);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(getBookSource).toHaveBeenCalledTimes(1);
      expect(requestRescan).not.toHaveBeenCalled();

      const retry = await within(fetch(fixture.sourceUrl), 1_000);
      expect(retry.status).toBe(200);
      expect(Buffer.from(await retry.arrayBuffer())).toEqual(fixture.sourceBytes);
    } finally {
      fixture.http.releaseFirstRead(fixture.sourceBytes.length);
      await fixture.service.close().catch(() => undefined);
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("closes SQLite in finally and then aggregates a scanner shutdown failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-catalog-close-finally-"));
    const allowed = path.join(directory, "libraries");
    await mkdir(allowed, { recursive: true });
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const rootPolicy = await AllowedRootPolicy.create([allowed]);
    const coverCache = new CoverCache(path.join(directory, "cache"));
    const events = new CatalogEventHub();
    const indexer = new CatalogIndexer(database, rootPolicy, coverCache, () => undefined, {
      watcherHints: false,
      reconciliationIntervalMs: 60_000,
    });
    const http = new CatalogHttpServer(database, indexer, rootPolicy, coverCache, events, {
      hostname: "127.0.0.1",
      port: 0,
      allowedHosts: ["127.0.0.1"],
    });
    const service = new CatalogService(database, indexer, http, events);
    vi.spyOn(indexer, "stop").mockRejectedValue(new Error("forced scanner failure"));

    try {
      await expect(service.close()).rejects.toThrow(AggregateError);
      expect(() => database.listProfiles()).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

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

async function drainsToDone(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await within(reader.read(), Math.max(1, deadline - Date.now()));
    if (result.done) return true;
  }
  return false;
}
