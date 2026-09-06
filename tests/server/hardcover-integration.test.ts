import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogDatabase } from "../../server/catalog-database.js";
import { CoverCache } from "../../server/cover-cache.js";
import { CoverProviderClient, CoverProviderError } from "../../server/cover-providers.js";
import { CatalogEventHub } from "../../server/event-hub.js";
import { CatalogHttpServer } from "../../server/http-server.js";
import { MetadataLookupWorker } from "../../server/metadata-lookup-worker.js";
import { CATALOG_MIGRATIONS, migrateCatalogDatabase } from "../../server/migrations.js";
import { AllowedRootPolicy } from "../../server/root-policy.js";
import type { CatalogMetadataCandidate, MetadataLookupJob } from "../../shared/catalog-contracts.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temp() {
  const directory = await mkdtemp(path.join(tmpdir(), "shelfsend-hardcover-"));
  directories.push(directory);
  return directory;
}
function addBook(database: CatalogDatabase, profileId: string, library: string, hash: string) {
  const root = database.createRoot(profileId, { label: "Books", path: library });
  return database.upsertCatalogFile({
    rootId: root.id, relativePath: "book.epub", format: "epub", size: 15, mtimeMs: 1,
    contentHash: hash, scanToken: "hardcover-test",
    metadata: {
      title: "Source title", authors: ["Source Author"], authorSort: null, language: "en",
      publisher: null, publishedAt: null, series: null, seriesIndex: null, subjects: [],
      identifiers: ["ISBN:9780140328721"], metadataComplete: true, coverKey: null, coverMediaType: null,
    },
  }).bookId;
}
const candidates: CatalogMetadataCandidate[] = [
  { provider: "hardcover", candidateId: "1-10", confidence: "high", metadata: { title: "Provider title", series: "Main sequence", seriesIndex: 1.5 } },
  { provider: "hardcover", candidateId: "1-20", confidence: "high", metadata: { title: "Provider title", series: "Shared universe", seriesIndex: 0 } },
];

describe("Hardcover persistence and HTTP integration", () => {
  it("migrates v18 credentials, replays, jobs and reviewed candidates without losing relationships", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
      for (const migration of CATALOG_MIGRATIONS.filter(({ version }) => version <= 18)) {
        database.exec(migration.sql);
        database.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(migration.version, migration.name, "now");
      }
      database.exec(`
        INSERT INTO profiles(id, name, enabled, created_at, updated_at) VALUES ('prf_old', 'Existing', 1, 'now', 'now');
        INSERT INTO cover_provider_credentials(provider, api_key, configuration_state, revision, last_test_status, created_at, updated_at)
          VALUES ('google-books', 'existing-key', 'configured', 3, 'working', 'now', 'now');
        INSERT INTO cover_provider_mutation_replays VALUES ('google-books', 'save', 'saved', 'hash', 3, 'now');
        INSERT INTO metadata_lookup_jobs VALUES ('lookup_old', 'prf_old', 'open-library', 'completed', 5, 'now', 'now');
        INSERT INTO metadata_lookup_entries VALUES ('lookup_old', 'book_old', 0, 'ready', 1, '[{"provider":"open-library","candidateId":"OL1W"}]', NULL, 'accepted', 'now');
        INSERT INTO metadata_lookup_job_replays VALUES ('prf_old', 'job-key', 'job-hash', 'lookup_old', 'now');
      `);
      expect(migrateCatalogDatabase(database)).toBe(19);
      expect(database.prepare("SELECT api_key, revision, last_test_status FROM cover_provider_credentials").get())
        .toEqual({ api_key: "existing-key", revision: 3, last_test_status: "working" });
      expect(database.prepare("SELECT result_revision FROM cover_provider_mutation_replays").get()).toEqual({ result_revision: 3 });
      expect(database.prepare("SELECT accepted_at, candidates_json FROM metadata_lookup_entries").get())
        .toEqual({ accepted_at: "accepted", candidates_json: '[{"provider":"open-library","candidateId":"OL1W"}]' });
      expect(database.prepare("SELECT job_id FROM metadata_lookup_job_replays").get()).toEqual({ job_id: "lookup_old" });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      database.exec("DELETE FROM metadata_lookup_jobs WHERE id = 'lookup_old'");
      expect(database.prepare("SELECT count(*) AS n FROM metadata_lookup_entries").get()).toEqual({ n: 0 });
      expect(database.prepare("SELECT count(*) AS n FROM metadata_lookup_job_replays").get()).toEqual({ n: 0 });
    } finally { database.close(); }
  });

  it("persists Hardcover credentials and fractional reviewed results across restart", async () => {
    const filename = path.join(await temp(), "catalog.sqlite");
    let database = new CatalogDatabase(filename);
    const profile = database.createProfile({ name: "Hardcover" });
    const bookId = addBook(database, profile.id, "/libraries/books", "a".repeat(64));
    const secret = "hc-" + "x".repeat(700);
    database.setCoverProviderCredential("hardcover", `Bearer ${secret}`, 0, "save-hardcover");
    expect(database.setCoverProviderCredential("hardcover", secret, 0, "save-hardcover").revision).toBe(1);
    database.recordCoverProviderCredentialTest("hardcover", 1, "insufficient-permissions");
    const job = database.createMetadataLookupJob(profile.id, { provider: "hardcover", bookIds: [bookId] }, "hc-job").job;
    database.controlMetadataLookupJob(profile.id, job.id, "resume", job.revision);
    database.claimMetadataLookupEntries(profile.id, job.id);
    database.completeMetadataLookupEntry(profile.id, job.id, bookId, candidates, null);
    database.close();
    database = new CatalogDatabase(filename);
    try {
      expect(database.getCoverProviderCredential("hardcover")?.apiKey).toBe(secret);
      expect(database.getCoverProviderCredentialState("hardcover")).toMatchObject({ configured: true, revision: 1, errorCode: "insufficient-permissions" });
      expect(JSON.stringify(database.listCoverProviderCredentialStates())).not.toContain(secret);
      expect(database.getMetadataLookupJob(profile.id, job.id)?.entries[0]?.candidates).toEqual(candidates);
      expect(database.getBook(profile.id, bookId)?.series).toBeNull();
      database.removeCoverProviderCredential("hardcover", 1, "remove-hardcover");
      expect(database.getCoverProviderCredential("hardcover")).toBeNull();
    } finally { database.close(); }
  });

  it("saves/tests the token and imports chosen individual and bulk series without touching originals", async () => {
    const directory = await temp();
    const library = path.join(directory, "library");
    await mkdir(library);
    const original = Buffer.from("immutable epub!");
    const filename = path.join(library, "book.epub");
    await writeFile(filename, original);
    const sourceHash = createHash("sha256").update(original).digest("hex");
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const profile = database.createProfile({ name: "Review" });
    const bookId = addBook(database, profile.id, library, sourceHash);
    const events = new CatalogEventHub();
    const search = vi.spyOn(CoverProviderClient.prototype, "searchMetadata").mockResolvedValue(candidates);
    const testToken = vi.spyOn(CoverProviderClient.prototype, "testHardcoverCredential").mockResolvedValue(null);
    const server = new CatalogHttpServer(database, {} as never, await AllowedRootPolicy.create([library]), new CoverCache(path.join(directory, "cache")), events, {
      hostname: "127.0.0.1", port: 0, allowedHosts: ["127.0.0.1"], allowedOrigins: [], requireOriginForMutations: false,
    });
    const address = await server.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const endpoint = `${base}/api/profiles/${profile.id}/books/${bookId}`;
    const json = { "Content-Type": "application/json" };
    try {
      const saved = await fetch(`${base}/api/settings/cover-providers/hardcover`, {
        method: "PUT", headers: { ...json, "Idempotency-Key": "hc-save" },
        body: JSON.stringify({ apiKey: "Bearer server-token", expectedRevision: 0 }),
      });
      expect(saved.status).toBe(200);
      const savedBody = await saved.json();
      expect(savedBody).toMatchObject({ provider: "hardcover", configured: true, revision: 1 });
      expect(JSON.stringify(savedBody)).not.toContain("server-token");
      const tested = await fetch(`${base}/api/settings/cover-providers/hardcover/test`, { method: "POST", headers: json, body: '{"expectedRevision":1}' });
      expect(await tested.json()).toMatchObject({ status: "working" });
      expect(testToken).toHaveBeenCalledWith("server-token", expect.any(AbortSignal));
      const found = await fetch(`${endpoint}/metadata-search?provider=hardcover&identifier=9780140328721&title=Source%20title&author=Source%20Author`);
      expect(await found.json()).toEqual({ provider: "hardcover", items: candidates });
      expect(search).toHaveBeenCalledWith("hardcover", { identifier: "9780140328721", title: "Source title", author: "Source Author" }, expect.any(Number), expect.any(AbortSignal));
      const body = { provider: "hardcover", candidateId: "1-10", selectedFields: ["series", "seriesIndex"], includeCover: false, expectedRevision: 0, expectedContentHash: sourceHash };
      const importCandidate = (value: unknown) => fetch(`${endpoint}/metadata-import`, { method: "POST", headers: json, body: JSON.stringify(value) });
      expect((await importCandidate({ ...body, selectedFields: ["series"] })).status).toBe(400);
      expect((await importCandidate({ ...body, selectedFields: ["seriesIndex"] })).status).toBe(400);
      expect((await importCandidate({ ...body, includeCover: true })).status).toBe(400);
      expect((await importCandidate({ ...body, expectedContentHash: "e".repeat(64) })).status).toBe(409);
      const imported = await importCandidate(body);
      expect(imported.status).toBe(200);
      expect(await imported.json()).toMatchObject({ book: { title: "Source title", series: "Main sequence", seriesIndex: 1.5 }, sourceMetadata: { series: null } });
      const jobBase = `${base}/api/profiles/${profile.id}/metadata-lookup-jobs`;
      const createdResponse = await fetch(jobBase, { method: "POST", headers: { ...json, "Idempotency-Key": "hc-bulk" }, body: JSON.stringify({ provider: "hardcover", bookIds: [bookId] }) });
      expect(createdResponse.status).toBe(201);
      const job = await createdResponse.json() as MetadataLookupJob;
      await fetch(`${jobBase}/${job.id}/resume`, { method: "POST", headers: json, body: JSON.stringify({ expectedRevision: job.revision }) });
      const run = await fetch(`${jobBase}/${job.id}/run`, { method: "POST", headers: json, body: "{}" });
      expect(await run.json()).toMatchObject({ provider: "hardcover", status: "completed", entries: [{ status: "ready", candidates }] });
      expect(database.getBook(profile.id, bookId)?.series).toBe("Main sequence");
      const bulkImport = await importCandidate({ ...body, candidateId: "1-20", lookupJobId: job.id, expectedRevision: 1 });
      expect(bulkImport.status).toBe(200);
      expect(await bulkImport.json()).toMatchObject({ book: { series: "Shared universe", seriesIndex: 0 }, revision: 2 });
      expect((await importCandidate({ ...body, lookupJobId: job.id, expectedRevision: 1 })).status).toBe(409);
      expect(await readFile(filename)).toEqual(original);
      expect((await fetch(`${endpoint}/cover-search?provider=hardcover&q=book`)).status).toBe(400);
    } finally {
      await server.close(); events.close(); database.close();
    }
  });

  it.each([
    ["provider_invalid_token", "provider-unauthorized"],
    ["provider_insufficient_permissions", "provider-forbidden"],
    ["provider_rate_limited", "provider-rate-limited"],
  ] as const)("records %s without retrying or applying metadata", async (code, expected) => {
    const database = new CatalogDatabase(":memory:");
    try {
      const profile = database.createProfile({ name: "Failures" });
      const bookId = addBook(database, profile.id, "/libraries/books", "a".repeat(64));
      const job = database.createMetadataLookupJob(profile.id, { provider: "hardcover", bookIds: [bookId] }, "failure").job;
      database.controlMetadataLookupJob(profile.id, job.id, "resume", job.revision);
      const searchMetadata = vi.fn().mockRejectedValue(new CoverProviderError(code, "Connect Hardcover in Settings."));
      const worker = new MetadataLookupWorker(database, { searchMetadata });
      const completed = await worker.runStep(profile.id, job.id);
      expect(completed.entries[0]).toMatchObject({ status: "failed", errorCode: expected });
      expect(searchMetadata).toHaveBeenCalledOnce();
      expect(database.getBookMetadataState(profile.id, bookId)?.revision).toBe(0);
    } finally { database.close(); }
  });
});
