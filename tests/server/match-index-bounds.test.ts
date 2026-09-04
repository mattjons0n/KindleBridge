import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CatalogDatabase, type ExtractedBookInput } from "../../server/catalog-database.js";
import { METADATA_CLAIM_BITMAP_BYTES } from "../../shared/catalog-contracts.js";

const databases: CatalogDatabase[] = [];

function bitmapBit(bitmap: string, position: number): boolean {
  const bytes = Buffer.from(bitmap, "base64");
  expect(bytes).toHaveLength(METADATA_CLAIM_BITMAP_BYTES);
  return ((bytes[position >>> 3] ?? 0) & (1 << (position & 7))) !== 0;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture(metadataOverrides: Partial<ExtractedBookInput> = {}): Promise<{
  database: CatalogDatabase;
  profileId: string;
  rootId: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kindle-bridge-match-index-"));
  const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
  databases.push(database);
  const profile = database.createProfile({ name: "Bounded" });
  const root = database.createRoot(profile.id, { label: "Books", path: "/libraries/bounded" });
  database.upsertCatalogFile({
    rootId: root.id,
    relativePath: "nested/quoted.epub",
    format: "epub",
    size: 42,
    mtimeMs: 1,
    contentHash: "a".repeat(64),
    scanToken: "bounded",
    metadata: {
      title: 'A "quoted" title\nwith a line',
      authors: ["Ada \\ Author", "漢字 📚"],
      authorSort: "Author, Ada",
      language: "en",
      publisher: null,
      publishedAt: null,
      series: null,
      subjects: [],
      identifiers: ["urn:test:\u0001"],
      metadataComplete: true,
      coverKey: null,
      coverMediaType: null,
      ...metadataOverrides,
    },
  });
  return { database, profileId: profile.id, rootId: root.id };
}

describe("bounded match-index serialization", () => {
  it("writes deterministic valid JSON directly and enforces its exact byte boundary", async () => {
    const { database, profileId } = await fixture();
    const body = database.serializeMatchIndex(profileId);
    const parsed = JSON.parse(body.toString("utf8")) as {
      profileId: string;
      generatedAt: string;
      metadataClaims: { complete: boolean; collisionBitmap: string };
      entries: Array<{ title: string; authors: string[]; authorSort: string | null; identifiers: string[]; sourceFilename: string }>;
    };

    expect(parsed.profileId).toBe(profileId);
    expect(parsed.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(parsed.metadataClaims).toMatchObject({ complete: true });
    expect(bitmapBit(parsed.metadataClaims.collisionBitmap as string, 0)).toBe(false);
    expect(parsed.entries).toMatchObject([
      {
        title: 'A "quoted" title\nwith a line',
        authors: ["Ada \\ Author", "漢字 📚"],
        authorSort: "Author, Ada",
        identifiers: ["urn:test:\u0001"],
        sourceFilename: "quoted.epub",
      },
    ]);
    expect(database.getMatchIndex(profileId).entries[0]?.authorSort).toBe("Author, Ada");
    expect(database.serializeMatchIndex(profileId, { maxResponseBytes: body.length })).toHaveLength(body.length);
    expect(() => database.serializeMatchIndex(profileId, { maxResponseBytes: body.length - 1 })).toThrow(
      expect.objectContaining({ code: "match_index_too_large" }),
    );
  });

  it("emits one bounded profile presentation preference in object and wire indexes", async () => {
    const { database, profileId, rootId } = await fixture();
    const original = database.listBooks(profileId).items[0]!;
    const preferred = database.upsertCatalogFile({
      rootId,
      relativePath: "preferred.epub",
      format: "epub",
      size: 42,
      mtimeMs: 2,
      contentHash: "a".repeat(64),
      scanToken: "bounded-preference",
      retainedRelativePaths: new Set(["nested/quoted.epub", "preferred.epub"]),
      metadata: {
        title: "Preferred presentation",
        authors: ["Ada Author"],
        authorSort: "Author, Ada",
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
    const duplicate = database.listCatalogIssues(profileId, { type: "suspected-duplicate" }).items[0]!;
    database.setCatalogDuplicatePreference(profileId, duplicate.signature, {
      expectedRevision: duplicate.disposition.revision,
      preferredBookId: preferred.bookId,
    });

    const objectIndex = database.getMatchIndex(profileId);
    expect(objectIndex.entries.find(({ bookId }) => bookId === preferred.bookId)).toMatchObject({
      preferredPresentation: true,
    });
    expect(objectIndex.entries.find(({ bookId }) => bookId === original.id)?.preferredPresentation).toBeUndefined();

    const body = database.serializeMatchIndex(profileId);
    const wire = JSON.parse(body.toString("utf8")) as {
      entries: Array<{ bookId: string; preferredPresentation?: true }>;
    };
    expect(wire.entries.find(({ bookId }) => bookId === preferred.bookId)).toMatchObject({
      preferredPresentation: true,
    });
    expect(wire.entries.find(({ bookId }) => bookId === original.id)?.preferredPresentation).toBeUndefined();
    expect(database.serializeMatchIndex(profileId, { maxResponseBytes: body.length })).toHaveLength(body.length);
    expect(() => database.serializeMatchIndex(profileId, { maxResponseBytes: body.length - 1 })).toThrow(
      expect.objectContaining({ code: "match_index_too_large" }),
    );
  });

  it("marks only distinct enabled and available cross-profile metadata claimants", async () => {
    const { database, profileId, rootId } = await fixture();
    database.upsertCatalogFile({
      rootId,
      relativePath: "unrelated.epub",
      format: "epub",
      size: 43,
      mtimeMs: 2,
      contentHash: "d".repeat(64),
      scanToken: "bounded",
      metadata: {
        title: "An unrelated active book",
        authors: ["Different Author"],
        authorSort: null,
        language: "en",
        publisher: null,
        publishedAt: null,
        series: null,
        subjects: [],
        identifiers: ["ASIN:UNRELATED"],
        metadataComplete: true,
        coverKey: null,
        coverMediaType: null,
      },
    });
    const otherProfile = database.createProfile({ name: "Other household library" });
    const otherRoot = database.createRoot(otherProfile.id, {
      label: "Other books",
      path: "/libraries/other-bounded",
    });
    database.upsertCatalogFile({
      rootId: otherRoot.id,
      relativePath: "other.epub",
      format: "epub",
      size: 200,
      mtimeMs: 2,
      contentHash: "b".repeat(64),
      scanToken: "other",
      metadata: {
        title: 'A "quoted" title\nwith a line',
        authors: ["Bob Other Author"],
        authorSort: null,
        language: "en",
        publisher: null,
        publishedAt: null,
        series: null,
        subjects: [],
        identifiers: ["ASIN:B000TEST"],
        metadataComplete: true,
        coverKey: null,
        coverMediaType: null,
      },
    });

    const collidedIndex = database.getMatchIndex(profileId);
    const collided = collidedIndex.metadataClaims;
    const matchingPosition = collidedIndex.entries.findIndex(({ title }) => title.includes("quoted"));
    const unrelatedPosition = collidedIndex.entries.findIndex(({ title }) => title.startsWith("An unrelated"));
    expect(matchingPosition).toBeGreaterThanOrEqual(0);
    expect(unrelatedPosition).toBeGreaterThanOrEqual(0);
    expect(collided.complete).toBe(true);
    expect(bitmapBit(collided.collisionBitmap, matchingPosition)).toBe(true);
    expect(bitmapBit(collided.collisionBitmap, unrelatedPosition)).toBe(false);

    database.updateProfile(otherProfile.id, { enabled: false });
    expect(bitmapBit(database.getMatchIndex(profileId).metadataClaims.collisionBitmap, matchingPosition)).toBe(false);
    database.updateProfile(otherProfile.id, { enabled: true });

    database.noteRootUnavailable(otherRoot.id);
    database.noteRootUnavailable(otherRoot.id);
    const unavailable = database.getMatchIndex(profileId).metadataClaims;
    expect(unavailable.complete).toBe(true);
    expect(bitmapBit(unavailable.collisionBitmap, matchingPosition)).toBe(false);
  });

  it("deduplicates a book shared into another profile instead of treating it as a claimant", async () => {
    const { database, profileId } = await fixture();
    const sharedProfile = database.createProfile({ name: "Shared view" });
    database.createRoot(sharedProfile.id, {
      label: "The same books",
      path: "/libraries/bounded",
    });

    const summary = database.getMatchIndex(profileId).metadataClaims;
    expect(summary.complete).toBe(true);
    expect(bitmapBit(summary.collisionBitmap, 0)).toBe(false);
  });

  it("keeps any retained device-specific artifact size as cross-tier claim capability", async () => {
    const { database, profileId } = await fixture();
    const otherProfile = database.createProfile({ name: "Delivered editions" });
    const otherRoot = database.createRoot(otherProfile.id, {
      label: "Delivered books",
      path: "/libraries/delivered-editions",
    });
    const indexed = database.upsertCatalogFile({
      rootId: otherRoot.id,
      relativePath: "delivered.epub",
      format: "epub",
      size: 300,
      mtimeMs: 2,
      contentHash: "c".repeat(64),
      scanToken: "delivered",
      metadata: {
        title: 'A "quoted" title\nwith a line',
        authors: ["Ada \\ Author"],
        authorSort: null,
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
    const token = database.getMatchIndex(otherProfile.id).entries[0]!.managedToken;
    database.createDelivery("delivery-stale-version", {
      profileId: otherProfile.id,
      bookId: indexed.bookId,
      deviceKey: "old-device",
      status: "delivered",
      filename: "stale-version.azw3",
      size: 199,
      managedToken: "kb-00000000000000000000",
    });
    expect(bitmapBit(database.getMatchIndex(profileId).metadataClaims.collisionBitmap, 0)).toBe(false);
    for (const [deviceKey, size] of [["device-a", 200], ["device-b", 210]] as const) {
      database.createDelivery(`delivery-${deviceKey}`, {
        profileId: otherProfile.id,
        bookId: indexed.bookId,
        deviceKey,
        status: "delivered",
        filename: `delivered-${deviceKey}.azw3`,
        size,
        managedToken: token,
      });
    }

    const summary = database.getMatchIndex(profileId).metadataClaims;
    expect(summary.complete).toBe(true);
    expect(bitmapBit(summary.collisionBitmap, 0)).toBe(true);
  });

  it("keeps an active index usable but metadata-incomplete when another claimant row is malformed", async () => {
    const { database, profileId } = await fixture();
    const otherProfile = database.createProfile({ name: "Malformed claimant" });
    const otherRoot = database.createRoot(otherProfile.id, {
      label: "Malformed books",
      path: "/libraries/malformed-claimant",
    });
    const indexed = database.upsertCatalogFile({
      rootId: otherRoot.id,
      relativePath: "malformed.epub",
      format: "epub",
      size: 200,
      mtimeMs: 2,
      contentHash: "e".repeat(64),
      scanToken: "malformed",
      metadata: {
        title: 'A "quoted" title\nwith a line',
        authors: ["Ada \\ Author"],
        authorSort: null,
        language: "en",
        publisher: null,
        publishedAt: null,
        series: null,
        subjects: [],
        identifiers: ["ASIN:B000TEST"],
        metadataComplete: true,
        coverKey: null,
        coverMediaType: null,
      },
    });
    database.database.prepare("UPDATE books SET authors_json = ? WHERE id = ?")
      .run('["Ada Author", 7]', indexed.bookId);

    const matchIndex = database.getMatchIndex(profileId);
    expect(matchIndex.entries).toHaveLength(1);
    expect(matchIndex.metadataClaims.complete).toBe(false);
    expect(bitmapBit(matchIndex.metadataClaims.collisionBitmap, 0)).toBe(false);
  });

  it("rejects escape expansion and large author/identifier JSON before retaining a response graph", async () => {
    const escaped = await fixture({ title: "\u0000".repeat(1_000) });
    expect(() => escaped.database.getMatchIndex(escaped.profileId, { maxResponseBytes: 2_000 })).toThrow(
      expect.objectContaining({ code: "match_index_too_large" }),
    );

    const arrays = await fixture({
      authors: Array.from({ length: 100 }, (_, index) => `${index}:${"a".repeat(200)}`),
      identifiers: Array.from({ length: 100 }, (_, index) => `${index}:${"i".repeat(200)}`),
    });
    expect(() => arrays.database.serializeMatchIndex(arrays.profileId, { maxResponseBytes: 32 * 1024 })).toThrow(
      expect.objectContaining({ code: "match_index_too_large" }),
    );
  });
});

describe("bounded catalog-page serialization", () => {
  it("preserves the BookPage contract and enforces the exact encoded boundary", async () => {
    const { database, profileId } = await fixture();
    const expected = database.listBooks(profileId, { limit: 24, offset: 0 });
    const body = database.serializeBookPage(profileId, { limit: 24, offset: 0 });

    expect(JSON.parse(body.toString("utf8"))).toEqual(expected);
    expect(database.serializeBookPage(profileId, { limit: 24 }, body.length)).toHaveLength(body.length);
    expect(() => database.serializeBookPage(profileId, { limit: 24 }, body.length - 1)).toThrow(
      expect.objectContaining({ code: "response_too_large" }),
    );
  });

  it("rejects valid maximum-count metadata arrays before loading the selected page rows", async () => {
    const hugeValue = (prefix: string, index: number): string =>
      `${prefix}-${index.toString().padStart(3, "0")}-${'"\\'.repeat(995)}`;
    const values = (prefix: string): string[] => Array.from({ length: 100 }, (_, index) => hugeValue(prefix, index));
    const { database, profileId } = await fixture({
      authors: values("author"),
      subjects: values("subject"),
      identifiers: values("identifier"),
    });

    expect(() => database.serializeBookPage(profileId, { limit: 200 }, 1024 * 1024)).toThrow(
      expect.objectContaining({ code: "response_too_large" }),
    );
  });
});
