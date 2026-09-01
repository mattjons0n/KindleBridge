import { mkdir } from "node:fs/promises";
import path from "node:path";

import { CatalogDatabase } from "./catalog-database.js";
import { CatalogIndexer, type CatalogIndexerOptions } from "./catalog-indexer.js";
import { CoverCache } from "./cover-cache.js";
import { CatalogEventHub } from "./event-hub.js";
import { CatalogHttpServer, type CatalogHttpOptions } from "./http-server.js";
import { MetadataCoverStore } from "./metadata-cover-store.js";
import { AllowedRootPolicy } from "./root-policy.js";

export interface CatalogServiceConfig {
  databasePath: string;
  cacheDirectory: string;
  /** Durable user-selected cover assets. Defaults beside catalog.sqlite. */
  metadataDirectory?: string;
  allowedRootPaths: string[];
  rootPolicyValidationTimeoutMs?: number;
  http?: Partial<CatalogHttpOptions>;
  scanner?: Partial<CatalogIndexerOptions>;
}

export class CatalogService {
  private started = false;
  private closed = false;
  private startPromise: Promise<{ hostname: string; port: number }> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(
    readonly database: CatalogDatabase,
    readonly indexer: CatalogIndexer,
    readonly http: CatalogHttpServer,
    readonly events: CatalogEventHub,
    readonly metadataCoverStore?: MetadataCoverStore,
  ) {}

  async start(): Promise<{ hostname: string; port: number }> {
    if (this.closed) throw new Error("Catalog service is closed.");
    if (this.started) throw new Error("Catalog service is already started.");
    this.started = true;
    this.startPromise = this.performStart();
    return this.startPromise;
  }

  private async performStart(): Promise<{ hostname: string; port: number }> {
    try {
      const address = await this.http.listen();
      if (this.closed) return address;
      await this.indexer.start();
      if (!this.closed) {
        this.http.setScannerState("ready");
        this.events.publish({ type: "catalog.ready" });
      }
      return address;
    } catch (error) {
      this.started = false;
      // A startup failure must still release every partially initialized
      // resource. It cannot call close(), because close() normally waits for
      // this very startup promise to settle.
      if (!this.closed) {
        this.closed = true;
        this.http.setScannerState("stopped");
        this.http.stopAccepting();
        this.events.close();
        this.closePromise = this.performClose(false);
        await this.closePromise;
      }
      throw error;
    }
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.http.setScannerState("stopped");
      // Stop accepting work and end long-lived SSE responses synchronously,
      // before waiting for the scanner or any in-flight source response.
      this.http.stopAccepting();
      this.events.close();
    }
    this.closePromise ??= this.performClose(true);
    return this.closePromise;
  }

  private async performClose(waitForStartup: boolean): Promise<void> {
    // stop() interrupts the parser pool and then drains active scans. HTTP
    // drains existing handlers independently; SQLite remains available to
    // both until they have settled.
    const failures: unknown[] = [];
    try {
      const scannerStop = this.indexer.stop();
      const httpStop = this.http.close();
      const firstPassPromise = Promise.allSettled([scannerStop, httpStop]);
      if (waitForStartup) await this.startPromise?.catch(() => undefined);
      const firstPass = await firstPassPromise;

      // A stop racing the early awaits inside indexer.start() can precede timer
      // creation. A second idempotent pass after startup settles closes anything
      // that was initialized in that narrow window.
      const finalScannerStop = await Promise.allSettled([this.indexer.stop()]);
      failures.push(
        ...[...firstPass, ...finalScannerStop]
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason),
      );
    } catch (error) {
      failures.push(error);
    } finally {
      // Indexer.stop() returns only after scans have drained or entered forced
      // retirement, whose abort guards prohibit every later SQLite access.
      // Close durable state even when one shutdown participant reported an
      // error, then aggregate rather than leaking the database handle.
      try {
        this.database.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Catalog service did not shut down cleanly.");
  }
}

export async function createCatalogService(
  config: CatalogServiceConfig,
  signal?: AbortSignal,
): Promise<CatalogService> {
  await mkdir(path.dirname(path.resolve(config.databasePath)), { recursive: true, mode: 0o750 });
  await mkdir(path.resolve(config.cacheDirectory), { recursive: true, mode: 0o750 });
  const rootPolicy = await AllowedRootPolicy.create(config.allowedRootPaths, {
    signal,
    timeoutMs: config.rootPolicyValidationTimeoutMs,
  });
  const database = new CatalogDatabase(path.resolve(config.databasePath));
  const coverCache = new CoverCache(path.resolve(config.cacheDirectory));
  const metadataCoverStore = new MetadataCoverStore(
    path.resolve(config.metadataDirectory ?? path.dirname(config.databasePath)),
  );
  await metadataCoverStore.initialize();
  database.pruneUnreferencedMetadataCoverAssetRows();
  await metadataCoverStore.pruneOrphans(database.referencedMetadataCoverKeys());
  const events = new CatalogEventHub();
  const indexer = new CatalogIndexer(
    database,
    rootPolicy,
    coverCache,
    (event) => events.publish(event),
    config.scanner,
  );
  const http = new CatalogHttpServer(
    database,
    indexer,
    rootPolicy,
    coverCache,
    events,
    config.http,
    metadataCoverStore,
  );
  indexer.setOperationalStateHandler((component, state) => http.setOperationalState(component, state));
  return new CatalogService(database, indexer, http, events, metadataCoverStore);
}

export async function startCatalogService(
  config: CatalogServiceConfig,
): Promise<{ service: CatalogService; address: { hostname: string; port: number } }> {
  const service = await createCatalogService(config);
  const address = await service.start();
  return { service, address };
}
