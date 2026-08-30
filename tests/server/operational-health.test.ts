import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CatalogDatabase } from "../../server/catalog-database";
import { CatalogIndexer } from "../../server/catalog-indexer";
import { CoverCache } from "../../server/cover-cache";
import { CatalogEventHub } from "../../server/event-hub";
import { CatalogHttpServer } from "../../server/http-server";
import { catalogConfigFromEnvironment } from "../../server/main";
import { AllowedRootPolicy } from "../../server/root-policy";
import { isFatalSqliteError } from "../../server/sqlite-health";

const temporaryDirectories: string[] = [];

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function statusWithHost(port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: "/api/status", headers: { Host: host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("operational health classification", () => {
  it("fails closed on mistyped Settings mode instead of silently enabling writes", () => {
    expect(catalogConfigFromEnvironment({ CATALOG_SETTINGS_MODE: "read-only" }).http?.settingsMode).toBe("read-only");
    expect(catalogConfigFromEnvironment({ CATALOG_SETTINGS_MODE: "" }).http?.settingsMode).toBe("read-write");
    expect(() => catalogConfigFromEnvironment({ CATALOG_SETTINGS_MODE: "readonly" })).toThrow(
      "CATALOG_SETTINGS_MODE must be exactly read-write or read-only",
    );
  });

  it("latches fatal SQLite base and extended errors but ignores ordinary contention and constraints", () => {
    expect(isFatalSqliteError({ code: "ERR_SQLITE_ERROR", errcode: 13, message: "database or disk is full" })).toBe(true);
    expect(isFatalSqliteError({ code: "ERR_SQLITE_ERROR", errcode: (3 << 8) | 10, message: "disk I/O error" })).toBe(true);
    expect(isFatalSqliteError({ code: "SQLITE_READONLY", message: "attempt to write a readonly database" })).toBe(true);
    expect(isFatalSqliteError({ code: "ERR_SQLITE_ERROR", errcode: 19, message: "UNIQUE constraint failed" })).toBe(false);
    expect(isFatalSqliteError({ code: "ERR_SQLITE_ERROR", errcode: 5, message: "database is locked" })).toBe(false);
    expect(isFatalSqliteError(new Error("ordinary application failure"))).toBe(false);
  });

  it("makes database failure unready while treating cache failure as recoverable degradation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-bridge-health-"));
    temporaryDirectories.push(directory);
    const allowed = path.join(directory, "libraries");
    await mkdir(allowed);
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const policy = await AllowedRootPolicy.create([allowed]);
    const cache = new CoverCache(path.join(directory, "cache"));
    const events = new CatalogEventHub();
    const indexer = new CatalogIndexer(database, policy, cache, () => undefined, {
      watcherHints: false,
      reconciliationIntervalMs: 60_000,
    });
    const port = await reserveLoopbackPort();
    const http = new CatalogHttpServer(database, indexer, policy, cache, events, {
      hostname: "127.0.0.1",
      port,
      allowedHosts: [`127.0.0.1:${port}`],
    });
    try {
      http.setScannerState("ready");
      const address = await http.listen();
      const base = `http://127.0.0.1:${address.port}`;
      expect(await statusWithHost(port, `127.0.0.1:${port + 1}`)).toBe(421);

      http.setOperationalState("cache", "error");
      let response = await fetch(`${base}/api/readyz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ready: true, database: "ready", cache: "degraded" });
      response = await fetch(`${base}/api/status`);
      expect(await response.json()).toMatchObject({ ready: true, database: "ready", cache: "degraded" });

      http.setOperationalState("cache", "ready");
      http.setOperationalState("database", "error");
      response = await fetch(`${base}/api/readyz`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ready: false, database: "error", cache: "ready" });
      response = await fetch(`${base}/api/status`);
      expect(await response.json()).toMatchObject({ ready: false, database: "error" });
    } finally {
      await http.close();
      await indexer.stop();
      database.close();
    }
  });
});
