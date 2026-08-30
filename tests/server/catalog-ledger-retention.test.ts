import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CatalogDatabase } from "../../server/catalog-database.js";
import {
  CATALOG_SCHEMA_VERSION,
  MAX_CONFIGURATION_WRITES_PER_PROFILE,
} from "../../server/migrations.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "kindle-ledger-retention-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "catalog.sqlite");
}

function seedConfigurationWrites(database: CatalogDatabase, profileId: string, count: number, prefix: string): void {
  const insert = database.database.prepare(
    `INSERT INTO configuration_writes(idempotency_key, request_hash, profile_id, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  database.database.exec("BEGIN IMMEDIATE");
  try {
    for (let index = 0; index < count; index += 1) {
      const sequence = index.toString().padStart(6, "0");
      insert.run(
        `${prefix}-${sequence}`,
        `${prefix}-hash-${sequence}`,
        profileId,
        "2025-01-01T00:00:00.000Z",
      );
    }
    database.database.exec("COMMIT");
  } catch (error) {
    database.database.exec("ROLLBACK");
    throw error;
  }
}

function configurationWriteCount(database: CatalogDatabase, profileId: string): number {
  return Number(
    (
      database.database
        .prepare("SELECT count(*) AS count FROM configuration_writes WHERE profile_id = ?")
        .get(profileId) as { count: number }
    ).count,
  );
}

describe("durable idempotency-ledger retention", () => {
  it("retains a deterministic bounded configuration replay window including the current request", async () => {
    const filename = await databasePath();
    const database = new CatalogDatabase(filename);
    try {
      const profile = database.createProfile({ name: "Before" });
      seedConfigurationWrites(database, profile.id, MAX_CONFIGURATION_WRITES_PER_PROFILE, "config-seed");
      const input = { profile: { name: "After" }, roots: [] };

      const created = database.applyProfileConfiguration(profile.id, input, "config-current");
      expect(created.configuration.profile.name).toBe("After");
      expect(created.applied).toBe(true);
      expect(configurationWriteCount(database, profile.id)).toBe(MAX_CONFIGURATION_WRITES_PER_PROFILE);
      expect(
        database.database
          .prepare("SELECT idempotency_key FROM configuration_writes WHERE idempotency_key = ?")
          .get("config-seed-000000"),
      ).toBe(undefined);
      expect(
        database.database
          .prepare("SELECT idempotency_key FROM configuration_writes WHERE idempotency_key = ?")
          .get("config-seed-000001"),
      ).toEqual({ idempotency_key: "config-seed-000001" });
      expect(
        database.database
          .prepare("SELECT idempotency_key FROM configuration_writes WHERE idempotency_key = ?")
          .get("config-current"),
      ).toEqual({ idempotency_key: "config-current" });

      const replay = database.applyProfileConfiguration(profile.id, input, "config-current");
      expect(replay.configuration.profile.id).toBe(created.configuration.profile.id);
      expect(replay.applied).toBe(false);
      expect(configurationWriteCount(database, profile.id)).toBe(MAX_CONFIGURATION_WRITES_PER_PROFILE);
      expect(() =>
        database.applyProfileConfiguration(
          profile.id,
          { profile: { name: "Conflicting replay" }, roots: [] },
          "config-current",
        ),
      ).toThrow(expect.objectContaining({ code: "conflict" }));
    } finally {
      database.close();
    }
  });

  it("commits scan intent with configuration and does not advance it on replay", async () => {
    const filename = await databasePath();
    let database = new CatalogDatabase(filename);
    const created = database.applyProfileConfiguration(
      null,
      {
        profile: { name: "Durable scan" },
        roots: [{ label: "Books", path: "/libraries/durable-scan", watch: false }],
      },
      "durable-scan-config",
    );
    const rootId = created.configuration.roots[0]!.id;
    expect(created.applied).toBe(true);
    expect(database.rootScanRequest(rootId)).toEqual({ generation: 1, reason: "manual" });

    const replay = database.applyProfileConfiguration(
      null,
      {
        profile: { name: "Durable scan" },
        roots: [{ label: "Books", path: "/libraries/durable-scan", watch: false }],
      },
      "durable-scan-config",
    );
    expect(replay.applied).toBe(false);
    expect(database.rootScanRequest(rootId)).toEqual({ generation: 1, reason: "manual" });

    database.close();
    database = new CatalogDatabase(filename);
    try {
      expect(database.pendingRootScanIds()).toEqual([rootId]);
      expect(database.rootScanRequest(rootId)).toEqual({ generation: 1, reason: "manual" });
    } finally {
      database.close();
    }
  });

  it("queues only scan-affecting configuration roots and coalesces pending work", async () => {
    const filename = await databasePath();
    const database = new CatalogDatabase(filename);
    try {
      const initial = database.applyProfileConfiguration(
        null,
        {
          profile: { name: "Selective scans" },
          roots: [
            { label: "One", path: "/libraries/selective-one", watch: false },
            { label: "Two", path: "/libraries/selective-two", watch: false },
          ],
        },
        "selective-initial",
      );
      const [first, second] = initial.configuration.roots;
      database.acknowledgeRootScan(first!.id, 1);
      database.acknowledgeRootScan(second!.id, 1);

      const displayOnly = database.applyProfileConfiguration(
        initial.configuration.profile.id,
        {
          profile: { name: "Selective scans", description: "Display-only edit" },
          roots: [
            { id: first!.id, label: "One renamed", path: first!.path, watch: false },
            { id: second!.id, label: "Two", path: second!.path, watch: false },
          ],
        },
        "selective-display",
      );
      expect(displayOnly.applied).toBe(true);
      expect(database.pendingRootScanIds()).toEqual([]);

      const changed = database.applyProfileConfiguration(
        initial.configuration.profile.id,
        {
          profile: { name: "Selective scans", description: "Display-only edit" },
          roots: [
            { id: first!.id, label: "One renamed", path: first!.path, watch: true },
            { id: second!.id, label: "Two", path: second!.path, watch: false },
          ],
        },
        "selective-change",
      );
      expect(changed.applied).toBe(true);
      expect(database.pendingRootScanIds()).toEqual([first!.id]);
      expect(database.rootScanRequest(first!.id)).toEqual({ generation: 2, reason: "configuration" });
      expect(database.rootScanRequest(second!.id)).toBeNull();

      const movedInput = {
        profile: { name: "Selective scans", description: "Display-only edit" },
        roots: [
          { id: first!.id, label: "One renamed", path: "/libraries/selective-one-moved", watch: true },
          { id: second!.id, label: "Two", path: second!.path, watch: false },
        ],
      };
      const moved = database.applyProfileConfiguration(
        initial.configuration.profile.id,
        movedInput,
        "selective-move",
      );
      expect(moved.applied).toBe(true);
      expect(database.rootScanRequest(first!.id)).toEqual({ generation: 3, reason: "manual" });
      expect(database.rootScanRequest(second!.id)).toBeNull();
      expect(
        database.applyProfileConfiguration(initial.configuration.profile.id, movedInput, "selective-move").applied,
      ).toBe(false);
      expect(database.rootScanRequest(first!.id)).toEqual({ generation: 3, reason: "manual" });
    } finally {
      database.close();
    }
  });

  it("reports scan effects only for enabling and scan-option direct patches", async () => {
    const filename = await databasePath();
    const database = new CatalogDatabase(filename);
    try {
      const profile = database.createProfile({ name: "Direct effects" });
      const root = database.createRoot(profile.id, {
        label: "Books",
        path: "/libraries/direct-effects",
        watch: false,
      });
      expect(database.updateProfileWithEffects(profile.id, { description: "Display only" }).scanRootIds).toEqual([]);
      expect(database.updateRootWithEffects(profile.id, root.id, { label: "Renamed" }).scanReason).toBeNull();
      expect(database.updateRootWithEffects(profile.id, root.id, { watch: true }).scanReason).toBe("configuration");
      expect(database.rootScanRequest(root.id)).toEqual({ generation: 1, reason: "configuration" });
      database.updateProfile(profile.id, { enabled: false });
      expect(database.updateRootWithEffects(profile.id, root.id, { watch: false }).scanReason).toBeNull();
      expect(database.updateProfileWithEffects(profile.id, { enabled: true }).scanRootIds).toEqual([root.id]);
      expect(database.rootScanRequest(root.id)).toEqual({ generation: 3, reason: "manual" });
    } finally {
      database.close();
    }
  });

  it("atomically commits direct-route scan intent and rolls back state when the outbox write fails", async () => {
    const filename = await databasePath();
    let database = new CatalogDatabase(filename);
    const profile = database.createProfile({ name: "Direct outbox" });
    database.database.exec(`
      CREATE TRIGGER block_direct_scan_intent
      BEFORE INSERT ON scan_requests
      BEGIN
        SELECT RAISE(ABORT, 'direct scan intent blocked');
      END;
    `);
    expect(() =>
      database.createRootWithEffects(profile.id, {
        label: "Blocked",
        path: "/libraries/direct-outbox",
        watch: false,
      }),
    ).toThrow(/direct scan intent blocked/u);
    expect(database.listRoots(profile.id)).toEqual([]);

    database.database.exec("DROP TRIGGER block_direct_scan_intent");
    const created = database.createRootWithEffects(profile.id, {
      label: "Committed",
      path: "/libraries/direct-outbox",
      watch: false,
    });
    expect(created.scanQueued).toBe(true);
    expect(database.rootScanRequest(created.root.id)).toEqual({ generation: 1, reason: "manual" });

    database.database.exec(`
      CREATE TRIGGER block_direct_scan_update
      BEFORE UPDATE ON scan_requests
      BEGIN
        SELECT RAISE(ABORT, 'direct scan update blocked');
      END;
    `);
    expect(() => database.updateRootWithEffects(profile.id, created.root.id, { watch: true }))
      .toThrow(/direct scan update blocked/u);
    expect(database.getRoot(profile.id, created.root.id)?.watch).toBe(false);
    database.updateProfile(profile.id, { enabled: false });
    expect(() => database.updateProfileWithEffects(profile.id, { enabled: true }))
      .toThrow(/direct scan update blocked/u);
    expect(database.getProfile(profile.id)?.enabled).toBe(false);
    database.database.exec("DROP TRIGGER block_direct_scan_update");

    database.close();
    database = new CatalogDatabase(filename);
    try {
      expect(database.pendingRootScanIds()).toEqual([created.root.id]);
      expect(database.listRoots(profile.id)).toEqual([expect.objectContaining({ id: created.root.id })]);
    } finally {
      database.close();
    }
  });

  it("rolls back the configuration mutation and insertion when retention pruning fails", async () => {
    const filename = await databasePath();
    const database = new CatalogDatabase(filename);
    try {
      const profile = database.createProfile({ name: "Rollback before" });
      seedConfigurationWrites(database, profile.id, MAX_CONFIGURATION_WRITES_PER_PROFILE, "rollback-seed");
      database.database.exec(`
        CREATE TRIGGER block_configuration_prune
        BEFORE DELETE ON configuration_writes
        BEGIN
          SELECT RAISE(ABORT, 'configuration prune blocked');
        END;
      `);

      expect(() =>
        database.applyProfileConfiguration(
          profile.id,
          { profile: { name: "Should roll back" }, roots: [] },
          "rollback-current",
        ),
      ).toThrow(/configuration prune blocked/u);
      expect(database.getProfile(profile.id)?.name).toBe("Rollback before");
      expect(configurationWriteCount(database, profile.id)).toBe(MAX_CONFIGURATION_WRITES_PER_PROFILE);
      expect(
        database.database
          .prepare("SELECT idempotency_key FROM configuration_writes WHERE idempotency_key = ?")
          .get("rollback-current"),
      ).toBe(undefined);
      expect(
        database.database
          .prepare("SELECT idempotency_key FROM configuration_writes WHERE idempotency_key = ?")
          .get("rollback-seed-000000"),
      ).toEqual({ idempotency_key: "rollback-seed-000000" });

      database.database.exec("DROP TRIGGER block_configuration_prune");
      expect(
        database.applyProfileConfiguration(
          profile.id,
          { profile: { name: "Committed" }, roots: [] },
          "rollback-current",
        ).configuration.profile.name,
      ).toBe("Committed");
    } finally {
      database.close();
    }
  });

  it("normalizes legacy configuration overflow and strips stored delivery result payloads on upgrade", async () => {
    const filename = await databasePath();
    const legacy = new CatalogDatabase(filename);
    const profile = legacy.createProfile({ name: "Legacy" });
    seedConfigurationWrites(
      legacy,
      profile.id,
      MAX_CONFIGURATION_WRITES_PER_PROFILE + 1,
      "legacy-config",
    );
    legacy.database
      .prepare(
        `INSERT INTO deliveries(
           id, idempotency_key, request_hash, profile_id, book_id, device_key, status,
           result_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)`,
      )
      .run(
        "legacy-delivery",
        "legacy-delivery-key",
        "legacy-delivery-hash",
        profile.id,
        "legacy-book",
        "legacy-device",
        JSON.stringify({ payload: "x".repeat(2 * 1024 * 1024) }),
        "2025-01-01T00:00:00.000Z",
        "2025-01-01T00:00:00.000Z",
      );
    legacy.database.prepare("DELETE FROM schema_migrations WHERE version = 11").run();
    legacy.close();

    const upgraded = new CatalogDatabase(filename);
    try {
      expect(upgraded.schemaVersion).toBe(CATALOG_SCHEMA_VERSION);
      expect(configurationWriteCount(upgraded, profile.id)).toBe(MAX_CONFIGURATION_WRITES_PER_PROFILE);
      expect(
        upgraded.database
          .prepare("SELECT idempotency_key FROM configuration_writes WHERE idempotency_key = ?")
          .get("legacy-config-000000"),
      ).toBe(undefined);
      expect(
        upgraded.database
          .prepare("SELECT idempotency_key FROM configuration_writes WHERE idempotency_key = ?")
          .get("legacy-config-000001"),
      ).toEqual({ idempotency_key: "legacy-config-000001" });
      expect(upgraded.database.prepare("SELECT result_json FROM deliveries WHERE id = ?").get("legacy-delivery")).toEqual({
        result_json: null,
      });
      expect(upgraded.getDelivery("legacy-delivery")).not.toHaveProperty("result");
    } finally {
      upgraded.close();
    }
  });

  it("scopes direct profile-create replay keys away from configuration operations", async () => {
    const filename = await databasePath();
    const database = new CatalogDatabase(filename);
    try {
      const first = database.createProfileIdempotent({ name: "Direct" }, "profile-create-key");
      const replay = database.createProfileIdempotent({ name: "Direct" }, "profile-create-key");
      expect(first.created).toBe(true);
      expect(replay).toEqual({ profile: first.profile, created: false });
      expect(database.listProfiles().filter((profile) => profile.name === "Direct")).toHaveLength(1);
      expect(() => database.createProfileIdempotent({ name: "Different" }, "profile-create-key")).toThrow(
        expect.objectContaining({ code: "conflict" }),
      );
      expect(() =>
        database.applyProfileConfiguration(
          null,
          { profile: { name: "Direct" }, roots: [] },
          "profile-create-key",
        ),
      ).toThrow(expect.objectContaining({ code: "conflict" }));
    } finally {
      database.close();
    }
  });
});
