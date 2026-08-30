import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogDatabase } from "../../server/catalog-database.js";
import { CatalogIndexer } from "../../server/catalog-indexer.js";
import { CoverCache } from "../../server/cover-cache.js";
import { CatalogEventHub } from "../../server/event-hub.js";
import { CatalogHttpServer } from "../../server/http-server.js";
import { AllowedRootPolicy } from "../../server/root-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("catalog HTTP idempotency side effects", () => {
  it("replays presumed lost configuration and delivery responses without duplicate work or events", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-http-replay-"));
    temporaryDirectories.push(directory);
    const allowed = path.join(directory, "libraries");
    const source = path.join(allowed, "books");
    await mkdir(source, { recursive: true });
    const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
    const rootPolicy = await AllowedRootPolicy.create([allowed]);
    const coverCache = new CoverCache(path.join(directory, "cache"));
    await coverCache.initialize();
    const events = new CatalogEventHub();
    const indexer = new CatalogIndexer(database, rootPolicy, coverCache, () => undefined, {
      quietWindowMs: 60_000,
      watcherHints: false,
      reconciliationIntervalMs: 60_000,
    });
    const http = new CatalogHttpServer(database, indexer, rootPolicy, coverCache, events, {
      hostname: "127.0.0.1",
      port: 0,
      allowedHosts: ["127.0.0.1"],
      requireOriginForMutations: false,
    });
    const publish = vi.spyOn(events, "publish");
    const wakePendingScan = vi.spyOn(indexer, "wakePendingScan");

    try {
      const address = await http.listen();
      const base = `http://127.0.0.1:${address.port}`;
      const configurationBody = JSON.stringify({
        profile: { name: "Response replay" },
        roots: [{ label: "Books", path: source, watch: false }],
      });
      const configurationRequest = (): Promise<Response> => fetch(`${base}/api/profiles/configuration`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "presumed-lost-configuration",
        },
        body: configurationBody,
      });

      const firstConfigurationResponse = await configurationRequest();
      expect(firstConfigurationResponse.status).toBe(200);
      const configuration = (await firstConfigurationResponse.json()) as {
        profile: { id: string };
        roots: Array<{ id: string }>;
      };
      const rootId = configuration.roots[0]!.id;
      expect(database.rootScanRequest(rootId)).toEqual({ generation: 1, reason: "manual" });

      const replayConfigurationResponse = await configurationRequest();
      expect(replayConfigurationResponse.status).toBe(200);
      expect(await replayConfigurationResponse.json()).toEqual(configuration);
      expect(database.rootScanRequest(rootId)).toEqual({ generation: 1, reason: "manual" });
      expect(wakePendingScan).toHaveBeenCalledTimes(2);
      expect(
        publish.mock.calls.filter(([event]) => event.type === "profile.created"),
      ).toHaveLength(1);

      const indexed = database.upsertCatalogFile({
        rootId,
        relativePath: "replay.epub",
        format: "epub",
        size: 12,
        mtimeMs: 1,
        contentHash: "a".repeat(64),
        scanToken: "replay-scan",
        metadata: {
          title: "Replay",
          authors: ["Test Author"],
          authorSort: "Author, Test",
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
      const deliveryBody = JSON.stringify({
        profileId: configuration.profile.id,
        bookId: indexed.bookId,
        deviceKey: "device-replay",
        status: "delivered",
      });
      const deliveryRequest = (): Promise<Response> => fetch(`${base}/api/deliveries`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "presumed-lost-delivery",
        },
        body: deliveryBody,
      });

      const firstDeliveryResponse = await deliveryRequest();
      expect(firstDeliveryResponse.status).toBe(201);
      const delivery = await firstDeliveryResponse.json();
      const replayDeliveryResponse = await deliveryRequest();
      expect(replayDeliveryResponse.status).toBe(200);
      expect(await replayDeliveryResponse.json()).toEqual(delivery);
      expect(
        publish.mock.calls.filter(([event]) => event.type === "delivery.updated"),
      ).toHaveLength(1);
    } finally {
      await http.close().catch(() => undefined);
      await indexer.stop().catch(() => undefined);
      events.close();
      database.close();
    }
  });
});
