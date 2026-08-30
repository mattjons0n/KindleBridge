import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request as httpRequest, type ClientRequest } from "node:http";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogDatabase } from "../../server/catalog-database.js";
import { CatalogIndexer } from "../../server/catalog-indexer.js";
import { CatalogService } from "../../server/catalog-service.js";
import { CoverCache } from "../../server/cover-cache.js";
import { CatalogEventHub } from "../../server/event-hub.js";
import { CatalogHttpServer } from "../../server/http-server.js";
import { runCatalogMain } from "../../server/main.js";
import { AllowedRootPolicy, type ValidatedRoot } from "../../server/root-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

async function validationFixture(settingsValidationTimeoutMs = 10_000): Promise<{
  database: CatalogDatabase;
  profileId: string;
  rootPolicy: AllowedRootPolicy;
  http: CatalogHttpServer;
  service: CatalogService;
  endpoint: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "kindle-settings-validation-"));
  temporaryDirectories.push(directory);
  const allowed = path.join(directory, "libraries");
  await mkdir(allowed, { recursive: true });
  const database = new CatalogDatabase(path.join(directory, "catalog.sqlite"));
  const profile = database.createProfile({ name: "Validation lifecycle" });
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
    settingsValidationTimeoutMs,
    shutdownDrainTimeoutMs: 5_000,
  });
  const service = new CatalogService(database, indexer, http, events);
  const address = await http.listen();
  return {
    database,
    profileId: profile.id,
    rootPolicy,
    http,
    service,
    endpoint: `http://127.0.0.1:${address.port}/api/profiles/${profile.id}/roots`,
  };
}

function postRoot(endpoint: string, signal?: AbortSignal): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Stalled", path: "/libraries/stalled", watch: false }),
    signal,
  });
}

function startAbandonedRootRequest(endpoint: string): { request: ClientRequest; settled: Promise<void> } {
  const target = new URL(endpoint);
  const body = Buffer.from(JSON.stringify({ label: "Stalled", path: "/libraries/stalled", watch: false }));
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
  const request = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
      },
    },
    (response) => {
      response.resume();
      response.once("end", resolveSettled);
    },
  );
  request.once("error", resolveSettled);
  request.end(body);
  return { request, settled };
}

describe("Settings filesystem-validation lifecycle", () => {
  it("retires a never-settling validation when the request disconnects and ignores late completion", async () => {
    const fixture = await validationFixture();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let resolveValidation!: (value: ValidatedRoot) => void;
    const validation = new Promise<ValidatedRoot>((resolve) => { resolveValidation = resolve; });
    vi.spyOn(fixture.rootPolicy, "validateConfiguredRoot").mockImplementation(() => {
      markStarted();
      return validation;
    });
    const createRoot = vi.spyOn(fixture.database, "createRoot");
    const client = startAbandonedRootRequest(fixture.endpoint);

    try {
      await within(started, 1_000);
      client.request.destroy();
      await within(client.settled, 1_000);
      await waitUntil(
        () => (fixture.http as unknown as { activeRequests: number }).activeRequests === 0,
        1_000,
      );
      expect(createRoot).not.toHaveBeenCalled();
      expect(fixture.database.listRoots(fixture.profileId)).toEqual([]);

      resolveValidation({
        absolutePath: "/libraries/stalled",
        realPath: "/libraries/stalled",
        available: true,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(createRoot).not.toHaveBeenCalled();
      expect(fixture.database.listRoots(fixture.profileId)).toEqual([]);
    } finally {
      resolveValidation({ absolutePath: "/libraries/stalled", realPath: null, available: false });
      await fixture.service.close().catch(() => undefined);
    }
  });

  it("returns a bounded service error when path validation never settles", async () => {
    const fixture = await validationFixture(20);
    vi.spyOn(fixture.rootPolicy, "validateConfiguredRoot").mockImplementation(
      () => new Promise<never>(() => undefined),
    );
    const createRoot = vi.spyOn(fixture.database, "createRoot");

    try {
      const response = await within(postRoot(fixture.endpoint), 1_000);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "path_validation_timeout" } });
      expect(createRoot).not.toHaveBeenCalled();
      expect(fixture.database.listRoots(fixture.profileId)).toEqual([]);
    } finally {
      await fixture.service.close().catch(() => undefined);
    }
  });

  it("aborts mutation validation immediately on shutdown before SQLite closes", async () => {
    const fixture = await validationFixture();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let resolveValidation!: (value: ValidatedRoot) => void;
    const validation = new Promise<ValidatedRoot>((resolve) => { resolveValidation = resolve; });
    vi.spyOn(fixture.rootPolicy, "validateConfiguredRoot").mockImplementation(() => {
      markStarted();
      return validation;
    });
    const createRoot = vi.spyOn(fixture.database, "createRoot");
    const request = postRoot(fixture.endpoint).catch((error: unknown) => error);

    try {
      await within(started, 1_000);
      await within(fixture.service.close(), 1_000);
      expect(createRoot).not.toHaveBeenCalled();
      expect(() => fixture.database.listProfiles()).toThrow();

      resolveValidation({
        absolutePath: "/libraries/stalled",
        realPath: "/libraries/stalled",
        available: true,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(createRoot).not.toHaveBeenCalled();
      await within(request, 1_000);
    } finally {
      resolveValidation({ absolutePath: "/libraries/stalled", realPath: null, available: false });
      await fixture.service.close().catch(() => undefined);
    }
  });
});

describe("catalog construction lifecycle", () => {
  it("lets SIGTERM retire a never-settling service factory", async () => {
    const signals = new EventEmitter();
    let markFactoryStarted!: () => void;
    const factoryStarted = new Promise<void>((resolve) => { markFactoryStarted = resolve; });
    let factorySignal: AbortSignal | undefined;
    const run = runCatalogMain({}, {
      signalSource: signals,
      serviceFactory: async (_config, signal) => {
        factorySignal = signal;
        markFactoryStarted();
        return new Promise<CatalogService>(() => undefined);
      },
      output: { write: () => true },
    });

    await within(factoryStarted, 1_000);
    signals.emit("SIGTERM");
    await within(run, 1_000);
    expect(factorySignal?.aborted).toBe(true);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("closes a service that a cancellation-ignoring factory returns late", async () => {
    const signals = new EventEmitter();
    let markFactoryStarted!: () => void;
    const factoryStarted = new Promise<void>((resolve) => { markFactoryStarted = resolve; });
    let resolveFactory!: (service: CatalogService) => void;
    const factory = new Promise<CatalogService>((resolve) => { resolveFactory = resolve; });
    const close = vi.fn(async () => undefined);
    const lateService = { close } as unknown as CatalogService;
    const run = runCatalogMain({}, {
      signalSource: signals,
      serviceFactory: async () => {
        markFactoryStarted();
        return factory;
      },
      output: { write: () => true },
    });

    await within(factoryStarted, 1_000);
    signals.emit("SIGINT");
    await within(run, 1_000);
    resolveFactory(lateService);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects allowed-root construction immediately when startup is already cancelled", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kindle-policy-cancel-"));
    temporaryDirectories.push(directory);
    const controller = new AbortController();
    controller.abort();
    await expect(
      AllowedRootPolicy.create([directory], { signal: controller.signal, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "path_unavailable" });
  });
});

async function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation exceeded ${timeoutMs} ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition exceeded ${timeoutMs} ms.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
