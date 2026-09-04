import {
  KindleDevice,
  KindleDeviceError,
  exactKindleObjectInfoFromInventory,
  extractManagedFilenameToken,
  isKindleReadableBookFilename,
  MTP_ACCESS_READ_WRITE,
  MTP_OBJECT_FORMAT_ASSOCIATION,
  normalizeManagedFilenameToken,
  acquireKindleDeviceLease,
  createKindleModificationDateProbe,
  createKindleMetadataCache,
  derivePseudonymousKindleIdentity,
  KindlePartialObjectProbeError,
  presentKindlePartialObjectProbeResult,
  runKindlePartialObjectProbe,
  type KindleBookTransferResult,
  type KindleBookRemovalResult,
  type KindleDeviceLease,
  type KindleDeviceLeaseProvider,
  type KindleDeviceOptions,
  type KindleIdentitySecretProvider,
  type KindleIdentityStability,
  type KindleInventoryOptions,
  type KindleInventorySnapshot,
  type KindleStoredObjectInfo,
  type KindleMetadataCache,
  type KindleModificationDateProbe,
  type KindlePartialObjectProbeRequest,
  type KindlePartialObjectProbeResult,
  type KindlePartialObjectProbePresentation,
  type KindleSelfTestResult,
  type KindleTransferProgress,
} from "./kindle";
import {
  runSafeKindleUpdate,
  SafeKindleUpdateError,
  type SafeKindleUpdateOldCopy,
  type SafeKindleUpdateResult,
  type SafeKindleUpdateStage,
  type SafeKindleUpdateVerifiedCopy,
} from "./safe-kindle-update";
import {
  isReplacementCleanupRecord,
  persistReplacementCleanupRecord,
  type ReplacementCleanupRecord,
  type ReplacementCleanupObject,
} from "./replacement-cleanup-journal";
import {
  MtpObjectStore,
  MtpSession,
  type MtpObjectCreationState,
  type MtpOperationOptions,
} from "./mtp";
import type { DeviceDetails } from "./state";
import { isFatalTransportFailure } from "./error-diagnostics";
import {
  WebUsbBulkTransport,
  captureDescriptorSnapshot,
  getUsbManager,
  maskSerialNumber,
  type UsbDeviceLike,
  type UsbManagerLike,
} from "./usb";

export interface DeviceRuntimeHooks {
  readonly onDescriptor: (details: DeviceDetails, descriptor: Readonly<Record<string, unknown>>) => void;
  readonly onUsbOpen: (details: DeviceDetails) => void;
  readonly onMtpReading: (details: DeviceDetails) => void;
}

export interface SendBookOptions extends MtpOperationOptions {
  /** Whole-operation wall-clock bound across discovery, collision scan, write, and verification. */
  readonly aggregateTimeoutMs?: number;
  readonly onProgress?: (progress: KindleTransferProgress) => void;
  readonly onObjectState?: (state: MtpObjectCreationState) => void;
  readonly managedToken?: string;
}

export interface RemoveKindleBooksOptions extends MtpOperationOptions {
  /** Whole-operation wall-clock bound across exact revalidation and deletion. */
  readonly aggregateTimeoutMs?: number;
}

export interface KindlePostConnectOptions {
  readonly inventory?: KindleInventoryRefreshOptions;
  readonly selfTest?: SendBookOptions;
}

export interface KindleInventoryRefreshOptions extends KindleInventoryOptions {
  /** Whole-refresh wall-clock bound in addition to each MTP command bound. */
  readonly aggregateTimeoutMs?: number;
}

export interface KindlePostConnectResult {
  readonly selfTest: KindleSelfTestResult;
  readonly inventory?: KindleInventorySnapshot;
  readonly inventoryRefresh: "complete" | "partial" | "failed";
  readonly inventoryErrorCode?: string;
}

export interface KindleSendAndRefreshResult {
  readonly transfer: KindleBookTransferResult;
  readonly inventory?: KindleInventorySnapshot;
  readonly inventoryRefresh: "complete" | "partial" | "failed";
  readonly inventoryErrorCode?: string;
  /** The transfer verified, but the MTP session then lost synchronization. */
  readonly connectionFaulted?: true;
}

export interface KindleRemoveBooksAndRefreshResult {
  readonly removals: readonly KindleBookRemovalResult[];
  readonly inventory?: KindleInventorySnapshot;
  readonly inventoryRefresh: "complete" | "partial" | "failed";
  readonly inventoryErrorCode?: string;
  /** Removal succeeded, but the MTP session then lost synchronization. */
  readonly connectionFaulted?: true;
}

export interface KindleRemoveBookAndRefreshResult
  extends Omit<KindleRemoveBooksAndRefreshResult, "removals"> {
  readonly removal: KindleBookRemovalResult;
}

export interface OpenKindleOptions extends MtpOperationOptions {
  readonly leaseProvider?: KindleDeviceLeaseProvider;
  readonly identitySecretProvider?: KindleIdentitySecretProvider;
  readonly kindleOptions?: KindleDeviceOptions;
  /** Injectable browser-local acceleration; raw Kindle inventory never leaves the browser. */
  readonly metadataCache?: KindleMetadataCache;
  /** Injectable, page-local aggregate probe; it never persists or logs raw device values. */
  readonly modificationDateProbe?: KindleModificationDateProbe;
  /** Explicit development-session opt-in; normal application connections leave this disabled. */
  readonly enableDevelopmentPartialObjectProbe?: boolean;
}

export interface KindlePartialObjectProbeOptions extends MtpOperationOptions {
  /** Whole-probe wall-clock bound across all bounded range samples. */
  readonly aggregateTimeoutMs?: number;
  /** Explicit confirmation required to repeat this diagnostic in one connection. */
  readonly allowRepeat?: boolean;
  /** Whole-object comparison is attempted only at or below this hard-bounded ceiling. */
  readonly maxReferenceBytes?: number;
}

export interface PreparedKindleManagedUpdate {
  /** Already prepared, validated PDOC derivative; mounted source bytes are never accepted here. */
  readonly blob: Blob;
  readonly originalFilename: string;
  readonly artifactHash: string;
  readonly managedToken: string;
  readonly sourceFormat: "epub" | "azw3";
  readonly hasPresentationEdits: boolean;
}

export interface KindleManagedOldCopyEvidence {
  readonly handle: number;
  readonly filename: string;
  readonly byteLength: number;
  readonly managedToken: string;
}

export interface KindleManagedUpdateDelivery {
  readonly operationId: string;
  readonly artifactHash: string;
  readonly managedToken: string;
  readonly transfer: KindleBookTransferResult;
  /** Exact ObjectInfo comparison key for local reconciliation; not deletion authority. */
  readonly exactIdentity: string;
}

export interface KindleManagedUpdateOptions {
  readonly operationId: string;
  readonly transfer?: SendBookOptions;
  readonly inventory?: KindleInventoryRefreshOptions;
  readonly freeSpaceReserveBytes?: bigint;
  readonly onStage?: (stage: SafeKindleUpdateStage) => void;
  /** Resolving means the verified replacement was accepted durably. */
  readonly recordVerifiedDelivery: (delivery: KindleManagedUpdateDelivery) => Promise<void>;
  /** Runs once with the final live inventory (including duplicate state on cleanup failure). */
  readonly reconcile: (inventory: KindleInventorySnapshot) => Promise<void>;
  readonly replacementCleanupStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly now?: () => number;
}

export type KindleManagedUpdateResult = SafeKindleUpdateResult & {
  readonly inventory?: KindleInventorySnapshot;
  readonly cleanupRecord?: ReplacementCleanupRecord;
};

export interface KindleReplacementCleanupOptions {
  readonly operation?: RemoveKindleBooksOptions;
  readonly inventory?: KindleInventoryRefreshOptions;
}

export interface KindleReplacementCleanupResult {
  readonly status: "cleaned" | "rolled-back" | "already-resolved";
  readonly inventory: KindleInventorySnapshot;
}

const defaultKindleMetadataCache = createKindleMetadataCache();
const defaultKindleModificationDateProbe = createKindleModificationDateProbe();
const MAX_UPDATE_PARENT_HANDLES = 10_000;

function exactObjectIdentity(info: KindleStoredObjectInfo): string {
  return JSON.stringify([
    info.handle,
    info.storageId,
    info.objectFormat,
    info.protectionStatus,
    info.compressedSize,
    info.parentHandle,
    info.associationType,
    info.filename,
    info.modificationDate,
  ]);
}

function sameStoredObjectInfo(left: KindleStoredObjectInfo, right: KindleStoredObjectInfo): boolean {
  return exactObjectIdentity(left) === exactObjectIdentity(right);
}

function validOperationId(value: string): boolean {
  return value.length > 0
    && value.length <= 96
    && /^[a-zA-Z0-9._:-]+$/u.test(value);
}

function exactUpdateInventoryOptions(
  options: KindleInventoryRefreshOptions | undefined,
): KindleInventoryRefreshOptions {
  return {
    ...options,
    bookMetadata: false,
    kfxSidecarMetadata: false,
    readingSidecars: false,
    deviceMetadataCache: false,
  };
}

function replacementObjectFromInventory(
  inventory: KindleInventorySnapshot,
  expected: ReplacementCleanupObject,
): KindleStoredObjectInfo | undefined {
  const object = inventory.objects.find((candidate) => candidate.handle === expected.handle);
  const exact = exactKindleObjectInfoFromInventory(inventory, expected.handle);
  if (
    object?.kind !== "file"
    || exact === undefined
    || object.storageId !== inventory.storageId
    || object.parentHandle !== inventory.documentsHandle
    || object.depth !== 1
    || object.relativePath !== object.filename
    || object.metadataAdjusted
    || object.filename !== expected.filename
    || object.size !== expected.byteLength
    || object.managedToken !== expected.managedToken
    || extractManagedFilenameToken(object.filename) !== expected.managedToken
    || exact.handle !== expected.handle
    || exact.storageId !== expected.storageId
    || exact.parentHandle !== expected.parentHandle
    || exact.filename !== expected.filename
    || exact.compressedSize !== expected.byteLength
    || exact.objectFormat === MTP_OBJECT_FORMAT_ASSOCIATION
    || exact.associationType !== 0
    || exact.protectionStatus !== 0
    || !isKindleReadableBookFilename(exact.filename)
  ) {
    return undefined;
  }
  return exact;
}

function inventoryContainsReplacementIdentity(
  inventory: KindleInventorySnapshot,
  expected: ReplacementCleanupObject,
): boolean {
  return inventory.objects.some((object) => object.kind === "file" && (
    object.filename === expected.filename
    || object.managedToken === expected.managedToken
    || extractManagedFilenameToken(object.filename) === expected.managedToken
  ));
}

function managedOldCopyFromInventory(
  inventory: KindleInventorySnapshot,
  evidence: KindleManagedOldCopyEvidence,
): {
  readonly safe: SafeKindleUpdateOldCopy;
  readonly exact: KindleStoredObjectInfo;
  readonly managedToken: string;
} {
  let managedToken: string;
  try {
    managedToken = normalizeManagedFilenameToken(evidence.managedToken);
  } catch {
    throw new SafeKindleUpdateError("OLD_COPY_NOT_MANAGED", "Update requires an exact KindleBridge-managed prior copy.");
  }
  if (inventory.status !== "complete") {
    throw new SafeKindleUpdateError("INVENTORY_INCOMPLETE", "Update requires a complete current Kindle inventory.");
  }
  const object = inventory.objects.find((candidate) => candidate.handle === evidence.handle);
  const exact = exactKindleObjectInfoFromInventory(inventory, evidence.handle);
  if (
    object?.kind !== "file"
    || exact === undefined
    || object.depth !== 1
    || object.parentHandle !== inventory.documentsHandle
    || object.metadataAdjusted
    || object.filename !== evidence.filename
    || object.size !== evidence.byteLength
    || object.managedToken !== managedToken
    || extractManagedFilenameToken(object.filename) !== managedToken
    || exact.storageId !== inventory.storageId
    || exact.parentHandle !== inventory.documentsHandle
    || exact.filename !== object.filename
    || exact.compressedSize !== object.size
    || exact.objectFormat === MTP_OBJECT_FORMAT_ASSOCIATION
    || exact.associationType !== 0
    || exact.protectionStatus !== 0
    || !isKindleReadableBookFilename(exact.filename)
  ) {
    throw new SafeKindleUpdateError(
      "OLD_COPY_NOT_MANAGED",
      "Update requires one unchanged, direct-child KindleBridge-managed prior copy from the current inventory.",
    );
  }
  return {
    safe: Object.freeze({
      handle: exact.handle,
      filename: exact.filename,
      byteLength: exact.compressedSize,
      exactIdentity: exactObjectIdentity(exact),
    }),
    exact,
    managedToken,
  };
}

export class KindleRuntimeBusyError extends Error {
  readonly code = "KINDLE_OPERATION_BUSY" as const;

  constructor() {
    super("Another operation is already using this Kindle connection.");
    this.name = "KindleRuntimeBusyError";
  }
}

function safeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code)
    ? code
    : undefined;
}

function isFatalInventoryError(error: unknown): boolean {
  return isFatalTransportFailure(error);
}

async function inventoryWithAggregateDeadline(
  kindle: KindleDevice,
  options: KindleInventoryRefreshOptions = {},
): Promise<KindleInventorySnapshot> {
  return operationWithAggregateDeadline(
    "Kindle inventory",
    options,
    (operationOptions) => kindle.inventory(operationOptions),
  );
}

async function operationWithAggregateDeadline<T, TOptions extends MtpOperationOptions & {
  readonly aggregateTimeoutMs?: number;
}>(
  activity: string,
  options: TOptions,
  operation: (options: Omit<TOptions, "aggregateTimeoutMs">) => Promise<T>,
): Promise<T> {
  const { aggregateTimeoutMs, ...operationOptions } = options;
  if (aggregateTimeoutMs === undefined) {
    return operation(operationOptions as Omit<TOptions, "aggregateTimeoutMs">);
  }
  if (!Number.isFinite(aggregateTimeoutMs) || aggregateTimeoutMs <= 0) {
    throw new TypeError("aggregateTimeoutMs must be a positive finite number");
  }
  const controller = new AbortController();
  const parentSignal = operationOptions.signal;
  const abortFromParent = (): void => {
    controller.abort(parentSignal?.reason ?? new DOMException(`${activity} aborted`, "AbortError"));
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException(
      `${activity} exceeded its ${Math.ceil(aggregateTimeoutMs)} ms aggregate deadline`,
      "TimeoutError",
    ));
  }, aggregateTimeoutMs);
  try {
    return await operation({
      ...operationOptions,
      signal: controller.signal,
    } as Omit<TOptions, "aggregateTimeoutMs">);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function initialDetails(device: UsbDeviceLike): DeviceDetails {
  return {
    vendorId: device.vendorId,
    productId: device.productId,
    manufacturerName: device.manufacturerName,
    productName: device.productName,
    serialNumber: maskSerialNumber(device.serialNumber),
  };
}

async function releaseLeaseAfterUsbQuiesces(
  transport: WebUsbBulkTransport,
  lease: KindleDeviceLease,
): Promise<void> {
  if (!transport.hasPendingNativeOperations) {
    await lease.release();
    return;
  }
  // WebUSB promises cannot be cancelled. Keep the cross-tab writer lease
  // poisoned until every native operation really settles, even though UI
  // cleanup returns promptly after its bounded close attempts.
  void transport.waitForNativeOperations()
    .then(() => lease.release())
    .catch(() => {
      // Fail closed: an unreleased lease is safer than a second tab racing the
      // still-active native operation. Document teardown releases Web Locks.
    });
}

export class ConnectedKindle {
  readonly device: UsbDeviceLike;
  readonly details: DeviceDetails;
  /** Opaque HMAC pseudonym suitable for local delivery records; never render or log it. */
  readonly identityKey?: string;
  /** Installation stability requires origin storage; otherwise the key is session-only. */
  readonly identityKeyStability?: KindleIdentityStability;
  readonly #transport: WebUsbBulkTransport;
  readonly #session: MtpSession;
  readonly #kindle: KindleDevice;
  readonly #lease: KindleDeviceLease;
  readonly #developmentPartialObjectProbeEnabled: boolean;
  #developmentPartialObjectProbeRuns = 0;
  #closed = false;
  #closePromise?: Promise<void>;
  #operationActive = false;
  #selfTestResult?: KindleSelfTestResult;
  #inventory?: KindleInventorySnapshot;

  constructor(
    device: UsbDeviceLike,
    details: DeviceDetails,
    transport: WebUsbBulkTransport,
    session: MtpSession,
    kindle: KindleDevice,
    lease: KindleDeviceLease,
    identityKey?: string,
    identityKeyStability?: KindleIdentityStability,
    developmentPartialObjectProbeEnabled = false,
  ) {
    this.device = device;
    this.details = Object.freeze({ ...details });
    this.#transport = transport;
    this.#session = session;
    this.#kindle = kindle;
    this.#lease = lease;
    this.identityKey = identityKey;
    this.identityKeyStability = identityKeyStability;
    this.#developmentPartialObjectProbeEnabled = developmentPartialObjectProbeEnabled;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get readyForSend(): boolean {
    return !this.#closed && this.#session.isOpen && this.#selfTestResult?.cleanedUp === true;
  }

  get latestInventory(): KindleInventorySnapshot | undefined {
    return this.#inventory;
  }

  get successfulSelfTest(): KindleSelfTestResult | undefined {
    return this.#selfTestResult;
  }

  async runSelfTest(options: SendBookOptions = {}): Promise<KindleSelfTestResult> {
    return this.#runExclusive(async () => {
      this.#selfTestResult = undefined;
      const result = await operationWithAggregateDeadline(
        "Kindle exact-byte self-test",
        options,
        (operationOptions) => this.#kindle.runSelfTest(operationOptions),
      );
      this.#selfTestResult = result;
      return result;
    });
  }

  /**
   * Development-only read probe. This is deliberately not called by normal
   * connection or inventory orchestration and cannot be enabled by device
   * advertising alone.
   */
  runDevelopmentPartialObjectProbe(
    request: KindlePartialObjectProbeRequest,
    options: KindlePartialObjectProbeOptions = {},
  ): Promise<KindlePartialObjectProbeResult> {
    return this.#runExclusive(async () => {
      if (!this.#developmentPartialObjectProbeEnabled) {
        throw new KindlePartialObjectProbeError(
          "KINDLE_PARTIAL_OBJECT_PROBE_DISABLED",
          "The development GetPartialObject probe was not enabled for this connection.",
        );
      }
      const { allowRepeat = false, ...probeOptions } = options;
      if (this.#developmentPartialObjectProbeRuns > 0 && !allowRepeat) {
        throw new KindlePartialObjectProbeError(
          "KINDLE_PARTIAL_OBJECT_PROBE_ALREADY_RUN",
          "The partial-object diagnostic already ran in this connection; repeat requires explicit confirmation.",
        );
      }
      this.#developmentPartialObjectProbeRuns += 1;
      return operationWithAggregateDeadline(
        "Kindle partial-object development probe",
        probeOptions,
        (operationOptions) => runKindlePartialObjectProbe(
          this.#kindle.store,
          this.details.operationsSupported,
          request,
          operationOptions,
        ),
      );
    });
  }

  /**
   * Advanced-panel adapter: derives size/protection from one exact live
   * inventory object and returns byte-free presentation metrics.
   */
  runAdvancedPartialObjectProbe(
    handle: number,
    options: KindlePartialObjectProbeOptions = {},
  ): Promise<KindlePartialObjectProbePresentation> {
    return this.#runExclusive(async () => {
      if (!this.#developmentPartialObjectProbeEnabled) {
        throw new KindlePartialObjectProbeError(
          "KINDLE_PARTIAL_OBJECT_PROBE_DISABLED",
          "The development GetPartialObject probe was not enabled for this connection.",
        );
      }
      const inventory = this.#inventory;
      const object = inventory?.objects.find((candidate) => candidate.handle === handle);
      const exact = inventory === undefined ? undefined : exactKindleObjectInfoFromInventory(inventory, handle);
      if (
        inventory?.status !== "complete"
        || object?.kind !== "file"
        || exact === undefined
        || exact.protectionStatus !== 0
        || exact.objectFormat === MTP_OBJECT_FORMAT_ASSOCIATION
        || exact.associationType !== 0
        || exact.compressedSize < 1
      ) {
        throw new KindlePartialObjectProbeError(
          "KINDLE_PARTIAL_OBJECT_PROBE_SELECTION_INVALID",
          "Select one unprotected file from this connection's complete live inventory.",
        );
      }
      const { allowRepeat = false, ...probeOptions } = options;
      if (this.#developmentPartialObjectProbeRuns > 0 && !allowRepeat) {
        throw new KindlePartialObjectProbeError(
          "KINDLE_PARTIAL_OBJECT_PROBE_ALREADY_RUN",
          "The partial-object diagnostic already ran in this connection; repeat requires explicit confirmation.",
        );
      }
      this.#developmentPartialObjectProbeRuns += 1;
      const live = await this.#kindle.store.getObjectInfo(handle, probeOptions);
      if (!sameStoredObjectInfo(live, exact)) {
        throw new KindlePartialObjectProbeError(
          "KINDLE_PARTIAL_OBJECT_PROBE_SELECTION_INVALID",
          "The selected object changed after inventory; refresh before probing it.",
        );
      }
      const siblings = await this.#kindle.store.listObjectHandles({
        storageId: exact.storageId,
        associationHandle: exact.parentHandle,
        maxHandles: MAX_UPDATE_PARENT_HANDLES,
      }, probeOptions);
      if (!siblings.includes(handle)) {
        throw new KindlePartialObjectProbeError(
          "KINDLE_PARTIAL_OBJECT_PROBE_SELECTION_INVALID",
          "The selected object is no longer in its inventoried parent folder.",
        );
      }
      const result = await operationWithAggregateDeadline(
        "Kindle partial-object Advanced diagnostic",
        probeOptions,
        (operationOptions) => runKindlePartialObjectProbe(
          this.#kindle.store,
          this.details.operationsSupported,
          { handle, objectSize: exact.compressedSize },
          operationOptions,
        ),
      );
      return presentKindlePartialObjectProbeResult(result);
    });
  }

  refreshInventory(options: KindleInventoryRefreshOptions = {}): Promise<KindleInventorySnapshot> {
    return this.#runExclusive(async () => {
      if (options.deviceMetadataCache === "read-write" && !this.#selfTestResult?.cleanedUp) {
        throw new KindleDeviceError(
          "MTP_SELF_TEST_REQUIRED",
          "The exact-byte safe-write check must pass before updating the Kindle metadata cache.",
        );
      }
      const inventory = await inventoryWithAggregateDeadline(this.#kindle, options);
      this.#inventory = inventory;
      return inventory;
    });
  }

  /** Root integration should call this immediately after a successful connect. */
  prepareAfterConnect(
    options: KindlePostConnectOptions = {},
  ): Promise<KindlePostConnectResult> {
    return this.#runExclusive(async () => {
      // The byte proof is deliberately first so a large inventory cannot delay
      // the required current-connection write-safety gate.
      this.#selfTestResult = undefined;
      const selfTest = await operationWithAggregateDeadline(
        "Kindle exact-byte self-test",
        options.selfTest ?? {},
        (operationOptions) => this.#kindle.runSelfTest(operationOptions),
      );
      this.#selfTestResult = selfTest;
      try {
        const inventory = await inventoryWithAggregateDeadline(this.#kindle, options.inventory);
        this.#inventory = inventory;
        return {
          selfTest,
          inventory,
          inventoryRefresh: inventory.status,
        };
      } catch (error) {
        if (isFatalInventoryError(error)) throw error;
        const inventoryErrorCode = safeErrorCode(error);
        return {
          selfTest,
          inventoryRefresh: "failed",
          ...(inventoryErrorCode === undefined ? {} : { inventoryErrorCode }),
        };
      }
    });
  }

  sendAzW3(
    blob: Blob,
    originalFilename: string,
    options: SendBookOptions = {},
  ): Promise<KindleBookTransferResult> {
    return this.#runExclusive(() => operationWithAggregateDeadline(
      "Kindle book transfer",
      options,
      (operationOptions) => this.#kindle.sendAzW3(blob, originalFilename, operationOptions),
    ));
  }

  /**
   * Full-product send: requires this connection's safe-write proof, preserves
   * the open session for more sends, and refreshes inventory without turning a
   * post-transfer refresh failure into an ambiguous upload failure.
   */
  sendAzW3AndRefreshInventory(
    blob: Blob,
    originalFilename: string,
    options: SendBookOptions = {},
    inventoryOptions: KindleInventoryRefreshOptions = {},
  ): Promise<KindleSendAndRefreshResult> {
    return this.#runExclusive(async () => {
      if (!this.#selfTestResult?.cleanedUp) {
        throw new KindleDeviceError(
          "MTP_SELF_TEST_REQUIRED",
          "The exact-byte safe-write check must pass in this connection before sending.",
        );
      }
      const transfer = await operationWithAggregateDeadline(
        "Kindle book transfer",
        options,
        (operationOptions) => this.#kindle.sendAzW3(blob, originalFilename, operationOptions),
      );
      try {
        const inventory = await inventoryWithAggregateDeadline(this.#kindle, inventoryOptions);
        this.#inventory = inventory;
        return {
          transfer,
          inventory,
          inventoryRefresh: inventory.status,
        };
      } catch (error) {
        const inventoryErrorCode = safeErrorCode(error);
        return {
          transfer,
          inventoryRefresh: "failed",
          ...(inventoryErrorCode === undefined ? {} : { inventoryErrorCode }),
          ...(isFatalInventoryError(error) ? { connectionFaulted: true as const } : {}),
        };
      }
    });
  }

  /**
   * Upload-first replacement transaction for an already prepared derivative.
   * Preparation deliberately belongs to the caller and therefore completes
   * before this method acquires the one device-operation lock.
   */
  updateManagedBook(
    prepared: PreparedKindleManagedUpdate,
    oldEvidence: KindleManagedOldCopyEvidence,
    options: KindleManagedUpdateOptions,
  ): Promise<KindleManagedUpdateResult> {
    if (prepared.sourceFormat === "azw3" && prepared.hasPresentationEdits) {
      return Promise.reject(new SafeKindleUpdateError(
        "UNSUPPORTED_EDITED_AZW3",
        "Edited AZW3 sources remain unsupported until bounded container reconstruction is available.",
      ));
    }
    if (!validOperationId(options.operationId)) {
      return Promise.reject(new TypeError("operationId must be 1 to 96 safe identifier characters"));
    }
    let newManagedToken: string;
    try {
      newManagedToken = normalizeManagedFilenameToken(prepared.managedToken);
    } catch {
      return Promise.reject(new SafeKindleUpdateError(
        "INVALID_UPDATE_ARTIFACT",
        "The prepared replacement does not contain a valid KindleBridge managed token.",
      ));
    }
    if (prepared.blob.size <= 0 || prepared.blob.size > 0xffff_ffff) {
      return Promise.reject(new SafeKindleUpdateError(
        "INVALID_UPDATE_ARTIFACT",
        "The prepared replacement has an invalid byte length.",
      ));
    }

    // This pre-lock capability is intentionally stronger than a UI match. It
    // can exist only on a complete inventory returned by this live connection.
    const current = this.#inventory;
    if (current === undefined) {
      return Promise.reject(new SafeKindleUpdateError(
        "INVENTORY_INCOMPLETE",
        "Update requires the current connection's complete Kindle inventory.",
      ));
    }
    let initialOld: ReturnType<typeof managedOldCopyFromInventory>;
    try {
      initialOld = managedOldCopyFromInventory(current, oldEvidence);
    } catch (error) {
      return Promise.reject(error);
    }
    if (newManagedToken === initialOld.managedToken) {
      return Promise.reject(new SafeKindleUpdateError(
        "INVALID_UPDATE_ARTIFACT",
        "The replacement must carry a new presentation-version managed token.",
      ));
    }

    let oldExact = initialOld.exact;
    let firstLockedRevalidationComplete = false;
    let uploadedTransfer: KindleBookTransferResult | undefined;
    let verifiedNewExact: KindleStoredObjectInfo | undefined;
    let finalInventory: KindleInventorySnapshot | undefined;
    let cleanupRecord: ReplacementCleanupRecord | undefined;
    const inventoryOptions = exactUpdateInventoryOptions(options.inventory);

    const requireParentMembership = async (
      info: KindleStoredObjectInfo,
      operationOptions: MtpOperationOptions,
    ): Promise<void> => {
      const handles = await this.#kindle.store.listObjectHandles({
        storageId: info.storageId,
        associationHandle: info.parentHandle,
        maxHandles: MAX_UPDATE_PARENT_HANDLES,
      }, operationOptions);
      if (!handles.includes(info.handle)) {
        throw new SafeKindleUpdateError("OLD_COPY_CHANGED", "The managed Kindle object is no longer in its exact parent folder.");
      }
    };

    return runSafeKindleUpdate(initialOld.safe, {
      prepare: async () => ({
        filename: prepared.originalFilename,
        byteLength: prepared.blob.size,
        artifactHash: prepared.artifactHash,
        value: prepared.blob,
      }),
      withDeviceLock: (operation) => this.#runExclusive(operation),
      ensureCurrentConnectionWriteProof: async () => {
        if (!this.#selfTestResult?.cleanedUp) {
          throw new KindleDeviceError(
            "MTP_SELF_TEST_REQUIRED",
            "The exact-byte safe-write check must pass in this connection before updating a Kindle copy.",
          );
        }
      },
      revalidateOldCopy: async () => {
        if (!firstLockedRevalidationComplete) {
          const refreshed = await inventoryWithAggregateDeadline(this.#kindle, inventoryOptions);
          this.#inventory = refreshed;
          const revalidated = managedOldCopyFromInventory(refreshed, oldEvidence);
          await requireParentMembership(revalidated.exact, options.transfer ?? {});
          oldExact = revalidated.exact;
          firstLockedRevalidationComplete = true;
          return revalidated.safe;
        }
        const live = await this.#kindle.store.getObjectInfo(oldExact.handle, options.transfer ?? {});
        await requireParentMembership(live, options.transfer ?? {});
        if (!sameStoredObjectInfo(live, oldExact)) {
          return {
            handle: live.handle,
            filename: live.filename,
            byteLength: live.compressedSize,
            exactIdentity: exactObjectIdentity(live),
          };
        }
        return initialOld.safe;
      },
      readFreeBytes: async () => {
        const target = this.#kindle.currentTarget;
        if (!target) {
          throw new SafeKindleUpdateError("OLD_COPY_CHANGED", "The selected Kindle storage is no longer available.");
        }
        if (target.storageId !== oldExact.storageId || target.documentsHandle !== oldExact.parentHandle) {
          throw new SafeKindleUpdateError("OLD_COPY_CHANGED", "The selected Kindle Documents storage changed before update.");
        }
        const storage = await this.#kindle.store.getStorageInfo(target.storageId, options.transfer ?? {});
        if (storage.accessCapability !== MTP_ACCESS_READ_WRITE) {
          throw new KindleDeviceError("MTP_STORAGE_NOT_WRITABLE", "The selected Kindle storage is no longer writable.");
        }
        return storage.freeSpaceInBytes;
      },
      uploadNewCopy: async () => {
        uploadedTransfer = await operationWithAggregateDeadline(
          "Kindle replacement upload",
          { ...(options.transfer ?? {}), managedToken: newManagedToken },
          (operationOptions) => this.#kindle.sendAzW3(
            prepared.blob,
            prepared.originalFilename,
            operationOptions,
          ),
        );
        return {
          handle: uploadedTransfer.handle,
          filename: uploadedTransfer.filename,
          byteLength: uploadedTransfer.size,
        };
      },
      verifyNewCopy: async (uploaded): Promise<SafeKindleUpdateVerifiedCopy> => {
        const live = await this.#kindle.store.getObjectInfo(uploaded.handle, options.transfer ?? {});
        await requireParentMembership(live, options.transfer ?? {});
        if (
          uploadedTransfer === undefined
          || live.storageId !== uploadedTransfer.storageId
          || live.parentHandle !== uploadedTransfer.parentHandle
          || live.filename !== uploadedTransfer.filename
          || live.compressedSize !== prepared.blob.size
          || live.objectFormat === MTP_OBJECT_FORMAT_ASSOCIATION
          || live.associationType !== 0
          || live.protectionStatus !== 0
          || extractManagedFilenameToken(live.filename) !== newManagedToken
          || !isKindleReadableBookFilename(live.filename)
        ) {
          throw new KindleDeviceError(
            "MTP_OBJECT_VERIFICATION_FAILED",
            "The uploaded replacement did not retain its exact managed object metadata.",
          );
        }
        verifiedNewExact = live;
        return {
          ...uploaded,
          exactIdentity: exactObjectIdentity(live),
        };
      },
      recordVerifiedDelivery: async (_verified) => {
        if (uploadedTransfer === undefined || verifiedNewExact === undefined) {
          throw new Error("Verified replacement metadata is unavailable");
        }
        await options.recordVerifiedDelivery({
          operationId: options.operationId,
          artifactHash: prepared.artifactHash,
          managedToken: newManagedToken,
          transfer: uploadedTransfer,
          exactIdentity: exactObjectIdentity(verifiedNewExact),
        });
      },
      deleteExactOldCopy: async () => {
        await this.#kindle.store.deleteExistingKindleBookObject(oldExact, options.transfer ?? {});
        this.#inventory = undefined;
      },
      verifyOldCopyAbsent: async () => {
        const handles = await this.#kindle.store.listObjectHandles({
          storageId: oldExact.storageId,
          associationHandle: oldExact.parentHandle,
          maxHandles: MAX_UPDATE_PARENT_HANDLES,
        }, options.transfer ?? {});
        if (handles.includes(oldExact.handle)) {
          throw new SafeKindleUpdateError("OLD_COPY_CHANGED", "The old Kindle copy is still present after exact deletion.");
        }
      },
      recordCleanupRequired: async (verified, _oldCopy, reason) => {
        if (uploadedTransfer === undefined || verifiedNewExact === undefined) {
          throw new Error("Verified replacement metadata is unavailable for cleanup recovery");
        }
        cleanupRecord = {
          version: 1,
          operationId: options.operationId,
          recordedAt: Math.trunc((options.now ?? Date.now)()),
          vendorId: this.device.vendorId,
          productId: this.device.productId,
          reason,
          ...(this.identityKey === undefined ? {} : { deviceKey: this.identityKey }),
          oldCopy: {
            handle: oldExact.handle,
            storageId: oldExact.storageId,
            parentHandle: oldExact.parentHandle,
            filename: oldExact.filename,
            byteLength: oldExact.compressedSize,
            managedToken: initialOld.managedToken,
            exactIdentity: oldExact === initialOld.exact
              ? initialOld.safe.exactIdentity
              : exactObjectIdentity(oldExact),
          },
          newCopy: {
            handle: verified.handle,
            storageId: verifiedNewExact.storageId,
            parentHandle: verifiedNewExact.parentHandle,
            filename: verified.filename,
            byteLength: verified.byteLength,
            managedToken: newManagedToken,
            exactIdentity: verified.exactIdentity,
          },
        };
        if (!persistReplacementCleanupRecord(cleanupRecord, options.replacementCleanupStorage)) {
          throw new Error("Browser storage could not persist the exact replacement cleanup task");
        }
      },
      reconcile: async () => {
        const inventory = await inventoryWithAggregateDeadline(this.#kindle, inventoryOptions);
        this.#inventory = inventory;
        finalInventory = inventory;
        await options.reconcile(inventory);
      },
      onStage: options.onStage,
      freeSpaceReserveBytes: options.freeSpaceReserveBytes,
    }).then((result) => ({
      ...result,
      ...(finalInventory === undefined ? {} : { inventory: finalInventory }),
      ...(cleanupRecord === undefined ? {} : { cleanupRecord }),
    }));
  }

  /**
   * Explicit recovery for a replacement that was verified before its prior
   * managed copy could be removed. The journal locates the work item only: a
   * fresh complete inventory and current exact ObjectInfo remain authority.
   */
  cleanupManagedReplacement(
    record: ReplacementCleanupRecord,
    options: KindleReplacementCleanupOptions = {},
  ): Promise<KindleReplacementCleanupResult> {
    if (!isReplacementCleanupRecord(record)) {
      return Promise.reject(new TypeError("The replacement cleanup record is invalid"));
    }
    return this.#runExclusive(async () => {
      if (!this.#selfTestResult?.cleanedUp) {
        throw new KindleDeviceError(
          "MTP_SELF_TEST_REQUIRED",
          "The exact-byte safe-write check must pass in this connection before cleaning up a replacement.",
        );
      }
      if (
        record.vendorId !== this.device.vendorId
        || record.productId !== this.device.productId
        || (record.deviceKey !== undefined && record.deviceKey !== this.identityKey)
      ) {
        throw new SafeKindleUpdateError(
          "OLD_COPY_CHANGED",
          "This cleanup task belongs to a different Kindle.",
        );
      }
      if (
        record.oldCopy.storageId !== record.newCopy.storageId
        || record.oldCopy.parentHandle !== record.newCopy.parentHandle
        || record.oldCopy.managedToken === record.newCopy.managedToken
      ) {
        throw new SafeKindleUpdateError(
          "OLD_COPY_CHANGED",
          "The replacement cleanup evidence is internally inconsistent.",
        );
      }

      const inventoryOptions = exactUpdateInventoryOptions(options.inventory);
      const operationOptions = options.operation ?? {};
      const requireCompleteTarget = (inventory: KindleInventorySnapshot): void => {
        if (
          inventory.status !== "complete"
          || inventory.storageId !== record.oldCopy.storageId
          || inventory.documentsHandle !== record.oldCopy.parentHandle
        ) {
          throw new SafeKindleUpdateError(
            "INVENTORY_INCOMPLETE",
            "Cleanup requires a fresh complete inventory of the exact Kindle Documents folder.",
          );
        }
        const target = this.#kindle.currentTarget;
        if (
          !target
          || target.storageId !== inventory.storageId
          || target.documentsHandle !== inventory.documentsHandle
        ) {
          throw new SafeKindleUpdateError(
            "OLD_COPY_CHANGED",
            "The selected Kindle Documents storage changed before cleanup.",
          );
        }
      };
      const requireLiveObject = async (
        expected: ReplacementCleanupObject,
        exact: KindleStoredObjectInfo,
      ): Promise<void> => {
        const live = await this.#kindle.store.getObjectInfo(expected.handle, operationOptions);
        if (!sameStoredObjectInfo(live, exact)) {
          throw new SafeKindleUpdateError(
            "OLD_COPY_CHANGED",
            "A replacement cleanup object changed after the fresh inventory.",
          );
        }
      };

      const fresh = await inventoryWithAggregateDeadline(this.#kindle, inventoryOptions);
      this.#inventory = fresh;
      requireCompleteTarget(fresh);
      const removePriorCopy = record.reason === "old-copy-cleanup";
      const retainedRecord = removePriorCopy ? record.newCopy : record.oldCopy;
      const removalRecord = removePriorCopy ? record.oldCopy : record.newCopy;
      const retainedExact = replacementObjectFromInventory(fresh, retainedRecord);
      if (!retainedExact) {
        throw new SafeKindleUpdateError(
          "OLD_COPY_CHANGED",
          removePriorCopy
            ? "The verified replacement is no longer present with its exact managed identity. The old copy was not removed."
            : "The prior durable copy is no longer present with its exact managed identity. The unrecorded replacement was not removed.",
        );
      }
      const removalExact = replacementObjectFromInventory(fresh, removalRecord);
      if (!removalExact) {
        if (inventoryContainsReplacementIdentity(fresh, removalRecord)) {
          throw new SafeKindleUpdateError(
            "OLD_COPY_CHANGED",
            "The cleanup target still appears under changed object evidence. It was not removed.",
          );
        }
        await requireLiveObject(retainedRecord, retainedExact);
        const parentHandles = await this.#kindle.store.listObjectHandles({
          storageId: retainedExact.storageId,
          associationHandle: retainedExact.parentHandle,
          maxHandles: MAX_UPDATE_PARENT_HANDLES,
        }, operationOptions);
        if (!parentHandles.includes(retainedExact.handle)) {
          throw new SafeKindleUpdateError(
            "OLD_COPY_CHANGED",
            "The retained managed copy left its exact parent folder during cleanup validation.",
          );
        }
        return { status: "already-resolved", inventory: fresh };
      }

      const parentHandles = await this.#kindle.store.listObjectHandles({
        storageId: removalExact.storageId,
        associationHandle: removalExact.parentHandle,
        maxHandles: MAX_UPDATE_PARENT_HANDLES,
      }, operationOptions);
      if (!parentHandles.includes(removalExact.handle) || !parentHandles.includes(retainedExact.handle)) {
        throw new SafeKindleUpdateError(
          "OLD_COPY_CHANGED",
          "Both exact managed copies must remain in Kindle Documents immediately before cleanup.",
        );
      }
      await requireLiveObject(retainedRecord, retainedExact);
      await requireLiveObject(removalRecord, removalExact);

      // MtpObjectStore repeats exact ObjectInfo and parent membership
      // checks immediately before deleting this one handle.
      try {
        await this.#kindle.store.deleteExistingKindleBookObject(removalExact, operationOptions);
      } finally {
        this.#inventory = undefined;
      }

      const verified = await inventoryWithAggregateDeadline(this.#kindle, inventoryOptions);
      this.#inventory = verified;
      requireCompleteTarget(verified);
      if (
        inventoryContainsReplacementIdentity(verified, removalRecord)
        || replacementObjectFromInventory(verified, retainedRecord) === undefined
      ) {
        throw new SafeKindleUpdateError(
          "OLD_COPY_CHANGED",
          "Cleanup could not verify its exact target absent while retaining the safe managed copy.",
        );
      }
      return { status: removePriorCopy ? "cleaned" : "rolled-back", inventory: verified };
    });
  }

  removeBookAndRefreshInventory(
    handle: number,
    options: RemoveKindleBooksOptions = {},
    inventoryOptions: KindleInventoryRefreshOptions = {},
  ): Promise<KindleRemoveBookAndRefreshResult> {
    return this.removeBooksAndRefreshInventory([handle], options, inventoryOptions)
      .then(({ removals, ...result }) => ({
        ...result,
        removal: removals[0]!,
      }));
  }

  /**
   * Bulk removal is one exclusive operation: each selected handle is deleted
   * sequentially under exact snapshot revalidation, followed by one inventory
   * refresh so the UI never needs N expensive reconnect scans.
   */
  removeBooksAndRefreshInventory(
    handles: readonly number[],
    options: RemoveKindleBooksOptions = {},
    inventoryOptions: KindleInventoryRefreshOptions = {},
  ): Promise<KindleRemoveBooksAndRefreshResult> {
    return this.#runExclusive(async () => {
      if (!this.#selfTestResult?.cleanedUp) {
        throw new KindleDeviceError(
          "MTP_SELF_TEST_REQUIRED",
          "The exact-byte safe-write check must pass in this connection before removing books.",
        );
      }
      const authorityInventory = this.#inventory;
      if (authorityInventory?.status !== "complete") {
        throw new KindleDeviceError(
          "MTP_BOOK_REMOVAL_REJECTED",
          "Reconnect and complete a live Kindle inventory before removing books.",
        );
      }

      let removals: readonly KindleBookRemovalResult[];
      try {
        removals = await operationWithAggregateDeadline(
          "Kindle book removal",
          options,
          (operationOptions) => this.#kindle.removeBooks(
            authorityInventory,
            handles,
            operationOptions,
          ),
        );
      } catch (error) {
        // A failed batch may have completed earlier exact-handle deletions.
        // Never expose the pre-operation inventory as current afterward.
        this.#inventory = undefined;
        throw error;
      }
      this.#inventory = undefined;
      try {
        const inventory = await inventoryWithAggregateDeadline(this.#kindle, inventoryOptions);
        this.#inventory = inventory;
        return {
          removals,
          inventory,
          inventoryRefresh: inventory.status,
        };
      } catch (error) {
        const inventoryErrorCode = safeErrorCode(error);
        return {
          removals,
          inventoryRefresh: "failed",
          ...(inventoryErrorCode === undefined ? {} : { inventoryErrorCode }),
          ...(isFatalInventoryError(error) ? { connectionFaulted: true as const } : {}),
        };
      }
    });
  }

  async disconnect(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#performDisconnect();
    return this.#closePromise;
  }

  async #performDisconnect(): Promise<void> {
    const failures: unknown[] = [];
    if (this.#session.isOpen) {
      try {
        await this.#session.close();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.#transport.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await releaseLeaseAfterUsbQuiesces(this.#transport, this.#lease);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "MTP and USB cleanup both failed");
    }
  }

  /** Physical removal makes a protocol CloseSession impossible; release browser state only. */
  async closeAfterPhysicalDisconnect(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      const failures: unknown[] = [];
      try {
        await this.#transport.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await releaseLeaseAfterUsbQuiesces(this.#transport, this.#lease);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "USB and device-lease cleanup both failed");
    })();
    return this.#closePromise;
  }

  async #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    if (this.#operationActive) throw new KindleRuntimeBusyError();
    this.#operationActive = true;
    try {
      return await operation();
    } finally {
      this.#operationActive = false;
    }
  }

  #assertOpen(): void {
    if (this.#closed || !this.#session.isOpen) {
      throw new Error("The Kindle connection is closed");
    }
  }
}

export async function openKindle(
  device: UsbDeviceLike,
  hooks: DeviceRuntimeHooks,
  usb: UsbManagerLike | undefined = getUsbManager(),
  options: OpenKindleOptions = {},
): Promise<ConnectedKindle> {
  const {
    leaseProvider,
    identitySecretProvider,
    kindleOptions,
    metadataCache = defaultKindleMetadataCache,
    modificationDateProbe = defaultKindleModificationDateProbe,
    enableDevelopmentPartialObjectProbe = false,
    ...operationOptions
  } = options;
  let details = initialDetails(device);
  const descriptor = captureDescriptorSnapshot(device) as unknown as Readonly<Record<string, unknown>>;
  hooks.onDescriptor(details, descriptor);

  let transport: WebUsbBulkTransport | undefined;
  let session: MtpSession | undefined;
  let lease: KindleDeviceLease | undefined;
  try {
    lease = leaseProvider
      ? await leaseProvider.acquire({ signal: operationOptions.signal })
      : await acquireKindleDeviceLease({ signal: operationOptions.signal });
    operationOptions.signal?.throwIfAborted();
    transport = await WebUsbBulkTransport.connect(device, { usb });
    operationOptions.signal?.throwIfAborted();
    details = {
      ...details,
      configurationValue: transport.selection.configurationValue,
      interfaceNumber: transport.selection.interfaceNumber,
      alternateSetting: transport.selection.alternateSetting,
      bulkInEndpoint: transport.selection.bulkInEndpoint,
      bulkOutEndpoint: transport.selection.bulkOutEndpoint,
    };
    hooks.onUsbOpen(details);

    session = new MtpSession(transport);
    // GetDeviceInfo is a protocol-defined pre-session operation using transaction 0.
    const deviceInfo = await session.getDeviceInfo(operationOptions);
    const mtpSerialNumber = deviceInfo.serialNumber.trim();
    const identity = await derivePseudonymousKindleIdentity(
      mtpSerialNumber || device.serialNumber,
      device.vendorId,
      device.productId,
      identitySecretProvider,
    );
    details = {
      ...details,
      manufacturerName: deviceInfo.manufacturer || details.manufacturerName,
      model: deviceInfo.model || details.productName,
      serialNumber: maskSerialNumber(deviceInfo.serialNumber || device.serialNumber),
      operationsSupported: deviceInfo.operationsSupported,
    };
    await session.open(1, operationOptions);
    hooks.onMtpReading(details);

    const store = new MtpObjectStore(session);
    const kindle = new KindleDevice(
      store,
      kindleOptions,
      identity === undefined
        ? undefined
        : { cache: metadataCache, identity, modificationDateProbe },
    );
    const target = await kindle.inspect(0, operationOptions);
    details = {
      ...details,
      storageId: target.storageId,
      storageDescription: target.storage.storageDescription || target.storage.volumeLabel,
      capacityBytes: target.storage.maxCapacity,
      freeBytes: target.storage.freeSpaceInBytes,
      documentsHandle: target.documentsHandle,
    };
    return new ConnectedKindle(
      device,
      details,
      transport,
      session,
      kindle,
      lease,
      identity?.key,
      identity?.stability,
      enableDevelopmentPartialObjectProbe,
    );
  } catch (error) {
    if (session?.isOpen) {
      try {
        await session.close();
      } catch {
        // Preserve the connection-stage error; USB close below is still attempted.
      }
    }
    if (transport) {
      try {
        await transport.close();
      } catch {
        // Preserve the connection-stage error.
      }
    }
    if (lease) {
      try {
        if (transport) await releaseLeaseAfterUsbQuiesces(transport, lease);
        else await lease.release();
      } catch {
        // Preserve the connection-stage error.
      }
    }
    throw error;
  }
}
