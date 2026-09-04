import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogDatabase } from "../../server/catalog-database.js";
import { createCatalogService, type CatalogService } from "../../server/catalog-service.js";
import { sanitizeServerLogContext } from "../../server/logging.js";

const temporaryDirectories: string[] = [];
const services: CatalogService[] = [];

afterEach(async () => {
  while (services.length) await services.pop()?.close();
  while (temporaryDirectories.length) await rm(temporaryDirectories.pop()!, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "kindle-cover-provider-settings-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function startService(options: { settingsMode?: "read-write" | "read-only"; legacyKey?: string } = {}) {
  const directory = await temporaryDirectory();
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
      settingsMode: options.settingsMode ?? "read-write",
      googleBooksApiKey: options.legacyKey,
    },
    scanner: { watcherHints: false, reconciliationIntervalMs: 60_000 },
  });
  services.push(service);
  const address = await service.start();
  return { service, base: `http://127.0.0.1:${address.port}` };
}

describe("cover-provider Settings", () => {
  it("persists only masked public state and does not resurrect a removed environment key", async () => {
    const directory = await temporaryDirectory();
    const filename = path.join(directory, "catalog.sqlite");
    let database = new CatalogDatabase(filename);
    database.initializeCoverProviderCredentials("legacy-secret");

    expect(database.database.prepare(
      "SELECT configuration_state FROM cover_provider_credentials WHERE provider = 'google-books'",
    ).get()).toEqual({ configuration_state: "configured" });

    expect(database.listCoverProviderCredentialStates()).toEqual([expect.objectContaining({
      provider: "google-books",
      configured: true,
      maskedKey: "••••••••",
      revision: 1,
      status: "untested",
    })]);
    expect(JSON.stringify(database.listCoverProviderCredentialStates())).not.toContain("legacy-secret");

    const replaced = database.setCoverProviderCredential("google-books", "replacement-secret", 1);
    expect(replaced).toMatchObject({ configured: true, revision: 2, status: "untested" });
    expect(database.getCoverProviderCredential("google-books")).toEqual({
      provider: "google-books",
      apiKey: "replacement-secret",
      revision: 2,
    });
    expect(database.recordCoverProviderCredentialTest("google-books", 2, null)).toMatchObject({
      status: "working",
      revision: 2,
    });
    expect(database.removeCoverProviderCredential("google-books", 2)).toMatchObject({
      configured: false,
      revision: 3,
      status: "not-configured",
    });
    expect(database.database.prepare(
      "SELECT configuration_state FROM cover_provider_credentials WHERE provider = 'google-books'",
    ).get()).toEqual({ configuration_state: "removed" });
    database.close();

    database = new CatalogDatabase(filename);
    database.initializeCoverProviderCredentials("stale-environment-secret");
    expect(database.getCoverProviderCredential("google-books")).toBeNull();
    expect(database.getCoverProviderCredentialState("google-books")).toMatchObject({
      configured: false,
      revision: 3,
    });
    database.close();
  });

  it("serves add, test, and remove flows without returning the key", async () => {
    const localFetch = globalThis.fetch;
    const upstream = vi.fn(async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input));
      expect(url.hostname).toBe("www.googleapis.com");
      expect(url.searchParams.get("key")).toBe("browser-entered-secret");
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", upstream);
    const { base } = await startService();

    const initial = await localFetch(`${base}/api/settings/cover-providers`);
    expect(await initial.json()).toEqual({ items: [expect.objectContaining({
      provider: "google-books",
      configured: false,
      revision: 0,
    })] });

    const saved = await localFetch(`${base}/api/settings/cover-providers/google-books`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "provider-save-1" },
      body: JSON.stringify({ apiKey: "browser-entered-secret", expectedRevision: 0 }),
    });
    const savedBody = JSON.stringify(await saved.json());
    expect(saved.status).toBe(200);
    expect(savedBody).not.toContain("browser-entered-secret");
    expect(JSON.parse(savedBody)).toMatchObject({ configured: true, revision: 1, status: "untested" });
    const replayedSave = await localFetch(`${base}/api/settings/cover-providers/google-books`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "provider-save-1" },
      body: JSON.stringify({ apiKey: "browser-entered-secret", expectedRevision: 0 }),
    });
    expect(await replayedSave.json()).toMatchObject({ configured: true, revision: 1 });

    const tested = await localFetch(`${base}/api/settings/cover-providers/google-books/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    const testedBody = JSON.stringify(await tested.json());
    expect(tested.status).toBe(200);
    expect(testedBody).not.toContain("browser-entered-secret");
    expect(JSON.parse(testedBody)).toMatchObject({ configured: true, revision: 1, status: "working" });
    expect(upstream).toHaveBeenCalledOnce();

    const removed = await localFetch(`${base}/api/settings/cover-providers/google-books?expectedRevision=1`, {
      method: "DELETE",
      headers: { "Idempotency-Key": "provider-remove-1" },
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ configured: false, revision: 2, status: "not-configured" });
    const replayedRemove = await localFetch(`${base}/api/settings/cover-providers/google-books?expectedRevision=1`, {
      method: "DELETE",
      headers: { "Idempotency-Key": "provider-remove-1" },
    });
    expect(await replayedRemove.json()).toMatchObject({ configured: false, revision: 2 });

    const missingTest = await localFetch(`${base}/api/settings/cover-providers/google-books/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 2 }),
    });
    expect(missingTest.status).toBe(409);
    expect(await missingTest.json()).toMatchObject({ error: { code: "provider_not_configured" } });
  });

  it("honors Settings read-only mode and redacts API-key-shaped log fields", async () => {
    const { base } = await startService({ settingsMode: "read-only" });
    const response = await fetch(`${base}/api/settings/cover-providers/google-books`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "must-not-save", expectedRevision: 0 }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "settings_read_only" } });

    const sanitized = sanitizeServerLogContext({
      apiKey: "secret-one",
      api_key: "secret-two",
      authorization: "secret-three",
      nested: { accessToken: "secret-four" },
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/secret-(?:one|two|three|four)/u);
  });
});
