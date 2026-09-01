import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, readFile, stat, type FileHandle } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  MAX_CATALOG_JSON_RESPONSE_BYTES,
  MAX_CATALOG_ROOTS_PER_PROFILE,
  MAX_MATCH_INDEX_DELIVERIES,
  MAX_MATCH_INDEX_ENTRIES,
  MAX_MATCH_INDEX_RESPONSE_BYTES,
  type BookMetadataPatchInput,
  type BookMetadataResetInput,
  type BookSetQuery,
  type CatalogSort,
  type CatalogStatus,
  type CoverImportInput,
  type CoverProvider,
  type DeliveryInput,
  type DeliveryStatus,
  type ProfileConfigurationInput,
  type ProfileInput,
  type RootInput,
} from "../shared/catalog-contracts.js";
import { DEFAULT_METADATA_LIMITS } from "./book-metadata.js";
import { CatalogDatabase, CatalogDatabaseError } from "./catalog-database.js";
import { CatalogIndexer } from "./catalog-indexer.js";
import { CoverCache, CoverCacheError } from "./cover-cache.js";
import { CoverProviderClient, CoverProviderError } from "./cover-providers.js";
import { CatalogEventHub } from "./event-hub.js";
import { AllowedRootPolicy, RootPolicyError } from "./root-policy.js";
import { isFatalSqliteError } from "./sqlite-health.js";
import {
  MAX_METADATA_COVER_BYTES,
  MetadataCoverStore,
  MetadataCoverStoreError,
} from "./metadata-cover-store.js";

export interface CatalogHttpOptions {
  hostname: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  requireOriginForMutations: boolean;
  maxJsonBodyBytes: number;
  maxCatalogJsonResponseBytes: number;
  maxMatchIndexEntries: number;
  maxMatchIndexDeliveries: number;
  maxMatchIndexResponseBytes: number;
  maxConcurrentRequests: number;
  maxConcurrentSourceStreams: number;
  sourceResponseTimeoutMs: number;
  coverResponseTimeoutMs: number;
  maxConcurrentBufferedResponses: number;
  bufferedResponseWaitTimeoutMs: number;
  requestsPerMinutePerAddress: number;
  settingsValidationTimeoutMs: number;
  shutdownDrainTimeoutMs: number;
  settingsMode: "read-write" | "read-only";
  googleBooksApiKey?: string;
  coverProviderTimeoutMs: number;
  staticDirectory?: string;
}

const DEFAULT_OPTIONS: Readonly<CatalogHttpOptions> = {
  hostname: "127.0.0.1",
  port: 8080,
  allowedHosts: ["127.0.0.1:8080", "localhost:8080", "[::1]:8080"],
  allowedOrigins: [],
  requireOriginForMutations: true,
  maxJsonBodyBytes: 1024 * 1024,
  maxCatalogJsonResponseBytes: MAX_CATALOG_JSON_RESPONSE_BYTES,
  maxMatchIndexEntries: MAX_MATCH_INDEX_ENTRIES,
  maxMatchIndexDeliveries: MAX_MATCH_INDEX_DELIVERIES,
  maxMatchIndexResponseBytes: MAX_MATCH_INDEX_RESPONSE_BYTES,
  maxConcurrentRequests: 64,
  maxConcurrentSourceStreams: 4,
  sourceResponseTimeoutMs: 10 * 60 * 1_000,
  coverResponseTimeoutMs: 30_000,
  maxConcurrentBufferedResponses: 2,
  bufferedResponseWaitTimeoutMs: 10_000,
  requestsPerMinutePerAddress: 600,
  settingsValidationTimeoutMs: 10_000,
  shutdownDrainTimeoutMs: 20_000,
  settingsMode: "read-write",
  coverProviderTimeoutMs: 12_000,
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

class SourceStreamSnapshotError extends Error {
  constructor(readonly kind: "source" | "cache") {
    super(kind === "cache" ? "Source snapshot cache failed." : "Source changed while snapshotting.");
    this.name = "SourceStreamSnapshotError";
  }
}

class SourceStreamAbortError extends Error {
  constructor(readonly kind: "client" | "shutdown" | "timeout" = "shutdown") {
    super(kind === "timeout" ? "Source response timed out." : "Source streaming was aborted.");
    this.name = "SourceStreamAbortError";
  }
}

class SettingsValidationAbortError extends Error {
  constructor(readonly kind: "client" | "shutdown" | "timeout") {
    super(
      kind === "client"
        ? "The Settings client disconnected."
        : kind === "shutdown"
          ? "The catalog service is shutting down."
          : "Source-root validation timed out.",
    );
    this.name = "SettingsValidationAbortError";
  }
}

class CoverResponseAbortError extends Error {
  constructor(readonly kind: "client" | "shutdown" | "timeout") {
    super(
      kind === "timeout"
        ? "Cover response timed out."
        : kind === "client"
          ? "The cover client disconnected."
          : "The catalog service is shutting down.",
    );
    this.name = "CoverResponseAbortError";
  }
}

interface BufferedResponseWaiter {
  response: ServerResponse;
  resolve: (release: () => void) => void;
  reject: (error: HttpError) => void;
  cleanup: () => void;
}

export class CatalogHttpServer {
  private readonly options: CatalogHttpOptions;
  private readonly server: Server;
  private scannerState: CatalogStatus["scanner"] = "starting";
  private databaseState: CatalogStatus["database"] = "ready";
  private cacheState: CatalogStatus["cache"] = "ready";
  private lastRootStatus: CatalogStatus["roots"] = { configured: 0, available: 0, unavailable: 0, errors: 0 };
  private activeRequests = 0;
  private activeSourceStreams = 0;
  private activeBufferedResponses = 0;
  private readonly bufferedResponseWaiters: BufferedResponseWaiter[] = [];
  private shuttingDown = false;
  private listenPromise: Promise<{ hostname: string; port: number }> | null = null;
  private serverClosePromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private readonly shutdownAbort = new AbortController();
  private readonly immediateShutdownAbort = new AbortController();
  private readonly activeRequestWaiters = new Set<() => void>();
  private readonly rateWindows = new Map<string, { startedAt: number; count: number }>();
  private readonly coverProviders: CoverProviderClient;

  constructor(
    private readonly database: CatalogDatabase,
    private readonly indexer: CatalogIndexer,
    private readonly rootPolicy: AllowedRootPolicy,
    private readonly coverCache: CoverCache,
    private readonly events: CatalogEventHub,
    options: Partial<CatalogHttpOptions> = {},
    private readonly metadataCoverStore?: MetadataCoverStore,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (!Number.isSafeInteger(this.options.settingsValidationTimeoutMs) || this.options.settingsValidationTimeoutMs <= 0) {
      throw new RangeError("Settings validation timeout must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.options.sourceResponseTimeoutMs) || this.options.sourceResponseTimeoutMs <= 0) {
      throw new RangeError("Source response timeout must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.options.coverResponseTimeoutMs) || this.options.coverResponseTimeoutMs <= 0) {
      throw new RangeError("Cover response timeout must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.options.coverProviderTimeoutMs) || this.options.coverProviderTimeoutMs <= 0) {
      throw new RangeError("Cover provider timeout must be a positive integer.");
    }
    this.coverProviders = new CoverProviderClient(
      fetch,
      this.options.googleBooksApiKey,
      this.options.coverProviderTimeoutMs,
    );
    this.server = createServer((request, response) => void this.handle(request, response));
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.maxHeadersCount = 100;
  }

  setScannerState(state: CatalogStatus["scanner"]): void {
    this.scannerState = state;
  }

  setOperationalState(component: "database" | "cache", state: "ready" | "error"): void {
    if (component === "database") {
      if (state === "error") this.databaseState = "error";
      return;
    }
    this.cacheState = state === "ready" ? "ready" : "degraded";
  }

  async listen(): Promise<{ hostname: string; port: number }> {
    if (this.shuttingDown) throw new Error("Catalog HTTP server is shutting down.");
    if (this.listenPromise) throw new Error("Catalog HTTP server is already starting or listening.");
    this.listenPromise = new Promise<{ hostname: string; port: number }>((resolve, reject) => {
      const failed = (error: Error): void => {
        this.server.off("error", failed);
        reject(error);
      };
      this.server.once("error", failed);
      this.server.listen(this.options.port, this.options.hostname, () => {
        this.server.off("error", failed);
        const address = this.address();
        if (!address) {
          reject(new Error("Catalog server did not bind a TCP address."));
          return;
        }
        resolve(address);
      });
    });
    const address = await this.listenPromise;
    if (this.shuttingDown) this.beginServerClose();
    return address;
  }

  address(): { hostname: string; port: number } | null {
    const address = this.server.address();
    return !address || typeof address === "string" ? null : { hostname: address.address, port: address.port };
  }

  stopAccepting(): void {
    if (!this.shuttingDown) {
      this.shuttingDown = true;
      this.scannerState = "stopped";
      // Mutation-path filesystem validation must stop immediately. Source
      // streams use the separate shutdownAbort signal and retain their normal
      // drain window.
      this.immediateShutdownAbort.abort(new SettingsValidationAbortError("shutdown"));
      // SSE responses are intentionally long-lived and would otherwise keep
      // server.close() pending forever.
      this.events.close();
    }
    if (this.server.listening) this.beginServerClose();
  }

  close(): Promise<void> {
    this.shutdownPromise ??= this.drainAndClose();
    return this.shutdownPromise;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomBytes(8).toString("hex");
    let release: (() => void) | null = null;
    try {
      this.applySecurityHeaders(response);
      if (this.shuttingDown) {
        response.setHeader("Connection", "close");
        sendJson(response, 503, {
          error: { code: "server_shutting_down", message: "The catalog service is shutting down.", requestId },
        });
        return;
      }
      release = this.acquireRequest(request);
      const host = this.assertHost(request);
      const origin = this.assertOrigin(request, host);
      if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key, Last-Event-ID",
          "Access-Control-Max-Age": "600",
          Vary: "Origin",
        });
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", `http://${host}`);
      const segments = decodeSegments(url.pathname);
      if (segments[0] !== "api") {
        if (request.method === "GET" && this.options.staticDirectory) {
          await this.serveStatic(url.pathname, response);
          return;
        }
        throw new HttpError(404, "not_found", "Route not found.");
      }
      await this.route(request, response, url, segments.slice(1));
    } catch (error) {
      if (error instanceof SourceStreamAbortError) {
        if (error.kind === "timeout" && !response.headersSent && !response.destroyed) {
          sendJson(response, 503, {
            error: { code: "source_timeout", message: error.message, requestId },
          });
        } else {
          response.destroy();
        }
        return;
      }
      if (error instanceof SettingsValidationAbortError && error.kind === "client") {
        response.destroy();
        return;
      }
      if (error instanceof CoverResponseAbortError && error.kind === "client") {
        response.destroy();
        return;
      }
      if (isFatalSqliteError(error)) this.setOperationalState("database", "error");
      if (response.headersSent) {
        response.end();
        return;
      }
      const mapped = mapError(error);
      if (
        (error instanceof SettingsValidationAbortError || error instanceof CoverResponseAbortError)
        && error.kind === "shutdown"
      ) {
        response.setHeader("Connection", "close");
      }
      sendJson(response, mapped.status, {
        error: { code: mapped.code, message: mapped.message, requestId },
      });
    } finally {
      release?.();
    }
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    segments: string[],
  ): Promise<void> {
    const method = request.method ?? "GET";
    if (method === "GET" && segments.length === 1 && segments[0] === "status") {
      sendJson(response, 200, this.status());
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "healthz") {
      sendJson(response, 200, { live: true });
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "readyz") {
      const ready = this.scannerState === "ready" && this.databaseState === "ready";
      sendJson(response, ready ? 200 : 503, {
        ready,
        database: this.databaseState,
        cache: this.cacheState,
      });
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "events") {
      if (!this.events.attach(response, header(request, "last-event-id") ?? undefined)) {
        throw new HttpError(503, "event_capacity", "Too many event streams are open.");
      }
      return;
    }
    if (segments[0] === "profiles") {
      await this.routeProfiles(request, response, url, segments);
      return;
    }
    if (method === "GET" && segments.length === 1 && segments[0] === "roots") {
      const releaseLargeResponse = await this.acquireBufferedResponse(response);
      try {
        sendJson(response, 200, this.database.listRoots(), this.options.maxCatalogJsonResponseBytes);
      } catch (error) {
        releaseLargeResponse();
        throw error;
      }
      return;
    }
    if (method === "POST" && segments.length === 1 && segments[0] === "deliveries") {
      const key = requiredIdempotencyKey(request);
      const input = validateDelivery(await readJson(request, this.options.maxJsonBodyBytes));
      const result = this.database.createDelivery(key, input);
      if (result.created) {
        this.events.publish({
          type: "delivery.updated",
          profileId: input.profileId,
          bookId: input.bookId,
          data: { deliveryId: result.record.id, status: result.record.status },
        });
      }
      sendJson(response, result.created ? 201 : 200, result.record);
      return;
    }
    throw new HttpError(404, "not_found", "Route not found.");
  }

  private async routeProfiles(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    segments: string[],
  ): Promise<void> {
    const method = request.method ?? "GET";
    if (segments.length === 1) {
      if (method === "GET") {
        const releaseLargeResponse = await this.acquireBufferedResponse(response);
        try {
          sendJson(response, 200, this.database.listProfiles(), this.options.maxCatalogJsonResponseBytes);
        } catch (error) {
          releaseLargeResponse();
          throw error;
        }
        return;
      }
      if (method === "POST") {
        this.assertSettingsWritable();
        const key = requiredIdempotencyKey(request);
        const result = this.database.createProfileIdempotent(
          validateProfile(await readJson(request, this.options.maxJsonBodyBytes)),
          key,
        );
        if (result.created) this.events.publish({ type: "profile.created", profileId: result.profile.id });
        sendJson(response, result.created ? 201 : 200, result.profile, this.options.maxCatalogJsonResponseBytes);
        return;
      }
    }
    if (segments.length === 2 && segments[1] === "configuration" && method === "POST") {
      this.assertSettingsWritable();
      const key = requiredIdempotencyKey(request);
      const input = await this.validateConfiguration(
        await readJson(request, this.options.maxJsonBodyBytes),
        request,
        response,
      );
      const releaseLargeResponse = await this.acquireBufferedResponse(response);
      try {
        const result = this.database.applyProfileConfiguration(null, input, key);
        if (result.applied) {
          this.events.publish({ type: "profile.created", profileId: result.configuration.profile.id });
        }
        this.indexer.pruneInactiveRoots();
        for (const root of result.configuration.roots) {
          if (root.enabled) this.indexer.wakePendingScan(root.id);
        }
        sendJson(response, 200, result.configuration, this.options.maxCatalogJsonResponseBytes);
      } catch (error) {
        releaseLargeResponse();
        throw error;
      }
      return;
    }
    if (segments.length < 2) throw new HttpError(404, "not_found", "Route not found.");
    const profileId = opaqueSegment(segments[1], "profile");
    if (segments.length === 2) {
      if (method === "GET") {
        const profile = this.database.getProfile(profileId);
        if (!profile) throw new HttpError(404, "not_found", "Profile not found.");
        sendJson(response, 200, profile, this.options.maxCatalogJsonResponseBytes);
        return;
      }
      if (method === "PATCH") {
        this.assertSettingsWritable();
        const input = validateProfilePatch(await readJson(request, this.options.maxJsonBodyBytes));
        const result = this.database.updateProfileWithEffects(profileId, input);
        this.events.publish({ type: "profile.updated", profileId });
        this.indexer.pruneInactiveRoots();
        for (const rootId of result.scanRootIds) this.indexer.wakePendingScan(rootId);
        sendJson(response, 200, result.profile, this.options.maxCatalogJsonResponseBytes);
        return;
      }
      if (method === "DELETE") {
        this.assertSettingsWritable();
        const deleted = this.database.deleteProfile(profileId);
        if (deleted) {
          this.indexer.pruneInactiveRoots();
          await this.pruneMetadataCoverAssets();
          this.events.publish({ type: "profile.deleted", profileId });
        }
        response.writeHead(204).end();
        return;
      }
    }
    if (segments.length === 3 && segments[2] === "configuration" && method === "PUT") {
      this.assertSettingsWritable();
      const key = requiredIdempotencyKey(request);
      const input = await this.validateConfiguration(
        await readJson(request, this.options.maxJsonBodyBytes),
        request,
        response,
      );
      const releaseLargeResponse = await this.acquireBufferedResponse(response);
      try {
        const result = this.database.applyProfileConfiguration(profileId, input, key);
        if (result.applied) this.events.publish({ type: "profile.updated", profileId });
        this.indexer.pruneInactiveRoots();
        for (const root of result.configuration.roots) {
          if (root.enabled) this.indexer.wakePendingScan(root.id);
        }
        sendJson(response, 200, result.configuration, this.options.maxCatalogJsonResponseBytes);
      } catch (error) {
        releaseLargeResponse();
        throw error;
      }
      return;
    }
    if (segments[2] === "roots") {
      await this.routeRoots(request, response, profileId, segments.slice(3));
      return;
    }
    if (segments[2] === "books") {
      await this.routeBooks(request, response, url, profileId, segments.slice(3));
      return;
    }
    if (segments.length === 3 && segments[2] === "filters" && method === "GET") {
      this.requireProfile(profileId);
      const releaseLargeResponse = await this.acquireBufferedResponse(response);
      try {
        sendJson(
          response,
          200,
          this.database.getFilters(profileId),
          this.options.maxCatalogJsonResponseBytes,
        );
      } catch (error) {
        releaseLargeResponse();
        throw error;
      }
      return;
    }
    if (segments.length === 3 && segments[2] === "match-index" && method === "GET") {
      const releaseLargeResponse = await this.acquireBufferedResponse(response);
      try {
        const body = this.database.serializeMatchIndex(profileId, {
          maxEntries: this.options.maxMatchIndexEntries,
          maxDeliveries: this.options.maxMatchIndexDeliveries,
          maxResponseBytes: this.options.maxMatchIndexResponseBytes,
        });
        sendJsonBuffer(response, 200, body);
      } catch (error) {
        releaseLargeResponse();
        throw error;
      }
      return;
    }
    throw new HttpError(404, "not_found", "Route not found.");
  }

  private async routeRoots(
    request: IncomingMessage,
    response: ServerResponse,
    profileId: string,
    segments: string[],
  ): Promise<void> {
    const method = request.method ?? "GET";
    this.requireProfile(profileId);
    if (segments.length === 0) {
      if (method === "GET") {
        const releaseLargeResponse = await this.acquireBufferedResponse(response);
        try {
          sendJson(response, 200, this.database.listRoots(profileId), this.options.maxCatalogJsonResponseBytes);
        } catch (error) {
          releaseLargeResponse();
          throw error;
        }
        return;
      }
      if (method === "POST") {
        this.assertSettingsWritable();
        const input = await this.validateRoot(
          await readJson(request, this.options.maxJsonBodyBytes),
          request,
          response,
        );
        const result = this.database.createRootWithEffects(profileId, input);
        this.events.publish({ type: "root.created", profileId, rootId: result.root.id });
        if (result.scanQueued) this.indexer.wakePendingScan(result.root.id);
        sendJson(response, 201, result.root, this.options.maxCatalogJsonResponseBytes);
        return;
      }
    }
    if (segments.length >= 1) {
      const rootId = opaqueSegment(segments[0], "root");
      if (segments.length === 1 && method === "PATCH") {
        this.assertSettingsWritable();
        const input = await this.validateRootPatch(
          await readJson(request, this.options.maxJsonBodyBytes),
          request,
          response,
        );
        const result = this.database.updateRootWithEffects(profileId, rootId, input);
        this.events.publish({ type: "root.updated", profileId, rootId });
        this.indexer.pruneInactiveRoots();
        if (result.scanReason) this.indexer.wakePendingScan(result.root.id);
        sendJson(response, 200, result.root, this.options.maxCatalogJsonResponseBytes);
        return;
      }
      if (segments.length === 1 && method === "DELETE") {
        this.assertSettingsWritable();
        if (!this.database.deleteRoot(profileId, rootId)) throw new HttpError(404, "not_found", "Source root not found.");
        this.indexer.pruneInactiveRoots();
        await this.pruneMetadataCoverAssets();
        this.events.publish({ type: "root.deleted", profileId, rootId });
        response.writeHead(204).end();
        return;
      }
      if (segments.length === 2 && segments[1] === "rescan" && method === "POST") {
        if (!this.database.getRoot(profileId, rootId)) throw new HttpError(404, "not_found", "Source root not found.");
        if (!this.indexer.requestRescan(rootId)) throw new HttpError(409, "root_disabled", "Source root is disabled.");
        sendJson(response, 202, { accepted: true, rootId });
        return;
      }
    }
    throw new HttpError(404, "not_found", "Route not found.");
  }

  private async routeBooks(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    profileId: string,
    segments: string[],
  ): Promise<void> {
    const method = request.method ?? "GET";
    this.requireProfile(profileId);
    if (segments.length === 0 && method === "GET") {
      const releaseLargeResponse = await this.acquireBufferedResponse(response);
      try {
        const body = this.database.serializeBookPage(
          profileId,
          queryFromSearchParams(url.searchParams),
          this.options.maxCatalogJsonResponseBytes,
        );
        sendJsonBuffer(response, 200, body);
      } catch (error) {
        releaseLargeResponse();
        throw error;
      }
      return;
    }
    if (segments.length === 1 && segments[0] === "query" && method === "POST") {
      const query = queryFromObject(await readJson(request, this.options.maxJsonBodyBytes), true);
      const releaseLargeResponse = await this.acquireBufferedResponse(response);
      try {
        const body = this.database.serializeBookPage(profileId, query, this.options.maxCatalogJsonResponseBytes);
        sendJsonBuffer(response, 200, body);
      } catch (error) {
        releaseLargeResponse();
        throw error;
      }
      return;
    }
    if (segments.length >= 1) {
      const bookId = opaqueSegment(segments[0], "book");
      if (segments.length === 1 && method === "GET") {
        const releaseLargeResponse = await this.acquireBufferedResponse(response);
        try {
          const book = this.database.getBook(profileId, bookId);
          if (!book) throw new HttpError(404, "not_found", "Book not found.");
          sendJson(response, 200, book, this.options.maxCatalogJsonResponseBytes);
        } catch (error) {
          releaseLargeResponse();
          throw error;
        }
        return;
      }
      if (segments.length === 2 && segments[1] === "metadata" && method === "GET") {
        const state = this.database.getBookMetadataState(profileId, bookId);
        if (!state) throw new HttpError(404, "not_found", "Book not found.");
        sendJson(response, 200, state, this.options.maxCatalogJsonResponseBytes);
        return;
      }
      if (segments.length === 2 && segments[1] === "metadata" && method === "PATCH") {
        const input = validateBookMetadataPatch(await readJson(request, this.options.maxJsonBodyBytes));
        const state = this.database.patchBookMetadata(profileId, bookId, input);
        this.events.publish({ type: "book.updated", profileId, bookId, data: { metadataEdited: true } });
        sendJson(response, 200, state, this.options.maxCatalogJsonResponseBytes);
        return;
      }
      if (segments.length === 3 && segments[1] === "metadata" && segments[2] === "reset" && method === "POST") {
        const input = validateBookMetadataReset(await readJson(request, this.options.maxJsonBodyBytes));
        const state = this.database.resetBookMetadata(profileId, bookId, input);
        this.events.publish({ type: "book.updated", profileId, bookId, data: { metadataEdited: state.book.metadataEdited } });
        sendJson(response, 200, state, this.options.maxCatalogJsonResponseBytes);
        return;
      }
      if (segments.length === 2 && segments[1] === "cover" && method === "GET") {
        await this.serveCover(request, response, profileId, bookId, url.searchParams.get("source") === "true");
        return;
      }
      if (segments.length === 2 && segments[1] === "cover" && method === "PUT") {
        await this.replaceBookCover(request, response, url, profileId, bookId);
        return;
      }
      if (segments.length === 2 && segments[1] === "cover" && method === "DELETE") {
        await this.resetBookCover(response, url, profileId, bookId);
        return;
      }
      if (segments.length === 2 && segments[1] === "cover-search" && method === "GET") {
        await this.searchBookCovers(response, url, profileId, bookId);
        return;
      }
      if (segments.length === 2 && segments[1] === "cover-preview" && method === "GET") {
        await this.serveProviderCoverPreview(response, url, profileId, bookId);
        return;
      }
      if (segments.length === 2 && segments[1] === "cover-import" && method === "POST") {
        await this.importBookCover(request, response, profileId, bookId);
        return;
      }
      if (segments.length === 2 && segments[1] === "source" && method === "GET") {
        await this.serveSource(request, response, profileId, bookId);
        return;
      }
    }
    throw new HttpError(404, "not_found", "Route not found.");
  }

  private async serveCover(
    request: IncomingMessage,
    response: ServerResponse,
    profileId: string,
    bookId: string,
    sourceOnly = false,
  ): Promise<void> {
    const releaseLargeResponse = await this.acquireBufferedResponse(response);
    const clientAbort = new AbortController();
    const deadlineAbort = new AbortController();
    const clientDisconnected = (): void => {
      if (!response.writableFinished && !clientAbort.signal.aborted) {
        clientAbort.abort(new CoverResponseAbortError("client"));
      }
    };
    request.once("aborted", clientDisconnected);
    response.once("close", clientDisconnected);
    request.socket.once("close", clientDisconnected);
    if (
      request.aborted
      || request.socket.destroyed
      || (response.destroyed && !response.writableFinished)
    ) clientDisconnected();
    const deadline = setTimeout(
      () => deadlineAbort.abort(new CoverResponseAbortError("timeout")),
      this.options.coverResponseTimeoutMs,
    );
    deadline.unref();
    const signal = AbortSignal.any([
      this.immediateShutdownAbort.signal,
      clientAbort.signal,
      deadlineAbort.signal,
    ]);
    try {
      throwIfCoverResponseAborted(signal);
      const source = this.database.getBookSource(profileId, bookId);
      const coverKey = sourceOnly ? source?.sourceCoverKey : source?.coverKey;
      const coverMediaType = sourceOnly ? source?.sourceCoverMediaType : source?.coverMediaType;
      const coverStorage = sourceOnly ? "cache" : source?.coverStorage;
      if (!source || !coverKey || !coverMediaType) throw new HttpError(404, "cover_not_found", "Cover not found.");
      let data: Buffer;
      try {
        data = await abortableCoverResponseOperation(
          coverStorage === "override"
            ? this.requireMetadataCoverStore().read(coverKey)
            : this.coverCache.read(coverKey),
          signal,
        );
      } catch (error) {
        rethrowCoverResponseAbort(error, signal);
        if (coverStorage === "override") {
          throw new HttpError(404, "cover_asset_missing", "The selected cover is unavailable.");
        }
        this.setOperationalState("cache", "error");
        this.indexer.requestRescan(source.book.rootId);
        throw new HttpError(404, "cover_cache_miss", "Cover is being rebuilt.");
      }
      throwIfCoverResponseAborted(signal);
      this.setOperationalState("cache", "ready");
      response.writeHead(200, {
        "Content-Type": coverMediaType,
        "Content-Length": data.length,
        "Cache-Control": "private, max-age=86400, immutable",
        ETag: `"${coverKey}"`,
      });
      response.end(data);
    } catch (error) {
      releaseLargeResponse();
      throw error;
    } finally {
      clearTimeout(deadline);
      request.off("aborted", clientDisconnected);
      response.off("close", clientDisconnected);
      request.socket.off("close", clientDisconnected);
    }
  }

  private async replaceBookCover(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    profileId: string,
    bookId: string,
  ): Promise<void> {
    const concurrency = coverConcurrencyFromSearchParams(url.searchParams);
    const mediaType = imageContentType(request);
    const data = await readBoundedBody(request, MAX_METADATA_COVER_BYTES);
    const store = this.requireMetadataCoverStore();
    const stored = await store.store(data, mediaType);
    try {
      const result = this.database.setBookCover(profileId, bookId, concurrency.expectedRevision, concurrency.expectedContentHash, {
        ...stored,
        sourceKind: "upload",
        provider: null,
        providerReference: null,
        sourceUrl: null,
      });
      if (result.unreferencedAssetKey) {
        await this.retireMetadataCoverAssetBestEffort(result.unreferencedAssetKey);
      }
      this.events.publish({ type: "book.updated", profileId, bookId, data: { coverEdited: true } });
      sendJson(response, 200, result.state, this.options.maxCatalogJsonResponseBytes);
    } catch (error) {
      await store.removeIfUnreferenced(stored.assetKey, this.database.isMetadataCoverReferenced(stored.assetKey)).catch(() => undefined);
      throw error;
    }
  }

  private async resetBookCover(response: ServerResponse, url: URL, profileId: string, bookId: string): Promise<void> {
    const concurrency = coverConcurrencyFromSearchParams(url.searchParams);
    const result = this.database.resetBookCover(
      profileId,
      bookId,
      concurrency.expectedRevision,
      concurrency.expectedContentHash,
    );
    if (result.unreferencedAssetKey) {
      await this.retireMetadataCoverAssetBestEffort(result.unreferencedAssetKey);
    }
    this.events.publish({ type: "book.updated", profileId, bookId, data: { coverEdited: false } });
    sendJson(response, 200, result.state, this.options.maxCatalogJsonResponseBytes);
  }

  private async searchBookCovers(
    response: ServerResponse,
    url: URL,
    profileId: string,
    bookId: string,
  ): Promise<void> {
    if (!this.database.getBook(profileId, bookId)) throw new HttpError(404, "not_found", "Book not found.");
    const provider = coverProvider(url.searchParams.get("provider"));
    const query = requiredString(url.searchParams.get("q"), "q", 500);
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 12 : boundedInteger(rawLimit, "limit", 1, 20);
    const candidates = await this.coverProviders.search(provider, query, limit);
    const prefix = `/api/profiles/${encodeURIComponent(profileId)}/books/${encodeURIComponent(bookId)}/cover-preview`;
    sendJson(response, 200, {
      provider,
      items: candidates.map((candidate) => ({
        ...candidate,
        thumbnailUrl: `${prefix}?provider=${encodeURIComponent(provider)}&candidateId=${encodeURIComponent(candidate.candidateId)}`,
      })),
    }, this.options.maxCatalogJsonResponseBytes);
  }

  private async serveProviderCoverPreview(
    response: ServerResponse,
    url: URL,
    profileId: string,
    bookId: string,
  ): Promise<void> {
    if (!this.database.getBook(profileId, bookId)) throw new HttpError(404, "not_found", "Book not found.");
    const provider = coverProvider(url.searchParams.get("provider"));
    const candidateId = requiredString(url.searchParams.get("candidateId"), "candidateId", 160);
    const releaseLargeResponse = await this.acquireBufferedResponse(response);
    try {
      const cover = await this.coverProviders.fetchCover(provider, candidateId);
      response.writeHead(200, {
        "Content-Type": cover.mediaType,
        "Content-Length": cover.data.length,
        "Cache-Control": "private, max-age=600",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(cover.data);
    } catch (error) {
      releaseLargeResponse();
      throw error;
    }
  }

  private async importBookCover(
    request: IncomingMessage,
    response: ServerResponse,
    profileId: string,
    bookId: string,
  ): Promise<void> {
    const input = validateCoverImport(await readJson(request, this.options.maxJsonBodyBytes));
    const remote = await this.coverProviders.fetchCover(input.provider, input.candidateId);
    const store = this.requireMetadataCoverStore();
    const stored = await store.store(remote.data, remote.mediaType);
    try {
      const result = this.database.setBookCover(profileId, bookId, input.expectedRevision, input.expectedContentHash, {
        ...stored,
        sourceKind: "provider",
        provider: input.provider,
        providerReference: input.candidateId,
        sourceUrl: remote.sourceUrl,
      });
      if (result.unreferencedAssetKey) {
        await this.retireMetadataCoverAssetBestEffort(result.unreferencedAssetKey);
      }
      this.events.publish({ type: "book.updated", profileId, bookId, data: { coverEdited: true } });
      sendJson(response, 200, result.state, this.options.maxCatalogJsonResponseBytes);
    } catch (error) {
      await store.removeIfUnreferenced(stored.assetKey, this.database.isMetadataCoverReferenced(stored.assetKey)).catch(() => undefined);
      throw error;
    }
  }

  private requireMetadataCoverStore(): MetadataCoverStore {
    if (!this.metadataCoverStore) {
      throw new HttpError(503, "metadata_cover_unavailable", "Durable metadata-cover storage is unavailable.");
    }
    return this.metadataCoverStore;
  }

  private async retireMetadataCoverAssetBestEffort(assetKey: string): Promise<void> {
    try {
      const store = this.requireMetadataCoverStore();
      await store.removeIfUnreferenced(assetKey, this.database.isMetadataCoverReferenced(assetKey));
      this.database.pruneUnreferencedMetadataCoverAssetRows();
    } catch {
      // The user-visible mutation already committed. Startup and periodic
      // pruning safely retry orphan cleanup; never misreport that commit as a
      // failed mutation and invite a stale-revision retry.
    }
  }

  private async pruneMetadataCoverAssets(): Promise<void> {
    if (!this.metadataCoverStore) return;
    this.database.pruneUnreferencedMetadataCoverAssetRows();
    await this.metadataCoverStore
      .pruneOrphans(
        this.database.referencedMetadataCoverKeys(),
        (assetKey) => this.database.isMetadataCoverReferenced(assetKey),
      )
      .catch(() => undefined);
  }

  private async serveSource(
    request: IncomingMessage,
    response: ServerResponse,
    profileId: string,
    bookId: string,
  ): Promise<void> {
    if (this.activeSourceStreams >= this.options.maxConcurrentSourceStreams) {
      throw new HttpError(503, "source_capacity", "Too many book sources are being streamed. Try again shortly.");
    }
    // Reserve capacity before containment checks and hashing; otherwise many
    // simultaneous callers could all pass the initial check and hash 200 MiB
    // sources concurrently before any stream increments the counter.
    this.activeSourceStreams += 1;
    let sourceHandle: FileHandle | null = null;
    let snapshotHandle: FileHandle | null = null;
    let immutableSnapshot: Awaited<ReturnType<CoverCache["createSourceSnapshot"]>> | null = null;
    const clientAbort = new AbortController();
    const deadlineAbort = new AbortController();
    const abortForClientDisconnect = (): void => {
      if (!response.writableFinished && !clientAbort.signal.aborted) {
        clientAbort.abort(new SourceStreamAbortError("client"));
      }
    };
    request.once("aborted", abortForClientDisconnect);
    response.once("close", abortForClientDisconnect);
    request.socket.once("close", abortForClientDisconnect);
    if (
      request.aborted
      || request.socket.destroyed
      || (response.destroyed && !response.writableFinished)
    ) abortForClientDisconnect();
    const deadline = setTimeout(
      () => deadlineAbort.abort(new SourceStreamAbortError("timeout")),
      this.options.sourceResponseTimeoutMs,
    );
    deadline.unref();
    const signal = AbortSignal.any([this.shutdownAbort.signal, clientAbort.signal, deadlineAbort.signal]);
    try {
      throwIfSourceStreamAborted(signal);
      const indexedSource = this.database.getBookSource(profileId, bookId);
      if (!indexedSource) throw new HttpError(404, "not_found", "Book not found.");
      if (!indexedSource.book.available) {
        throw new HttpError(409, "source_unavailable", "Book source is unavailable.");
      }
      let safe: Awaited<ReturnType<AllowedRootPolicy["resolveSource"]>>;
      try {
        safe = await abortableSourceOperation(
          this.rootPolicy.resolveSource(indexedSource.rootPath, indexedSource.relativePath),
          signal,
        );
      } catch (error) {
        rethrowSourceStreamAbort(error, signal);
        this.rejectChangedSource(indexedSource.book.rootId, signal);
      }
      try {
        sourceHandle = await abortableSourceOperation(
          open(safe.realPath, constants.O_RDONLY | constants.O_NOFOLLOW),
          signal,
          closeLateFileHandle,
        );
      } catch (error) {
        rethrowSourceStreamAbort(error, signal);
        this.rejectChangedSource(indexedSource.book.rootId, signal);
      }
      let initialDetails: Awaited<ReturnType<FileHandle["stat"]>>;
      try {
        initialDetails = await abortableSourceOperation(sourceHandle.stat({ bigint: true }), signal);
      } catch (error) {
        rethrowSourceStreamAbort(error, signal);
        this.rejectChangedSource(indexedSource.book.rootId, signal);
      }
      if (!initialDetails.isFile()) this.rejectChangedSource(indexedSource.book.rootId, signal);
      if (initialDetails.size > BigInt(DEFAULT_METADATA_LIMITS.maxBookBytes)) {
        this.rejectOversizedSource(indexedSource.book.rootId, signal);
      }

      try {
        immutableSnapshot = await abortableSourceOperation(
          this.coverCache.createSourceSnapshot(indexedSource.book.sourceFilename),
          signal,
          disposeLateSourceSnapshot,
        );
      } catch (error) {
        rethrowSourceStreamAbort(error, signal);
        this.setOperationalState("cache", "error");
        throw new HttpError(503, "source_snapshot_unavailable", "A verified source snapshot could not be created. Try again shortly.");
      }
      let contentHash: string;
      try {
        contentHash = await snapshotAndHashOpenFile(
          sourceHandle,
          immutableSnapshot.filename,
          Number(initialDetails.size),
          signal,
          (source, buffer, offset, length, position) =>
            this.readSourceSnapshotChunk(source, buffer, offset, length, position),
        );
      } catch (error) {
        rethrowSourceStreamAbort(error, signal);
        if (error instanceof SourceStreamSnapshotError && error.kind === "cache") {
          this.setOperationalState("cache", "error");
          throw new HttpError(503, "source_snapshot_unavailable", "A verified source snapshot could not be written. Try again shortly.");
        }
        this.rejectChangedSource(indexedSource.book.rootId, signal);
      }
      let verifiedDetails: Awaited<ReturnType<FileHandle["stat"]>>;
      try {
        verifiedDetails = await abortableSourceOperation(sourceHandle.stat({ bigint: true }), signal);
      } catch (error) {
        rethrowSourceStreamAbort(error, signal);
        this.rejectChangedSource(indexedSource.book.rootId, signal);
      }
      if (
        !verifiedDetails.isFile() ||
        verifiedDetails.dev !== initialDetails.dev ||
        verifiedDetails.ino !== initialDetails.ino ||
        verifiedDetails.size !== initialDetails.size ||
        verifiedDetails.mtimeNs !== initialDetails.mtimeNs ||
        verifiedDetails.ctimeNs !== initialDetails.ctimeNs
      ) {
        this.rejectChangedSource(indexedSource.book.rootId, signal);
      }

      // Re-read the profile-scoped record and containment decision after the
      // descriptor is open. The path may have been renamed or substituted
      // while it was being hashed, but all response bytes remain bound to the
      // already-open descriptor.
      throwIfSourceStreamAborted(signal);
      const source = this.database.getBookSource(profileId, bookId);
      if (
        !source ||
        !source.book.available ||
        source.book.profileId !== profileId ||
        source.book.id !== bookId ||
        source.book.rootId !== indexedSource.book.rootId ||
        source.rootPath !== indexedSource.rootPath ||
        source.relativePath !== indexedSource.relativePath
      ) {
        this.rejectChangedSource(indexedSource.book.rootId, signal);
      }
      if (source.book.size > DEFAULT_METADATA_LIMITS.maxBookBytes) {
        this.rejectOversizedSource(source.book.rootId, signal);
      }
      let revalidated: Awaited<ReturnType<AllowedRootPolicy["resolveSource"]>>;
      try {
        revalidated = await abortableSourceOperation(
          this.rootPolicy.resolveSource(source.rootPath, source.relativePath),
          signal,
        );
      } catch (error) {
        rethrowSourceStreamAbort(error, signal);
        this.rejectChangedSource(source.book.rootId, signal);
      }
      let pathDetails: Awaited<ReturnType<typeof stat>>;
      try {
        pathDetails = await abortableSourceOperation(stat(revalidated.realPath, { bigint: true }), signal);
      } catch (error) {
        rethrowSourceStreamAbort(error, signal);
        this.rejectChangedSource(source.book.rootId, signal);
      }
      if (
        revalidated.realPath !== safe.realPath ||
        revalidated.rootRealPath !== safe.rootRealPath ||
        !pathDetails.isFile() ||
        pathDetails.dev !== verifiedDetails.dev ||
        pathDetails.ino !== verifiedDetails.ino ||
        verifiedDetails.size !== BigInt(source.book.size) ||
        contentHash !== source.book.contentHash
      ) {
        this.rejectChangedSource(source.book.rootId, signal);
      }

      await abortableSourceOperation(this.sourceVerifiedForStreaming(), signal);
      // Close the mutable host-backed descriptor before responding. Every HTTP
      // byte now comes from the private, descriptor-verified cache snapshot.
      const verifiedSourceHandle = sourceHandle;
      sourceHandle = null;
      await closeSourceStreamFileHandle(verifiedSourceHandle, signal);
      throwIfSourceStreamAborted(signal);
      snapshotHandle = await abortableSourceOperation(
        open(immutableSnapshot.filename, constants.O_RDONLY | constants.O_NOFOLLOW),
        signal,
        closeLateFileHandle,
      );
      this.setOperationalState("cache", "ready");
      response.writeHead(200, {
        "Content-Type": source.book.format === "epub" ? "application/epub+zip" : "application/vnd.amazon.mobi8-ebook",
        "Content-Length": source.book.size,
        "Content-Disposition": sourceContentDisposition(source.book.sourceFilename),
        "Cache-Control": "private, no-store",
        ETag: `"sha256-${source.book.contentHash}"`,
        "X-Kindle-Bridge-Presentation-Version": source.book.presentationVersion,
      });
      await abortableSourceOperation(
        pipeline(
          snapshotHandle.createReadStream({
            autoClose: false,
            start: 0,
            signal,
            ...(source.book.size > 0 ? { end: source.book.size - 1 } : {}),
          }),
          response,
        ),
        signal,
      );
    } finally {
      await closeSourceStreamFileHandle(sourceHandle, signal);
      await closeSourceStreamFileHandle(snapshotHandle, signal);
      await disposeSourceStreamSnapshot(immutableSnapshot, signal);
      this.activeSourceStreams -= 1;
      clearTimeout(deadline);
      request.off("aborted", abortForClientDisconnect);
      response.off("close", abortForClientDisconnect);
      request.socket.off("close", abortForClientDisconnect);
      this.sourceStreamFinished();
    }
  }

  protected async sourceVerifiedForStreaming(): Promise<void> {}

  protected sourceStreamFinished(): void {}

  protected async readSourceSnapshotChunk(
    source: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> {
    return source.read(buffer, offset, length, position);
  }

  private rejectChangedSource(rootId: string, signal: AbortSignal): never {
    throwIfSourceStreamAborted(signal);
    this.indexer.requestRescan(rootId);
    throw new HttpError(409, "source_changed", "Book source changed and is being reindexed.");
  }

  private rejectOversizedSource(rootId: string, signal: AbortSignal): never {
    throwIfSourceStreamAborted(signal);
    this.indexer.requestRescan(rootId);
    throw new HttpError(413, "book_too_large", "Book source exceeds the 200 MiB transfer limit.");
  }

  private status(): CatalogStatus {
    if (this.databaseState === "ready") {
      try {
        this.lastRootStatus = this.database.statusCounts();
      } catch (error) {
        if (isFatalSqliteError(error)) this.setOperationalState("database", "error");
        else throw error;
      }
    }
    const ready = this.scannerState === "ready" && this.databaseState === "ready";
    return {
      service: "kindle-bridge-catalog",
      version: this.database.schemaVersion,
      live: true,
      ready,
      database: this.databaseState,
      cache: this.cacheState,
      scanner: this.scannerState,
      settingsMode: this.options.settingsMode,
      roots: this.lastRootStatus,
    };
  }

  private requireProfile(profileId: string): void {
    if (!this.database.getProfile(profileId)) throw new HttpError(404, "not_found", "Profile not found.");
  }

  private assertSettingsWritable(): void {
    if (this.options.settingsMode === "read-only") {
      throw new HttpError(403, "settings_read_only", "Catalog settings are read-only on this service.");
    }
  }

  private async validateConfiguration(
    value: unknown,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<ProfileConfigurationInput> {
    return this.withSettingsValidation(request, response, async (signal) => {
      const object = objectValue(value);
      const rootsValue = object.roots;
      if (!Array.isArray(rootsValue) || rootsValue.length > MAX_CATALOG_ROOTS_PER_PROFILE) {
        throw new HttpError(400, "invalid_request", "Configuration roots must be a bounded array.");
      }
      const roots: RootInput[] = [];
      for (const root of rootsValue) {
        throwIfSettingsValidationAborted(signal);
        roots.push(await this.validateRootValue(root, signal));
      }
      return { profile: validateProfile(object.profile), roots };
    });
  }

  private async validateRoot(
    value: unknown,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<RootInput> {
    return this.withSettingsValidation(request, response, (signal) => this.validateRootValue(value, signal));
  }

  private async validateRootValue(value: unknown, signal: AbortSignal): Promise<RootInput> {
    const root = validateRootShape(value, false);
    const validated = await abortableSettingsValidation(
      this.rootPolicy.validateConfiguredRoot(root.path, true),
      signal,
    );
    return { ...root, path: validated.realPath ?? validated.absolutePath };
  }

  private async validateRootPatch(
    value: unknown,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<Partial<RootInput>> {
    return this.withSettingsValidation(request, response, async (signal) => {
      const root = validateRootShape(value, true);
      if (root.path) {
        const validated = await abortableSettingsValidation(
          this.rootPolicy.validateConfiguredRoot(root.path, true),
          signal,
        );
        root.path = validated.realPath ?? validated.absolutePath;
      }
      return root;
    });
  }

  private async withSettingsValidation<T>(
    request: IncomingMessage,
    response: ServerResponse,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const clientAbort = new AbortController();
    const deadlineAbort = new AbortController();
    const clientDisconnected = (): void => {
      if (!response.writableFinished && !clientAbort.signal.aborted) {
        clientAbort.abort(new SettingsValidationAbortError("client"));
      }
    };
    request.once("aborted", clientDisconnected);
    response.once("close", clientDisconnected);
    request.socket.once("close", clientDisconnected);
    if (
      request.aborted
      || request.socket.destroyed
      || (response.destroyed && !response.writableFinished)
    ) clientDisconnected();
    const timer = setTimeout(
      () => deadlineAbort.abort(new SettingsValidationAbortError("timeout")),
      this.options.settingsValidationTimeoutMs,
    );
    timer.unref();
    const signal = AbortSignal.any([
      this.immediateShutdownAbort.signal,
      clientAbort.signal,
      deadlineAbort.signal,
    ]);
    const validation = Promise.resolve().then(() => {
      throwIfSettingsValidationAborted(signal);
      return operation(signal);
    });
    try {
      return await abortableSettingsValidation(validation, signal);
    } finally {
      clearTimeout(timer);
      request.off("aborted", clientDisconnected);
      response.off("close", clientDisconnected);
      request.socket.off("close", clientDisconnected);
    }
  }

  private assertHost(request: IncomingMessage): string {
    const host = header(request, "host");
    if (!host || /[\s\\/@?#]/u.test(host)) throw new HttpError(400, "invalid_host", "Host header is invalid.");
    let hostname: string;
    try {
      const parsed = new URL(`http://${host}`);
      if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
        throw new Error("invalid host components");
      }
      hostname = parsed.hostname.toLocaleLowerCase();
    } catch {
      throw new HttpError(400, "invalid_host", "Host header is invalid.");
    }
    const authority = host.toLocaleLowerCase();
    const allowed = this.options.allowedHosts.some((candidate) => {
      const normalized = candidate.trim().toLocaleLowerCase();
      if (normalized === authority) return true;
      // Ephemeral port 0 is used only by local test/integration servers, whose
      // eventual authority cannot be known before listen(). Production
      // deployments must enumerate the exact Host authority, including port.
      return this.options.port === 0
        && !normalized.includes(":")
        && normalized === hostname;
    });
    if (!allowed) throw new HttpError(421, "host_not_allowed", "Host is not allowed.");
    return host;
  }

  private assertOrigin(request: IncomingMessage, host: string): string | null {
    const origin = header(request, "origin");
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET");
    if (!origin) {
      if (mutation && this.options.requireOriginForMutations) {
        throw new HttpError(403, "origin_required", "Origin header is required for this request.");
      }
      return null;
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new HttpError(403, "origin_not_allowed", "Origin is not allowed.");
    }
    const supportedProtocol = ["http:", "https:"].includes(parsed.protocol);
    const explicitOrigins = this.options.allowedOrigins.map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return "";
      }
    });
    // When deployment supplies an origin allowlist it is authoritative; an
    // insecure page on the same hostname must not bypass the configured HTTPS
    // origin merely because Host matches. Empty-list development falls back
    // to exact host equality.
    const allowed = supportedProtocol && (explicitOrigins.length > 0
      ? explicitOrigins.includes(parsed.origin)
      : parsed.host.toLocaleLowerCase() === host.toLocaleLowerCase());
    if (!allowed) {
      throw new HttpError(403, "origin_not_allowed", "Origin is not allowed.");
    }
    return parsed.origin;
  }

  private applySecurityHeaders(response: ServerResponse): void {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    );
    response.setHeader("Permissions-Policy", "usb=(self)");
  }

  private async acquireBufferedResponse(response: ServerResponse): Promise<() => void> {
    if (response.destroyed || response.writableFinished) {
      throw new HttpError(503, "buffered_response_aborted", "The buffered response client disconnected.");
    }
    if (this.activeBufferedResponses < this.options.maxConcurrentBufferedResponses) {
      return this.reserveBufferedResponse(response);
    }
    if (this.bufferedResponseWaiters.length >= this.options.maxConcurrentRequests) {
      throw new HttpError(503, "buffered_response_busy", "Buffered response capacity is full. Try again shortly.");
    }
    return new Promise<() => void>((resolve, reject) => {
      let waiter: BufferedResponseWaiter;
      const remove = (): void => {
        const index = this.bufferedResponseWaiters.indexOf(waiter);
        if (index >= 0) this.bufferedResponseWaiters.splice(index, 1);
      };
      const fail = (code: "buffered_response_busy" | "buffered_response_aborted", message: string): void => {
        remove();
        waiter.cleanup();
        reject(new HttpError(503, code, message));
      };
      const closed = (): void => fail("buffered_response_aborted", "The buffered response client disconnected.");
      const shutdown = (): void => fail("buffered_response_aborted", "The catalog service is shutting down.");
      const timer = setTimeout(
        () => fail("buffered_response_busy", "Buffered responses remained busy. Try again shortly."),
        this.options.bufferedResponseWaitTimeoutMs,
      );
      timer.unref();
      waiter = {
        response,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          response.off("close", closed);
          response.off("finish", closed);
          this.shutdownAbort.signal.removeEventListener("abort", shutdown);
        },
      };
      response.once("close", closed);
      response.once("finish", closed);
      this.shutdownAbort.signal.addEventListener("abort", shutdown, { once: true });
      this.bufferedResponseWaiters.push(waiter);
      if (response.destroyed || response.writableFinished) closed();
    });
  }

  private reserveBufferedResponse(response: ServerResponse): () => void {
    if (response.destroyed || response.writableFinished) {
      throw new HttpError(503, "buffered_response_aborted", "The buffered response client disconnected.");
    }
    this.activeBufferedResponses += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      response.off("finish", release);
      response.off("close", release);
      this.activeBufferedResponses -= 1;
      this.serviceBufferedResponseWaiter();
    };
    response.once("finish", release);
    response.once("close", release);
    if (response.destroyed || response.writableFinished) {
      release();
      throw new HttpError(503, "buffered_response_aborted", "The buffered response client disconnected.");
    }
    return release;
  }

  private serviceBufferedResponseWaiter(): void {
    while (
      this.activeBufferedResponses < this.options.maxConcurrentBufferedResponses
      && this.bufferedResponseWaiters.length > 0
    ) {
      const waiter = this.bufferedResponseWaiters.shift() as BufferedResponseWaiter;
      waiter.cleanup();
      if (waiter.response.destroyed || waiter.response.writableFinished) {
        waiter.reject(new HttpError(503, "buffered_response_aborted", "The buffered response client disconnected."));
        continue;
      }
      waiter.resolve(this.reserveBufferedResponse(waiter.response));
    }
  }

  private acquireRequest(request: IncomingMessage): () => void {
    if (this.activeRequests >= this.options.maxConcurrentRequests) {
      throw new HttpError(503, "server_busy", "The catalog service is busy. Try again shortly.");
    }
    const address = request.socket.remoteAddress ?? "unknown";
    const timestamp = Date.now();
    let window = this.rateWindows.get(address);
    if (!window && this.rateWindows.size >= 10_000) {
      for (const [key, item] of this.rateWindows) {
        if (timestamp - item.startedAt >= 60_000) this.rateWindows.delete(key);
      }
      window = this.rateWindows.get(address);
      if (!window && this.rateWindows.size >= 10_000) {
        throw new HttpError(503, "rate_window_capacity", "The catalog request limiter is at capacity. Try again shortly.");
      }
    }
    const current = !window || timestamp - window.startedAt >= 60_000 ? { startedAt: timestamp, count: 0 } : window;
    current.count += 1;
    this.rateWindows.set(address, current);
    if (current.count > this.options.requestsPerMinutePerAddress) {
      throw new HttpError(429, "rate_limited", "Too many catalog requests. Try again shortly.");
    }
    this.activeRequests += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activeRequests -= 1;
        if (this.activeRequests === 0) {
          for (const waiter of this.activeRequestWaiters) waiter();
          this.activeRequestWaiters.clear();
        }
      }
    };
  }

  private beginServerClose(): void {
    if (this.serverClosePromise || !this.server.listening) return;
    this.serverClosePromise = new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeIdleConnections();
    });
  }

  private waitForActiveRequests(): Promise<void> {
    if (this.activeRequests === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.activeRequestWaiters.add(resolve));
  }

  private async drainAndClose(): Promise<void> {
    this.stopAccepting();
    await this.listenPromise?.catch(() => undefined);
    if (this.server.listening) this.beginServerClose();
    const drained = Promise.all([this.serverClosePromise ?? Promise.resolve(), this.waitForActiveRequests()]).then(
      () => undefined,
    );
    if (await settlesWithin(drained, this.options.shutdownDrainTimeoutMs)) return;

    // Give normal source transfers time to finish, then abort descriptor-bound
    // streams and destroy remaining HTTP sockets. This keeps shutdown bounded
    // without closing SQLite while a request handler is still using it.
    this.shutdownAbort.abort(new Error("Catalog HTTP shutdown deadline exceeded."));
    this.server.closeAllConnections();
    this.server.closeIdleConnections();
    const forcedDrainMs = Math.min(2_000, Math.max(250, Math.floor(this.options.shutdownDrainTimeoutMs / 4)));
    if (!(await settlesWithin(drained, forcedDrainMs))) {
      throw new Error("Catalog HTTP requests did not stop after the shutdown deadline.");
    }
  }

  private async serveStatic(pathname: string, response: ServerResponse): Promise<void> {
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    if (relative.split("/").some((segment) => segment === ".." || segment.startsWith("."))) {
      throw new HttpError(404, "not_found", "Asset not found.");
    }
    const base = path.resolve(this.options.staticDirectory as string);
    let filename = path.resolve(base, relative);
    if (!contained(base, filename)) throw new HttpError(404, "not_found", "Asset not found.");
    let details = await stat(filename).catch(() => null);
    if (!details?.isFile() && !path.extname(relative)) {
      filename = path.join(base, "index.html");
      details = await stat(filename).catch(() => null);
    }
    if (!details?.isFile() || details.size > 16 * 1024 * 1024) throw new HttpError(404, "not_found", "Asset not found.");
    const releaseLargeResponse = await this.acquireBufferedResponse(response);
    try {
      const data = await readFile(filename);
      response.writeHead(200, {
        "Content-Type": staticMediaType(filename),
        "Content-Length": data.length,
        "Cache-Control": path.basename(filename) === "index.html" ? "no-cache" : "public, max-age=3600",
      });
      response.end(data);
    } catch (error) {
      releaseLargeResponse();
      throw error;
    }
  }
}

function validateProfile(value: unknown): ProfileInput {
  const object = objectValue(value);
  return {
    name: requiredString(object.name, "name", 120),
    description: optionalNullableString(object.description, "description", 2_000),
    enabled: optionalBoolean(object.enabled, "enabled"),
  };
}

function validateProfilePatch(value: unknown): Partial<ProfileInput> {
  const object = objectValue(value);
  const result: Partial<ProfileInput> = {};
  if (object.name !== undefined) result.name = requiredString(object.name, "name", 120);
  if (object.description !== undefined) result.description = optionalNullableString(object.description, "description", 2_000);
  if (object.enabled !== undefined) result.enabled = optionalBoolean(object.enabled, "enabled");
  if (Object.keys(result).length === 0) throw new HttpError(400, "invalid_request", "No profile changes were supplied.");
  return result;
}

function validateRootShape(value: unknown, partial: false): RootInput;
function validateRootShape(value: unknown, partial: true): Partial<RootInput>;
function validateRootShape(value: unknown, partial: boolean): RootInput | Partial<RootInput> {
  const object = objectValue(value);
  const result: Partial<RootInput> = {};
  if (object.id !== undefined) result.id = opaqueSegment(requiredString(object.id, "id", 100), "root");
  if (!partial || object.label !== undefined) result.label = requiredString(object.label, "label", 120);
  if (!partial || object.path !== undefined) result.path = requiredString(object.path, "path", 4_096);
  if (object.recursive !== undefined) result.recursive = optionalBoolean(object.recursive, "recursive");
  if (object.watch !== undefined) result.watch = optionalBoolean(object.watch, "watch");
  if (object.enabled !== undefined) result.enabled = optionalBoolean(object.enabled, "enabled");
  if (object.sentinel !== undefined) {
    result.sentinel = optionalNullableString(object.sentinel, "sentinel", 1_024);
    if (result.sentinel && !safeRelativePath(result.sentinel)) {
      throw new HttpError(400, "invalid_sentinel", "Sentinel must be a safe relative file path.");
    }
  }
  if (object.mountIdentity !== undefined) {
    result.mountIdentity = optionalNullableString(object.mountIdentity, "mountIdentity", 256);
  }
  if (partial && Object.keys(result).length === 0) throw new HttpError(400, "invalid_request", "No root changes were supplied.");
  return result as RootInput | Partial<RootInput>;
}

function validateDelivery(value: unknown): DeliveryInput {
  const object = objectValue(value);
  if (Object.hasOwn(object, "result")) {
    throw new HttpError(400, "invalid_request", "Delivery result payloads are not accepted.");
  }
  const statuses: DeliveryStatus[] = ["queued", "converting", "sending", "delivered", "failed"];
  const status = requiredString(object.status, "status", 32) as DeliveryStatus;
  if (!statuses.includes(status)) throw new HttpError(400, "invalid_request", "Delivery status is invalid.");
  const size = object.size === undefined || object.size === null ? null : boundedInteger(object.size, "size", 0, Number.MAX_SAFE_INTEGER);
  return {
    profileId: opaqueSegment(requiredString(object.profileId, "profileId", 100), "profile"),
    bookId: opaqueSegment(requiredString(object.bookId, "bookId", 100), "book"),
    deviceKey: requiredString(object.deviceKey, "deviceKey", 256),
    status,
    artifactHash: optionalNullableString(object.artifactHash, "artifactHash", 128),
    filename: optionalNullableString(object.filename, "filename", 512),
    size,
    objectIdentity: optionalNullableString(object.objectIdentity, "objectIdentity", 256),
    managedToken: optionalNullableString(object.managedToken, "managedToken", 256),
  };
}

const EDITABLE_METADATA_FIELDS = [
  "title",
  "authors",
  "authorSort",
  "language",
  "publisher",
  "publishedAt",
  "series",
  "seriesIndex",
  "description",
  "subjects",
  "identifiers",
] as const;

function validateBookMetadataPatch(value: unknown): BookMetadataPatchInput {
  const object = objectValue(value);
  const changesValue = objectValue(object.changes);
  const allowed = new Set<string>(EDITABLE_METADATA_FIELDS);
  for (const field of Object.keys(changesValue)) {
    if (!allowed.has(field)) throw new HttpError(400, "invalid_request", `Metadata field ${field} is not editable.`);
  }
  const changes: BookMetadataPatchInput["changes"] = {};
  if (Object.hasOwn(changesValue, "title")) changes.title = requiredMetadataString(changesValue.title, "title", 500);
  if (Object.hasOwn(changesValue, "authors")) changes.authors = metadataStringArray(changesValue.authors, "authors", 100, 300);
  if (Object.hasOwn(changesValue, "authorSort")) changes.authorSort = metadataNullableString(changesValue.authorSort, "authorSort", 500);
  if (Object.hasOwn(changesValue, "language")) changes.language = metadataNullableString(changesValue.language, "language", 64);
  if (Object.hasOwn(changesValue, "publisher")) changes.publisher = metadataNullableString(changesValue.publisher, "publisher", 500);
  if (Object.hasOwn(changesValue, "publishedAt")) changes.publishedAt = metadataNullableString(changesValue.publishedAt, "publishedAt", 64);
  if (Object.hasOwn(changesValue, "series")) changes.series = metadataNullableString(changesValue.series, "series", 500);
  if (Object.hasOwn(changesValue, "seriesIndex")) changes.seriesIndex = metadataNullableNumber(changesValue.seriesIndex, "seriesIndex", 0, 1_000_000);
  if (Object.hasOwn(changesValue, "description")) changes.description = metadataNullableText(changesValue.description, "description", 20_000);
  if (Object.hasOwn(changesValue, "subjects")) changes.subjects = metadataStringArray(changesValue.subjects, "subjects", 200, 500);
  if (Object.hasOwn(changesValue, "identifiers")) changes.identifiers = metadataStringArray(changesValue.identifiers, "identifiers", 100, 500);
  return {
    expectedRevision: boundedInteger(object.expectedRevision, "expectedRevision", 0, Number.MAX_SAFE_INTEGER),
    expectedContentHash: contentHash(object.expectedContentHash),
    changes,
  };
}

function validateBookMetadataReset(value: unknown): BookMetadataResetInput {
  const object = objectValue(value);
  let fields: BookMetadataResetInput["fields"];
  if (object.fields !== undefined) {
    if (!Array.isArray(object.fields) || object.fields.length === 0 || object.fields.length > EDITABLE_METADATA_FIELDS.length) {
      throw new HttpError(400, "invalid_request", "Metadata reset fields are invalid.");
    }
    const allowed = new Set<string>(EDITABLE_METADATA_FIELDS);
    fields = Array.from(new Set(object.fields.map((field) => {
      if (typeof field !== "string" || !allowed.has(field)) {
        throw new HttpError(400, "invalid_request", "Metadata reset field is invalid.");
      }
      return field as (typeof EDITABLE_METADATA_FIELDS)[number];
    })));
  }
  return {
    expectedRevision: boundedInteger(object.expectedRevision, "expectedRevision", 0, Number.MAX_SAFE_INTEGER),
    expectedContentHash: contentHash(object.expectedContentHash),
    ...(fields ? { fields } : {}),
  };
}

function validateCoverImport(value: unknown): CoverImportInput {
  const object = objectValue(value);
  return {
    expectedRevision: boundedInteger(object.expectedRevision, "expectedRevision", 0, Number.MAX_SAFE_INTEGER),
    expectedContentHash: contentHash(object.expectedContentHash),
    provider: coverProvider(object.provider),
    candidateId: requiredString(object.candidateId, "candidateId", 160),
  };
}

function coverConcurrencyFromSearchParams(params: URLSearchParams): {
  expectedRevision: number;
  expectedContentHash: string;
} {
  return {
    expectedRevision: boundedInteger(params.get("expectedRevision"), "expectedRevision", 0, Number.MAX_SAFE_INTEGER),
    expectedContentHash: contentHash(params.get("expectedContentHash")),
  };
}

function coverProvider(value: unknown): CoverProvider {
  if (value !== "google-books" && value !== "open-library") {
    throw new HttpError(400, "invalid_request", "Cover provider is invalid.");
  }
  return value;
}

function contentHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new HttpError(400, "invalid_request", "expectedContentHash is invalid.");
  }
  return value;
}

function requiredMetadataString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return value.trim();
}

function metadataNullableString(value: unknown, field: string, maximum: number): string | null {
  if (value === null || value === "") return null;
  return requiredMetadataString(value, field, maximum);
}

function metadataNullableText(value: unknown, field: string, maximum: number): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return value.trim();
}

function metadataNullableNumber(value: unknown, field: string, minimum: number, maximum: number): number | null {
  if (value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new HttpError(400, "invalid_request", `${field} is outside its allowed range.`);
  }
  return value;
}

function metadataStringArray(
  value: unknown,
  field: string,
  maximumItems: number,
  maximumItemLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new HttpError(400, "invalid_request", `${field} must be a bounded array.`);
  }
  const result = value.map((item) => requiredMetadataString(item, field, maximumItemLength));
  if (new Set(result.map((item) => item.toLocaleLowerCase())).size !== result.length) {
    throw new HttpError(400, "invalid_request", `${field} contains duplicate values.`);
  }
  return result;
}

function queryFromSearchParams(params: URLSearchParams): BookSetQuery {
  const object: Record<string, unknown> = {};
  for (const key of [
    "q",
    "author",
    "language",
    "subject",
    "publisher",
    "series",
    "year",
    "format",
    "rootId",
    "metadata",
    "available",
    "sort",
    "order",
    "limit",
    "offset",
  ]) {
    const value = params.get(key);
    if (value !== null) object[key] = value;
  }
  return queryFromObject(object, false);
}

function queryFromObject(value: unknown, allowSets: boolean): BookSetQuery {
  const object = objectValue(value);
  const query: BookSetQuery = {};
  for (const field of ["q", "author", "language", "subject", "publisher", "series"] as const) {
    if (object[field] !== undefined) query[field] = requiredString(object[field], field, 500);
  }
  if (object.year !== undefined) {
    const year = requiredString(object.year, "year", 4);
    if (!/^\d{4}$/u.test(year)) throw new HttpError(400, "invalid_query", "Year must contain four digits.");
    query.year = year;
  }
  if (object.format !== undefined) {
    if (object.format !== "epub" && object.format !== "azw3") throw new HttpError(400, "invalid_query", "Format is invalid.");
    query.format = object.format;
  }
  if (object.rootId !== undefined) query.rootId = opaqueSegment(requiredString(object.rootId, "rootId", 100), "root");
  if (object.metadata !== undefined) {
    if (object.metadata !== "complete" && object.metadata !== "partial") {
      throw new HttpError(400, "invalid_query", "Metadata filter is invalid.");
    }
    query.metadata = object.metadata;
  }
  if (object.available !== undefined) {
    if (object.available === "true") query.available = true;
    else if (object.available === "false") query.available = false;
    else query.available = optionalBoolean(object.available, "available");
  }
  if (object.sort !== undefined) {
    const sorts: CatalogSort[] = ["recent", "title", "author", "published", "size", "added", "updated"];
    if (!sorts.includes(object.sort as CatalogSort)) throw new HttpError(400, "invalid_query", "Sort is invalid.");
    query.sort = object.sort as CatalogSort;
  }
  if (object.order !== undefined) {
    if (object.order !== "asc" && object.order !== "desc") throw new HttpError(400, "invalid_query", "Order is invalid.");
    query.order = object.order;
  }
  if (object.limit !== undefined) query.limit = boundedInteger(object.limit, "limit", 1, 200);
  if (object.offset !== undefined) query.offset = boundedInteger(object.offset, "offset", 0, 10_000_000);
  if (allowSets) {
    if (object.includeBookIds !== undefined) query.includeBookIds = validateBookIds(object.includeBookIds);
    if (object.excludeBookIds !== undefined) query.excludeBookIds = validateBookIds(object.excludeBookIds);
  }
  return query;
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const contentType = header(request, "content-type")?.split(";", 1)[0]?.trim().toLocaleLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "unsupported_media_type", "Expected application/json.");
  const length = header(request, "content-length");
  if (length && (!/^\d+$/u.test(length) || Number(length) > limit)) {
    throw new HttpError(413, "body_too_large", "Request body exceeds the configured limit.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += data.length;
    if (total > limit) throw new HttpError(413, "body_too_large", "Request body exceeds the configured limit.");
    chunks.push(data);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

async function readBoundedBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const length = header(request, "content-length");
  if (length && (!/^\d+$/u.test(length) || Number(length) > limit)) {
    throw new HttpError(413, "body_too_large", "Cover upload exceeds the configured limit.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += data.length;
    if (total > limit) throw new HttpError(413, "body_too_large", "Cover upload exceeds the configured limit.");
    chunks.push(data);
  }
  if (total === 0) throw new HttpError(400, "invalid_cover", "Cover upload is empty.");
  return Buffer.concat(chunks, total);
}

function imageContentType(request: IncomingMessage): "image/jpeg" | "image/png" | "image/webp" {
  const value = header(request, "content-type")?.split(";", 1)[0]?.trim().toLocaleLowerCase();
  if (value !== "image/jpeg" && value !== "image/png" && value !== "image/webp") {
    throw new HttpError(415, "unsupported_media_type", "Cover must be uploaded as JPEG, PNG, or WebP.");
  }
  return value;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  maximumBytes?: number,
  limitErrorCode = "response_too_large",
): void {
  const data = Buffer.from(JSON.stringify(value));
  if (maximumBytes !== undefined && data.length > maximumBytes) {
    throw new HttpError(413, limitErrorCode, "The requested catalog response exceeds the safe transfer limit.");
  }
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  response.end(data);
}

function sendJsonBuffer(response: ServerResponse, status: number, data: Buffer): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  response.end(data);
}

function mapError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof SettingsValidationAbortError) {
    return new HttpError(
      503,
      error.kind === "shutdown" ? "server_shutting_down" : "path_validation_timeout",
      error.message,
    );
  }
  if (error instanceof CoverResponseAbortError) {
    return new HttpError(
      503,
      error.kind === "shutdown" ? "server_shutting_down" : "cover_timeout",
      error.message,
    );
  }
  if (error instanceof CatalogDatabaseError) {
    return new HttpError(
      error.code === "not_found"
        ? 404
        : error.code === "conflict"
          ? 409
          : error.code === "too_large"
              || error.code === "response_too_large"
              || error.code === "match_index_too_large"
            ? 413
            : 500,
      error.code,
      error.message,
    );
  }
  if (error instanceof RootPolicyError) {
    const status = error.code === "permission_denied" ? 403 : error.code === "path_unavailable" ? 409 : 400;
    return new HttpError(status, error.code, error.message);
  }
  if (error instanceof CoverCacheError) return new HttpError(404, error.code, error.message);
  if (error instanceof MetadataCoverStoreError) {
    return new HttpError(
      error.code === "cover_too_large" ? 413 : error.code === "asset_unavailable" ? 503 : 400,
      error.code,
      error.message,
    );
  }
  if (error instanceof CoverProviderError) {
    return new HttpError(
      error.code === "invalid_provider" || error.code === "invalid_candidate"
        ? 400
        : error.code === "provider_response_too_large"
          ? 413
          : 502,
      error.code,
      error.message,
    );
  }
  return new HttpError(500, "internal_error", "The catalog service could not complete the request.");
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new HttpError(400, "invalid_request", `${field} is invalid.`);
  }
  return value.trim();
}

function optionalNullableString(value: unknown, field: string, maximum: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return requiredString(value, field, maximum);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, "invalid_request", `${field} must be a boolean.`);
  return value;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new HttpError(400, "invalid_request", `${field} is outside its allowed range.`);
  }
  return number;
}

function validateBookIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20_000) throw new HttpError(400, "invalid_query", "Book ID set is invalid.");
  return Array.from(new Set(value.map((item) => opaqueSegment(requiredString(item, "bookId", 100), "book"))));
}

function opaqueSegment(value: string, kind: "profile" | "root" | "book"): string {
  const prefix = kind === "profile" ? "prf" : kind;
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_-]{8,80}$`, "u").test(value)) {
    throw new HttpError(400, "invalid_identifier", `${kind} identifier is invalid.`);
  }
  return value;
}

function requiredIdempotencyKey(request: IncomingMessage): string {
  const value = header(request, "idempotency-key");
  if (!value || value.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new HttpError(400, "idempotency_key_required", "A valid Idempotency-Key header is required.");
  }
  return value;
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

function decodeSegments(pathname: string): string[] {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    throw new HttpError(400, "invalid_path", "Request path is invalid.");
  }
}

function safeRelativePath(value: string): boolean {
  return !path.isAbsolute(value) && !value.includes("\0") && !value.split(/[\\/]+/u).some((part) => part === "..");
}

function contained(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function snapshotAndHashOpenFile(
  source: FileHandle,
  snapshotFilename: string,
  expectedSize: number,
  signal: AbortSignal,
  readChunk: (
    source: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesRead: number }>,
): Promise<string> {
  let target: FileHandle;
  try {
    target = await abortableSourceOperation(
      open(snapshotFilename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600),
      signal,
      closeLateFileHandle,
    );
  } catch (error) {
    rethrowSourceStreamAbort(error, signal);
    throw new SourceStreamSnapshotError("cache");
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  try {
    while (offset < expectedSize) {
      throwIfSourceStreamAborted(signal);
      const requested = Math.min(buffer.length, expectedSize - offset);
      let bytesRead: number;
      try {
        ({ bytesRead } = await abortableSourceOperation(
          readChunk(source, buffer, 0, requested, offset),
          signal,
        ));
      } catch (error) {
        rethrowSourceStreamAbort(error, signal);
        throw new SourceStreamSnapshotError("source");
      }
      if (bytesRead <= 0) throw new SourceStreamSnapshotError("source");
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        let result: { bytesWritten: number };
        try {
          result = await abortableSourceOperation(
            target.write(buffer, written, bytesRead - written, offset + written),
            signal,
          );
        } catch (error) {
          rethrowSourceStreamAbort(error, signal);
          throw new SourceStreamSnapshotError("cache");
        }
        if (result.bytesWritten <= 0) throw new SourceStreamSnapshotError("cache");
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    try {
      await abortableSourceOperation(target.sync(), signal);
    } catch (error) {
      rethrowSourceStreamAbort(error, signal);
      throw new SourceStreamSnapshotError("cache");
    }
  } finally {
    await closeSourceStreamFileHandle(target, signal);
  }
  try {
    await abortableSourceOperation(chmod(snapshotFilename, 0o400), signal);
  } catch (error) {
    rethrowSourceStreamAbort(error, signal);
    throw new SourceStreamSnapshotError("cache");
  }
  return hash.digest("hex");
}

function throwIfSourceStreamAborted(signal: AbortSignal): void {
  if (signal.aborted) throw sourceStreamAbortError(signal);
}

function rethrowSourceStreamAbort(error: unknown, signal: AbortSignal): void {
  if (error instanceof SourceStreamAbortError) throw error;
  if (signal.aborted) throw sourceStreamAbortError(signal);
}

function sourceStreamAbortError(signal: AbortSignal): SourceStreamAbortError {
  return signal.reason instanceof SourceStreamAbortError
    ? signal.reason
    : new SourceStreamAbortError("shutdown");
}

function throwIfSettingsValidationAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof SettingsValidationAbortError
    ? signal.reason
    : new SettingsValidationAbortError("shutdown");
}

function throwIfCoverResponseAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof CoverResponseAbortError
    ? signal.reason
    : new CoverResponseAbortError("shutdown");
}

function rethrowCoverResponseAbort(error: unknown, signal: AbortSignal): void {
  if (error instanceof CoverResponseAbortError) throw error;
  if (signal.aborted) throwIfCoverResponseAborted(signal);
}

function abortableCoverResponseOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    try {
      throwIfCoverResponseAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const abort = (): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      try {
        throwIfCoverResponseAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function abortableSettingsValidation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    try {
      throwIfSettingsValidationAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const abort = (): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      try {
        throwIfSettingsValidationAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function abortableSourceOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  disposeLateResult?: (value: T) => void | Promise<void>,
): Promise<T> {
  if (signal.aborted) {
    void operation.then(
      (value) => disposeLateSourceResult(value, disposeLateResult),
      () => undefined,
    );
    return Promise.reject(sourceStreamAbortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const abort = (): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      reject(sourceStreamAbortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        if (finished) {
          disposeLateSourceResult(value, disposeLateResult);
          return;
        }
        finished = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function disposeLateSourceResult<T>(
  value: T,
  disposeLateResult: ((value: T) => void | Promise<void>) | undefined,
): void {
  if (!disposeLateResult) return;
  try {
    void Promise.resolve(disposeLateResult(value)).catch(() => undefined);
  } catch {
    // A best-effort late cleanup must never revive a retired request.
  }
}

function closeLateFileHandle(handle: FileHandle): void {
  void handle.close().catch(() => undefined);
}

function disposeLateSourceSnapshot(
  snapshot: Awaited<ReturnType<CoverCache["createSourceSnapshot"]>>,
): void {
  void snapshot.dispose().catch(() => undefined);
}

async function closeSourceStreamFileHandle(handle: FileHandle | null, signal: AbortSignal): Promise<void> {
  if (!handle) return;
  await abortableSourceOperation(handle.close(), signal).catch(() => undefined);
}

async function disposeSourceStreamSnapshot(
  snapshot: Awaited<ReturnType<CoverCache["createSourceSnapshot"]>> | null,
  signal: AbortSignal,
): Promise<void> {
  if (!snapshot) return;
  await abortableSourceOperation(snapshot.dispose(), signal).catch(() => undefined);
}

async function settlesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sourceContentDisposition(sourceFilename: string): string {
  const normalized = sourceFilename.normalize("NFKD").replace(/\p{Mark}+/gu, "");
  const fallback =
    Array.from(normalized, (character) => {
      const codePoint = character.codePointAt(0) as number;
      return codePoint >= 0x20 && codePoint <= 0x7e && !/["\\/]/u.test(character) ? character : "_";
    })
      .join("")
      .replace(/\s+/gu, " ")
      .trim() || "book";
  const encoded = Array.from(Buffer.from(sourceFilename, "utf8"), (byte) => {
    const character = String.fromCharCode(byte);
    return /[A-Za-z0-9!#$&+.^_`|~-]/u.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function staticMediaType(filename: string): string {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".webp": "image/webp",
      ".wasm": "application/wasm",
    }[path.extname(filename).toLocaleLowerCase()] ?? "application/octet-stream"
  );
}
