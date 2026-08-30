import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { CatalogDatabase } from "./catalog-database.js";
import { CATALOG_SCHEMA_VERSION } from "./migrations.js";

export interface CatalogRebuildResult {
  profiles: number;
  roots: number;
  deliveries: number;
}

export interface CatalogVerificationResult {
  schemaVersion: number;
  integrity: "ok";
}

export function verifyCatalogDatabase(databasePath: string): CatalogVerificationResult {
  if (!existsSync(databasePath)) throw new Error(`Catalog database does not exist: ${databasePath}`);
  // A catalog uses WAL mode. SQLite normally needs to create/open shared-memory
  // sidecars even for a read-only connection, which fails when restore
  // verification deliberately mounts the volume read-only. A cold backup has
  // already closed/checkpointed SQLite, so immutable URI mode is the correct
  // non-mutating verifier and prevents any journal/WAL sidecar creation.
  const immutableLocation = pathToFileURL(databasePath);
  immutableLocation.searchParams.set("immutable", "1");
  const database = new DatabaseSync(immutableLocation.href, { readOnly: true });
  try {
    const integrityRows = database.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    const integrity = integrityRows.map((row) => String(Object.values(row)[0] ?? ""));
    if (integrity.length !== 1 || integrity[0] !== "ok") {
      throw new Error(`Catalog database integrity check failed: ${integrity.join("; ") || "no result"}`);
    }
    const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyRows.length > 0) throw new Error("Catalog database foreign-key check failed.");
    const versionRow = database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as Record<string, unknown> | undefined;
    const schemaVersion = Number(versionRow?.version ?? 0);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > CATALOG_SCHEMA_VERSION) {
      throw new Error(`Catalog schema version ${schemaVersion} is not supported by this image.`);
    }
    return { schemaVersion, integrity: "ok" };
  } finally {
    database.close();
  }
}

/**
 * Clear only source-derived rows while retaining configuration, delivery
 * evidence, and the stable identity map needed to re-associate deliveries on
 * the next scan. The service must be stopped while this runs.
 */
export function prepareCatalogRebuild(databasePath: string): CatalogRebuildResult {
  verifyCatalogDatabase(databasePath);
  const database = new CatalogDatabase(databasePath);
  try {
    const profiles = database.listProfiles().length;
    const roots = Number(database.database.prepare("SELECT count(*) AS count FROM library_roots").get()!.count);
    const deliveries = Number(database.database.prepare("SELECT count(*) AS count FROM deliveries").get()!.count);
    database.clearRebuildableCatalog();
    const result = database.database.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
    if (String(Object.values(result ?? {})[0] ?? "") !== "ok") {
      throw new Error("Catalog database integrity check failed after rebuild preparation.");
    }
    return { profiles, roots, deliveries };
  } finally {
    database.close();
  }
}

function main(): void {
  const command = process.argv[2];
  if (!(["prepare-rebuild", "verify"] as const).includes(command as "prepare-rebuild" | "verify") || process.argv.length !== 3) {
    process.stderr.write("Usage: node maintenance.js <prepare-rebuild|verify>\n");
    process.exitCode = 64;
    return;
  }
  const databasePath = process.env.CATALOG_DATABASE_PATH?.trim() || "/data/catalog.sqlite";
  const result = command === "verify"
    ? verifyCatalogDatabase(databasePath)
    : prepareCatalogRebuild(databasePath);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
