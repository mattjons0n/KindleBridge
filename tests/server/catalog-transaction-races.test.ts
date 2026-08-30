import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import { CatalogDatabase, StaleCatalogScanError } from "../../server/catalog-database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

async function databaseFixture(): Promise<{ database: CatalogDatabase; filename: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "kindle-catalog-race-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "catalog.sqlite");
  return { database: new CatalogDatabase(filename), filename };
}

interface ConcurrentStatement {
  sql: string;
  parameters?: Array<string | number | null>;
}

/**
 * Hold an uncommitted write in a second SQLite connection. The catalog
 * connection is instrumented only to notify that writer immediately before
 * its next BEGIN IMMEDIATE, making pre-lock stale reads deterministic without
 * timers or production hooks.
 */
async function withConcurrentCommit<T>(
  database: CatalogDatabase,
  filename: string,
  statements: ConcurrentStatement[],
  operation: () => T,
): Promise<T> {
  const commitSignal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const worker = new Worker(
    `
      const { DatabaseSync } = require("node:sqlite");
      const { parentPort, workerData } = require("node:worker_threads");
      const signal = new Int32Array(workerData.commitSignal);
      const database = new DatabaseSync(workerData.filename);
      try {
        database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
        for (const statement of workerData.statements) {
          database.prepare(statement.sql).run(...(statement.parameters ?? []));
        }
        parentPort.postMessage({ type: "ready" });
        if (Atomics.wait(signal, 0, 0, 5000) === "timed-out") {
          throw new Error("Catalog race test did not reach its writer transaction.");
        }
        database.exec("COMMIT");
        database.close();
        parentPort.postMessage({ type: "committed" });
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        try { database.close(); } catch {}
        parentPort.postMessage({ type: "error", message: String(error) });
      }
    `,
    { eval: true, workerData: { filename, statements, commitSignal } },
  );

  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let committedResolve!: () => void;
  let committedReject!: (error: Error) => void;
  const committed = new Promise<void>((resolve, reject) => {
    committedResolve = resolve;
    committedReject = reject;
  });
  worker.on("message", (message: { type?: string; message?: string }) => {
    if (message.type === "ready") readyResolve();
    if (message.type === "committed") committedResolve();
    if (message.type === "error") {
      const error = new Error(message.message ?? "Concurrent catalog writer failed.");
      readyReject(error);
      committedReject(error);
    }
  });
  worker.on("error", (error) => {
    const workerError = error instanceof Error ? error : new Error(String(error));
    readyReject(workerError);
    committedReject(workerError);
  });

  await ready;
  const originalExec = database.database.exec.bind(database.database);
  let writerReleased = false;
  database.database.exec = (sql: string): void => {
    if (!writerReleased && sql.trim().toLocaleUpperCase() === "BEGIN IMMEDIATE") {
      writerReleased = true;
      Atomics.store(new Int32Array(commitSignal), 0, 1);
      Atomics.notify(new Int32Array(commitSignal), 0);
    }
    originalExec(sql);
  };

  let result: T | undefined;
  let operationError: unknown;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  } finally {
    database.database.exec = originalExec;
    if (!writerReleased) {
      Atomics.store(new Int32Array(commitSignal), 0, 1);
      Atomics.notify(new Int32Array(commitSignal), 0);
    }
    await committed;
    await worker.terminate();
  }
  if (operationError !== undefined) throw operationError;
  return result as T;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

describe("catalog writer-lock invariants", () => {
  it("rechecks a configuration replay after taking the writer lock", async () => {
    const { database, filename } = await databaseFixture();
    try {
      const idempotencyKey = "concurrent-profile-create";
      const input = { profile: { name: "Concurrent profile" }, roots: [] };
      const requestHash = createHash("sha256")
        .update(stableJson({ operationScope: "profile_create", profileId: null, input }))
        .digest("hex");
      const timestamp = "2026-08-30T00:00:00.000Z";

      const replay = await withConcurrentCommit(
        database,
        filename,
        [
          {
            sql: `INSERT INTO profiles(id, name, enabled, created_at, updated_at)
                  VALUES (?, ?, 1, ?, ?)`,
            parameters: ["prf_concurrent01", "Concurrent profile", timestamp, timestamp],
          },
          {
            sql: `INSERT INTO configuration_writes(idempotency_key, request_hash, profile_id, created_at)
                  VALUES (?, ?, ?, ?)`,
            parameters: [idempotencyKey, requestHash, "prf_concurrent01", timestamp],
          },
        ],
        () => database.createProfileIdempotent(input.profile, idempotencyKey),
      );

      expect(replay).toMatchObject({ created: false, profile: { id: "prf_concurrent01" } });
      expect(database.listProfiles()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("rechecks profile and direct-root state after waiting for another writer", async () => {
    const { database, filename } = await databaseFixture();
    try {
      const owner = database.createProfile({ name: "Owner" });
      const other = database.createProfile({ name: "Other" });
      const timestamp = "2026-08-30T00:00:00.000Z";

      const updated = await withConcurrentCommit(
        database,
        filename,
        [{
          sql: "UPDATE profiles SET enabled = 0, updated_at = ? WHERE id = ?",
          parameters: [timestamp, owner.id],
        }],
        () => database.updateProfile(owner.id, { name: "Renamed owner" }),
      );
      expect(updated).toMatchObject({ name: "Renamed owner", enabled: false });

      await expect(withConcurrentCommit(
        database,
        filename,
        [
          {
            sql: `INSERT INTO library_roots(id, path, created_at, updated_at)
                  VALUES (?, ?, ?, ?)`,
            parameters: ["root_concurrent01", "/libraries/outer", timestamp, timestamp],
          },
          {
            sql: `INSERT INTO profile_roots(profile_id, root_id, label, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?)`,
            parameters: [other.id, "root_concurrent01", "Outer", timestamp, timestamp],
          },
        ],
        () => database.createRoot(owner.id, { label: "Nested", path: "/libraries/outer/nested" }),
      )).rejects.toMatchObject({ code: "conflict" });
      expect(database.listRoots()).toEqual([
        expect.objectContaining({ id: "root_concurrent01", path: "/libraries/outer" }),
      ]);
    } finally {
      database.close();
    }
  });

  it("does not mutate scan settings after a root becomes shared while waiting for the lock", async () => {
    const { database, filename } = await databaseFixture();
    try {
      const owner = database.createProfile({ name: "Owner" });
      const other = database.createProfile({ name: "Other" });
      const root = database.createRoot(owner.id, { label: "Owned", path: "/libraries/owned" });
      const timestamp = "2026-08-30T00:00:00.000Z";

      await expect(withConcurrentCommit(
        database,
        filename,
        [{
          sql: `INSERT INTO profile_roots(profile_id, root_id, label, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)`,
          parameters: [other.id, root.id, "Shared", timestamp, timestamp],
        }],
        () => database.updateRoot(owner.id, root.id, { path: "/libraries/moved" }),
      )).rejects.toMatchObject({ code: "conflict" });
      expect(database.getRoot(owner.id, root.id)?.path).toBe("/libraries/owned");
      expect(database.getRoot(other.id, root.id)?.path).toBe("/libraries/owned");
    } finally {
      database.close();
    }
  });

  it("recomputes removable roots before an atomic Settings replacement", async () => {
    const { database, filename } = await databaseFixture();
    try {
      const owner = database.createProfile({ name: "Owner" });
      const other = database.createProfile({ name: "Other" });
      const root = database.createRoot(owner.id, { label: "Outer", path: "/libraries/outer" });
      const timestamp = "2026-08-30T00:00:00.000Z";

      await expect(withConcurrentCommit(
        database,
        filename,
        [{
          sql: `INSERT INTO profile_roots(profile_id, root_id, label, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)`,
          parameters: [other.id, root.id, "Shared outer", timestamp, timestamp],
        }],
        () => database.applyProfileConfiguration(
          owner.id,
          {
            profile: { name: owner.name },
            roots: [{ label: "Nested", path: "/libraries/outer/nested" }],
          },
          "concurrent-settings",
        ),
      )).rejects.toMatchObject({ code: "conflict" });
      expect(database.listRoots(other.id)).toEqual([
        expect.objectContaining({ id: root.id, path: "/libraries/outer" }),
      ]);
      expect(database.listRoots(owner.id)).toEqual([
        expect.objectContaining({ id: root.id, path: "/libraries/outer" }),
      ]);
    } finally {
      database.close();
    }
  });

  it("transactionally fences every old scan mutation after another connection changes configuration", async () => {
    const { database, filename } = await databaseFixture();
    const other = new CatalogDatabase(filename);
    try {
      const profile = database.createProfile({ name: "Generation fence" });
      const created = database.createRootWithEffects(profile.id, {
        label: "Books",
        path: "/libraries/fence-before",
        watch: false,
      });
      const fence = { rootId: created.root.id, generation: 1 };

      const changed = other.updateRootWithEffects(profile.id, created.root.id, {
        path: "/libraries/fence-after",
      });
      expect(changed.scanReason).toBe("manual");
      expect(database.rootScanRequest(created.root.id)).toEqual({ generation: 2, reason: "manual" });

      const oldFile = {
        rootId: created.root.id,
        relativePath: "old.epub",
        format: "epub" as const,
        size: 3,
        mtimeMs: 1,
        contentHash: "a".repeat(64),
        scanToken: "old-generation",
        metadata: {
          title: "Old generation",
          authors: [],
          authorSort: null,
          language: null,
          publisher: null,
          publishedAt: null,
          series: null,
          subjects: [],
          identifiers: [],
          metadataComplete: true,
          coverKey: null,
          coverMediaType: null,
        },
      };
      expect(() => database.upsertCatalogFile(oldFile, fence)).toThrow(StaleCatalogScanError);
      expect(() => database.recordSourceError({
        ...oldFile,
        errorCode: "old_error",
      }, fence)).toThrow(StaleCatalogScanError);
      expect(() => database.touchSource("missing-old-source", "old-generation", undefined, fence))
        .toThrow(StaleCatalogScanError);
      expect(() => database.completeRootScan(created.root.id, "old-generation", 0, fence))
        .toThrow(StaleCatalogScanError);
      expect(() => database.noteRootUnavailable(created.root.id, fence)).toThrow(StaleCatalogScanError);
      expect(() => database.setRootStatus(created.root.id, "error", "old_error", true, fence))
        .toThrow(StaleCatalogScanError);
      expect(() => database.acknowledgeRootScan(created.root.id, 1, true, fence))
        .toThrow(StaleCatalogScanError);

      expect(database.database.prepare("SELECT count(*) AS count FROM source_files").get()).toEqual({ count: 0 });
      expect(database.rootScanRequest(created.root.id)).toEqual({ generation: 2, reason: "manual" });
      expect(database.getRoot(profile.id, created.root.id)).toMatchObject({
        path: "/libraries/fence-after",
        status: "pending",
      });
    } finally {
      other.close();
      database.close();
    }
  });

  it("gives concurrent service claims distinct monotonic fences across acknowledgement", async () => {
    const { database, filename } = await databaseFixture();
    const other = new CatalogDatabase(filename);
    try {
      const profile = database.createProfile({ name: "Monotonic claim" });
      const root = database.createRootWithEffects(profile.id, {
        label: "Books",
        path: "/libraries/monotonic-claim",
        watch: false,
      }).root;

      const firstClaim = database.claimRootScan(root.id)!;
      const secondClaim = other.claimRootScan(root.id)!;
      expect(firstClaim).toEqual({ generation: 2, reason: "manual" });
      expect(secondClaim).toEqual({ generation: 3, reason: "manual" });
      expect(() => database.setRootStatus(
        root.id,
        "available",
        null,
        true,
        { rootId: root.id, generation: firstClaim.generation },
      )).toThrow(StaleCatalogScanError);

      const winningFence = { rootId: root.id, generation: secondClaim.generation };
      other.setRootStatus(root.id, "available", null, true, winningFence);
      other.acknowledgeRootScan(root.id, secondClaim.generation, false, winningFence);
      expect(database.rootScanRequest(root.id)).toBeNull();
      expect(database.database.prepare(
        "SELECT generation, pending FROM scan_requests WHERE root_id = ?",
      ).get(root.id)).toEqual({ generation: 3, pending: 0 });

      other.updateRootWithEffects(profile.id, root.id, { watch: true });
      expect(database.rootScanRequest(root.id)).toEqual({ generation: 4, reason: "configuration" });
      expect(() => database.setRootStatus(
        root.id,
        "error",
        "aba",
        true,
        { rootId: root.id, generation: firstClaim.generation },
      )).toThrow(StaleCatalogScanError);
    } finally {
      other.close();
      database.close();
    }
  });
});
