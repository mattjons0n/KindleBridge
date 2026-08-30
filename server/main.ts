import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createCatalogService, type CatalogService, type CatalogServiceConfig } from "./catalog-service.js";
import { structuredServerLog } from "./logging.js";
import { DEFAULT_ROOT_POLICY_VALIDATION_TIMEOUT_MS } from "./root-policy.js";

export interface CatalogSignalSource {
  once(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  off(event: "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export interface CatalogMainRuntime {
  signalSource?: CatalogSignalSource;
  serviceFactory?: (config: CatalogServiceConfig, signal?: AbortSignal) => Promise<CatalogService>;
  output?: Pick<NodeJS.WriteStream, "write">;
}

export function catalogConfigFromEnvironment(environment: NodeJS.ProcessEnv = process.env): CatalogServiceConfig {
  const port = integerEnvironment(environment.CATALOG_PORT, 8080, 1, 65_535);
  const shutdownTimeoutMs = integerEnvironment(environment.CATALOG_SHUTDOWN_TIMEOUT_MS, 20_000, 1_000, 25_000);
  const hostname = environment.CATALOG_HOST?.trim() || "0.0.0.0";
  const allowedRootPaths = listEnvironment(environment.CATALOG_ALLOWED_ROOTS);
  if (allowedRootPaths.length === 0) allowedRootPaths.push("/library");
  const staticCandidate = path.resolve(environment.CATALOG_STATIC_DIRECTORY?.trim() || "dist/client");
  return {
    databasePath: environment.CATALOG_DATABASE_PATH?.trim() || "/data/catalog.sqlite",
    cacheDirectory: environment.CATALOG_CACHE_DIRECTORY?.trim() || "/cache",
    allowedRootPaths,
    rootPolicyValidationTimeoutMs: integerEnvironment(
      environment.CATALOG_ROOT_POLICY_TIMEOUT_MS,
      DEFAULT_ROOT_POLICY_VALIDATION_TIMEOUT_MS,
      1_000,
      60_000,
    ),
    http: {
      hostname,
      port,
      allowedHosts: listEnvironment(environment.CATALOG_ALLOWED_HOSTS).length
        ? listEnvironment(environment.CATALOG_ALLOWED_HOSTS)
        : [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`],
      allowedOrigins: listEnvironment(environment.CATALOG_ALLOWED_ORIGINS),
      requireOriginForMutations: environment.CATALOG_REQUIRE_ORIGIN !== "false",
      maxJsonBodyBytes: integerEnvironment(environment.CATALOG_MAX_BODY_BYTES, 1024 * 1024, 1_024, 2 * 1024 * 1024),
      maxConcurrentRequests: integerEnvironment(environment.CATALOG_MAX_CONCURRENT, 64, 1, 1_024),
      maxConcurrentSourceStreams: integerEnvironment(environment.CATALOG_MAX_SOURCE_STREAMS, 4, 1, 64),
      sourceResponseTimeoutMs: integerEnvironment(
        environment.CATALOG_SOURCE_RESPONSE_TIMEOUT_MS,
        10 * 60 * 1_000,
        1_000,
        60 * 60 * 1_000,
      ),
      coverResponseTimeoutMs: integerEnvironment(
        environment.CATALOG_COVER_RESPONSE_TIMEOUT_MS,
        30_000,
        1_000,
        5 * 60 * 1_000,
      ),
      requestsPerMinutePerAddress: integerEnvironment(environment.CATALOG_RATE_PER_MINUTE, 600, 1, 100_000),
      settingsValidationTimeoutMs: integerEnvironment(
        environment.CATALOG_SETTINGS_VALIDATION_TIMEOUT_MS,
        10_000,
        1_000,
        60_000,
      ),
      shutdownDrainTimeoutMs: shutdownTimeoutMs,
      settingsMode: settingsModeEnvironment(environment.CATALOG_SETTINGS_MODE),
      staticDirectory: existsSync(staticCandidate) ? staticCandidate : undefined,
    },
    scanner: {
      quietWindowMs: integerEnvironment(environment.CATALOG_QUIET_WINDOW_MS, 750, 50, 60_000),
      stabilityWindowMs: integerEnvironment(environment.CATALOG_STABILITY_WINDOW_MS, 250, 0, 60_000),
      maxConcurrentScans: integerEnvironment(environment.CATALOG_MAX_CONCURRENT_SCANS, 2, 1, 16),
      scanTimeoutMs: integerEnvironment(
        environment.CATALOG_SCAN_TIMEOUT_MS,
        10 * 60 * 1_000,
        1_000,
        24 * 60 * 60 * 1_000,
      ),
      maxEntriesPerRoot: integerEnvironment(environment.CATALOG_MAX_SCAN_ENTRIES, 1_000_000, 1, 10_000_000),
      maxDirectoriesPerRoot: integerEnvironment(environment.CATALOG_MAX_SCAN_DIRECTORIES, 50_000, 1, 1_000_000),
      metadataWorkerCount: integerEnvironment(environment.CATALOG_METADATA_WORKERS, 2, 1, 16),
      metadataTimeoutMs: integerEnvironment(environment.CATALOG_METADATA_TIMEOUT_MS, 15_000, 100, 5 * 60_000),
      coverRetentionMs: integerEnvironment(
        environment.CATALOG_COVER_RETENTION_MS,
        7 * 24 * 60 * 60 * 1_000,
        60_000,
        365 * 24 * 60 * 60 * 1_000,
      ),
      coverPruneIntervalMs: integerEnvironment(
        environment.CATALOG_COVER_PRUNE_MS,
        24 * 60 * 60 * 1_000,
        60_000,
        30 * 24 * 60 * 60 * 1_000,
      ),
      shutdownTimeoutMs,
      reconciliationIntervalMs: integerEnvironment(
        environment.CATALOG_RECONCILE_MS,
        15 * 60 * 1_000,
        1_000,
        24 * 60 * 60 * 1_000,
      ),
      deepReconciliationIntervalMs: integerEnvironment(
        environment.CATALOG_DEEP_RECONCILE_MS,
        24 * 60 * 60 * 1_000,
        60_000,
        30 * 24 * 60 * 60 * 1_000,
      ),
    },
  };
}

function settingsModeEnvironment(value: string | undefined): "read-write" | "read-only" {
  const normalized = value?.trim();
  if (!normalized) return "read-write";
  if (normalized === "read-write" || normalized === "read-only") return normalized;
  throw new RangeError("CATALOG_SETTINGS_MODE must be exactly read-write or read-only.");
}

export async function runCatalogMain(
  environment: NodeJS.ProcessEnv = process.env,
  runtime: CatalogMainRuntime = {},
): Promise<void> {
  const signalSource = runtime.signalSource ?? process;
  const serviceFactory = runtime.serviceFactory ?? createCatalogService;
  const output = runtime.output ?? process.stdout;
  let service: CatalogService | null = null;
  let requestedSignal: "SIGTERM" | "SIGINT" | null = null;
  let closePromise: Promise<void> | null = null;
  let resolveSignal!: (signal: "SIGTERM" | "SIGINT") => void;
  const signalPromise = new Promise<"SIGTERM" | "SIGINT">((resolve) => {
    resolveSignal = resolve;
  });
  const beginClose = (): Promise<void> | null => {
    if (!service) return null;
    closePromise ??= service.close();
    // A listener cannot await. Attach a rejection observer immediately, while
    // retaining the original promise for runCatalogMain to await and report.
    void closePromise.catch(() => undefined);
    return closePromise;
  };
  const requestStop = (signal: "SIGTERM" | "SIGINT"): void => {
    if (requestedSignal) return;
    requestedSignal = signal;
    structuredServerLog(output, "info", "catalog.stop", { signal });
    resolveSignal(signal);
    beginClose();
  };
  const onSigterm = (): void => requestStop("SIGTERM");
  const onSigint = (): void => requestStop("SIGINT");

  // Install lifecycle handling before configuration, service creation, and in
  // particular before the potentially long initial catalog scan.
  signalSource.once("SIGTERM", onSigterm);
  signalSource.once("SIGINT", onSigint);
  try {
    const config = catalogConfigFromEnvironment(environment);
    const factoryAbort = new AbortController();
    const factoryPromise = Promise.resolve().then(() => serviceFactory(config, factoryAbort.signal));
    const factoryOutcome = factoryPromise.then(
      (createdService) => ({ status: "fulfilled" as const, service: createdService }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const factoryFirst = await Promise.race([
      factoryOutcome,
      signalPromise.then(() => ({ status: "signaled" as const })),
    ]);
    if (factoryFirst.status === "signaled") {
      factoryAbort.abort(new Error("Catalog service construction was interrupted by shutdown."));
      // A custom factory may ignore cancellation. Observe its eventual outcome
      // and retire any service it creates after runCatalogMain has returned.
      void factoryPromise
        .then((lateService) => lateService.close())
        .catch(() => undefined);
      return;
    }
    if (factoryFirst.status === "rejected") throw factoryFirst.error;
    service = factoryFirst.service;
    if (requestedSignal) {
      await beginClose();
      return;
    }

    const startup = service.start().then(
      (address) => ({ status: "fulfilled" as const, address }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    const first = await Promise.race([
      startup,
      signalPromise.then(() => ({ status: "signaled" as const })),
    ]);
    if (first.status === "rejected") throw first.error;
    if (first.status === "fulfilled") {
      if (!requestedSignal) {
        structuredServerLog(output, "info", "catalog.listen", {
          hostname: first.address.hostname,
          port: first.address.port,
        });
        await signalPromise;
      }
    } else {
      // Consume startup's result even though close() also waits for it, so a
      // concurrent startup rejection can never become unhandled.
      await startup;
    }
    await (beginClose() ?? Promise.resolve());
  } finally {
    signalSource.off("SIGTERM", onSigterm);
    signalSource.off("SIGINT", onSigint);
  }
}

function listEnvironment(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  if (value.trim().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && item.trim())) {
        return parsed.map((item) => item.trim());
      }
    } catch {
      throw new Error("A catalog list environment variable contains invalid JSON.");
    }
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function integerEnvironment(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("A catalog numeric environment variable is outside its allowed range.");
  }
  return parsed;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  runCatalogMain().catch((error: unknown) => {
    structuredServerLog(process.stderr, "error", "catalog.start.failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: error !== null && typeof error === "object" && "code" in error ? String(error.code).slice(0, 80) : "unknown",
    });
    process.exitCode = 1;
  });
}
