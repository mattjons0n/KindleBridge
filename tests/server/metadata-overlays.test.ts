import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "kindle-metadata-overlay-"));
  temporaryDirectories.push(directory);
  return directory;
}

function catalogMetadata(title = "Immutable title", coverKey: string | null = null) {
  return {
    title,
    authors: ["Source Author"],
    authorSort: "Author, Source",
    language: "en",
    publisher: "Source Press",
    publishedAt: "2020-01-01",
    series: null,
    subjects: ["Source subject"],
    identifiers: ["ISBN:9780000000001"],
    metadataComplete: true,
    coverKey,
    coverMediaType: coverKey ? "image/png" : null,
  };
}

function onePixelPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
}

describe("non-destructive metadata overlays", () => {
  it("materializes effective metadata, survives rebuild, and invalidates only the presentation identity", async () => {
    const directory = await temporaryDirectory();
    const filename = path.join(directory, "catalog.sqlite");
    let database = new CatalogDatabase(filename);
    const profile = database.createProfile({ name: "Household" });
    const root = database.createRoot(profile.id, { label: "Read only", path: "/libraries/books" });
    const sourceHash = "a".repeat(64);
    const sourceCoverKey = `v1-${"c".repeat(64)}.png`;
    const indexed = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "book.epub",
      format: "epub",
      size: 100,
      mtimeMs: 1,
      contentHash: sourceHash,
      scanToken: "scan-1",
      metadata: catalogMetadata("Immutable title", sourceCoverKey),
    });
    const originalToken = database.getMatchIndex(profile.id).entries[0]!.managedToken;
    const initial = database.getBookMetadataState(profile.id, indexed.bookId)!;
    expect(initial.revision).toBe(0);
    expect(initial.book.presentationVersion).toBe(sourceHash);

    const edited = database.patchBookMetadata(profile.id, indexed.bookId, {
      expectedRevision: 0,
      expectedContentHash: sourceHash,
      changes: {
        title: "Edited title",
        authors: ["Edited Author"],
        series: "Overlay series",
        seriesIndex: 2.5,
        description: "A durable description",
      },
    });
    expect(edited.sourceMetadata.title).toBe("Immutable title");
    expect(edited.book).toMatchObject({
      title: "Edited title",
      authors: ["Edited Author"],
      series: "Overlay series",
      seriesIndex: 2.5,
      description: "A durable description",
      contentHash: sourceHash,
      metadataEdited: true,
      metadataComplete: true,
      metadataRevision: 1,
    });
    expect(edited.book.presentationVersion).not.toBe(sourceHash);
    expect(() => database.patchBookMetadata(profile.id, indexed.bookId, {
      expectedRevision: 0,
      expectedContentHash: sourceHash,
      changes: { title: "Lost update" },
    })).toThrowError(/edited elsewhere/u);
    expect(() => database.patchBookMetadata(profile.id, indexed.bookId, {
      expectedRevision: 1,
      expectedContentHash: "d".repeat(64),
      changes: { title: "Wrong source" },
    })).toThrowError(/source changed/u);
    expect(database.listBooks(profile.id, { q: "Edited" }).items).toHaveLength(1);
    expect(database.listBooks(profile.id, { q: "durable description" }).items).toHaveLength(1);
    expect(database.getFilters(profile.id).authors[0]?.value).toBe("Edited Author");
    const editedIndex = database.getMatchIndex(profile.id).entries[0]!;
    expect(editedIndex.presentationVersion).toBe(edited.book.presentationVersion);
    expect(editedIndex.managedToken).not.toBe(originalToken);
    const covered = database.setBookCover(profile.id, indexed.bookId, 1, sourceHash, {
      assetKey: `${"b".repeat(64)}.png`,
      checksum: "b".repeat(64),
      mediaType: "image/png",
      byteLength: 68,
      width: 1,
      height: 1,
      sourceKind: "upload",
      provider: null,
      providerReference: null,
      sourceUrl: null,
    }).state;
    expect(covered.sourceCoverUrl).toContain("source=true");
    expect(covered.book.coverEdited).toBe(true);
    expect(database.referencedCoverKeys()).toEqual(new Set([sourceCoverKey]));

    database.clearRebuildableCatalog();
    const rebuilt = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "book.epub",
      format: "epub",
      size: 100,
      mtimeMs: 2,
      contentHash: sourceHash,
      scanToken: "scan-2",
      metadata: catalogMetadata("Immutable title", sourceCoverKey),
    });
    expect(rebuilt.bookId).toBe(indexed.bookId);
    expect(database.getBook(profile.id, indexed.bookId)?.title).toBe("Edited title");
    database.close();

    database = new CatalogDatabase(filename);
    expect(database.getBookMetadataState(profile.id, indexed.bookId)).toMatchObject({
      revision: 2,
      sourceChanged: false,
      book: { title: "Edited title", contentHash: sourceHash },
    });
    const replacementHash = "c".repeat(64);
    database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "book.epub",
      format: "epub",
      size: 100,
      mtimeMs: 3,
      contentHash: replacementHash,
      scanToken: "scan-3",
      metadata: catalogMetadata("Replacement source", sourceCoverKey),
    });
    expect(database.getBookMetadataState(profile.id, indexed.bookId)).toMatchObject({
      revision: 2,
      sourceChanged: true,
      coverOverride: { assetKey: `${"b".repeat(64)}.png` },
      book: { title: "Replacement source", coverEdited: false },
    });
    const rebased = database.patchBookMetadata(profile.id, indexed.bookId, {
      expectedRevision: 2,
      expectedContentHash: replacementHash,
      changes: {},
    });
    expect(rebased).toMatchObject({
      revision: 3,
      sourceChanged: false,
      coverOverride: { assetKey: `${"b".repeat(64)}.png` },
      book: { title: "Edited title", coverEdited: true },
    });
    database.close();
  });

  it("serves edit/upload/reset APIs while source bytes stay byte-identical", async () => {
    const directory = await temporaryDirectory();
    const rootDirectory = path.join(directory, "library");
    const dataDirectory = path.join(directory, "data");
    const cacheDirectory = path.join(directory, "cache");
    await mkdir(rootDirectory, { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
    const sourceBytes = Buffer.from("immutable-source-bytes");
    const sourceFilename = path.join(rootDirectory, "book.epub");
    await writeFile(sourceFilename, sourceBytes);
    const sourceDetails = await stat(sourceFilename);
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");

    const database = new CatalogDatabase(path.join(dataDirectory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "HTTP" });
    const root = database.createRoot(profile.id, { label: "Library", path: rootDirectory });
    const indexed = database.upsertCatalogFile({
      rootId: root.id,
      relativePath: "book.epub",
      format: "epub",
      size: sourceBytes.length,
      mtimeMs: sourceDetails.mtimeMs,
      contentHash: sourceHash,
      scanToken: "scan-http",
      metadata: catalogMetadata(),
    });
    const coverCache = new CoverCache(cacheDirectory);
    await coverCache.initialize();
    const metadataStore = new MetadataCoverStore(dataDirectory);
    await metadataStore.initialize();
    const policy = await AllowedRootPolicy.create([rootDirectory]);
    const events = new CatalogEventHub();
    const http = new CatalogHttpServer(
      database,
      { requestRescan: () => true } as never,
      policy,
      coverCache,
      events,
      {
        hostname: "127.0.0.1",
        port: 0,
        allowedHosts: ["127.0.0.1"],
        allowedOrigins: [],
        requireOriginForMutations: true,
        requestsPerMinutePerAddress: 1_000,
      },
      metadataStore,
    );
    const address = await http.listen();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const bookPath = `/api/profiles/${profile.id}/books/${indexed.bookId}`;
    try {
      const metadataResponse = await fetch(`${baseUrl}${bookPath}/metadata`);
      const initial = await metadataResponse.json() as { revision: number; book: { contentHash: string } };
      const patchResponse = await fetch(`${baseUrl}${bookPath}/metadata`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({
          expectedRevision: initial.revision,
          expectedContentHash: sourceHash,
          changes: { title: "HTTP overlay", authors: [] },
        }),
      });
      expect(patchResponse.status).toBe(200);
      expect(await patchResponse.json()).toMatchObject({
        revision: 1,
        book: { title: "HTTP overlay", metadataComplete: false, metadataEdited: true },
        sourceMetadata: { title: "Immutable title" },
      });

      const image = onePixelPng();
      const coverResponse = await fetch(
        `${baseUrl}${bookPath}/cover?expectedRevision=1&expectedContentHash=${sourceHash}`,
        { method: "PUT", headers: { "Content-Type": "image/png", Origin: baseUrl }, body: Uint8Array.from(image) },
      );
      expect(coverResponse.status).toBe(200);
      expect(await coverResponse.json()).toMatchObject({ revision: 2, book: { coverEdited: true } });
      const servedCover = await fetch(`${baseUrl}${bookPath}/cover`);
      expect(Buffer.from(await servedCover.arrayBuffer())).toEqual(image);
      const restartedCoverStore = new MetadataCoverStore(dataDirectory);
      await restartedCoverStore.initialize();
      const persistedAssetKey = database.getBookMetadataState(profile.id, indexed.bookId)!.coverOverride!.assetKey;
      expect(await restartedCoverStore.read(persistedAssetKey)).toEqual(image);

      const sourceResponse = await fetch(`${baseUrl}${bookPath}/source`);
      expect(sourceResponse.headers.get("x-kindle-bridge-presentation-version")).toMatch(/^[a-f0-9]{64}$/u);
      expect(Buffer.from(await sourceResponse.arrayBuffer())).toEqual(sourceBytes);
      expect(await readFile(sourceFilename)).toEqual(sourceBytes);

      vi.spyOn(metadataStore, "removeIfUnreferenced").mockRejectedValueOnce(new Error("simulated cleanup failure"));
      const resetCover = await fetch(
        `${baseUrl}${bookPath}/cover?expectedRevision=2&expectedContentHash=${sourceHash}`,
        { method: "DELETE", headers: { Origin: baseUrl } },
      );
      expect(resetCover.status).toBe(200);
      expect(await resetCover.json()).toMatchObject({ revision: 3, book: { coverEdited: false } });
    } finally {
      await http.close();
      events.close();
      database.close();
    }
  });

  it("fails closed when a same-length durable cover is corrupted", async () => {
    const directory = await temporaryDirectory();
    const store = new MetadataCoverStore(directory);
    await store.initialize();
    const image = onePixelPng();
    const asset = await store.store(image, "image/png");
    const corrupt = Buffer.from(image);
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] as number) ^ 0xff;
    await writeFile(store.pathForKey(asset.assetKey), corrupt);
    await expect(store.read(asset.assetKey)).rejects.toMatchObject({ code: "asset_unavailable" });
  });
});
