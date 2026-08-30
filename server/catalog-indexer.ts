import { createHash, randomUUID } from "node:crypto";
import { constants, watch, type BigIntStats, type FSWatcher } from "node:fs";
import { chmod, lstat, open, opendir, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { BookFormat, CatalogEventType } from "../shared/catalog-contracts.js";
import { DEFAULT_METADATA_LIMITS, MetadataError, type ExtractedBookMetadata } from "./book-metadata.js";
import {
  CatalogDatabase,
  StaleCatalogScanError,
  type RootScanFence,
  type ScanRoot,
} from "./catalog-database.js";
import { CoverCache, CoverCacheError } from "./cover-cache.js";
import { MetadataWorkerPool } from "./metadata-worker-pool.js";
import { AllowedRootPolicy, RootPolicyError } from "./root-policy.js";
import { isFatalSqliteError } from "./sqlite-health.js";

export interface ScannerEvent {
  type: CatalogEventType;
  profileId?: string;
  rootId?: string;
  bookId?: string;
  data?: Record<string, unknown>;
}

export type CatalogOperationalComponent = "database" | "cache";
export type CatalogOperationalState = "ready" | "error";

export interface CatalogIndexerOptions {
  quietWindowMs: number;
  reconciliationIntervalMs: number;
  deepReconciliationIntervalMs: number;
  stabilityWindowMs: number;
  maxDepth: number;
  maxFilesPerRoot: number;
  maxEntriesPerRoot: number;
  maxDirectoriesPerRoot: number;
  maxWatchDirectories: number;
  maxWatcherDirtyPaths: number;
  maxConcurrentScans: number;
  scanTimeoutMs: number;
  metadataWorkerCount: number;
  metadataTimeoutMs: number;
  coverRetentionMs: number;
  coverPruneIntervalMs: number;
  shutdownTimeoutMs: number;
  watcherHints: boolean;
}

const DEFAULT_OPTIONS: Readonly<CatalogIndexerOptions> = {
  quietWindowMs: 750,
  reconciliationIntervalMs: 15 * 60 * 1_000,
  deepReconciliationIntervalMs: 24 * 60 * 60 * 1_000,
  stabilityWindowMs: 250,
  maxDepth: 64,
  maxFilesPerRoot: 250_000,
  maxEntriesPerRoot: 1_000_000,
  maxDirectoriesPerRoot: 50_000,
  maxWatchDirectories: 20_000,
  maxWatcherDirtyPaths: 10_000,
  maxConcurrentScans: 2,
  scanTimeoutMs: 10 * 60 * 1_000,
  metadataWorkerCount: 2,
  metadataTimeoutMs: 15_000,
  coverRetentionMs: 7 * 24 * 60 * 60 * 1_000,
  coverPruneIntervalMs: 24 * 60 * 60 * 1_000,
  shutdownTimeoutMs: 20_000,
  watcherHints: true,
};

const QUICK_FINGERPRINT_VERSION = "qf1";
const QUICK_FINGERPRINT_SAMPLE_BYTES = 4 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const MAX_DEEP_RECONCILIATION_RETRY_MS = 15 * 60 * 1_000;
const MAX_SCAN_TIMEOUT_RETRY_MS = 15 * 60 * 1_000;

interface SourceIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface CandidateFile {
  filename: string;
  relativePath: string;
  format: BookFormat;
  size: number;
  mtimeMs: number;
  identity: SourceIdentity;
}

interface CandidateFailure {
  relativePath: string;
  format: BookFormat;
  size: number;
  mtimeMs: number;
  errorCode: string;
}

type CandidateIndexResult = "indexed" | "source-error" | "unstable" | "cache-error";

type WatcherInstallResult = "complete" | "truncated" | "unavailable";

class ScanAbortedError extends Error {
  constructor() {
    super("Catalog scan was aborted.");
    this.name = "ScanAbortedError";
  }
}

class ScanRootError extends Error {
  constructor(readonly code: "scan_entry_limit" | "scan_directory_limit" | "scan_depth_limit" | "scan_file_limit") {
    super(code);
    this.name = "ScanRootError";
  }
}

class SourceSnapshotError extends Error {
  readonly code = "source_changed";

  constructor() {
    super("The source changed while it was being indexed.");
    this.name = "SourceSnapshotError";
  }
}

class CacheSnapshotError extends Error {
  readonly code = "cache_unavailable";

  constructor() {
    super("The derived cache could not hold an immutable source snapshot.");
    this.name = "CacheSnapshotError";
  }
}

interface CandidateSnapshot {
  filename: string;
  contentHash: string;
  quickFingerprint: string;
  sourceHandle: FileHandle;
  identity: SourceIdentity;
  dispose(): Promise<void>;
}

interface ScanVerificationContext {
  readonly reason: string;
  readonly watcherDirtyPaths: ReadonlySet<string>;
  readonly unknownWatcherDirty: boolean;
  readonly discoveredPaths: ReadonlySet<string>;
}

export interface SourceFingerprintReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
}

export type MetadataExtractor = (
  filename: string,
  format: BookFormat,
) => Promise<ExtractedBookMetadata>;

export class QuietWindowQueue {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly quietWindowMs: number,
    private readonly consumer: (key: string) => void,
  ) {}

  enqueue(key: string, delayMs = this.quietWindowMs): void {
    const current = this.timers.get(key);
    if (current) clearTimeout(current);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.consumer(key);
    }, delayMs);
    timer.unref();
    this.timers.set(key, timer);
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }

  has(key: string): boolean {
    return this.timers.has(key);
  }

  keys(): string[] {
    return [...this.timers.keys()];
  }
}

export class CatalogIndexer {
  private readonly options: CatalogIndexerOptions;
  private readonly quietQueue: QuietWindowQueue;
  private readonly running = new Map<string, Promise<void>>();
  private readonly activeRequestGenerations = new Map<string, number>();
  private readonly rootScanControllers = new Map<string, AbortController>();
  private readonly activeRootConfigurations = new Map<string, ScanRoot>();
  private readonly activeProfileIdsByRoot = new Map<string, ReadonlySet<string>>();
  private readonly rerun = new Set<string>();
  private readonly watchers = new Map<string, FSWatcher[]>();
  private readonly watcherDirtyPaths = new Map<string, Set<string>>();
  private readonly unknownWatcherDirtyRoots = new Set<string>();
  private readonly cacheFailureCounts = new Map<string, number>();
  private readonly scanTimeoutFailureCounts = new Map<string, number>();
  private readonly scanRetryNotBefore = new Map<string, number>();
  private reconciliationTimer: NodeJS.Timeout | null = null;
  private deepReconciliationTimer: NodeJS.Timeout | null = null;
  private coverPruneTimer: NodeJS.Timeout | null = null;
  private coverPrunePromise: Promise<void> | null = null;
  private activeScanSlots = 0;
  private readonly scanWaiters: Array<() => void> = [];
  private readonly metadataExtractor: MetadataExtractor;
  private readonly metadataWorkerPool: MetadataWorkerPool | null;
  private scanAbortController: AbortController | null = null;
  private stopPromise: Promise<void> | null = null;
  private deepSchedulerReady = false;
  private retired = false;
  private stopped = true;
  private operationalState: (
    component: CatalogOperationalComponent,
    state: CatalogOperationalState,
  ) => void = () => undefined;

  constructor(
    private readonly database: CatalogDatabase,
    private readonly rootPolicy: AllowedRootPolicy,
    private readonly coverCache: CoverCache,
    private readonly emit: (event: ScannerEvent) => void = () => undefined,
    options: Partial<CatalogIndexerOptions> = {},
    metadataExtractor?: MetadataExtractor,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.metadataWorkerPool = metadataExtractor
      ? null
      : new MetadataWorkerPool({
          size: this.options.metadataWorkerCount,
          timeoutMs: this.options.metadataTimeoutMs,
        });
    this.metadataExtractor = metadataExtractor ?? ((filename, format) => this.metadataWorkerPool!.extract(filename, format));
    this.quietQueue = new QuietWindowQueue(this.options.quietWindowMs, (rootId) => {
      void this.scanById(rootId);
    });
  }

  setOperationalStateHandler(
    handler: (component: CatalogOperationalComponent, state: CatalogOperationalState) => void,
  ): void {
    this.operationalState = handler;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    if (this.retired) throw new Error("Catalog indexer cannot restart after it has been retired.");
    this.stopped = false;
    this.scanAbortController = new AbortController();
    const signal = this.scanAbortController.signal;
    await abortable(this.coverCache.initialize(), signal);
    await abortable(this.pruneCoverCache(), signal);
    throwIfAborted(signal);
    const roots = this.database.listScanRoots();
    for (const root of roots) {
      if (this.database.rootScanRequestGeneration(root.id) === null) {
        this.database.requestRootScan(root.id, "startup");
      }
    }
    // withScanSlot enforces the configured global bound while allowing
    // independent roots to make progress concurrently.
    await Promise.all(roots.map((root) => this.scan(root)));
    if (this.stopped) return;
    // The first watcher handles can only be installed after their directory
    // enumeration completes. Close that one startup-only blind window with a
    // bounded authoritative pass for exactly the roots that installed at least
    // one handle. Those handles remain live throughout this follow-up, so any
    // later event is captured by the durable generation queue and coalesced.
    const startupFollowups = this.database
      .listScanRoots()
      .filter((root) => root.watch && this.watchers.has(root.id));
    for (const root of startupFollowups) {
      this.database.requestRootScan(root.id, "startup-followup");
    }
    await Promise.all(startupFollowups.map((root) => this.scan(root)));
    // Installing the first watcher can synchronously surface an event from the
    // startup blind window and supersede the follow-up while it is running.
    // Drain that one retained watch generation before declaring startup ready;
    // continued live churn remains coalesced by the ordinary quiet queue.
    const supersededStartupFollowups = this.database
      .listScanRoots()
      .filter((root) => (
        this.watchers.has(root.id)
        && this.database.rootScanRequest(root.id)?.reason === "watch-event"
      ));
    for (const root of supersededStartupFollowups) this.quietQueue.cancel(root.id);
    await Promise.all(supersededStartupFollowups.map((root) => this.scan(root)));
    if (this.stopped) return;
    this.reconciliationTimer = setInterval(() => {
      try {
        for (const root of this.database.listScanRoots()) this.enqueueDurableScan(root.id, "reconciliation");
      } catch (error) {
        if (isFatalSqliteError(error)) this.operationalState("database", "error");
      }
    }, this.options.reconciliationIntervalMs);
    this.reconciliationTimer.unref();
    this.deepSchedulerReady = true;
    this.scheduleDeepReconciliation();
    this.coverPruneTimer = setInterval(() => {
      void this.pruneCoverCache();
    }, this.options.coverPruneIntervalMs);
    this.coverPruneTimer.unref();
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    this.stopped = true;
    this.retired = true;
    this.deepSchedulerReady = false;
    this.scanAbortController?.abort();
    for (const controller of this.rootScanControllers.values()) controller.abort();
    this.quietQueue.cancelAll();
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    this.reconciliationTimer = null;
    if (this.deepReconciliationTimer) clearTimeout(this.deepReconciliationTimer);
    this.deepReconciliationTimer = null;
    if (this.coverPruneTimer) clearInterval(this.coverPruneTimer);
    this.coverPruneTimer = null;
    for (const rootId of this.watchers.keys()) this.closeWatchers(rootId);
    for (const wake of this.scanWaiters.splice(0)) wake();
    const retirement = Promise.allSettled([
      this.metadataWorkerPool?.close() ?? Promise.resolve(),
      this.coverPrunePromise ?? Promise.resolve(),
      ...this.running.values(),
    ]).then(() => undefined);
    await settleWithin(retirement, this.options.shutdownTimeoutMs);
    // A late filesystem callback may still settle after a forced retirement,
    // but every scan checks the aborted lifecycle before any later DB access.
    this.running.clear();
    this.activeRequestGenerations.clear();
    this.rootScanControllers.clear();
    this.activeRootConfigurations.clear();
    this.activeProfileIdsByRoot.clear();
    this.rerun.clear();
    this.watcherDirtyPaths.clear();
    this.unknownWatcherDirtyRoots.clear();
    this.cacheFailureCounts.clear();
    this.scanTimeoutFailureCounts.clear();
    this.scanRetryNotBefore.clear();
  }

  requestRescan(rootId: string): boolean {
    if (this.stopped || this.retired) return false;
    if (!this.database.listScanRoots().some((root) => root.id === rootId)) return false;
    this.cacheFailureCounts.delete(rootId);
    this.scanTimeoutFailureCounts.delete(rootId);
    this.scanRetryNotBefore.delete(rootId);
    this.enqueueDurableScan(rootId, "manual", true);
    return true;
  }

  /**
   * Wake work that was committed atomically with a Settings replacement.
   * Unlike requestRescan(), this never creates or advances a generation, so a
   * lost-response replay cannot duplicate durable scan work. Startup still
   * discovers the retained row if the process exits before this wake happens.
   */
  wakePendingScan(rootId: string): boolean {
    if (this.stopped || this.retired) return false;
    if (!this.database.listScanRoots().some((root) => root.id === rootId)) return false;
    if (this.database.rootScanRequest(rootId) === null) return false;
    this.cacheFailureCounts.delete(rootId);
    this.scanTimeoutFailureCounts.delete(rootId);
    this.scanRetryNotBefore.delete(rootId);
    this.quietQueue.enqueue(rootId, this.retryAwareQuietDelay(rootId));
    return true;
  }

  pruneInactiveRoots(): void {
    if (this.stopped || this.retired) return;
    const activeRoots = new Map(this.database.listScanRoots().map((root) => [root.id, root]));
    const configuredRoots = new Map(this.database.listRoots().map((root) => [root.id, root]));
    for (const root of activeRoots.values()) {
      if (this.running.has(root.id)) {
        this.activeProfileIdsByRoot.set(root.id, new Set(root.profileIds));
        const activeConfiguration = this.activeRootConfigurations.get(root.id);
        const controller = this.rootScanControllers.get(root.id);
        if (
          activeConfiguration
          && controller
          && !controller.signal.aborted
          && !sameScanSourceConfiguration(activeConfiguration, root)
        ) {
          // A retained root ID may be pointed at a new directory or given new
          // traversal/validation options while the old scan is suspended in
          // filesystem or metadata work. Retire that generation synchronously
          // with the Settings mutation, before its next DB write can repopulate
          // rows from the old configuration. The mutation route durably queues
          // the current configuration immediately after pruning.
          this.closeWatchers(root.id);
          this.watcherDirtyPaths.delete(root.id);
          this.unknownWatcherDirtyRoots.delete(root.id);
          this.database.setRootStatus(root.id, "pending", null);
          controller.abort();
        }
      }
    }
    const managedRootIds = new Set([
      ...configuredRoots.keys(),
      ...this.quietQueue.keys(),
      ...this.watchers.keys(),
      ...this.rerun,
      ...this.rootScanControllers.keys(),
      ...this.activeProfileIdsByRoot.keys(),
    ]);
    for (const rootId of managedRootIds) {
      if (activeRoots.has(rootId)) continue;
      this.quietQueue.cancel(rootId);
      this.rerun.delete(rootId);
      // Empty the recipient set before aborting so a shared synchronous event
      // callback can never publish to a profile after its final active
      // membership has gone away.
      this.activeProfileIdsByRoot.set(rootId, new Set());
      this.rootScanControllers.get(rootId)?.abort();
      const configured = configuredRoots.get(rootId);
      if (configured) {
        this.database.setRootStatus(rootId, "paused", configured.lastErrorCode);
      } else if (!this.running.has(rootId)) {
        this.activeProfileIdsByRoot.delete(rootId);
      }
      this.scanTimeoutFailureCounts.delete(rootId);
      this.scanRetryNotBefore.delete(rootId);
    }
    for (const rootId of this.watchers.keys()) {
      const root = activeRoots.get(rootId);
      if (!root || !root.watch || !this.options.watcherHints) this.closeWatchers(rootId);
    }
    for (const rootId of this.rerun) {
      if (!activeRoots.has(rootId)) this.rerun.delete(rootId);
    }
  }

  async scanNow(rootId: string): Promise<boolean> {
    if (this.stopped || this.retired) return false;
    const root = this.database.listScanRoots().find((candidate) => candidate.id === rootId);
    if (!root) return false;
    this.scanTimeoutFailureCounts.delete(rootId);
    this.scanRetryNotBefore.delete(rootId);
    this.database.requestRootScan(root.id, "explicit");
    this.quietQueue.cancel(root.id);
    await this.scan(root);
    return true;
  }

  private enqueueDurableScan(rootId: string, reason: string, forceNewGeneration = false): void {
    try {
      const pendingRequest = this.database.rootScanRequest(rootId);
      const pendingGeneration = pendingRequest?.generation ?? null;
      const activeGeneration = this.activeRequestGenerations.get(rootId);
      // The table holds one bounded row per root. A generation is advanced only
      // when there is genuinely new work, especially an event arriving after
      // the active scan captured its generation.
      if (
        forceNewGeneration
        || pendingGeneration === null
        || (activeGeneration !== undefined && pendingGeneration <= activeGeneration)
        || (
          pendingRequest !== null
          && isAuthoritativeScanReason(reason)
          && !isAuthoritativeScanReason(pendingRequest.reason)
        )
        || (
          pendingRequest !== null
          && isDeepScanReason(reason)
          && !isDeepScanReason(pendingRequest.reason)
        )
      ) {
        this.database.requestRootScan(rootId, reason);
      }
      this.quietQueue.enqueue(rootId, this.retryAwareQuietDelay(rootId));
    } catch (error) {
      if (isFatalSqliteError(error)) this.operationalState("database", "error");
      // The root may have been removed or disabled between a watcher callback
      // and this request. A future configuration reconciliation is authoritative.
      this.closeWatchers(rootId);
      this.quietQueue.cancel(rootId);
    }
  }

  private wakeSupersedingScan(root: ScanRoot): void {
    if (this.stopped || this.retired) return;
    const currentRoot = this.database.listScanRoots().find((candidate) => candidate.id === root.id);
    if (!currentRoot || !sameScanSourceConfiguration(currentRoot, root)) this.closeWatchers(root.id);
    if (this.database.rootScanRequest(root.id) !== null) this.quietQueue.enqueue(root.id);
  }

  private async scanById(rootId: string): Promise<void> {
    try {
      const retryDelayMs = this.retryDelayRemaining(rootId);
      if (retryDelayMs > 0) {
        this.quietQueue.enqueue(rootId, retryDelayMs);
        return;
      }
      const root = this.database.listScanRoots().find((candidate) => candidate.id === rootId);
      if (root) await this.scan(root);
    } catch (error) {
      if (isFatalSqliteError(error)) this.operationalState("database", "error");
    }
  }

  private scan(root: ScanRoot): Promise<void> {
    const active = this.running.get(root.id);
    if (active) {
      this.rerun.add(root.id);
      return active;
    }
    const lifecycleSignal = this.scanAbortController?.signal;
    if (!lifecycleSignal || lifecycleSignal.aborted || this.stopped) return Promise.resolve();
    const rootController = new AbortController();
    const signal = AbortSignal.any([lifecycleSignal, rootController.signal]);
    let deadlineRetryScheduled = false;
    this.rootScanControllers.set(root.id, rootController);
    this.activeRootConfigurations.set(root.id, root);
    this.activeProfileIdsByRoot.set(root.id, new Set(root.profileIds));
    const operation = this.withScanSlot(async () => {
      deadlineRetryScheduled = await this.performScanWithDeadline(root, signal);
    }, signal)
      .catch((error: unknown) => {
        if (isFatalSqliteError(error)) this.operationalState("database", "error");
      })
      .finally(async () => {
        this.running.delete(root.id);
        this.activeRequestGenerations.delete(root.id);
        if (this.rootScanControllers.get(root.id) === rootController) {
          this.rootScanControllers.delete(root.id);
          this.activeRootConfigurations.delete(root.id);
          this.activeProfileIdsByRoot.delete(root.id);
        }
        const rerunRequested = this.rerun.delete(root.id);
        if (!this.stopped && rerunRequested && !deadlineRetryScheduled) await this.scanById(root.id);
      });
    this.running.set(root.id, operation);
    return operation;
  }

  /**
   * Bound only the time for which a root owns an active scan slot. A large
   * queue therefore does not consume each root's budget before it can start,
   * while a filesystem promise that never settles still releases the shared
   * slot and lets startup/reconciliation continue for other roots.
   */
  private async performScanWithDeadline(root: ScanRoot, parentSignal: AbortSignal): Promise<boolean> {
    const deadlineController = new AbortController();
    const signal = AbortSignal.any([parentSignal, deadlineController.signal]);
    let deadlineExceeded = false;
    const timer = setTimeout(() => {
      deadlineExceeded = true;
      deadlineController.abort();
    }, this.options.scanTimeoutMs);
    try {
      await this.performScan(root, signal);
    } finally {
      clearTimeout(timer);
    }

    if (!deadlineExceeded || parentSignal.aborted || this.stopped) return false;
    const currentRoot = this.database.listScanRoots().find((candidate) => candidate.id === root.id);
    if (
      !currentRoot
      || !sameScanSourceConfiguration(currentRoot, root)
      || (this.activeProfileIdsByRoot.get(root.id)?.size ?? 0) === 0
    ) {
      return false;
    }

    // The interrupted generation remains in scan_requests. That durable row is
    // both crash-safe retry intent and proof that no full-root acknowledgement
    // (including deletion reconciliation or deep-scan clock advancement) was
    // accepted. A bounded in-process backoff avoids hammering a stalled mount;
    // startup on a later process and the periodic schedulers also recover it.
    const requestGeneration = this.activeRequestGenerations.get(root.id);
    if (requestGeneration === undefined) return false;
    try {
      this.database.setRootStatus(
        root.id,
        "error",
        "scan_timeout",
        true,
        { rootId: root.id, generation: requestGeneration },
      );
    } catch (error) {
      if (error instanceof StaleCatalogScanError) {
        this.wakeSupersedingScan(root);
        return true;
      }
      throw error;
    }
    this.emitForProfiles(root, {
      type: "root.unavailable",
      rootId: root.id,
      data: { code: "scan_timeout" },
    });
    const failures = (this.scanTimeoutFailureCounts.get(root.id) ?? 0) + 1;
    this.scanTimeoutFailureCounts.set(root.id, failures);
    const backoffMs = Math.min(
      MAX_SCAN_TIMEOUT_RETRY_MS,
      Math.max(5_000, 5_000 * (2 ** Math.min(8, failures - 1))),
    );
    this.scanRetryNotBefore.set(root.id, Date.now() + backoffMs);
    this.quietQueue.enqueue(root.id, backoffMs);
    this.scheduleDeepReconciliation();
    return true;
  }

  private async withScanSlot(operation: () => Promise<void>, signal: AbortSignal): Promise<void> {
    if (this.activeScanSlots >= this.options.maxConcurrentScans) {
      let wake = (): void => undefined;
      const waiting = new Promise<void>((resolve) => { wake = resolve; });
      this.scanWaiters.push(wake);
      try {
        await abortable(waiting, signal);
      } catch (error) {
        const index = this.scanWaiters.indexOf(wake);
        if (index >= 0) this.scanWaiters.splice(index, 1);
        // The slot may have been released immediately before this waiter was
        // aborted. Hand that capacity to the next live waiter instead of
        // leaving the queue stalled behind the retired root.
        if (this.activeScanSlots < this.options.maxConcurrentScans) {
          this.scanWaiters.shift()?.();
        }
        throw error;
      }
    }
    throwIfAborted(signal);
    this.activeScanSlots += 1;
    try {
      await operation();
    } finally {
      this.activeScanSlots -= 1;
      this.scanWaiters.shift()?.();
    }
  }

  private async performScan(root: ScanRoot, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const request = this.database.claimRootScan(root.id);
    // Another service may have completed the retained request after this root
    // snapshot was read but before our writer-locked claim.
    if (!request) return;
    const requestGeneration = request.generation;
    const fence: RootScanFence = { rootId: root.id, generation: requestGeneration };
    // A root with no retained source rows is fully hashed by its first
    // successful ingestion even though its request is named `startup`. Existing
    // roots keep startup on qf1 and require a distinct due/manual deep pass.
    const fullRootVerification = isDeepScanReason(request.reason)
      || !this.database.rootHasSources(root.id);
    const watcherDirtyPaths = this.watcherDirtyPaths.get(root.id) ?? new Set<string>();
    this.watcherDirtyPaths.delete(root.id);
    const hadUnknownWatcherDirty = this.unknownWatcherDirtyRoots.delete(root.id);
    // A durable watch request can survive a process restart while its in-memory
    // filename hint cannot. Deep-verify that bounded exceptional case.
    const unknownWatcherDirty = hadUnknownWatcherDirty
      || (request.reason === "watch-event" && watcherDirtyPaths.size === 0);
    const discoveredPaths = new Set<string>();
    const verification: ScanVerificationContext = {
      reason: request.reason,
      watcherDirtyPaths,
      unknownWatcherDirty,
      discoveredPaths,
    };
    this.activeRequestGenerations.set(root.id, requestGeneration);
    const scanToken = randomUUID();
    let scanAcknowledged = false;
    try {
      this.database.setRootStatus(root.id, "scanning", null, false, fence);
      this.emitForProfiles(root, { type: "root.scan.started", rootId: root.id });
      const validated = await abortable(this.rootPolicy.validateConfiguredRoot(root.path, false), signal);
      throwIfAborted(signal);
      const rootRealPath = validated.realPath as string;
      const rootStat = await abortable(stat(rootRealPath), signal);
      throwIfAborted(signal);
      const currentMountIdentity = String(rootStat.dev);
      if (root.mountIdentity && root.mountIdentity !== currentMountIdentity) {
        throw new RootPolicyError("path_unavailable", "The source mount identity does not match.");
      }
      if (root.sentinel) await abortable(this.rootPolicy.resolveSource(root.path, root.sentinel), signal);
      const { files, failures, directories } = await this.collectCandidates(root, rootRealPath, signal);
      for (const candidate of files) discoveredPaths.add(candidate.relativePath);
      for (const failure of failures) discoveredPaths.add(failure.relativePath);
      throwIfAborted(signal);
      // One bounded root-level window is enough to make every discovered
      // identity age before it is opened, without multiplying the delay by the
      // number of books in a large library. Descriptor/fresh-path verification
      // below catches any file that changes during snapshotting or parsing.
      const needsStabilityWindow = failures.length > 0 || files.some((candidate) => {
        const existing = this.database.findSource(root.id, candidate.relativePath);
        return existing === null
          || existing.size !== candidate.size
          || existing.mtimeMs !== candidate.mtimeMs;
      });
      if (this.options.stabilityWindowMs > 0 && needsStabilityWindow) {
        await abortable(delay(this.options.stabilityWindowMs), signal);
      }
      let stableGeneration = true;
      let cacheFailure = false;
      let sourceErrorCount = failures.length;
      for (const failure of failures) {
        throwIfAborted(signal);
        this.database.recordSourceError({
          rootId: root.id,
          relativePath: failure.relativePath,
          format: failure.format,
          size: failure.size,
          mtimeMs: failure.mtimeMs,
          contentHash: rejectedSourceFingerprint(failure, failure.errorCode),
          scanToken,
          errorCode: failure.errorCode,
        }, fence);
      }
      for (const candidate of files) {
        throwIfAborted(signal);
        const result = await this.indexCandidate(root, candidate, scanToken, verification, fence, signal);
        if (result === "unstable") stableGeneration = false;
        if (result === "cache-error") {
          cacheFailure = true;
          // A cache-local snapshot failure is systemic, not a property of this
          // source file. Stop after the first failure so a read-only/full cache
          // cannot trigger one doomed copy attempt per book in a large root.
          break;
        }
        if (result === "source-error") sourceErrorCount += 1;
      }
      if (cacheFailure) {
        throwIfAborted(signal);
        this.database.setRootStatus(root.id, "error", "cache_unavailable", false, fence);
        const failures = (this.cacheFailureCounts.get(root.id) ?? 0) + 1;
        this.cacheFailureCounts.set(root.id, failures);
        const backoffMs = Math.min(5 * 60_000, Math.max(5_000, 5_000 * (2 ** Math.min(6, failures - 1))));
        this.quietQueue.enqueue(root.id, backoffMs);
        return;
      }
      if (!stableGeneration) {
        throwIfAborted(signal);
        this.database.setRootStatus(root.id, "error", "unstable_source", false, fence);
        this.quietQueue.enqueue(root.id);
        return;
      }
      throwIfAborted(signal);
      const discoveredFileCount = files.length + failures.length;
      const completion = this.database.completeRootScan(root.id, scanToken, discoveredFileCount, fence);
      if (!completion.confirmed) {
        this.database.setRootStatus(root.id, "unavailable", "empty_scan_unconfirmed", true, fence);
        this.emitForProfiles(root, {
          type: "root.unavailable",
          rootId: root.id,
          data: { code: "empty_scan_unconfirmed" },
        });
        return;
      }
      for (const bookId of completion.unavailableBookIds) {
        throwIfAborted(signal);
        this.emitForProfiles(root, { type: "book.removed", rootId: root.id, bookId });
      }
      throwIfAborted(signal);
      const currentRoot = this.database.listScanRoots().find((candidate) => candidate.id === root.id);
      if (!currentRoot) {
        // Configuration may have disabled or detached the last active
        // membership while this scan was running. Keep Settings history but do
        // not leave stale watchers or a durable request behind.
        this.closeWatchers(root.id);
        this.database.setRootStatus(root.id, "paused", null, true, fence);
        this.database.acknowledgeRootScan(root.id, requestGeneration, fullRootVerification, fence);
        scanAcknowledged = true;
        this.scheduleDeepReconciliation();
        return;
      }
      if (!sameScanSourceConfiguration(currentRoot, root)) {
        // Do not install watcher handles for a configuration that changed while
        // its old path was being scanned. Retain the prior complete watcher set
        // and durably schedule the current configuration instead.
        this.database.setRootStatus(root.id, "pending", null, false, fence);
        this.enqueueDurableScan(root.id, "configuration");
        return;
      }
      let status: "watching" | "paused" | "available";
      let statusError: string | null = null;
      if (!currentRoot.watch) {
        this.closeWatchers(root.id);
        status = "paused";
      } else if (!this.options.watcherHints) {
        this.closeWatchers(root.id);
        status = "available";
      } else {
        const watcherResult = this.replaceWatchers(currentRoot, rootRealPath, directories);
        if (watcherResult === "complete") {
          status = "watching";
        } else {
          status = "paused";
          statusError = watcherResult === "truncated" ? "watch_directory_limit" : "watch_unavailable";
        }
      }
      if (sourceErrorCount > 0 && !statusError) statusError = `source_errors:${sourceErrorCount}`;
      throwIfAborted(signal);
      this.database.setRootStatus(root.id, status, statusError, true, fence);
      this.database.acknowledgeRootScan(root.id, requestGeneration, fullRootVerification, fence);
      scanAcknowledged = true;
      this.cacheFailureCounts.delete(root.id);
      this.scanTimeoutFailureCounts.delete(root.id);
      this.scanRetryNotBefore.delete(root.id);
      this.scheduleDeepReconciliation();
      this.emitForProfiles(root, {
        type: "root.scan.completed",
        rootId: root.id,
        data: {
          files: discoveredFileCount,
          unavailable: completion.unavailableBookIds.length,
          sourceErrors: sourceErrorCount,
          status,
        },
      });
    } catch (error) {
      if (error instanceof ScanAbortedError || signal.aborted) return;
      if (error instanceof StaleCatalogScanError) {
        // The newer generation was committed by another request/process. Its
        // durable row is the authoritative retry intent; wake it locally when
        // still present, but never manufacture another generation here.
        this.wakeSupersedingScan(root);
        return;
      }
      if (isFatalSqliteError(error)) {
        this.operationalState("database", "error");
        return;
      }
      const permissionDenied = error instanceof RootPolicyError && error.code === "permission_denied";
      const unavailable = error instanceof RootPolicyError && error.code === "path_unavailable";
      // Only a validated root/mount failure participates in the two-generation
      // mass-unavailability safeguard. Traversal bounds and nested I/O errors
      // are per-root scan failures and preserve every prior source row.
      try {
        if (permissionDenied || unavailable) this.database.noteRootUnavailable(root.id, fence);
        const status = permissionDenied ? "permission_denied" : unavailable ? "unavailable" : "error";
        const code = safeErrorCode(error);
        this.database.setRootStatus(root.id, status, code, true, fence);
        this.emitForProfiles(root, { type: "root.unavailable", rootId: root.id, data: { code } });
      } catch (statusError) {
        if (statusError instanceof StaleCatalogScanError) {
          this.wakeSupersedingScan(root);
          return;
        }
        throw statusError;
      }
    } finally {
      if (
        !scanAcknowledged
        && !this.stopped
        && (this.activeProfileIdsByRoot.get(root.id)?.size ?? 0) > 0
        && this.database.listScanRoots().some((candidate) => (
          candidate.id === root.id && sameScanSourceConfiguration(candidate, root)
        ))
      ) {
        this.mergeWatcherDirty(root.id, watcherDirtyPaths, unknownWatcherDirty);
      }
    }
  }

  private async collectCandidates(
    root: ScanRoot,
    rootRealPath: string,
    signal: AbortSignal,
  ): Promise<{ files: CandidateFile[]; failures: CandidateFailure[]; directories: string[] }> {
    const files: CandidateFile[] = [];
    const failures: CandidateFailure[] = [];
    const directories = new Set<string>([rootRealPath]);
    const queue: Array<{ directory: string; depth: number }> = [{ directory: rootRealPath, depth: 0 }];
    let queueIndex = 0;
    let entryCount = 0;
    while (queueIndex < queue.length) {
      throwIfAborted(signal);
      const current = queue[queueIndex++] as { directory: string; depth: number };
      const opening = opendir(current.directory);
      const handle = await abortable(opening, signal, (lateHandle) => {
        void lateHandle.close().catch(() => undefined);
      });
      try {
        while (true) {
          const entry = await abortable(handle.read(), signal);
          if (!entry) break;
          entryCount += 1;
          if (entryCount > this.options.maxEntriesPerRoot) {
            throw new ScanRootError("scan_entry_limit");
          }
          const candidatePath = path.join(current.directory, entry.name);
          const symbolicLink = entry.isSymbolicLink();
          let directory = entry.isDirectory();
          let regularFile = entry.isFile();
          const knownType = symbolicLink
            || directory
            || regularFile
            || entry.isBlockDevice()
            || entry.isCharacterDevice()
            || entry.isFIFO()
            || entry.isSocket();
          if (symbolicLink) continue;
          if (!knownType) {
            // d_type is optional filesystem metadata. CIFS/NFS/FUSE and other
            // host-mounted filesystems may report DT_UNKNOWN for every entry,
            // so fall back to one bounded, no-follow classification per entry.
            // Later realpath and descriptor checks remain authoritative against
            // containment and replacement races.
            const details = await abortable(lstat(candidatePath), signal);
            if (details.isSymbolicLink()) continue;
            directory = details.isDirectory();
            regularFile = details.isFile();
          }
          if (directory) {
            if (root.recursive) {
              if (current.depth >= this.options.maxDepth) {
                throw new ScanRootError("scan_depth_limit");
              }
              const canonical = await abortable(
                this.rootPolicy.assertDirectoryInsideRoot(root.path, candidatePath),
                signal,
              );
              if (!directories.has(canonical)) {
                if (directories.size >= this.options.maxDirectoriesPerRoot) {
                  throw new ScanRootError("scan_directory_limit");
                }
                directories.add(canonical);
                queue.push({ directory: canonical, depth: current.depth + 1 });
              }
            }
            continue;
          }
          if (!regularFile) continue;
          const declaredFormat = declaredBookFormat(candidatePath);
          if (!declaredFormat) continue;
          if (files.length + failures.length >= this.options.maxFilesPerRoot) {
            throw new ScanRootError("scan_file_limit");
          }
          const relativePath = path.relative(rootRealPath, candidatePath).split(path.sep).join("/");
          throwIfAborted(signal);
          const existing = this.database.findSource(root.id, relativePath);
          let size = existing?.size ?? 0;
          let mtimeMs = existing?.mtimeMs ?? 0;
          try {
            const resolved = await abortable(this.rootPolicy.resolveSource(root.path, relativePath), signal);
            const details = await abortable(stat(resolved.absolutePath, { bigint: true }), signal);
            throwIfAborted(signal);
            size = Number(details.size);
            mtimeMs = Number(details.mtimeNs) / 1_000_000;
            files.push({
              // Keep the lexical path so O_NOFOLLOW and final-path identity
              // checks can detect a swap after policy resolution.
              filename: resolved.absolutePath,
              relativePath,
              format: declaredFormat,
              size,
              mtimeMs,
              identity: sourceIdentity(details),
            });
          } catch (error) {
            if (error instanceof ScanAbortedError) throw error;
            failures.push({
              relativePath,
              format: declaredFormat,
              size,
              mtimeMs,
              errorCode: safeSourceErrorCode(error),
            });
          }
        }
      } finally {
        if (signal.aborted) {
          void handle.close().catch(() => undefined);
        } else {
          await handle.close().catch(() => undefined);
        }
      }
    }
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    failures.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return { files, failures, directories: [...directories] };
  }

  private async indexCandidate(
    root: ScanRoot,
    candidate: CandidateFile,
    scanToken: string,
    verification: ScanVerificationContext,
    fence: RootScanFence,
    signal: AbortSignal,
  ): Promise<CandidateIndexResult> {
    throwIfAborted(signal);
    const existing = this.database.findSource(root.id, candidate.relativePath);
    const statMatches = Boolean(
      existing
      && existing.size === candidate.size
      && existing.mtimeMs === candidate.mtimeMs,
    );
    let contentHash: string | null = null;
    let detectedFormat = candidate.format;
    let snapshot: CandidateSnapshot | null = null;
    try {
      if (candidate.size > DEFAULT_METADATA_LIMITS.maxBookBytes) {
        this.database.recordSourceError({
          rootId: root.id,
          relativePath: candidate.relativePath,
          format: candidate.format,
          size: candidate.size,
          mtimeMs: candidate.mtimeMs,
          // Error rows cannot participate in strong book matching. Keep their
          // required database identity namespaced so a rejected source is never
          // mistaken for a real SHA-256 content hash.
          contentHash: rejectedSourceFingerprint(candidate, "book_too_large"),
          scanToken,
          errorCode: "book_too_large",
        }, fence);
        return "source-error";
      }

      const cachePresent = existing?.coverKey
        ? await abortable(this.coverCache.has(existing.coverKey), signal).catch((error) => {
            if (error instanceof ScanAbortedError) throw error;
            return false;
          })
        : !existing?.coverExpected;
      const reusable = Boolean(existing?.bookId && existing.lastErrorCode === null && statMatches && cachePresent);
      if (reusable) {
        const watcherDirty = verification.unknownWatcherDirty
          || verification.watcherDirtyPaths.has(candidate.relativePath);
        const deepVerification = isDeepScanReason(verification.reason) || watcherDirty;
        if (!deepVerification && verification.reason === "watch-event") {
          // A watcher callback supplies a per-path hint. Unrelated same-stat
          // candidates can be retained without touching their source bytes.
          throwIfAborted(signal);
          this.database.touchSource(existing!.id, scanToken, undefined, fence);
          return "indexed";
        }
        if (!deepVerification && existing!.quickFingerprint !== null) {
          const quickFingerprint = await this.fingerprintCandidate(root, candidate, signal);
          if (quickFingerprint === existing!.quickFingerprint) {
            throwIfAborted(signal);
            this.database.touchSource(existing!.id, scanToken, undefined, fence);
            return "indexed";
          }
        }
      }
      snapshot = await this.createCandidateSnapshot(root, candidate, signal);
      contentHash = snapshot.contentHash;
      detectedFormat = (await abortable(detectBookFormat(snapshot.filename, candidate.format), signal)) ?? candidate.format;
      // A deep verification or quick-fingerprint mismatch with identical bytes
      // can still avoid the isolated metadata parser and refresh a migrated
      // row's persisted bounded fingerprint.
      if (reusable && contentHash === existing!.contentHash) {
        await this.verifyCandidateSnapshot(root, candidate, snapshot, signal);
        throwIfAborted(signal);
        this.database.touchSource(existing!.id, scanToken, snapshot.quickFingerprint, fence);
        return "indexed";
      }
      const extracted = await abortable(this.metadataExtractor(snapshot.filename, detectedFormat), signal);
      let coverKey: string | null = null;
      if (extracted.cover && extracted.coverMediaType) {
        coverKey = await abortable(
          this.coverCache.store(contentHash, extracted.cover, extracted.coverMediaType),
          signal,
        )
          .then((key) => {
            this.operationalState("cache", "ready");
            return key;
          })
          .catch((error: unknown) => {
            if (error instanceof ScanAbortedError || signal.aborted) throw new ScanAbortedError();
            if (!(error instanceof CoverCacheError) || error.code === "cache_unavailable") {
              this.operationalState("cache", "error");
            }
            return null;
          });
      }
      // Validate both the held descriptor and a fresh no-follow descriptor as
      // the last operation before committing metadata. This rejects in-place
      // growth, atomic replacement, and final symlink substitution while the
      // hash and parser remain bound to one immutable cache-local snapshot.
      await this.verifyCandidateSnapshot(root, candidate, snapshot, signal);
      throwIfAborted(signal);
      const result = this.database.upsertCatalogFile({
        rootId: root.id,
        relativePath: candidate.relativePath,
        format: detectedFormat,
        size: candidate.size,
        mtimeMs: candidate.mtimeMs,
        contentHash,
        quickFingerprint: snapshot.quickFingerprint,
        scanToken,
        retainedRelativePaths: verification.discoveredPaths,
        metadata: { ...extracted, coverKey, coverExpected: Boolean(extracted.cover && extracted.coverMediaType) },
      }, fence);
      this.emitForProfiles(root, {
        type: result.created ? "book.added" : "book.updated",
        rootId: root.id,
        bookId: result.bookId,
      });
      return "indexed";
    } catch (error) {
      if (error instanceof ScanAbortedError || signal.aborted) throw new ScanAbortedError();
      if (error instanceof StaleCatalogScanError) throw error;
      if (error instanceof SourceSnapshotError) {
        // Do not replace a previously good row with transient partial bytes or
        // acknowledge this generation. The root-level retry will reconsider
        // the file after the quiet window.
        return "unstable";
      }
      if (error instanceof CacheSnapshotError) {
        // Cache failures say nothing about immutable source validity. Preserve
        // every prior good row and keep the durable generation pending.
        this.operationalState("cache", "error");
        return "cache-error";
      }
      const errorCode = safeSourceErrorCode(error);
      throwIfAborted(signal);
      this.database.recordSourceError({
        rootId: root.id,
        relativePath: candidate.relativePath,
        format: detectedFormat,
        size: candidate.size,
        mtimeMs: candidate.mtimeMs,
        contentHash: contentHash ?? rejectedSourceFingerprint(candidate, errorCode),
        quickFingerprint: snapshot?.quickFingerprint ?? null,
        scanToken,
        errorCode,
      }, fence);
      return "source-error";
    } finally {
      if (snapshot) {
        await closeSnapshot(snapshot, signal.aborted);
      }
    }
  }

  private async createCandidateSnapshot(
    root: ScanRoot,
    candidate: CandidateFile,
    signal: AbortSignal,
  ): Promise<CandidateSnapshot> {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const sourceOpening = open(candidate.filename, constants.O_RDONLY | noFollow);
    const sourceHandle = await abortable(sourceOpening, signal, (lateHandle) => {
      void lateHandle.close().catch(() => undefined);
    });
    let target: Awaited<ReturnType<CoverCache["createSourceSnapshot"]>> | null = null;
    let snapshotHandle: FileHandle | null = null;
    let retained = false;
    try {
      const openedDetails = await abortable(sourceHandle.stat({ bigint: true }), signal);
      if (!openedDetails.isFile() || !sameSourceIdentity(sourceIdentity(openedDetails), candidate.identity)) {
        throw new SourceSnapshotError();
      }
      await this.verifyCandidatePolicy(root, candidate, sourceIdentity(openedDetails), signal);
      if (openedDetails.size > BigInt(DEFAULT_METADATA_LIMITS.maxBookBytes)) {
        throw new MetadataError("book_too_large", "Book exceeds the configured metadata extraction limit.");
      }

      const targetCreation = this.coverCache.createSourceSnapshot(candidate.filename);
      target = await cacheSnapshotOperation(targetCreation, signal, (lateTarget) => {
        void lateTarget.dispose().catch(() => undefined);
      });
      snapshotHandle = await cacheSnapshotOperation(
        open(target.filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600),
        signal,
        (lateHandle) => { void lateHandle.close().catch(() => undefined); },
      );
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      const expectedSize = Number(openedDetails.size);
      let sourceOffset = 0;
      while (sourceOffset < expectedSize) {
        const requested = Math.min(buffer.length, expectedSize - sourceOffset);
        const { bytesRead } = await abortable(
          sourceHandle.read(buffer, 0, requested, sourceOffset),
          signal,
        );
        if (bytesRead <= 0) throw new SourceSnapshotError();
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await cacheSnapshotOperation(
            snapshotHandle.write(buffer, written, bytesRead - written, sourceOffset + written),
            signal,
          );
          if (result.bytesWritten <= 0) throw new CacheSnapshotError();
          written += result.bytesWritten;
        }
        sourceOffset += bytesRead;
      }
      await cacheSnapshotOperation(snapshotHandle.sync(), signal);
      await cacheSnapshotOperation(snapshotHandle.close(), signal);
      snapshotHandle = null;
      await cacheSnapshotOperation(chmod(target.filename, 0o400), signal);
      const quickFingerprint = await quickSourceFingerprint(sourceHandle, expectedSize, signal);
      const copiedDetails = await abortable(sourceHandle.stat({ bigint: true }), signal);
      const identity = sourceIdentity(openedDetails);
      if (!sameSourceIdentity(sourceIdentity(copiedDetails), identity)) {
        throw new SourceSnapshotError();
      }
      retained = true;
      this.operationalState("cache", "ready");
      return {
        filename: target.filename,
        contentHash: hash.digest("hex"),
        quickFingerprint,
        sourceHandle,
        identity,
        dispose: target.dispose,
      };
    } finally {
      if (!retained) {
        await closeFileHandle(snapshotHandle, signal.aborted);
        await closeFileHandle(sourceHandle, signal.aborted);
        if (target) {
          if (signal.aborted) void target.dispose().catch(() => undefined);
          else await target.dispose().catch(() => undefined);
        }
      }
    }
  }

  private async fingerprintCandidate(
    root: ScanRoot,
    candidate: CandidateFile,
    signal: AbortSignal,
  ): Promise<string> {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const opening = open(candidate.filename, constants.O_RDONLY | noFollow);
    const sourceHandle = await abortable(opening, signal, (lateHandle) => {
      void lateHandle.close().catch(() => undefined);
    });
    try {
      const openedDetails = await abortable(sourceHandle.stat({ bigint: true }), signal);
      const identity = sourceIdentity(openedDetails);
      if (!openedDetails.isFile() || !sameSourceIdentity(identity, candidate.identity)) {
        throw new SourceSnapshotError();
      }
      const fingerprint = await quickSourceFingerprint(
        sourceHandle,
        Number(openedDetails.size),
        signal,
      );
      await this.verifyCandidateSource(root, candidate, sourceHandle, identity, signal);
      return fingerprint;
    } catch (error) {
      if (error instanceof ScanAbortedError || error instanceof SourceSnapshotError) throw error;
      throw new SourceSnapshotError();
    } finally {
      await closeFileHandle(sourceHandle, signal.aborted);
    }
  }

  private async verifyCandidateSnapshot(
    root: ScanRoot,
    candidate: CandidateFile,
    snapshot: CandidateSnapshot,
    signal: AbortSignal,
  ): Promise<void> {
    await this.verifyCandidateSource(root, candidate, snapshot.sourceHandle, snapshot.identity, signal);
  }

  private async verifyCandidateSource(
    root: ScanRoot,
    candidate: CandidateFile,
    sourceHandle: FileHandle,
    identity: SourceIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const heldDetails = await abortable(sourceHandle.stat({ bigint: true }), signal);
      if (!sameSourceIdentity(sourceIdentity(heldDetails), identity)) {
        throw new SourceSnapshotError();
      }
      await this.verifyCandidatePolicy(root, candidate, identity, signal);
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
      const reopening = open(candidate.filename, constants.O_RDONLY | noFollow);
      const currentHandle = await abortable(reopening, signal, (lateHandle) => {
        void lateHandle.close().catch(() => undefined);
      });
      try {
        const currentDetails = await abortable(currentHandle.stat({ bigint: true }), signal);
        if (!currentDetails.isFile() || !sameSourceIdentity(sourceIdentity(currentDetails), identity)) {
          throw new SourceSnapshotError();
        }
      } finally {
        await closeFileHandle(currentHandle, signal.aborted);
      }
    } catch (error) {
      if (error instanceof ScanAbortedError || error instanceof SourceSnapshotError) throw error;
      throw new SourceSnapshotError();
    }
  }

  private async verifyCandidatePolicy(
    root: ScanRoot,
    candidate: CandidateFile,
    identity: SourceIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const resolved = await abortable(
        this.rootPolicy.resolveSource(root.path, candidate.relativePath),
        signal,
      );
      const details = await abortable(stat(resolved.realPath, { bigint: true }), signal);
      if (!details.isFile() || !sameSourceIdentity(sourceIdentity(details), identity)) {
        throw new SourceSnapshotError();
      }
    } catch (error) {
      if (error instanceof ScanAbortedError || error instanceof SourceSnapshotError) throw error;
      throw new SourceSnapshotError();
    }
  }

  private pruneCoverCache(): Promise<void> {
    if (this.coverPrunePromise) return this.coverPrunePromise;
    if (this.stopped && this.scanAbortController !== null) return Promise.resolve();
    let referencedKeys: Set<string>;
    try {
      referencedKeys = this.database.referencedCoverKeys();
    } catch (error) {
      if (isFatalSqliteError(error)) this.operationalState("database", "error");
      return Promise.resolve();
    }
    const operation = this.coverCache
      .pruneUnused(referencedKeys, this.options.coverRetentionMs)
      // Covers are rebuildable. A transient cache-volume error must not make
      // catalog startup or reconciliation unavailable; the next interval
      // retries, while referenced entries are always protected by the DB set.
      .then(() => { this.operationalState("cache", "ready"); })
      .catch(() => { this.operationalState("cache", "error"); });
    this.coverPrunePromise = operation;
    void operation.finally(() => {
      if (this.coverPrunePromise === operation) this.coverPrunePromise = null;
    });
    return operation;
  }

  /**
   * Derive the next full-hash deadline from the last successful completion
   * persisted for every active root. Unlike a process-relative interval, this
   * cannot be postponed indefinitely by container restarts.
   */
  private scheduleDeepReconciliation(): void {
    if (this.deepReconciliationTimer) clearTimeout(this.deepReconciliationTimer);
    this.deepReconciliationTimer = null;
    if (this.stopped || !this.deepSchedulerReady) return;

    const currentTime = Date.now();
    let nextDelayMs = Number.POSITIVE_INFINITY;
    let foundDueRoot = false;
    for (const root of this.database.listScanRoots()) {
      const completedAt = root.lastDeepScanAt === null ? Number.NaN : Date.parse(root.lastDeepScanAt);
      const dueInMs = Number.isFinite(completedAt)
        ? completedAt + this.options.deepReconciliationIntervalMs - currentTime
        : 0;
      if (dueInMs <= 0) {
        foundDueRoot = true;
        this.enqueueDueDeepScan(root.id);
      } else {
        nextDelayMs = Math.min(nextDelayMs, dueInMs);
      }
    }

    if (foundDueRoot) {
      // A failed/unavailable due scan intentionally keeps both its durable
      // request and old completion timestamp. Recheck on a bounded cadence so
      // it recovers without waiting for another process restart.
      const retryDelayMs = Math.max(
        this.options.quietWindowMs + 1,
        Math.min(this.options.reconciliationIntervalMs, MAX_DEEP_RECONCILIATION_RETRY_MS),
      );
      nextDelayMs = Math.min(nextDelayMs, retryDelayMs);
    }
    if (!Number.isFinite(nextDelayMs)) return;

    this.deepReconciliationTimer = setTimeout(() => {
      this.deepReconciliationTimer = null;
      this.scheduleDeepReconciliation();
    }, Math.max(1, Math.min(Math.ceil(nextDelayMs), MAX_TIMER_DELAY_MS)));
    this.deepReconciliationTimer.unref();
  }

  private enqueueDueDeepScan(rootId: string): void {
    try {
      const pending = this.database.rootScanRequest(rootId);
      if (pending && isDeepScanReason(pending.reason)) {
        // Do not create an unnecessary generation behind an already-running
        // deep scan. A retained request without live work is a failed/crashed
        // generation and only needs its quiet-queue retry restored.
        if (!this.running.has(rootId) && !this.quietQueue.has(rootId)) {
          this.quietQueue.enqueue(rootId, this.retryAwareQuietDelay(rootId));
        }
        return;
      }
      this.enqueueDurableScan(rootId, "deep-reconciliation");
    } catch {
      this.quietQueue.cancel(rootId);
    }
  }

  private replaceWatchers(
    root: ScanRoot,
    rootRealPath: string,
    directories: string[],
  ): WatcherInstallResult {
    const previous = this.watchers.get(root.id) ?? [];
    const installed: FSWatcher[] = [];
    const truncated = directories.length > this.options.maxWatchDirectories;
    try {
      for (const directory of directories.slice(0, this.options.maxWatchDirectories)) {
        const watcher = watch(directory, { persistent: false }, (_eventType, filename) => {
          this.noteWatcherDirty(root.id, rootRealPath, directory, filename);
          this.enqueueDurableScan(root.id, "watch-event");
        });
        watcher.on("error", () => this.enqueueDurableScan(root.id, "watch-error"));
        installed.push(watcher);
      }
      if (installed.length === 0) return "unavailable";
      // Publish every replacement before closing any previous handle. Events
      // during a long reconciliation or this short overlap are therefore
      // either observed by the old watcher, the new watcher, or both (the
      // quiet queue safely coalesces duplicates).
      this.watchers.set(root.id, installed);
      for (const watcher of previous) watcher.close();
      return truncated ? "truncated" : "complete";
    } catch {
      for (const watcher of installed) watcher.close();
      // A partial replacement is discarded, but the last complete watcher set
      // remains live until a later scan can replace it.
      return "unavailable";
    }
  }

  private noteWatcherDirty(
    rootId: string,
    rootRealPath: string,
    directory: string,
    filename: string | Buffer | null,
  ): void {
    const leaf = typeof filename === "string" ? filename : filename?.toString("utf8");
    if (!leaf) {
      this.unknownWatcherDirtyRoots.add(rootId);
      return;
    }
    const absolute = path.resolve(directory, leaf);
    const relative = path.relative(rootRealPath, absolute);
    if (
      relative.length === 0
      || path.isAbsolute(relative)
      || relative === ".."
      || relative.startsWith(`..${path.sep}`)
    ) {
      this.unknownWatcherDirtyRoots.add(rootId);
      return;
    }
    const normalized = relative.split(path.sep).join("/");
    this.mergeWatcherDirty(rootId, [normalized], false);
  }

  private mergeWatcherDirty(
    rootId: string,
    paths: Iterable<string>,
    unknown: boolean,
  ): void {
    if (unknown || this.unknownWatcherDirtyRoots.has(rootId)) {
      this.watcherDirtyPaths.delete(rootId);
      this.unknownWatcherDirtyRoots.add(rootId);
      return;
    }
    const dirty = this.watcherDirtyPaths.get(rootId) ?? new Set<string>();
    for (const candidate of paths) {
      if (!dirty.has(candidate) && dirty.size >= this.options.maxWatcherDirtyPaths) {
        this.watcherDirtyPaths.delete(rootId);
        this.unknownWatcherDirtyRoots.add(rootId);
        return;
      }
      dirty.add(candidate);
    }
    if (dirty.size > 0) this.watcherDirtyPaths.set(rootId, dirty);
  }

  private closeWatchers(rootId: string): void {
    for (const watcher of this.watchers.get(rootId) ?? []) watcher.close();
    this.watchers.delete(rootId);
    this.watcherDirtyPaths.delete(rootId);
    this.unknownWatcherDirtyRoots.delete(rootId);
  }

  private retryDelayRemaining(rootId: string): number {
    return Math.max(0, (this.scanRetryNotBefore.get(rootId) ?? 0) - Date.now());
  }

  private retryAwareQuietDelay(rootId: string): number {
    return Math.max(this.options.quietWindowMs, this.retryDelayRemaining(rootId));
  }

  private emitForProfiles(root: ScanRoot, event: ScannerEvent): void {
    const profileIds = this.activeProfileIdsByRoot.get(root.id) ?? root.profileIds;
    for (const profileId of profileIds) this.emit({ ...event, profileId });
  }
}

function rejectedSourceFingerprint(
  candidate: Pick<CandidateFile, "relativePath" | "size" | "mtimeMs">,
  code: string,
): string {
  return `rejected:${code}:${createHash("sha256")
    .update(`${candidate.relativePath}\0${candidate.size}\0${candidate.mtimeMs}`)
    .digest("hex")}`;
}

function declaredBookFormat(filename: string): BookFormat | null {
  const extension = path.extname(filename).toLocaleLowerCase();
  return extension === ".epub" ? "epub" : extension === ".azw3" ? "azw3" : null;
}

/** Detect a supported container from its bytes, using the extension only to
 * retain malformed .epub/.azw3 files as visible indexing errors. */
async function detectBookFormat(
  filename: string,
  declared: BookFormat | null = declaredBookFormat(filename),
): Promise<BookFormat | null> {
  // Temporary downloads and unrelated ZIP/MOBI files are outside the catalog.
  // For a supported ebook extension, bytes remain authoritative over the label.
  if (!declared) return null;
  const handle = await open(filename, "r");
  try {
    const head = Buffer.alloc(78);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
      return "epub";
    }
    if (bytesRead >= 68 && head.subarray(60, 68).toString("ascii") === "BOOKMOBI") {
      return "azw3";
    }
    return declared;
  } finally {
    await handle.close();
  }
}

function isAuthoritativeScanReason(reason: string): boolean {
  return reason === "startup"
    || reason === "startup-followup"
    || reason === "explicit"
    || reason === "manual"
    || reason === "source_changed"
    || reason === "reconciliation"
    || reason === "deep-reconciliation";
}

function sameScanSourceConfiguration(left: ScanRoot, right: ScanRoot): boolean {
  return left.path === right.path
    && left.recursive === right.recursive
    && left.watch === right.watch
    && left.sentinel === right.sentinel
    && left.mountIdentity === right.mountIdentity;
}

function isDeepScanReason(reason: string): boolean {
  return reason === "explicit"
    || reason === "manual"
    || reason === "source_changed"
    || reason === "deep-reconciliation";
}

function safeSourceErrorCode(error: unknown): string {
  if (error instanceof MetadataError) return error.code;
  if (error instanceof SourceSnapshotError) return error.code;
  if (error instanceof RootPolicyError) {
    return error.code === "permission_denied" ? "source_unreadable" : "source_unavailable";
  }
  const systemCode = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (systemCode === "ENOENT" || systemCode === "ENOTDIR" || systemCode === "ESTALE") {
    return "source_unavailable";
  }
  if (systemCode === "ELOOP") return "source_changed";
  if (systemCode === "EACCES" || systemCode === "EPERM") return "source_unreadable";
  if (systemCode === "EIO" || systemCode === "EBUSY") return "source_read_error";
  return safeErrorCode(error);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof ScanRootError || error instanceof SourceSnapshotError) return error.code;
  if (error instanceof MetadataError || error instanceof RootPolicyError) return error.code;
  if (error instanceof Error && /^scan_[a-z_]+$/u.test(error.message)) return error.message;
  return "scan_error";
}

function sourceIdentity(details: BigIntStats): SourceIdentity {
  return {
    dev: details.dev,
    ino: details.ino,
    size: details.size,
    mtimeNs: details.mtimeNs,
    ctimeNs: details.ctimeNs,
  };
}

function sameSourceIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export async function quickSourceFingerprint(
  handle: SourceFingerprintReader,
  size: number,
  signal: AbortSignal,
): Promise<string> {
  if (!Number.isSafeInteger(size) || size < 0 || size > DEFAULT_METADATA_LIMITS.maxBookBytes) {
    throw new SourceSnapshotError();
  }
  const lastStart = Math.max(0, size - QUICK_FINGERPRINT_SAMPLE_BYTES);
  const offsets = [...new Set([
    0,
    Math.floor(lastStart / 3),
    Math.floor((lastStart * 2) / 3),
    lastStart,
  ])].sort((left, right) => left - right);
  const hash = createHash("sha256");
  hash.update(`${QUICK_FINGERPRINT_VERSION}\0${size}\0`);
  for (const offset of offsets) {
    const length = Math.min(QUICK_FINGERPRINT_SAMPLE_BYTES, size - offset);
    hash.update(`${offset}:${length}\0`);
    if (length <= 0) continue;
    const sample = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const result = await abortable(handle.read(sample, read, length - read, offset + read), signal);
      if (result.bytesRead <= 0) throw new SourceSnapshotError();
      read += result.bytesRead;
    }
    hash.update(sample);
  }
  return `${QUICK_FINGERPRINT_VERSION}:${hash.digest("hex")}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ScanAbortedError();
}

function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  disposeLateResult?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    void operation.then(
      (value) => disposeLateResult?.(value),
      () => undefined,
    );
    return Promise.reject(new ScanAbortedError());
  }
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const abort = (): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      reject(new ScanAbortedError());
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        if (finished) {
          disposeLateResult?.(value);
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

async function cacheSnapshotOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  disposeLateResult?: (value: T) => void,
): Promise<T> {
  try {
    return await abortable(operation, signal, disposeLateResult);
  } catch (error) {
    if (error instanceof ScanAbortedError || signal.aborted) throw new ScanAbortedError();
    if (error instanceof CacheSnapshotError) throw error;
    throw new CacheSnapshotError();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function closeFileHandle(handle: FileHandle | null, detached: boolean): Promise<void> {
  if (!handle) return;
  if (detached) {
    void handle.close().catch(() => undefined);
    return;
  }
  await handle.close().catch(() => undefined);
}

async function closeSnapshot(snapshot: CandidateSnapshot, detached: boolean): Promise<void> {
  if (detached) {
    void snapshot.sourceHandle.close().catch(() => undefined);
    void snapshot.dispose().catch(() => undefined);
    return;
  }
  await Promise.allSettled([snapshot.sourceHandle.close(), snapshot.dispose()]);
}

async function settleWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
