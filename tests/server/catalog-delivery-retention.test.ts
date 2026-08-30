import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CatalogDatabase,
  MAX_NON_DELIVERED_DELIVERIES_PER_PROFILE,
} from "../../server/catalog-database.js";
import {
  MAX_MATCH_INDEX_DELIVERIES,
  MAX_MATCH_INDEX_RESPONSE_BYTES,
  type DeliveryInput,
  type DeliveryStatus,
} from "../../shared/catalog-contracts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "kindle-delivery-retention-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "catalog.sqlite");
}

function createCatalog(filename: string): {
  database: CatalogDatabase;
  profileId: string;
  rootId: string;
  bookId: string;
  managedToken: string;
} {
  const database = new CatalogDatabase(filename);
  const profile = database.createProfile({ name: "Retention" });
  const root = database.createRoot(profile.id, { label: "Books", path: "/library/retention" });
  const indexed = database.upsertCatalogFile({
    rootId: root.id,
    relativePath: "retention.epub",
    format: "epub",
    size: 128,
    mtimeMs: 1,
    contentHash: "a".repeat(64),
    scanToken: "retention",
    metadata: {
      title: "Retention",
      authors: ["Ada Author"],
      authorSort: "Author, Ada",
      language: "en",
      publisher: null,
      publishedAt: null,
      series: null,
      subjects: [],
      identifiers: ["urn:test:retention"],
      metadataComplete: true,
      coverKey: null,
      coverMediaType: null,
    },
  });
  const managedToken = database.getMatchIndex(profile.id).entries[0]!.managedToken;
  return { database, profileId: profile.id, rootId: root.id, bookId: indexed.bookId, managedToken };
}

function seedDeliveries(
  database: CatalogDatabase,
  input: {
    profileId: string;
    bookId: string;
    managedToken: string;
    count: number;
    prefix: string;
    statuses: readonly DeliveryStatus[];
  },
): void {
  const insert = database.database.prepare(
    `INSERT INTO deliveries(
       id, idempotency_key, request_hash, profile_id, book_id, device_key, status,
       artifact_hash, filename, size, object_persistent_id, managed_token, result_json,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, ?, ?)`,
  );
  const timestamp = "2025-01-01T00:00:00.000Z";
  database.database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < input.count; index += 1) {
      const sequence = index.toString().padStart(6, "0");
      insert.run(
        `${input.prefix}-id-${sequence}`,
        `${input.prefix}-key-${sequence}`,
        `${input.prefix}-hash-${sequence}`,
        input.profileId,
        input.bookId,
        `${input.prefix}-device-${sequence}`,
        input.statuses[index % input.statuses.length]!,
        input.managedToken,
        timestamp,
        timestamp,
      );
    }
    database.database.exec("COMMIT");
  } catch (error) {
    database.database.exec("ROLLBACK");
    throw error;
  }
}

function deliveryCount(database: CatalogDatabase, profileId: string, delivered: boolean): number {
  const statusPredicate = delivered ? "status = 'delivered'" : "status <> 'delivered'";
  const row = database.database
    .prepare(`SELECT count(*) AS count FROM deliveries WHERE profile_id = ? AND ${statusPredicate}`)
    .get(profileId) as { count: number };
  return Number(row.count);
}

function seedWideDelivered(
  database: CatalogDatabase,
  input: {
    profileId: string;
    bookId: string;
    managedToken: string;
    count: number;
    prefix: string;
    fillCharacter?: string;
  },
): void {
  const insert = database.database.prepare(
    `INSERT INTO deliveries(
       id, idempotency_key, request_hash, profile_id, book_id, device_key, status,
       artifact_hash, filename, size, object_persistent_id, managed_token, result_json,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  const fillCharacter = input.fillCharacter ?? "\\";
  const escapedDevice = fillCharacter.repeat(256);
  const escapedArtifact = fillCharacter.repeat(128);
  const escapedFilename = fillCharacter.repeat(512);
  const escapedObject = fillCharacter.repeat(256);
  const timestamp = "2025-01-01T00:00:00.000Z";
  database.database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < input.count; index += 1) {
      const sequence = index.toString().padStart(6, "0");
      insert.run(
        `${input.prefix}-id-${sequence}`,
        `${input.prefix}-key-${sequence}`,
        `${input.prefix}-hash-${sequence}`,
        input.profileId,
        input.bookId,
        escapedDevice,
        escapedArtifact,
        escapedFilename,
        Number.MAX_SAFE_INTEGER,
        escapedObject,
        input.managedToken,
        timestamp,
        timestamp,
      );
    }
    database.database.exec("COMMIT");
  } catch (error) {
    database.database.exec("ROLLBACK");
    throw error;
  }
}

function insertRawDelivery(
  database: CatalogDatabase,
  input: { id: string; profileId: string; bookId: string; managedToken: string },
): void {
  database.database
    .prepare(
      `INSERT INTO deliveries(
         id, idempotency_key, request_hash, profile_id, book_id, device_key, status,
         managed_token, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?)`,
    )
    .run(
      input.id,
      `${input.id}-key`,
      `${input.id}-hash`,
      input.profileId,
      input.bookId,
      `${input.id}-device`,
      input.managedToken,
      "2025-01-01T00:00:00.000Z",
      "2025-01-01T00:00:00.000Z",
    );
}

function newestDeliveredInput(profileId: string, bookId: string, managedToken: string): DeliveryInput {
  return {
    profileId,
    bookId,
    deviceKey: "newest-device",
    status: "delivered",
    artifactHash: "b".repeat(64),
    filename: "retention.azw3",
    size: 256,
    objectIdentity: "newest-object",
    managedToken,
  };
}

function replaceCatalogVersion(database: CatalogDatabase, rootId: string, contentHash: string, scanToken: string): string {
  return database.upsertCatalogFile({
    rootId,
    relativePath: "retention.epub",
    format: "epub",
    size: 128,
    mtimeMs: Date.now(),
    contentHash,
    scanToken,
    metadata: {
      title: "Retention",
      authors: ["Ada Author"],
      authorSort: "Author, Ada",
      language: "en",
      publisher: null,
      publishedAt: null,
      series: null,
      subjects: [],
      identifiers: ["urn:test:retention"],
      metadataComplete: true,
      coverKey: null,
      coverMediaType: null,
    },
  }).bookId;
}

describe("delivery-history retention", () => {
  it("heals a legacy overflow, prunes 40,000 to 40,001 deterministically, and preserves replayable newest evidence", async () => {
    const filename = await temporaryDatabasePath();
    const catalog = createCatalog(filename);
    seedDeliveries(catalog.database, {
      ...catalog,
      count: MAX_MATCH_INDEX_DELIVERIES + 1,
      prefix: "delivered",
      statuses: ["delivered"],
    });
    catalog.database.database.exec("DELETE FROM catalog_maintenance_markers");
    catalog.database.close();

    const database = new CatalogDatabase(filename);
    try {
      expect(deliveryCount(database, catalog.profileId, true)).toBe(MAX_MATCH_INDEX_DELIVERIES);
      expect(database.database.prepare("SELECT id FROM deliveries WHERE id = ?").get("delivered-id-000000")).toBe(
        undefined,
      );
      expect(database.database.prepare("SELECT id FROM deliveries WHERE id = ?").get("delivered-id-000001")).toEqual({
        id: "delivered-id-000001",
      });

      const healed = JSON.parse(database.serializeMatchIndex(catalog.profileId).toString("utf8")) as {
        entries: Array<{ deliveries: Array<{ deviceKey: string }> }>;
      };
      expect(healed.entries[0]?.deliveries).toHaveLength(MAX_MATCH_INDEX_DELIVERIES);

      const input = newestDeliveredInput(catalog.profileId, catalog.bookId, catalog.managedToken);
      const created = database.createDelivery("newest-delivery", input);
      expect(created.created).toBe(true);
      expect(deliveryCount(database, catalog.profileId, true)).toBe(MAX_MATCH_INDEX_DELIVERIES);
      expect(database.getDelivery(created.record.id)).toEqual(created.record);
      expect(database.database.prepare("SELECT id FROM deliveries WHERE id = ?").get("delivered-id-000001")).toBe(
        undefined,
      );
      expect(database.database.prepare("SELECT id FROM deliveries WHERE id = ?").get("delivered-id-000002")).toEqual({
        id: "delivered-id-000002",
      });

      const oldestRetainedBeforeReplay = database.database
        .prepare(
          `SELECT id FROM deliveries
           WHERE profile_id = ? AND status = 'delivered'
           ORDER BY updated_at ASC, id ASC LIMIT 1`,
        )
        .get(catalog.profileId);
      const replay = database.createDelivery("newest-delivery", input);
      expect(replay).toEqual({ record: created.record, created: false });
      expect(deliveryCount(database, catalog.profileId, true)).toBe(MAX_MATCH_INDEX_DELIVERIES);
      expect(
        database.database
          .prepare(
            `SELECT id FROM deliveries
             WHERE profile_id = ? AND status = 'delivered'
             ORDER BY updated_at ASC, id ASC LIMIT 1`,
          )
          .get(catalog.profileId),
      ).toEqual(oldestRetainedBeforeReplay);

      const serialized = JSON.parse(database.serializeMatchIndex(catalog.profileId).toString("utf8")) as {
        entries: Array<{ deliveries: Array<{ deviceKey: string }> }>;
      };
      expect(serialized.entries[0]?.deliveries).toHaveLength(MAX_MATCH_INDEX_DELIVERIES);
      expect(serialized.entries[0]?.deliveries.some((delivery) => delivery.deviceKey === "newest-device")).toBe(true);
      expect(
        serialized.entries[0]?.deliveries.some(
          (delivery) => delivery.deviceKey === "delivered-device-000001",
        ),
      ).toBe(false);
    } finally {
      database.close();
    }
  }, 30_000);

  it("rolls back the insertion and every prune when retention fails", async () => {
    const filename = await temporaryDatabasePath();
    const catalog = createCatalog(filename);
    try {
      seedDeliveries(catalog.database, {
        ...catalog,
        count: MAX_MATCH_INDEX_DELIVERIES,
        prefix: "rollback",
        statuses: ["delivered"],
      });
      catalog.database.database.exec(`
        CREATE TRIGGER block_delivery_retention
        BEFORE DELETE ON deliveries
        BEGIN
          SELECT RAISE(ABORT, 'retention blocked');
        END;
      `);
      const input = newestDeliveredInput(catalog.profileId, catalog.bookId, catalog.managedToken);
      expect(() => catalog.database.createDelivery("rollback-current", input)).toThrow(/retention blocked/u);
      expect(deliveryCount(catalog.database, catalog.profileId, true)).toBe(MAX_MATCH_INDEX_DELIVERIES);
      expect(
        catalog.database.database.prepare("SELECT id FROM deliveries WHERE id = ?").get("rollback-id-000000"),
      ).toEqual({ id: "rollback-id-000000" });
      expect(
        catalog.database.database
          .prepare("SELECT id FROM deliveries WHERE idempotency_key = ?")
          .get("rollback-current"),
      ).toBe(undefined);

      catalog.database.database.exec("DROP TRIGGER block_delivery_retention");
      expect(catalog.database.createDelivery("rollback-current", input).created).toBe(true);
      expect(deliveryCount(catalog.database, catalog.profileId, true)).toBe(MAX_MATCH_INDEX_DELIVERIES);
    } finally {
      catalog.database.close();
    }
  }, 30_000);

  it("compacts valid maximum-width evidence to the exact JSON byte ceiling on startup and live insertion", async () => {
    const filename = await temporaryDatabasePath();
    const catalog = createCatalog(filename);
    const wideCount = 13_500;
    seedWideDelivered(catalog.database, { ...catalog, count: wideCount, prefix: "wide" });
    catalog.database.database.exec("DELETE FROM catalog_maintenance_markers");
    catalog.database.close();

    const database = new CatalogDatabase(filename);
    try {
      const startupBody = database.serializeMatchIndex(catalog.profileId);
      const startupCount = deliveryCount(database, catalog.profileId, true);
      expect(startupBody.byteLength).toBeLessThanOrEqual(MAX_MATCH_INDEX_RESPONSE_BYTES);
      expect(startupCount).toBeLessThan(wideCount);
      expect(database.database.prepare("SELECT id FROM deliveries WHERE id = ?").get("wide-id-000000")).toBe(
        undefined,
      );
      expect(database.database.prepare("SELECT id FROM deliveries WHERE id = ?").get("wide-id-013499")).toEqual({
        id: "wide-id-013499",
      });

      const liveInput: DeliveryInput = {
        profileId: catalog.profileId,
        bookId: catalog.bookId,
        deviceKey: "\\".repeat(256),
        status: "delivered",
        artifactHash: "\\".repeat(128),
        filename: "\\".repeat(512),
        size: Number.MAX_SAFE_INTEGER,
        objectIdentity: "\\".repeat(256),
        managedToken: catalog.managedToken,
      };
      const created = database.createDelivery("wide-live-current", liveInput);
      expect(created.created).toBe(true);
      expect(database.getDelivery(created.record.id)).toEqual(created.record);
      expect(deliveryCount(database, catalog.profileId, true)).toBeLessThanOrEqual(startupCount);
      expect(database.serializeMatchIndex(catalog.profileId).byteLength).toBeLessThanOrEqual(
        MAX_MATCH_INDEX_RESPONSE_BYTES,
      );
      expect(database.createDelivery("wide-live-current", liveInput)).toEqual({
        record: created.record,
        created: false,
      });
    } finally {
      database.close();
    }
  }, 30_000);

  it("heals newly visible byte-heavy evidence before enabling a disabled profile", async () => {
    const filename = await temporaryDatabasePath();
    const catalog = createCatalog(filename);
    try {
      catalog.database.updateProfile(catalog.profileId, { enabled: false });
      seedWideDelivered(catalog.database, {
        ...catalog,
        count: 4_800,
        prefix: "disabled-wide",
        fillCharacter: "\u0001",
      });
      expect(deliveryCount(catalog.database, catalog.profileId, true)).toBe(4_800);

      const enabled = catalog.database.updateProfile(catalog.profileId, { enabled: true });
      expect(enabled.enabled).toBe(true);
      expect(deliveryCount(catalog.database, catalog.profileId, true)).toBeLessThan(4_800);
      expect(catalog.database.serializeMatchIndex(catalog.profileId).byteLength).toBeLessThanOrEqual(
        MAX_MATCH_INDEX_RESPONSE_BYTES,
      );
      expect(
        catalog.database.database.prepare("SELECT id FROM deliveries WHERE id = ?").get("disabled-wide-id-000000"),
      ).toBe(undefined);
      expect(
        catalog.database.database.prepare("SELECT id FROM deliveries WHERE id = ?").get("disabled-wide-id-004799"),
      ).toEqual({ id: "disabled-wide-id-004799" });
    } finally {
      catalog.database.close();
    }
  }, 30_000);

  it("lazily compacts evidence reactivated by a normal source-hash reversion", async () => {
    const filename = await temporaryDatabasePath();
    const catalog = createCatalog(filename);
    try {
      expect(replaceCatalogVersion(catalog.database, catalog.rootId, "b".repeat(64), "replacement")).toBe(
        catalog.bookId,
      );
      const replacementToken = catalog.database.getMatchIndex(catalog.profileId).entries[0]!.managedToken;
      expect(replacementToken).not.toBe(catalog.managedToken);
      seedWideDelivered(catalog.database, {
        ...catalog,
        count: 4_800,
        prefix: "reverted-wide",
        fillCharacter: "\u0001",
      });
      expect(catalog.database.getMatchIndex(catalog.profileId).entries[0]?.deliveries).toEqual([]);

      expect(replaceCatalogVersion(catalog.database, catalog.rootId, "a".repeat(64), "reverted")).toBe(
        catalog.bookId,
      );
      const body = catalog.database.serializeMatchIndex(catalog.profileId);
      const parsed = JSON.parse(body.toString("utf8")) as {
        entries: Array<{ deliveries: Array<{ managedToken: string }> }>;
      };
      expect(body.byteLength).toBeLessThanOrEqual(MAX_MATCH_INDEX_RESPONSE_BYTES);
      expect(parsed.entries[0]?.deliveries.length).toBeLessThan(4_800);
      expect(parsed.entries[0]?.deliveries.every((delivery) => delivery.managedToken === catalog.managedToken)).toBe(
        true,
      );
      expect(
        catalog.database.database.prepare("SELECT id FROM deliveries WHERE id = ?").get("reverted-wide-id-000000"),
      ).toBe(undefined);
      expect(
        catalog.database.database.prepare("SELECT id FROM deliveries WHERE id = ?").get("reverted-wide-id-004799"),
      ).toEqual({ id: "reverted-wide-id-004799" });
    } finally {
      catalog.database.close();
    }
  }, 30_000);

  it("persists the one-time legacy maintenance marker across a second open", async () => {
    const filename = await temporaryDatabasePath();
    const catalog = createCatalog(filename);
    const marker = catalog.database.database
      .prepare("SELECT key, completed_at FROM catalog_maintenance_markers")
      .get() as { key: string; completed_at: string };
    catalog.database.close();

    const reopened = new CatalogDatabase(filename);
    try {
      expect(reopened.database.prepare("SELECT key, completed_at FROM catalog_maintenance_markers").get()).toEqual(
        marker,
      );
    } finally {
      reopened.close();
    }
  });

  it("excludes unmapped and old-token rows from preflight and reopens disabled profiles safely", async () => {
    const filename = await temporaryDatabasePath();
    const catalog = createCatalog(filename);
    insertRawDelivery(catalog.database, {
      id: "unmapped-delivery",
      profileId: catalog.profileId,
      bookId: "missing-book",
      managedToken: catalog.managedToken,
    });
    const staleManagedToken = "€".repeat(256);
    seedWideDelivered(catalog.database, {
      ...catalog,
      managedToken: staleManagedToken,
      count: 8_000,
      prefix: "old-token-wide",
      fillCharacter: "€",
    });
    const staleRawBytes = Number(
      (
        catalog.database.database
          .prepare(
            `SELECT coalesce(sum(
               length(CAST(device_key AS BLOB))
               + coalesce(length(CAST(artifact_hash AS BLOB)), 0)
               + coalesce(length(CAST(filename AS BLOB)), 0)
               + coalesce(length(CAST(object_persistent_id AS BLOB)), 0)
               + coalesce(length(CAST(managed_token AS BLOB)), 0)
               + length(CAST(status AS BLOB)) + length(CAST(updated_at AS BLOB))
             ), 0) AS bytes
             FROM deliveries WHERE profile_id = ? AND status = 'delivered'`,
          )
          .get(catalog.profileId) as { bytes: number }
      ).bytes,
    );
    expect(staleRawBytes).toBeGreaterThan(MAX_MATCH_INDEX_RESPONSE_BYTES);
    expect(catalog.database.getMatchIndex(catalog.profileId, { maxDeliveries: 0 }).entries[0]?.deliveries).toEqual(
      [],
    );
    expect(catalog.database.serializeMatchIndex(catalog.profileId).byteLength).toBeLessThanOrEqual(
      MAX_MATCH_INDEX_RESPONSE_BYTES,
    );
    catalog.database.updateProfile(catalog.profileId, { enabled: false });
    catalog.database.close();

    const reopened = new CatalogDatabase(filename);
    try {
      expect(reopened.getProfile(catalog.profileId)?.enabled).toBe(false);
      expect(reopened.getDelivery("unmapped-delivery")?.bookId).toBe("missing-book");
      expect(reopened.getDelivery("old-token-wide-id-007999")?.managedToken).toBe(staleManagedToken);
    } finally {
      reopened.close();
    }
  }, 30_000);

  it("separately caps non-delivered attempts without disturbing delivered controller evidence", async () => {
    const filename = await temporaryDatabasePath();
    const catalog = createCatalog(filename);
    try {
      const controllerDelivery = catalog.database.createDelivery(
        "controller-delivered",
        newestDeliveredInput(catalog.profileId, catalog.bookId, catalog.managedToken),
      ).record;
      seedDeliveries(catalog.database, {
        ...catalog,
        count: MAX_NON_DELIVERED_DELIVERIES_PER_PROFILE,
        prefix: "attempt",
        statuses: ["queued", "converting", "sending", "failed"],
      });

      const failedInput: DeliveryInput = {
        profileId: catalog.profileId,
        bookId: catalog.bookId,
        deviceKey: "newest-failed-device",
        status: "failed",
      };
      const created = catalog.database.createDelivery("newest-failed", failedInput);
      expect(created.created).toBe(true);
      expect(deliveryCount(catalog.database, catalog.profileId, false)).toBe(
        MAX_NON_DELIVERED_DELIVERIES_PER_PROFILE,
      );
      expect(catalog.database.getDelivery(created.record.id)).toEqual(created.record);
      expect(catalog.database.database.prepare("SELECT id FROM deliveries WHERE id = ?").get("attempt-id-000000")).toBe(
        undefined,
      );
      expect(catalog.database.database.prepare("SELECT id FROM deliveries WHERE id = ?").get("attempt-id-000001")).toEqual({
        id: "attempt-id-000001",
      });
      expect(catalog.database.getDelivery(controllerDelivery.id)).toEqual(controllerDelivery);
      expect(deliveryCount(catalog.database, catalog.profileId, true)).toBe(1);

      const replay = catalog.database.createDelivery("newest-failed", failedInput);
      expect(replay).toEqual({ record: created.record, created: false });
      expect(deliveryCount(catalog.database, catalog.profileId, false)).toBe(
        MAX_NON_DELIVERED_DELIVERIES_PER_PROFILE,
      );
      const matchIndex = JSON.parse(catalog.database.serializeMatchIndex(catalog.profileId).toString("utf8")) as {
        entries: Array<{ deliveries: Array<{ deviceKey: string }> }>;
      };
      expect(matchIndex.entries[0]?.deliveries.map((delivery) => delivery.deviceKey)).toEqual(["newest-device"]);
    } finally {
      catalog.database.close();
    }
  }, 20_000);
});
