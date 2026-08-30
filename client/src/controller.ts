import { convertEpub, type ConversionResult } from "./api/convert";
import { AppError, toAppError } from "./app-error";
import type { CatalogKindleInventory, CatalogSendRequest } from "./catalog-browser";
import {
  createCatalogClient,
  type CatalogApi,
  type CatalogMatchIndex,
  type CreateDeliveryInput,
} from "./catalog-client";
import {
  asLastSeenInventory,
  reconcileCatalogIndexes,
} from "./catalog-reconciliation";
import { prepareCatalogArtifact } from "./catalog-transfer";
import {
  acknowledgePendingDelivery,
  flushPendingDeliveries,
  queuePendingDelivery,
} from "./delivery-journal";
import {
  ConnectedKindle,
  openKindle,
  type DeviceRuntimeHooks,
  type KindlePostConnectResult,
  type KindleSendAndRefreshResult,
  type SendBookOptions,
} from "./device-runtime";
import {
  acquireKindleDeviceLease,
  createManagedFilenameToken,
  extractManagedFilenameToken,
  type KindleBookTransferResult,
  type KindleDeviceLease,
  type KindleInventorySnapshot,
  type KindleSelfTestResult,
} from "./kindle";
import { DebugLog } from "./log";
import type { MtpObjectCreationState } from "./mtp";
import {
  clearPendingObjectCleanup,
  initialAppState,
  persistPendingObjectCleanup,
  persistTargetProfile,
  readPendingObjectCleanup,
  samePendingObjectCleanup,
  targetProfileComplete,
  type AppState,
  type DeviceDetails,
  type PendingObjectCleanup,
  type PendingObjectPurpose,
  type TargetProfile,
  type TransferPurpose,
  type TransferState,
} from "./state";
import {
  getUsbManager,
  requestKindleDevice,
  type UsbConnectionEventLike,
  type UsbDeviceLike,
  type UsbManagerLike,
} from "./usb";
import { AppView, type AppViewHandlers } from "./view";
import {
  MAX_MATCH_INDEX_DELIVERIES,
  MAX_MATCH_INDEX_ENTRIES,
  MAX_MATCH_INDEX_RESPONSE_BYTES,
} from "../../shared/catalog-contracts.js";

export interface ConnectedKindlePort {
  readonly device: UsbDeviceLike;
  readonly details: DeviceDetails;
  readonly closed: boolean;
  /** Opaque, in-memory-only digest of a device serial, when available. */
  readonly identityKey?: string;
  readonly readyForSend: boolean;
  readonly latestInventory?: KindleInventorySnapshot;
  runSelfTest(options?: SendBookOptions): Promise<KindleSelfTestResult>;
  prepareAfterConnect(options?: {
    readonly inventory?: Parameters<ConnectedKindle["refreshInventory"]>[0];
    readonly selfTest?: SendBookOptions;
  }): Promise<KindlePostConnectResult>;
  refreshInventory(
    options?: Parameters<ConnectedKindle["refreshInventory"]>[0],
  ): Promise<KindleInventorySnapshot>;
  sendAzW3(
    blob: Blob,
    originalFilename: string,
    options?: SendBookOptions,
  ): Promise<KindleBookTransferResult>;
  sendAzW3AndRefreshInventory(
    blob: Blob,
    originalFilename: string,
    options?: SendBookOptions,
    inventoryOptions?: Parameters<ConnectedKindle["refreshInventory"]>[0],
  ): Promise<KindleSendAndRefreshResult>;
  disconnect(): Promise<void>;
  closeAfterPhysicalDisconnect(): Promise<void>;
}

export interface AppControllerDependencies {
  readonly usb?: UsbManagerLike;
  readonly requestDevice: () => Promise<UsbDeviceLike>;
  readonly openDevice: (
    device: UsbDeviceLike,
    hooks: DeviceRuntimeHooks,
    signal: AbortSignal,
  ) => Promise<ConnectedKindlePort>;
  readonly convert: (file: File, signal?: AbortSignal) => Promise<ConversionResult>;
  readonly download: (blob: Blob, filename: string) => void;
  readonly copyText: (value: string) => Promise<void>;
  readonly now: () => number;
  readonly catalogApi?: CatalogApi;
  /** Tests can disable the catalog's startup requests while exercising POC gates. */
  readonly autoStartCatalog?: boolean;
  /** Observable page lifecycle only; this does not claim generic OS sleep detection. */
  readonly browserLifecycle?: BrowserLifecycleSource;
  /**
   * Catalog bookkeeping happens after MTP has already verified the object. It
   * must never keep the USB/session lease forever if the backend disappears.
   */
  readonly postUploadCatalogTimeoutMs?: number;
  /** Bounds profile/index requests while a newly opened USB session is held. */
  readonly connectCatalogTimeoutMs?: number;
  /** Bounds catalog reconciliation triggered by a live SSE hint. */
  readonly connectedCatalogTimeoutMs?: number;
  /** Test/deployment override for aggregate browser-retained match-index data. */
  readonly catalogReconciliationLimits?: Partial<CatalogReconciliationLimits>;
  /** Bounds the indexed metadata recheck before any MTP upload begins. */
  readonly preUploadCatalogTimeoutMs?: number;
  /**
   * Bounds the complete source download before any MTP upload begins. If only
   * preUploadCatalogTimeoutMs is supplied, that override remains compatible and
   * applies to both phases.
   */
  readonly sourceDownloadTimeoutMs?: number;
  /** Bounds USB/MTP open, storage inspection, and Documents discovery. */
  readonly openDeviceTimeoutMs?: number;
  /** Bounds the complete exact-byte self-test, including collision discovery. */
  readonly selfTestOperationTimeoutMs?: number;
  /** Optional test/deployment override for the complete MTP book transaction. */
  readonly sendOperationTimeoutMs?: number;
  /** Aggregate wall-clock bound for automatic connection inventory. */
  readonly connectInventoryTimeoutMs?: number;
  /** Aggregate wall-clock bound for the refresh after verified upload. */
  readonly postUploadInventoryTimeoutMs?: number;
  /** Acquires the same browser-wide lock held by every connected Kindle. */
  readonly acquireRecoveryLease?: () => Promise<KindleDeviceLease>;
}

export interface BrowserLifecycleSource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(
    type: "pagehide" | "pageshow" | "visibilitychange",
    listener: (event: Event) => void,
  ): void;
}

type BrowserLifecycleInvalidationReason = "bfcache-restore" | "pagehide" | "visibility-gap";

const MAX_RETAINED_HIDDEN_MS = 60_000;
const DEFAULT_POST_UPLOAD_CATALOG_TIMEOUT_MS = 5_000;
const DEFAULT_CONNECT_CATALOG_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTED_CATALOG_TIMEOUT_MS = 30_000;
const DEFAULT_PRE_UPLOAD_CATALOG_TIMEOUT_MS = 120_000;
const DEFAULT_SOURCE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OPEN_DEVICE_TIMEOUT_MS = 120_000;
const DEFAULT_SELF_TEST_OPERATION_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_INVENTORY_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POST_UPLOAD_INVENTORY_TIMEOUT_MS = 2 * 60_000;
const MAX_SYNTHETIC_INVENTORY_OBJECTS = 10_000;
const MAX_SYNTHETIC_INVENTORY_ISSUES = 64;

export interface CatalogReconciliationLimits {
  readonly entries: number;
  readonly deliveries: number;
  readonly stringValues: number;
  readonly stringCodeUnits: number;
}

interface CatalogReconciliationFootprint extends CatalogReconciliationLimits {
  readonly profiles: number;
}

const DEFAULT_CATALOG_RECONCILIATION_LIMITS: Readonly<CatalogReconciliationLimits> = {
  // The aggregate is no larger than one maximum legal server response. Only
  // the active profile participates; another profile is reconciled on demand
  // when the user selects it.
  entries: MAX_MATCH_INDEX_ENTRIES,
  deliveries: MAX_MATCH_INDEX_DELIVERIES,
  stringValues: 5_000_000,
  stringCodeUnits: MAX_MATCH_INDEX_RESPONSE_BYTES,
};

function matchIndexFootprint(index: CatalogMatchIndex): CatalogReconciliationFootprint {
  let entries = 0;
  let deliveries = 0;
  let stringValues = 0;
  let stringCodeUnits = 0;
  const retain = (value: string | undefined): void => {
    if (value === undefined) return;
    stringValues += 1;
    stringCodeUnits += value.length;
  };
  retain(index.profileId);
  retain(index.generatedAt);
  retain(index.metadataClaims?.collisionBitmap);
  for (const entry of index.entries) {
    entries += 1;
    retain(entry.bookId);
    retain(entry.title);
    retain(entry.sourceFilename);
    retain(entry.sourceFormat);
    retain(entry.contentHash);
    retain(entry.managedToken);
    for (const value of entry.authors) retain(value);
    for (const value of entry.identifiers) retain(value);
    for (const delivery of entry.deliveries) {
      deliveries += 1;
      retain(delivery.deviceKey);
      retain(delivery.filename);
      retain(delivery.artifactHash);
      retain(delivery.objectIdentity);
      retain(delivery.managedToken);
      retain(delivery.status);
      retain(delivery.deliveredAt);
    }
  }
  return { profiles: 1, entries, deliveries, stringValues, stringCodeUnits };
}

function addMatchIndexFootprint(
  current: CatalogReconciliationFootprint,
  additional: CatalogReconciliationFootprint,
  limits: CatalogReconciliationLimits,
): CatalogReconciliationFootprint | undefined {
  const combined = {
    profiles: current.profiles + additional.profiles,
    entries: current.entries + additional.entries,
    deliveries: current.deliveries + additional.deliveries,
    stringValues: current.stringValues + additional.stringValues,
    stringCodeUnits: current.stringCodeUnits + additional.stringCodeUnits,
  };
  if (
    !Object.values(combined).every(Number.isSafeInteger)
    || combined.entries > limits.entries
    || combined.deliveries > limits.deliveries
    || combined.stringValues > limits.stringValues
    || combined.stringCodeUnits > limits.stringCodeUnits
  ) {
    return undefined;
  }
  return combined;
}

interface CatalogReconciliationResult {
  readonly complete: boolean;
  readonly activeProfileComplete: boolean;
}

function defaultBrowserLifecycleSource(): BrowserLifecycleSource {
  return {
    get visibilityState() {
      return document.visibilityState;
    },
    addEventListener(type, listener) {
      if (type === "visibilitychange") document.addEventListener(type, listener);
      else window.addEventListener(type, listener);
    },
  };
}

function persistedPageTransition(event: Event): boolean {
  return Reflect.get(event, "persisted") === true;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("The browser did not grant clipboard access");
}

export function defaultControllerDependencies(): AppControllerDependencies {
  const usb = getUsbManager();
  return {
    usb,
    requestDevice: () => requestKindleDevice({ usb }),
    openDevice: (device, hooks, signal) => openKindle(device, hooks, usb, { signal }),
    convert: convertEpub,
    download: downloadBlob,
    copyText,
    now: () => Date.now(),
    acquireRecoveryLease: () => acquireKindleDeviceLease(),
    catalogApi: createCatalogClient(),
    autoStartCatalog: true,
  };
}

function sameProfile(left: TargetProfile, right: TargetProfile): boolean {
  return (Object.keys(left) as Array<keyof TargetProfile>)
    .every((key) => left[key] === right[key]);
}

function manualCleanupInstruction(error: AppError): string | undefined {
  if (error.code !== "MTP_PARTIAL_OBJECT_CLEANUP_FAILED") return undefined;
  if (error.details?.cleanupSucceeded === true) return undefined;
  const nextAction = error.details?.safeNextAction;
  if (typeof nextAction === "string") return nextAction;
  const filename = error.details?.filename;
  const handle = error.details?.createdHandle;
  return `Remove only the Kindle Bridge-created object${typeof filename === "string" ? ` ${filename}` : ""}${typeof handle === "number" ? ` (handle 0x${handle.toString(16)})` : ""}.`;
}

function errorContext(error: AppError): Readonly<Record<string, unknown>> {
  return { code: error.code, ...(error.details ?? {}) };
}

function isFatalInventoryError(error: unknown): boolean {
  if (error && typeof error === "object" && Reflect.get(error, "fatal") === true) return true;
  const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
  return code === "MTP_INVALID_STATE"
    || code === "MTP_TRANSPORT_ERROR"
    || code === "MTP_COMMAND_TIMEOUT"
    || code === "MTP_INACTIVITY_TIMEOUT"
    || (typeof code === "string" && code.startsWith("USB_"));
}

function bookTransferCommandTimeoutMs(bytes: number): number {
  // Allow one minute of fixed overhead plus transfer time at a deliberately
  // conservative 32 KiB/s. Per-I/O inactivity timeouts still catch a hang.
  return Math.max(120_000, Math.ceil(bytes / (32 * 1024) * 1_000) + 60_000);
}

function hasCrossConnectionEvidence(state: AppState): boolean {
  return (state.conversion.kind === "ready" && state.conversion.validated)
    || state.integratedTransfer.kind === "verified";
}

function pendingCleanupInstruction(entry: PendingObjectCleanup | undefined): string | undefined {
  if (!entry) return undefined;
  const handle = entry.handle === undefined
    ? "handle unknown because SendObjectInfo did not return a trustworthy response"
    : `MTP handle 0x${entry.handle.toString(16).padStart(8, "0")}`;
  const target = entry.deviceLabel
    ? `${entry.deviceLabel} (VID 0x${entry.vendorId.toString(16).padStart(4, "0")}, PID 0x${entry.productId.toString(16).padStart(4, "0")})`
    : `the device with VID 0x${entry.vendorId.toString(16).padStart(4, "0")} and PID 0x${entry.productId.toString(16).padStart(4, "0")}`;
  return `Inspect Kindle Documents on ${target} for exactly ${entry.filename} (${handle}). Remove only that exact managed filename if it is partial or unwanted; never delete a similarly named book.`;
}

function failInterruptedTransfer(
  transfer: TransferState,
  error: AppError,
  cleanupRequired: string | undefined,
): TransferState {
  if (transfer.kind !== "sending") return transfer;
  return {
    kind: "failed",
    purpose: transfer.purpose,
    filename: transfer.filename,
    ...(transfer.artifactId === undefined ? {} : { artifactId: transfer.artifactId }),
    error,
    cleanupRequired: cleanupRequired
      ?? `The USB connection ended during the operation. Inspect only the exact generated filename ${transfer.filename} in Kindle Documents before retrying.`,
  };
}

export class AppController {
  readonly log: DebugLog;
  readonly #view: AppView;
  readonly #dependencies: AppControllerDependencies;
  readonly #catalogApi: CatalogApi;
  #state: AppState;
  #connection?: ConnectedKindlePort;
  #connectionMode?: "catalog" | "poc";
  #deviceAbort?: AbortController;
  #deviceEpoch = 0;
  #disconnectPromise?: Promise<void>;
  #lifecycleCleanup?: Promise<void>;
  #pendingDevice?: UsbDeviceLike;
  #hardwareBusy = false;
  #conversionPipelineBusy = false;
  readonly #hardwareIdleWaiters = new Set<() => void>();
  #hiddenAt?: number;
  #provenDeviceIdentityKey?: string;
  #unidentifiedCrossConnectionEvidence = false;
  #conversionAbort?: AbortController;
  #lastProgressRender = 0;
  #artifactSequence = 0;
  #recoveryOperationSequence = 0;
  #catalogInventory?: import("./catalog-browser").CatalogKindleInventory;
  #rawCatalogInventory?: KindleInventorySnapshot;
  #catalogInventoryEpoch?: number;
  #catalogReadyProfileIds = new Set<string>();
  #catalogReconciledContentHashes = new Map<string, string>();
  #catalogEventReconciliation?: Promise<void>;
  #catalogEventReconciliationQueued = false;

  readonly #handlePageHide = (event: Event): void => {
    this.#hiddenAt = undefined;
    this.#invalidateForBrowserLifecycle(persistedPageTransition(event) ? "bfcache-restore" : "pagehide");
  };

  readonly #handlePageShow = (event: Event): void => {
    if (persistedPageTransition(event)) this.#invalidateForBrowserLifecycle("bfcache-restore");
  };

  readonly #handleVisibilityChange = (): void => {
    const lifecycle = this.#dependencies.browserLifecycle ?? defaultBrowserLifecycleSource();
    if (lifecycle.visibilityState === "hidden") {
      this.#hiddenAt ??= this.#dependencies.now();
      return;
    }
    if (lifecycle.visibilityState !== "visible" || this.#hiddenAt === undefined) return;
    const hiddenAt = this.#hiddenAt;
    this.#hiddenAt = undefined;
    const hiddenMilliseconds = Math.max(0, this.#dependencies.now() - hiddenAt);
    if (hiddenMilliseconds >= MAX_RETAINED_HIDDEN_MS) {
      this.#invalidateForBrowserLifecycle("visibility-gap", hiddenMilliseconds);
    }
  };

  readonly #handleUsbDisconnect = (event: UsbConnectionEventLike): void => {
    const connection = this.#connection;
    const pendingMatch = event.device === this.#pendingDevice;
    if ((!connection || event.device !== connection.device) && !pendingMatch) return;
    this.#deviceEpoch += 1;
    this.#deviceAbort?.abort(new DOMException("USB device disconnected", "AbortError"));
    this.#deviceAbort = undefined;
    this.#pendingDevice = undefined;
    this.#connection = undefined;
    this.#clearCurrentCatalogInventoryAuthority();
    const error = new AppError(
      "USB_DEVICE_DISCONNECTED",
      "The Kindle was physically disconnected. Reconnect before retrying the current gate.",
      { details: { vendorId: event.device.vendorId, productId: event.device.productId } },
    );
    const cleanupRequired = pendingCleanupInstruction(this.#state.pendingObjectCleanup);
    this.log.error(error.message, errorContext(error));
    let nextState: AppState = {
      ...this.#state,
      usbAccessProven: false,
      mtpReadProven: false,
      device: {
        kind: "error",
        details: connection?.details ?? (
          this.#state.device.kind === "disconnected" || this.#state.device.kind === "requesting-permission"
            ? undefined
            : this.#state.device.details
        ),
        error,
      },
      selfTest: this.#state.selfTest.kind === "running"
        ? { kind: "failed", error, cleanupRequired }
        : { kind: "not-run" },
      postConnectStage: "idle",
      catalogInventoryState: "idle",
      integratedTransfer: failInterruptedTransfer(
        this.#state.integratedTransfer,
        error,
        cleanupRequired,
      ),
      activeError: error,
    };
    if (connection) nextState = this.#stateAfterDisconnect(nextState, connection);
    this.#commit(nextState);
    this.#markCatalogInventoryLastSeen();
    this.#connectionMode = undefined;
    if (!connection) return;
    void connection.closeAfterPhysicalDisconnect().catch((cleanupError) => {
      this.log.warn("Browser-side USB cleanup after physical removal failed", {
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    });
  };

  constructor(
    root: HTMLElement,
    dependencies: AppControllerDependencies = defaultControllerDependencies(),
    initialState: AppState = initialAppState(),
    log = new DebugLog(),
  ) {
    this.#dependencies = dependencies;
    this.#catalogApi = dependencies.catalogApi ?? createCatalogClient();
    this.#state = initialState;
    this.log = log;

    const handlers: AppViewHandlers = {
      onTargetProfileSaved: (profile) => { void this.saveTargetProfile(profile); },
      onEpubSelected: (file) => this.selectEpub(file),
      onConvert: () => { void this.convert(); },
      onDownloadConverted: () => this.downloadConverted(),
      onConnect: () => { void this.connect("poc"); },
      onDisconnect: () => { void this.disconnect(); },
      onSelfTest: () => { void this.runSelfTest(); },
      onSendIntegrated: () => { void this.sendIntegrated(); },
      onIntegratedOpenConfirmed: () => this.confirmIntegratedOpened(),
      onCleanupInspectionConfirmed: () => { void this.confirmCleanupInspection(); },
      onCopyLog: () => { void this.copyLog(); },
      onCatalogConnectRequested: () => this.connect("catalog"),
      onCatalogDisconnectRequested: () => this.disconnect(),
      onCatalogSendRequested: (request) => this.sendCatalogBook(request),
      onCatalogChanged: () => this.#queueConnectedCatalogReconciliation(),
      onCatalogProfileChanged: () => this.#queueConnectedCatalogReconciliation(),
    };
    this.#view = new AppView(root, this.#state, handlers, this.log, {
      catalogApi: this.#catalogApi,
      autoStartCatalog: dependencies.autoStartCatalog
        ?? dependencies.catalogApi !== undefined,
    });
    if (dependencies.catalogApi) {
      void flushPendingDeliveries(this.#catalogApi).then(({ delivered, remaining }) => {
        if (delivered > 0) this.log.info("Pending delivery records were reconciled", { delivered });
        if (remaining > 0) this.log.warn("Delivery records remain queued for a later retry", { remaining });
      });
    }
    dependencies.usb?.addEventListener("disconnect", this.#handleUsbDisconnect);
    window.addEventListener("beforeunload", (event) => {
      if (!this.#connection && !this.#pendingDevice && !this.#hardwareBusy && !this.#disconnectPromise) return;
      event.preventDefault();
      event.returnValue = "";
    });
    const lifecycle = dependencies.browserLifecycle ?? defaultBrowserLifecycleSource();
    lifecycle.addEventListener("pagehide", this.#handlePageHide);
    lifecycle.addEventListener("pageshow", this.#handlePageShow);
    lifecycle.addEventListener("visibilitychange", this.#handleVisibilityChange);

    this.log.info("POC initialized", {
      secureContext: this.#state.secureContext,
      webUsbAvailable: this.#state.webUsbAvailable,
    });
    if (this.#state.pendingObjectCleanup) {
      this.log.warn("An interrupted MTP write requires manual inspection", {
        purpose: this.#state.pendingObjectCleanup.purpose,
        stage: this.#state.pendingObjectCleanup.stage,
        handleKnown: this.#state.pendingObjectCleanup.handle !== undefined,
      });
    }
  }

  get state(): AppState {
    return this.#state;
  }

  /** Sanitized presentation inventory; disconnected evidence is explicitly Last seen. */
  get latestCatalogInventory(): CatalogKindleInventory | undefined {
    return this.#catalogInventory;
  }

  async saveTargetProfile(profile: TargetProfile): Promise<void> {
    if (this.#hardwareBusy) {
      this.#invalidState("Wait for the current Kindle operation to finish before changing the target environment");
      return;
    }
    const changed = !sameProfile(this.#state.targetProfile, profile);
    if (changed && this.#state.device.kind !== "disconnected" && this.#state.device.kind !== "error") {
      await this.disconnect();
    }
    if (changed) {
      this.#provenDeviceIdentityKey = undefined;
      this.#unidentifiedCrossConnectionEvidence = false;
    }
    persistTargetProfile(profile);
    this.#commit({
      ...this.#state,
      targetProfile: profile,
      usbAccessProven: changed ? false : this.#state.usbAccessProven,
      mtpReadProven: changed ? false : this.#state.mtpReadProven,
      selfTest: changed ? { kind: "not-run" } : this.#state.selfTest,
      postConnectStage: changed ? "idle" : this.#state.postConnectStage,
      integratedTransfer: changed ? { kind: "idle" } : this.#state.integratedTransfer,
      conversion: this.#state.conversion,
      activeError: undefined,
    });
    this.log.info("Target environment recorded", { complete: targetProfileComplete(profile) });
  }

  selectEpub(file: File): void {
    if (this.#integratedUploadRunning()) {
      this.#invalidState("Wait for the integrated Kindle upload to finish before changing the EPUB");
      return;
    }
    this.#conversionAbort?.abort(new DOMException("A different EPUB was selected", "AbortError"));
    this.#conversionAbort = undefined;
    this.#commit({
      ...this.#state,
      conversion: { kind: "selected", file },
      integratedTransfer: { kind: "idle" },
      activeError: undefined,
    });
    this.log.info("EPUB selected", { filename: file.name, bytes: file.size });
  }

  async connect(mode: "catalog" | "poc" = "catalog"): Promise<void> {
    if (!this.#state.secureContext || !this.#state.webUsbAvailable) {
      this.#invalidState("A trusted HTTPS or localhost context and a WebUSB-capable Chromium browser are required");
      return;
    }
    if (
      mode === "poc"
      && (this.#state.conversion.kind !== "ready" || !this.#state.conversion.validated)
    ) {
      this.#invalidState("Convert an EPUB locally before requesting WebUSB permission");
      return;
    }
    if (
      this.#connection
      || this.#state.device.kind === "requesting-permission"
      || this.#state.device.kind === "opening"
      || this.#state.device.kind === "mtp-reading"
      || this.#state.device.kind === "recovering"
      || this.#hardwareBusy
      || this.#disconnectPromise
      || this.#lifecycleCleanup
    ) {
      this.#invalidState("A Kindle connection is already active");
      return;
    }

    // A raw MTP inventory is connection-scoped evidence. Retain only its
    // sanitized Last seen presentation while a new chooser/session starts.
    this.#clearCurrentCatalogInventoryAuthority();
    this.#markCatalogInventoryLastSeen();
    const epoch = ++this.#deviceEpoch;
    const abort = new AbortController();
    this.#deviceAbort = abort;
    // This invocation stays before any await so WebUSB sees the original click activation.
    const devicePromise = this.#dependencies.requestDevice();
    this.#commit({
      ...this.#state,
      device: { kind: "requesting-permission" },
      postConnectStage: "idle",
      catalogInventoryState: "idle",
      activeError: undefined,
    });
    this.log.info("Opening the WebUSB device chooser");

    let lastDetails: DeviceDetails | undefined;
    try {
      const device = await devicePromise;
      if (!this.#isDeviceEpoch(epoch, abort)) return;
      this.#pendingDevice = device;
      lastDetails = {
        vendorId: device.vendorId,
        productId: device.productId,
        manufacturerName: device.manufacturerName,
        productName: device.productName,
      };
      const hooks: DeviceRuntimeHooks = {
        onDescriptor: (details, descriptor) => {
          if (!this.#isDeviceEpoch(epoch, abort)) return;
          lastDetails = details;
          this.log.info("USB descriptor snapshot captured", { descriptor });
          this.#commit({ ...this.#state, device: { kind: "opening", details } });
        },
        onUsbOpen: (details) => {
          if (!this.#isDeviceEpoch(epoch, abort)) return;
          lastDetails = details;
          this.log.info("Exact USB interface claimed", {
            configurationValue: details.configurationValue,
            interfaceNumber: details.interfaceNumber,
            alternateSetting: details.alternateSetting,
            bulkInEndpoint: details.bulkInEndpoint,
            bulkOutEndpoint: details.bulkOutEndpoint,
          });
          this.#commit({
            ...this.#state,
            usbAccessProven: true,
            device: { kind: "opening", details },
          });
        },
        onMtpReading: (details) => {
          if (!this.#isDeviceEpoch(epoch, abort)) return;
          lastDetails = details;
          this.log.info("GetDeviceInfo and OpenSession succeeded", {
            model: details.model,
            operationsSupported: details.operationsSupported,
          });
          this.#commit({ ...this.#state, device: { kind: "mtp-reading", details } });
        },
      };
      const connection = await this.#openDeviceWithDeadline(device, hooks, abort.signal);
      this.#pendingDevice = undefined;
      if (!this.#isDeviceEpoch(epoch, abort)) {
        await connection.disconnect().catch(() => undefined);
        return;
      }
      // The device lease is acquired inside openDevice. Re-read the durable
      // recovery journal only after that exclusive boundary so a tab that was
      // already open when another tab crashed cannot begin the automatic
      // self-test from stale in-memory state.
      this.#synchronizePendingCleanupFromStorage();
      if (mode === "poc") {
        const identityError = this.#connectionIdentityError(connection);
        if (identityError) {
          await connection.disconnect().catch(() => undefined);
          throw identityError;
        }
      }
      this.#connection = connection;
      this.#connectionMode = mode;
      if (mode === "poc" && connection.identityKey) {
        this.#provenDeviceIdentityKey ??= connection.identityKey;
      }
      lastDetails = connection.details;
      this.#commit({
        ...this.#state,
        usbAccessProven: true,
        mtpReadProven: true,
        device: { kind: "ready", details: connection.details },
        selfTest: this.#state.pendingObjectCleanup
          ? this.#state.selfTest
          : { kind: "running" },
        postConnectStage: this.#state.pendingObjectCleanup ? "inventory" : "safe-write",
        catalogInventoryState: "loading",
        activeError: undefined,
      });
      this.log.info("Gate 2 MTP inspection passed", {
        storageId: connection.details.storageId,
        documentsHandle: connection.details.documentsHandle,
        freeBytes: connection.details.freeBytes?.toString(),
      });

      if (this.#state.pendingObjectCleanup) {
        // Recovery records deliberately block every new write, including the
        // automatic byte test. Inventory remains safe and read-only.
        this.#hardwareBusy = true;
        try {
          const inventory = await connection.refreshInventory({
            signal: abort.signal,
            aggregateTimeoutMs:
              this.#dependencies.connectInventoryTimeoutMs ?? DEFAULT_CONNECT_INVENTORY_TIMEOUT_MS,
          });
          if (this.#isActiveConnection(epoch, connection)) {
            this.#commit({ ...this.#state, postConnectStage: "reconciliation" });
            await this.#withCatalogDeadline(
              (catalogSignal) => this.#reconcileCatalogInventory(inventory, connection, catalogSignal),
              this.#dependencies.connectCatalogTimeoutMs ?? DEFAULT_CONNECT_CATALOG_TIMEOUT_MS,
              "connect-reconciliation",
              abort.signal,
            );
          }
        } catch (inventoryError) {
          if (this.#isActiveConnection(epoch, connection)) {
            this.#catalogInventoryEpoch = undefined;
            this.#commit({
              ...this.#state,
              postConnectStage: "idle",
              catalogInventoryState: "failed",
            });
          }
          this.log.warn("Read-only Kindle inventory was unavailable while recovery is pending", {
            code: errorContext(toAppError(inventoryError)).code,
          });
        } finally {
          if (
            epoch === this.#deviceEpoch
            && this.#connection === connection
            && this.#state.postConnectStage !== "idle"
          ) {
            this.#commit({ ...this.#state, postConnectStage: "idle" });
          }
          this.#finishHardwareOperation();
        }
        return;
      }

      this.#hardwareBusy = true;
      try {
        await this.#runAutomaticPostConnect(epoch, connection, abort.signal);
      } finally {
        this.#finishHardwareOperation();
      }
    } catch (rawError) {
      if (!this.#isDeviceEpoch(epoch, abort)) return;
      this.#pendingDevice = undefined;
      this.#deviceAbort = undefined;
      this.#connectionMode = undefined;
      const error = toAppError(rawError, "Could not connect to the Kindle");
      this.log.error(error.message, errorContext(error));
      this.#commit({
        ...this.#state,
        usbAccessProven: false,
        mtpReadProven: false,
        selfTest: { kind: "not-run" },
        postConnectStage: "idle",
        device: { kind: "error", details: lastDetails, error },
        catalogInventoryState: "idle",
        activeError: error,
      });
    }
  }

  disconnect(): Promise<void> {
    if (this.#disconnectPromise) return this.#disconnectPromise;
    if (this.#hardwareBusy) {
      this.#invalidState("Wait for the current write/read/cleanup sequence to finish before disconnecting");
      return Promise.resolve();
    }

    const operation = this.#disconnectCurrentConnection();
    this.#disconnectPromise = operation;
    void operation.then(
      () => { if (this.#disconnectPromise === operation) this.#disconnectPromise = undefined; },
      () => { if (this.#disconnectPromise === operation) this.#disconnectPromise = undefined; },
    );
    return operation;
  }

  async #disconnectCurrentConnection(): Promise<void> {
    const epoch = ++this.#deviceEpoch;
    this.#deviceAbort?.abort(new DOMException("Connection closed by the user", "AbortError"));
    this.#deviceAbort = undefined;
    this.#pendingDevice = undefined;
    const connection = this.#connection;
    this.#connection = undefined;
    this.#clearCurrentCatalogInventoryAuthority();
    if (!connection) {
      this.#connectionMode = undefined;
      this.#commit({
        ...this.#state,
        usbAccessProven: false,
        mtpReadProven: false,
        selfTest: { kind: "not-run" },
        postConnectStage: "idle",
        catalogInventoryState: "idle",
        device: { kind: "disconnected" },
        activeError: undefined,
      });
      this.#markCatalogInventoryLastSeen();
      this.#connectionMode = undefined;
      return;
    }
    this.#commit({
      ...this.#state,
      device: { kind: "recovering", details: connection.details },
      postConnectStage: "idle",
      catalogInventoryState: "idle",
    });
    try {
      await connection.disconnect();
      if (epoch !== this.#deviceEpoch) return;
      this.#commit(this.#stateAfterDisconnect({
        ...this.#state,
        usbAccessProven: false,
        mtpReadProven: false,
        selfTest: { kind: "not-run" },
        postConnectStage: "idle",
        catalogInventoryState: "idle",
        device: { kind: "disconnected" },
        activeError: undefined,
      }, connection));
      this.#markCatalogInventoryLastSeen();
      this.#connectionMode = undefined;
      this.log.info("MTP session closed; USB interface and device released");
    } catch (rawError) {
      if (epoch !== this.#deviceEpoch) return;
      const error = toAppError(rawError, "Could not cleanly close the Kindle connection");
      this.log.error(error.message, errorContext(error));
      this.#commit(this.#stateAfterDisconnect({
        ...this.#state,
        usbAccessProven: false,
        mtpReadProven: false,
        selfTest: { kind: "not-run" },
        postConnectStage: "idle",
        catalogInventoryState: "idle",
        device: { kind: "error", details: connection.details, error },
        activeError: error,
      }, connection));
      this.#markCatalogInventoryLastSeen();
      this.#connectionMode = undefined;
    }
  }

  async runSelfTest(): Promise<void> {
    if (this.#hardwareBusy) {
      this.#invalidState("Another Kindle operation is already running");
      return;
    }
    if (this.#synchronizePendingCleanupFromStorage()) {
      this.#invalidState("Inspect and acknowledge the previously interrupted managed object before any new Kindle write");
      return;
    }
    if (!this.#state.mtpReadProven) {
      this.#invalidState("Kindle inspection must pass before the exact-byte self-test");
      return;
    }
    const connection = this.#readyConnection("Connect and inspect the Kindle before running the byte self-test");
    if (!connection) return;
    const epoch = this.#deviceEpoch;
    const signal = this.#deviceAbort?.signal;
    this.#hardwareBusy = true;
    this.#commit({
      ...this.#state,
      selfTest: { kind: "running" },
      postConnectStage: "safe-write",
      integratedTransfer: { kind: "idle" },
      activeError: undefined,
    });
    this.log.info("Gate 3 exact-byte write/read/delete test started");
    try {
      const result = await connection.runSelfTest({
        signal,
        aggregateTimeoutMs:
          this.#dependencies.selfTestOperationTimeoutMs ?? DEFAULT_SELF_TEST_OPERATION_TIMEOUT_MS,
        onObjectState: this.#objectStateHandler("self-test", undefined, connection.details),
      });
      if (!this.#isActiveConnection(epoch, connection) || this.#state.selfTest.kind !== "running") return;
      this.#commit({
        ...this.#state,
        selfTest: { kind: "passed", byteLength: result.bytesVerified },
        postConnectStage: "idle",
        activeError: undefined,
      });
      this.log.info("Gate 3 exact-byte round trip and cleanup passed", {
        filename: result.filename,
        handle: result.handle,
        bytesVerified: result.bytesVerified,
      });
    } catch (rawError) {
      if (this.#state.selfTest.kind !== "running") return;
      const error = toAppError(rawError, "The exact-byte self-test failed");
      const cleanupRequired = manualCleanupInstruction(error)
        ?? pendingCleanupInstruction(this.#state.pendingObjectCleanup);
      this.#commit({
        ...this.#state,
        selfTest: { kind: "failed", error, cleanupRequired },
        postConnectStage: "idle",
        activeError: error,
      });
      this.log.error(error.message, errorContext(error));
      await this.#retireFaultedConnection(connection, error);
    } finally {
      if (
        epoch === this.#deviceEpoch
        && this.#connection === connection
        && this.#state.postConnectStage !== "idle"
      ) {
        this.#commit({ ...this.#state, postConnectStage: "idle" });
      }
      this.#finishHardwareOperation();
    }
  }

  async convert(): Promise<void> {
    if (this.#conversionPipelineBusy || this.#hardwareBusy) {
      const error = new AppError(
        "CONVERSION_BUSY",
        "Wait for the active Kindle preparation or transfer before starting another conversion",
      );
      this.#commit({ ...this.#state, activeError: error });
      return;
    }
    if (this.#integratedUploadRunning()) {
      this.#invalidState("Wait for the integrated Kindle upload to finish before converting another artifact");
      return;
    }
    const current = this.#state.conversion;
    const file = current.kind === "selected" || current.kind === "ready" || current.kind === "error"
      ? current.file
      : undefined;
    if (!file) {
      this.#invalidState("Choose an EPUB before conversion");
      return;
    }
    this.#conversionAbort?.abort();
    const abort = new AbortController();
    this.#conversionAbort = abort;
    this.#conversionPipelineBusy = true;
    this.#commit({ ...this.#state, conversion: { kind: "converting", file }, activeError: undefined });
    this.log.info("Gate 0 in-browser EPUB conversion started", { filename: file.name, bytes: file.size });
    try {
      const result = await this.#dependencies.convert(file, abort.signal);
      if (this.#conversionAbort !== abort) return;
      this.#commit({
        ...this.#state,
        conversion: {
          kind: "ready",
          file,
          result,
          artifactId: this.#newArtifactId(),
          downloaded: false,
          validated: true,
        },
        integratedTransfer: { kind: "idle" },
        activeError: undefined,
      });
      this.log.info("AZW3 conversion completed", {
        filename: result.filename,
        bytes: result.blob.size,
        engine: result.diagnostics.engine,
        runsLocally: result.diagnostics.runsLocally,
        kindleDocumentType: result.diagnostics.kindleDocumentType,
        embeddedCover: result.diagnostics.embeddedCover,
      });
    } catch (rawError) {
      if (abort.signal.aborted && this.#conversionAbort !== abort) return;
      const error = toAppError(rawError, "EPUB conversion failed");
      this.#commit({ ...this.#state, conversion: { kind: "error", file, error }, activeError: error });
      this.log.error(error.message, errorContext(error));
    } finally {
      if (this.#conversionAbort === abort) this.#conversionAbort = undefined;
      this.#conversionPipelineBusy = false;
    }
  }

  downloadConverted(): void {
    if (this.#integratedUploadRunning()) {
      this.#invalidState("Wait for the integrated Kindle upload to finish before downloading the conversion");
      return;
    }
    if (this.#state.conversion.kind !== "ready") {
      this.#invalidState("Convert an EPUB before downloading AZW3");
      return;
    }
    try {
      this.#dependencies.download(
        this.#state.conversion.result.blob,
        this.#state.conversion.result.filename,
      );
      this.#commit({
        ...this.#state,
        conversion: { ...this.#state.conversion, downloaded: true },
        activeError: undefined,
      });
      this.log.info("Converted AZW3 download started", {
        filename: this.#state.conversion.result.filename,
      });
    } catch (rawError) {
      const error = toAppError(rawError, "Could not download the converted AZW3");
      this.#commit({ ...this.#state, activeError: error });
      this.log.error(error.message, errorContext(error));
    }
  }

  async sendIntegrated(): Promise<void> {
    const conversion = this.#state.conversion;
    if (
      this.#state.selfTest.kind !== "passed"
      || conversion.kind !== "ready"
      || !conversion.validated
    ) {
      this.#invalidState("Local conversion and the exact-byte Kindle self-test must pass before transfer");
      return;
    }
    await this.#sendAndClose(
      "integrated",
      conversion.result.blob,
      conversion.result.filename,
      conversion.artifactId,
    );
  }

  async sendCatalogBook(request: CatalogSendRequest): Promise<void> {
    if (this.#hardwareBusy) {
      throw new AppError("INVALID_STATE", "Another Kindle operation is already running");
    }
    if (this.#conversionPipelineBusy) {
      throw new AppError("CONVERSION_BUSY", "Another browser-local book conversion is already running");
    }
    if (this.#synchronizePendingCleanupFromStorage()) {
      throw new AppError(
        "INVALID_STATE",
        "Inspect and acknowledge the interrupted Kindle object before sending another book",
      );
    }
    if (this.#state.selfTest.kind !== "passed") {
      throw new AppError(
        "MTP_SELF_TEST_REQUIRED",
        "Safe-write check failed. No book has been sent. Reconnect the Kindle and let the automatic check pass.",
      );
    }
    const connection = this.#readyConnection("Connect the Kindle before sending a catalog book");
    if (!connection || !connection.readyForSend) {
      throw new AppError(
        "MTP_SELF_TEST_REQUIRED",
        "Safe-write check failed. No book has been sent. Reconnect the Kindle and let the automatic check pass.",
      );
    }
    if (!this.#catalogInventoryReadyForCurrentConnection(connection, request.profileId)) {
      throw new AppError(
        "INVALID_STATE",
        "The current Kindle inventory and catalog comparison are not ready. Disconnect and reconnect the Kindle before sending.",
      );
    }
    const kindleStatus = this.#view.catalogKindleStatus(request.book.id);
    if (kindleStatus !== "not-on-kindle") {
      throw new AppError(
        "INVALID_STATE",
        kindleStatus === "confirmed"
          ? "This book is already confirmed on the connected Kindle. No duplicate was sent."
          : kindleStatus === "possible"
            ? "This book may already be on the connected Kindle. Resolve the possible match before sending a duplicate."
            : "Kindle presence could not be verified for this book. No book was sent; reconnect and complete inventory before trying again.",
      );
    }
    const reconciliationKey = `${request.profileId}\u0000${request.book.id}`;
    const reconciledContentHash = this.#catalogReconciledContentHashes.get(reconciliationKey);
    if (!reconciledContentHash) {
      throw new AppError(
        "INVALID_STATE",
        "The compared catalog version is unavailable. No book was sent; refresh the Kindle comparison before trying again.",
      );
    }

    const epoch = this.#deviceEpoch;
    const signal = this.#deviceAbort?.signal;
    const operationId = globalThis.crypto?.randomUUID?.()
      ?? `delivery-${Math.max(0, Math.floor(this.#dependencies.now())).toString(36)}-${(++this.#artifactSequence).toString(36)}`;
    this.#hardwareBusy = true;
    this.#conversionPipelineBusy = true;
    this.#lastProgressRender = 0;
    this.#view.setCatalogTransferUpdate({
      phase: "preparing",
      progress: 0,
      message: "Checking the indexed source bytes",
    });

    try {
      // Re-read the profile-scoped record so a stale card can never select a
      // source that has changed ownership or availability.
      const book = await this.#withCatalogDeadline(
        (catalogSignal) => this.#catalogApi.getBook(request.profileId, request.book.id, catalogSignal),
        this.#dependencies.preUploadCatalogTimeoutMs ?? DEFAULT_PRE_UPLOAD_CATALOG_TIMEOUT_MS,
        "pre-upload-book",
        signal,
      );
      this.#assertConnectionCurrent(epoch, connection, signal);
      if (!book.contentHash
        || book.contentHash.toLocaleLowerCase("en-US") !== reconciledContentHash) {
        throw new AppError(
          "CATALOG_SOURCE_CHANGED",
          "The indexed book changed after Kindle comparison. No book was sent; refresh the comparison before trying again.",
        );
      }
      const source = await this.#withCatalogDeadline(
        (catalogSignal) => this.#catalogApi.getBookSource(request.profileId, book.id, catalogSignal),
        this.#dependencies.sourceDownloadTimeoutMs
          ?? this.#dependencies.preUploadCatalogTimeoutMs
          ?? DEFAULT_SOURCE_DOWNLOAD_TIMEOUT_MS,
        "pre-upload-source",
        signal,
      );
      this.#assertConnectionCurrent(epoch, connection, signal);
      const expectedEtag = book.contentHash ? `"sha256-${book.contentHash.toLocaleLowerCase()}"` : undefined;
      if (source.contentLength !== undefined && source.contentLength !== book.size) {
        throw new AppError("CATALOG_SOURCE_CHANGED", "The streamed Content-Length does not match the indexed source", {
          details: { indexedBytes: book.size, receivedBytes: source.contentLength },
        });
      }
      if (source.etag && expectedEtag && source.etag.toLocaleLowerCase() !== expectedEtag) {
        throw new AppError("CATALOG_SOURCE_CHANGED", "The streamed ETag does not match the indexed source hash");
      }
      const prepared = await prepareCatalogArtifact(book, source.blob, {
        signal,
        convertEpub: this.#dependencies.convert,
        onPhase: (phase) => {
          if (phase === "preparing") {
            this.#view.setCatalogTransferUpdate({
              phase: "preparing",
              progress: 3,
              message: "Verifying size, format, and SHA-256",
            });
          } else if (phase === "converting") {
            this.#view.setCatalogTransferUpdate({
              phase: "converting",
              progress: 15,
              message: "Converting an immutable EPUB copy with boko WASM",
            });
          } else if (phase === "validating") {
            this.#view.setCatalogTransferUpdate({
              phase: "validating",
              progress: 20,
              message: "Validating a copied AZW3 and preparing it as a Kindle document",
            });
          }
        },
      });
      this.#assertConnectionCurrent(epoch, connection, signal);
      if (
        connection.details.freeBytes !== undefined
        && BigInt(prepared.blob.size) > connection.details.freeBytes
      ) {
        throw new AppError("MTP_INSUFFICIENT_SPACE", "The Kindle does not have enough free space for this derivative", {
          details: {
            requiredBytes: prepared.blob.size,
            freeBytes: connection.details.freeBytes.toString(),
          },
        });
      }
      const managedToken = await createManagedFilenameToken(book.id, prepared.sourceHash);
      this.#assertConnectionCurrent(epoch, connection, signal);
      // The controller's connection-scoped snapshot may include a verified
      // object synthesized from returned MTP metadata when the device's
      // post-upload hierarchy refresh lagged behind. Prefer that newer view so
      // an immediate retry cannot create a duplicate managed token.
      const knownInventory = this.#currentRawCatalogInventory(connection) ?? connection.latestInventory;
      const existingManagedObjects = knownInventory?.objects.filter((object) => (
        object.kind === "file" && object.managedToken === managedToken
      )) ?? [];
      if (existingManagedObjects.length > 0) {
        throw new AppError(
          "INVALID_STATE",
          "This exact source version is already present on the Kindle. Reconnect or refresh the device inventory before trying again.",
          {
            details: {
              managedToken,
              matchingObjectCount: existingManagedObjects.length,
            },
          },
        );
      }
      this.#view.setCatalogTransferUpdate({
        phase: "sending",
        progress: 25,
        message: "Sending a collision-safe managed filename",
      });
      const sent = await connection.sendAzW3AndRefreshInventory(
        prepared.blob,
        prepared.filename,
        {
          signal,
          managedToken,
          aggregateTimeoutMs: this.#dependencies.sendOperationTimeoutMs
            ?? bookTransferCommandTimeoutMs(prepared.blob.size),
          commandTimeoutMs: bookTransferCommandTimeoutMs(prepared.blob.size),
          inactivityTimeoutMs: 10_000,
          onObjectState: this.#objectStateHandler("catalog", operationId, connection.details),
          onProgress: ({ bytesTransferred, totalBytes }) => {
            if (!this.#isActiveConnection(epoch, connection)) return;
            const now = this.#dependencies.now();
            if (bytesTransferred !== totalBytes && now - this.#lastProgressRender < 100) return;
            this.#lastProgressRender = now;
            const ratio = totalBytes === 0 ? 1 : bytesTransferred / totalBytes;
            this.#view.setCatalogTransferUpdate({
              phase: bytesTransferred === totalBytes ? "verifying" : "sending",
              progress: Math.round(25 + 65 * ratio),
              message: bytesTransferred === totalBytes
                ? "Verifying the returned MTP object metadata"
                : `Sending ${bytesTransferred.toLocaleString()} of ${totalBytes.toLocaleString()} bytes`,
            });
          },
        },
        {
          signal,
          aggregateTimeoutMs:
            this.#dependencies.postUploadInventoryTimeoutMs ?? DEFAULT_POST_UPLOAD_INVENTORY_TIMEOUT_MS,
        },
      );
      const inventory = sent.inventory?.objects.some((object) => object.handle === sent.transfer.handle)
        ? sent.inventory
        : this.#inventoryAfterVerifiedTransfer(
            sent.inventory ?? this.#currentRawCatalogInventory(connection),
            sent.transfer,
            managedToken,
          );
      const delivery: CreateDeliveryInput = {
        profileId: request.profileId,
        bookId: book.id,
        deviceKey: connection.identityKey ?? "unidentified-device",
        status: "delivered",
        artifactHash: prepared.artifactHash,
        filename: sent.transfer.filename,
        size: sent.transfer.size,
        managedToken,
      };
      // From this point onward the returned MTP metadata proves that bytes were
      // written. Install the connection-scoped duplicate guard before touching
      // Web Locks or storage: those best-effort facilities can themselves fail.
      await this.#installVerifiedTransferFallback(
        epoch,
        request.profileId,
        book,
        prepared.sourceHash,
        inventory,
        connection,
        delivery,
      );
      const queued = await queuePendingDelivery({
        version: 1,
        operationId,
        delivery,
        recordedAt: Math.max(0, Math.floor(this.#dependencies.now())),
      }).catch(() => false);
      let deliveryRecorded = false;
      if (queued) {
        try {
          await this.#withPostUploadCatalogDeadline((catalogSignal) => (
            this.#catalogApi.createDelivery(delivery, operationId, catalogSignal)
          ));
          deliveryRecorded = await acknowledgePendingDelivery(operationId);
        } catch {
          // Kept in the bounded journal under the same idempotency key.
        }
      } else {
        try {
          await this.#withPostUploadCatalogDeadline((catalogSignal) => (
            this.#catalogApi.createDelivery(delivery, operationId, catalogSignal)
          ));
          deliveryRecorded = true;
        } catch {
          // The source-version-scoped managed token intentionally preserves
          // recovery evidence for these exact indexed bytes even when browser
          // storage and the API are both unavailable.
        }
      }
      let reconciliationDegraded = false;
      const postTransferConnectionError = sent.connectionFaulted
        ? new AppError(
            "MTP_TRANSPORT_ERROR",
            "The transfer verified, but the Kindle session lost synchronization during inventory refresh. Reconnect before sending another book.",
            { details: { inventoryErrorCode: sent.inventoryErrorCode } },
          )
        : undefined;
      if (postTransferConnectionError) {
        reconciliationDegraded = true;
      } else if (this.#isActiveConnection(epoch, connection)) {
        try {
          const reconciliation = await this.#withPostUploadCatalogDeadline((catalogSignal) => (
            this.#reconcileCatalogInventory(inventory, connection, catalogSignal)
          ));
          reconciliationDegraded = !reconciliation.activeProfileComplete;
          if (reconciliationDegraded) {
            this.log.warn("Transfer verified but some catalog match indexes were unavailable");
          }
        } catch (error) {
          reconciliationDegraded = true;
          if (this.#isActiveConnection(epoch, connection)) {
            this.#catalogInventoryEpoch = undefined;
            this.#commit({ ...this.#state, catalogInventoryState: "failed" });
          }
          this.log.warn("Transfer verified but full catalog matching will retry later", {
            code: errorContext(toAppError(error)).code,
          });
        }
      } else {
        reconciliationDegraded = true;
      }
      this.#view.setCatalogTransferUpdate({
        phase: "complete",
        progress: 100,
        message: reconciliationDegraded
          ? "Transfer verified; live catalog matching will retry when the connection is available"
          : deliveryRecorded
            ? "Transfer and delivery record verified"
            : "Transfer verified; the managed filename will recover the match when the catalog returns",
      });
      this.log.info(postTransferConnectionError
        ? "Catalog book transfer verified; faulted Kindle session will be retired"
        : "Catalog book transfer verified while keeping the Kindle session open", {
        profileId: request.profileId,
        bookId: book.id,
        filename: sent.transfer.filename,
        bytes: sent.transfer.size,
        inventoryRefresh: sent.inventoryRefresh,
        deliveryRecorded,
      });
      if (postTransferConnectionError && this.#connection === connection) {
        await this.#retireFaultedConnection(connection, postTransferConnectionError);
      }
    } catch (rawError) {
      const error = toAppError(rawError, "The catalog book could not be sent");
      const connectionFaulted = this.#connection === connection && (
        (rawError !== null && typeof rawError === "object" && Reflect.get(rawError, "fatal") === true)
        || !connection.readyForSend
      );
      this.#view.setCatalogTransferUpdate({
        phase: "failed",
        message: error.message,
      });
      this.log.error(error.message, errorContext(error));
      // A fatal MTP command failure faults the underlying transaction stream.
      // Do not leave stale AppState readiness or the browser-wide device lease
      // alive for a retry on a session that can no longer accept commands.
      if (connectionFaulted) await this.#retireFaultedConnection(connection, error);
      throw error;
    } finally {
      this.#conversionPipelineBusy = false;
      this.#finishHardwareOperation();
    }
  }

  confirmIntegratedOpened(): void {
    const transfer = this.#state.integratedTransfer;
    if (transfer.kind !== "verified") {
      this.#invalidState("The integrated transfer must verify and close cleanly first");
      return;
    }
    if (
      this.#state.conversion.kind !== "ready"
      || !this.#state.conversion.validated
      || transfer.artifactId === undefined
      || transfer.artifactId !== this.#state.conversion.artifactId
    ) {
      this.#invalidState("The converted artifact changed after upload; repeat the integrated transfer with the current artifact");
      return;
    }
    this.#commit({
      ...this.#state,
      integratedTransfer: { ...transfer, physicalOpenConfirmed: true },
      activeError: undefined,
    });
    this.log.info("Gate 5 end-to-end Kindle open manually confirmed", {
      filename: transfer.filename,
    });
  }

  async confirmCleanupInspection(): Promise<void> {
    if (this.#hardwareBusy) {
      this.#invalidState("Wait for the current Kindle operation to finish before acknowledging manual inspection");
      return;
    }
    if (!this.#connection && this.#deviceAbort) {
      this.#invalidState("Wait for the current Kindle connection attempt to finish before acknowledging manual inspection");
      return;
    }
    const pending = this.#state.pendingObjectCleanup;
    if (!pending) {
      this.#invalidState("There is no interrupted object requiring manual inspection");
      return;
    }
    this.#hardwareBusy = true;
    let recoveryLease: KindleDeviceLease | undefined;
    try {
      // A live connection already holds this browser-wide lock. A disconnected
      // tab must acquire it before touching the shared journal, so it cannot
      // acknowledge another tab's in-flight SendObjectInfo/SendObject.
      if (!this.#connection) {
        recoveryLease = await (
          this.#dependencies.acquireRecoveryLease ?? (() => acquireKindleDeviceLease())
        )();
      }
      const durable = readPendingObjectCleanup();
      if (!samePendingObjectCleanup(durable, pending)) {
        this.#commit({
          ...this.#state,
          pendingObjectCleanup: durable,
        });
        this.#invalidState(
          "The interrupted-object recovery record changed in another tab. Review the current exact filename before acknowledging it.",
        );
        return;
      }
      if (!clearPendingObjectCleanup(pending)) {
        this.#invalidState("Browser storage could not safely clear this exact recovery record; do not start another Kindle write yet");
        return;
      }
      this.#commit({
        ...this.#state,
        pendingObjectCleanup: undefined,
        activeError: undefined,
      });
      this.log.info("Manual inspection of the interrupted managed object was acknowledged", {
        purpose: pending.purpose,
        stage: pending.stage,
        handleKnown: pending.handle !== undefined,
      });
      const connection = this.#connection;
      if (
        connection
        && !connection.closed
        && this.#connectionMode === "catalog"
        && this.#state.device.kind === "ready"
      ) {
        // The live connection already owns the browser-wide device lease. Only
        // after the exact durable compare-and-delete above may it create the
        // self-test object and rebuild current Send authority automatically.
        if (this.#synchronizePendingCleanupFromStorage()) {
          this.#invalidState(
            "A new interrupted-object recovery record appeared before the safe-write check could restart",
          );
          return;
        }
        this.log.info("Restarting the automatic safe-write check after recovery acknowledgement");
        await this.#runAutomaticPostConnect(
          this.#deviceEpoch,
          connection,
          this.#deviceAbort?.signal,
        );
      }
    } catch (rawError) {
      const error = toAppError(rawError, "The interrupted-object record is still protected by another Kindle operation");
      this.#commit({ ...this.#state, activeError: error });
      this.log.warn(error.message, errorContext(error));
    } finally {
      if (recoveryLease) {
        try {
          await recoveryLease.release();
        } catch (releaseError) {
          this.log.warn("The recovery journal lock did not release cleanly", {
            message: releaseError instanceof Error ? releaseError.message : String(releaseError),
          });
        }
      }
      this.#finishHardwareOperation();
    }
  }

  async copyLog(): Promise<void> {
    try {
      await this.#dependencies.copyText(this.log.format());
      this.log.info("Debug log copied to clipboard");
    } catch (rawError) {
      const error = toAppError(rawError, "Could not copy the debug log");
      this.#commit({ ...this.#state, activeError: error });
      this.log.error(error.message, errorContext(error));
    }
  }

  async #sendAndClose(
    purpose: TransferPurpose,
    blob: Blob,
    originalFilename: string,
    artifactId?: string,
  ): Promise<void> {
    if (this.#hardwareBusy) {
      this.#invalidState("Another Kindle operation is already running");
      return;
    }
    if (this.#synchronizePendingCleanupFromStorage()) {
      this.#invalidState("Inspect and acknowledge the previously interrupted managed object before any new Kindle write");
      return;
    }
    const connection = this.#readyConnection("Reconnect the Kindle before sending a book");
    if (!connection) return;
    const epoch = this.#deviceEpoch;
    const signal = this.#deviceAbort?.signal;
    const details = connection.details;
    const transferKey = "integratedTransfer" as const;
    this.#hardwareBusy = true;
    this.#lastProgressRender = 0;
    this.#commit({
      ...this.#state,
      device: { kind: "transferring", details },
      [transferKey]: {
        kind: "sending",
        purpose,
        filename: originalFilename,
        ...(artifactId === undefined ? {} : { artifactId }),
        sentBytes: 0,
        totalBytes: blob.size,
      },
      activeError: undefined,
    });
    this.log.info("Gate 4 converted-book upload started", {
      sourceFilename: originalFilename,
      bytes: blob.size,
    });

    let uploaded: KindleBookTransferResult | undefined;
    try {
      uploaded = await connection.sendAzW3(blob, originalFilename, {
        signal,
        aggregateTimeoutMs: this.#dependencies.sendOperationTimeoutMs
          ?? bookTransferCommandTimeoutMs(blob.size),
        commandTimeoutMs: bookTransferCommandTimeoutMs(blob.size),
        inactivityTimeoutMs: 10_000,
        onObjectState: this.#objectStateHandler(purpose, artifactId, details),
        onProgress: ({ bytesTransferred, totalBytes }) => {
          if (!this.#isActiveConnection(epoch, connection)) return;
          const now = this.#dependencies.now();
          if (bytesTransferred !== totalBytes && now - this.#lastProgressRender < 100) return;
          this.#lastProgressRender = now;
          this.#commit({
            ...this.#state,
            [transferKey]: {
              kind: "sending",
              purpose,
              filename: originalFilename,
              ...(artifactId === undefined ? {} : { artifactId }),
              sentBytes: bytesTransferred,
              totalBytes,
            },
          });
        },
      });
      if (!this.#isActiveConnection(epoch, connection)) return;

      this.#connection = undefined;
      this.#clearCurrentCatalogInventoryAuthority();
      await connection.disconnect();
      if (epoch !== this.#deviceEpoch) return;
      this.#deviceEpoch += 1;
      this.#deviceAbort = undefined;
      this.#commit(this.#stateAfterDisconnect({
        ...this.#state,
        device: { kind: "disconnected" },
        postConnectStage: "idle",
        catalogInventoryState: "idle",
        [transferKey]: {
          kind: "verified",
          purpose,
          filename: uploaded.filename,
          ...(artifactId === undefined ? {} : { artifactId }),
          totalBytes: uploaded.size,
          physicalOpenConfirmed: false,
        },
        activeError: undefined,
      }, connection));
      this.#markCatalogInventoryLastSeen();
      this.#connectionMode = undefined;
      this.log.info("Object metadata verified and connection closed cleanly", {
        filename: uploaded.filename,
        handle: uploaded.handle,
        storageId: uploaded.storageId,
        parentHandle: uploaded.parentHandle,
        bytes: uploaded.size,
      });
    } catch (rawError) {
      const activeTransfer = this.#state[transferKey];
      if (
        activeTransfer.kind !== "sending"
        || activeTransfer.purpose !== purpose
        || activeTransfer.filename !== originalFilename
      ) {
        return;
      }
      if (epoch !== this.#deviceEpoch) return;
      const error = toAppError(rawError, "The Kindle book transfer failed");
      let cleanupRequired = manualCleanupInstruction(error)
        ?? pendingCleanupInstruction(this.#state.pendingObjectCleanup);
      if (uploaded) {
        cleanupRequired = `The book metadata was verified as ${uploaded.filename}, but the session did not close cleanly. Disconnect safely and inspect only that generated file.`;
      }
      if (this.#connection === connection) {
        this.#connection = undefined;
        this.#clearCurrentCatalogInventoryAuthority();
        try {
          await connection.disconnect();
        } catch (cleanupError) {
          this.log.warn("Connection cleanup after transfer failure was incomplete", {
            message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      if (epoch === this.#deviceEpoch) {
        this.#deviceEpoch += 1;
        this.#deviceAbort = undefined;
      }
      const deviceState = this.#state.device.kind === "error"
        ? this.#state.device
        : uploaded
          ? { kind: "error" as const, details, error }
          : { kind: "disconnected" as const };
      this.#commit(this.#stateAfterDisconnect({
        ...this.#state,
        device: deviceState,
        postConnectStage: "idle",
        catalogInventoryState: "idle",
        [transferKey]: {
          kind: "failed",
          purpose,
          filename: uploaded?.filename ?? originalFilename,
          ...(artifactId === undefined ? {} : { artifactId }),
          error,
          cleanupRequired,
        },
        activeError: error,
      }, connection));
      this.#markCatalogInventoryLastSeen();
      this.#connectionMode = undefined;
      this.log.error(error.message, errorContext(error));
    } finally {
      this.#finishHardwareOperation();
    }
  }

  /**
   * Re-establish current-connection write and catalog authority. This is used
   * both immediately after opening a normal catalog connection and after the
   * user exactly acknowledges an older durable recovery record on that same
   * live connection.
   */
  async #runAutomaticPostConnect(
    epoch: number,
    connection: ConnectedKindlePort,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.#isActiveConnection(epoch, connection)) return;
    this.#commit({
      ...this.#state,
      selfTest: { kind: "running" },
      postConnectStage: "safe-write",
      device: { kind: "ready", details: connection.details },
      catalogInventoryState: "loading",
      activeError: undefined,
    });
    try {
      const selfTest = await connection.runSelfTest({
        signal,
        aggregateTimeoutMs:
          this.#dependencies.selfTestOperationTimeoutMs ?? DEFAULT_SELF_TEST_OPERATION_TIMEOUT_MS,
        onObjectState: this.#objectStateHandler("self-test", undefined, connection.details),
      });
      if (!this.#isActiveConnection(epoch, connection)) return;
      this.log.info("Automatic exact-byte round trip and cleanup passed", {
        filename: selfTest.filename,
        handle: selfTest.handle,
        bytesVerified: selfTest.bytesVerified,
      });
      this.#commit({
        ...this.#state,
        selfTest: { kind: "passed", byteLength: selfTest.bytesVerified },
        postConnectStage: "inventory",
      });

      let inventory: KindleInventorySnapshot | undefined;
      try {
        inventory = await connection.refreshInventory({
          signal,
          aggregateTimeoutMs:
            this.#dependencies.connectInventoryTimeoutMs ?? DEFAULT_CONNECT_INVENTORY_TIMEOUT_MS,
        });
      } catch (inventoryError) {
        if (isFatalInventoryError(inventoryError)) throw inventoryError;
        this.#catalogInventoryEpoch = undefined;
        this.log.warn("Kindle inventory refresh failed after the safe-write test", {
          code: errorContext(toAppError(inventoryError)).code,
        });
      }
      if (!this.#isActiveConnection(epoch, connection)) return;
      if (inventory) {
        this.#commit({ ...this.#state, postConnectStage: "reconciliation" });
        try {
          await this.#withCatalogDeadline(
            (catalogSignal) => this.#reconcileCatalogInventory(inventory!, connection, catalogSignal),
            this.#dependencies.connectCatalogTimeoutMs ?? DEFAULT_CONNECT_CATALOG_TIMEOUT_MS,
            "connect-reconciliation",
            signal,
          );
        } catch (inventoryError) {
          if (!this.#isActiveConnection(epoch, connection)) return;
          this.log.warn("Kindle inventory could not be reconciled after the safe-write test", {
            code: errorContext(toAppError(inventoryError)).code,
          });
        }
      }
      if (!this.#isActiveConnection(epoch, connection)) return;
      this.#commit({
        ...this.#state,
        selfTest: { kind: "passed", byteLength: selfTest.bytesVerified },
        postConnectStage: "idle",
        device: { kind: "ready", details: connection.details },
        catalogInventoryState: this.#catalogInventoryEpoch === epoch ? "ready" : "failed",
        activeError: undefined,
      });
    } catch (rawPostConnectError) {
      if (!this.#isActiveConnection(epoch, connection)) return;
      const safeWritePassed = this.#state.selfTest.kind === "passed";
      const underlying = toAppError(
        rawPostConnectError,
        safeWritePassed
          ? "The Kindle inventory or catalog comparison failed"
          : "The automatic exact-byte self-test failed",
      );
      const error = new AppError(
        underlying.code,
        safeWritePassed
          ? `Kindle inventory/comparison failed after the safe-write check passed. No book has been sent. ${underlying.message}`
          : `Safe-write check failed. No book has been sent. ${underlying.message}`,
        { cause: underlying, details: underlying.details },
      );
      const cleanupRequired = safeWritePassed
        ? undefined
        : manualCleanupInstruction(underlying)
          ?? pendingCleanupInstruction(this.#state.pendingObjectCleanup);
      this.#commit({
        ...this.#state,
        selfTest: safeWritePassed
          ? this.#state.selfTest
          : { kind: "failed", error, cleanupRequired },
        postConnectStage: "idle",
        catalogInventoryState: "failed",
        activeError: error,
      });
      this.log.error(error.message, errorContext(error));
      await this.#retireFaultedConnection(connection, error);
    } finally {
      if (
        epoch === this.#deviceEpoch
        && this.#connection === connection
        && this.#state.postConnectStage !== "idle"
      ) {
        this.#commit({ ...this.#state, postConnectStage: "idle" });
      }
    }
  }

  async #reconcileCatalogInventory(
    inventory: KindleInventorySnapshot,
    connection: ConnectedKindlePort,
    catalogSignal?: AbortSignal,
  ): Promise<CatalogReconciliationResult> {
    const epoch = this.#deviceEpoch;
    const signal = catalogSignal ?? this.#deviceAbort?.signal;
    if (!this.#isActiveConnection(epoch, connection)) return { complete: false, activeProfileComplete: false };
    this.#catalogInventoryEpoch = undefined;
    this.#commit({ ...this.#state, catalogInventoryState: "loading" });
    let profileIds: string[] = [];
    let profileDiscoveryComplete = true;
    try {
      const profiles = await this.#catalogApi.listProfiles(signal);
      profileIds = profiles.filter((profile) => profile.enabled).map((profile) => profile.id);
    } catch (error) {
      profileDiscoveryComplete = false;
      const active = this.#view.activeCatalogProfileId;
      if (active) profileIds = [active];
      this.log.warn("The catalog profile list was unavailable during Kindle reconciliation", {
        code: errorContext(toAppError(error)).code,
      });
    }
    signal?.throwIfAborted();

    const activeProfileId = this.#view.activeCatalogProfileId;
    const uniqueProfileIds = [...new Set(profileIds)];
    if (activeProfileId) {
      const activeIndex = uniqueProfileIds.indexOf(activeProfileId);
      if (activeIndex > 0) {
        uniqueProfileIds.splice(activeIndex, 1);
        uniqueProfileIds.unshift(activeProfileId);
      }
    }
    const configuredLimits = {
      ...DEFAULT_CATALOG_RECONCILIATION_LIMITS,
      ...(this.#dependencies.catalogReconciliationLimits ?? {}),
    };
    const indexes: CatalogMatchIndex[] = [];
    const retained: CatalogReconciliationFootprint = {
      profiles: 0,
      entries: 0,
      deliveries: 0,
      stringValues: 0,
      stringCodeUnits: 0,
    };
    let failedIndexes = 0;
    let budgetSkippedIndexes = 0;
    const requestedProfileId = activeProfileId && uniqueProfileIds.includes(activeProfileId)
      ? activeProfileId
      : uniqueProfileIds[0];
    // Reconcile only the visible profile. This gives a strict one-index browser
    // aggregate and prevents an unrelated/hung household profile from consuming
    // the post-connect deadline. Selecting another profile queues an on-demand
    // reconciliation against the same connection-scoped raw inventory.
    if (requestedProfileId) {
      signal?.throwIfAborted();
      try {
        const index = await this.#catalogApi.getMatchIndex(requestedProfileId, signal);
        signal?.throwIfAborted();
        if (index.profileId !== requestedProfileId) {
          throw new Error("The catalog returned a match index for another profile.");
        }
        const next = addMatchIndexFootprint(retained, matchIndexFootprint(index), configuredLimits);
        if (!next) {
          budgetSkippedIndexes += 1;
        } else {
          indexes.push(index);
        }
      } catch (error) {
        failedIndexes += 1;
        this.log.warn("A profile match index was unavailable", {
          code: errorContext(toAppError(error)).code,
        });
      }
    }
    failedIndexes += budgetSkippedIndexes;
    const deferredIndexes = Math.max(0, uniqueProfileIds.length - (requestedProfileId ? 1 : 0));
    if (budgetSkippedIndexes > 0) {
      this.log.warn("The active profile match index exceeded the browser reconciliation budget", {
        skippedProfiles: budgetSkippedIndexes,
      });
    }
    if (deferredIndexes > 0) {
      this.log.info("Other household profiles will be reconciled when selected", {
        deferredProfiles: deferredIndexes,
      });
    }
    if (failedIndexes > 0) {
      this.log.warn("The active profile match index was unavailable", { failedProfiles: failedIndexes });
    }
    signal?.throwIfAborted();
    const reconciled = await reconcileCatalogIndexes(indexes, inventory, {
      deviceLabel: connection.details.model ?? connection.details.productName ?? "Connected Kindle",
      deviceKey: connection.identityKey,
      scannedAt: new Date(this.#dependencies.now()),
      metadataClaimScopeComplete: indexes.every((index) => index.metadataClaims?.complete === true),
    });
    signal?.throwIfAborted();
    if (!this.#isActiveConnection(epoch, connection)) {
      signal?.throwIfAborted();
      return { complete: false, activeProfileComplete: false };
    }
    const activeProfileComplete = requestedProfileId !== undefined
      && indexes.some((index) => index.profileId === requestedProfileId);
    const presentedInventory = {
      ...reconciled.inventory,
      matching: {
        // This contract describes the currently visible profile. A successful
        // profile-scoped match index is authoritative for that profile even if
        // the optional household profile-list request failed transiently.
        status: activeProfileComplete ? "complete" as const : "unavailable" as const,
        matchedProfiles: indexes.length,
        failedProfiles: activeProfileComplete ? 0 : 1,
        ...(profileDiscoveryComplete ? { deferredProfiles: deferredIndexes } : {}),
      },
    };
    this.#rawCatalogInventory = inventory;
    this.#catalogInventory = presentedInventory;
    this.#catalogReadyProfileIds = new Set(indexes.map((index) => index.profileId));
    this.#catalogReconciledContentHashes = new Map(indexes.flatMap((index) => index.entries.map((entry) => [
      `${index.profileId}\u0000${entry.bookId}`,
      entry.contentHash.toLocaleLowerCase("en-US"),
    ] as const)));
    this.#view.setCatalogKindleStatuses(reconciled.statuses, reconciled.statusCountsByProfile);
    this.#view.setCatalogKindleInventory(presentedInventory);
    const comparisonReady = presentedInventory.matching.status !== "unavailable";
    this.#catalogInventoryEpoch = comparisonReady ? epoch : undefined;
    this.#commit({
      ...this.#state,
      catalogInventoryState: comparisonReady ? "ready" : "failed",
    });
    this.log.info("Kindle Documents inventory reconciled in the browser", {
      completeness: inventory.status,
      objects: inventory.objects.length,
      issues: inventory.issueCount,
      profiles: indexes.length,
      metadataStatus: inventory.bookMetadata?.status,
      metadataReads: inventory.bookMetadata?.attemptedObjectCount,
      metadataCacheHits: inventory.bookMetadata?.cacheHitObjectCount ?? 0,
      managedMetadataSkips: inventory.bookMetadata?.managedObjectCount ?? 0,
      metadataReadBytes: inventory.bookMetadata?.readByteCount,
    });
    return {
      complete: activeProfileComplete,
      activeProfileComplete,
    };
  }

  async #withPostUploadCatalogDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.#withCatalogDeadline(
      operation,
      this.#dependencies.postUploadCatalogTimeoutMs ?? DEFAULT_POST_UPLOAD_CATALOG_TIMEOUT_MS,
      "post-upload",
    );
  }

  async #openDeviceWithDeadline(
    device: UsbDeviceLike,
    hooks: DeviceRuntimeHooks,
    parentSignal: AbortSignal,
  ): Promise<ConnectedKindlePort> {
    parentSignal.throwIfAborted();
    const controller = new AbortController();
    const timeoutMs = Math.max(
      1,
      this.#dependencies.openDeviceTimeoutMs ?? DEFAULT_OPEN_DEVICE_TIMEOUT_MS,
    );
    const timeoutError = new AppError(
      "USB_OPEN_TIMEOUT",
      "Opening the Kindle and locating its Documents storage took too long. The partial session was closed; reconnect the Kindle and try again.",
      { details: { phase: "open-device", timeoutMs } },
    );
    let retired = false;
    let terminalReason: unknown;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let removeParentAbort = (): void => undefined;
    const guardedHooks: DeviceRuntimeHooks = {
      onDescriptor: (details, descriptor) => {
        if (!retired) hooks.onDescriptor(details, descriptor);
      },
      onUsbOpen: (details) => {
        if (!retired) hooks.onUsbOpen(details);
      },
      onMtpReading: (details) => {
        if (!retired) hooks.onMtpReading(details);
      },
    };

    const openPromise = this.#dependencies.openDevice(
      device,
      guardedHooks,
      controller.signal,
    ).then(
      (connection) => {
        if (!retired) return connection;
        void connection.disconnect().catch((cleanupError) => {
          this.log.warn("Late Kindle open cleanup was incomplete", {
            message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        });
        throw terminalReason ?? new DOMException("Kindle open retired", "AbortError");
      },
      (error: unknown) => {
        throw retired && terminalReason !== undefined ? terminalReason : error;
      },
    );
    // A deliberately non-cooperative adapter may settle after the aggregate
    // deadline. Observe that late branch while the race returns promptly.
    void openPromise.catch(() => undefined);

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        retired = true;
        terminalReason = timeoutError;
        controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });
    const parentAbort = new Promise<never>((_resolve, reject) => {
      const abort = (): void => {
        retired = true;
        terminalReason = parentSignal.reason
          ?? new DOMException("Kindle open aborted", "AbortError");
        controller.abort(terminalReason);
        reject(terminalReason);
      };
      if (parentSignal.aborted) abort();
      else {
        parentSignal.addEventListener("abort", abort, { once: true });
        removeParentAbort = () => parentSignal.removeEventListener("abort", abort);
      }
    });

    try {
      return await Promise.race([openPromise, timeout, parentAbort]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      removeParentAbort();
    }
  }

  async #withCatalogDeadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    requestedTimeoutMs: number,
    phase: string,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = Math.max(1, requestedTimeoutMs);
    const timeoutError = new AppError(
      "CATALOG_REQUEST_FAILED",
      phase === "post-upload"
        ? "The catalog backend did not respond after the verified Kindle transfer"
        : "The catalog backend did not respond while the Kindle session was active",
      { details: { phase, timeoutMs } },
    );
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let removeParentAbort = (): void => undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });
    const parentAbort = new Promise<never>((_resolve, reject) => {
      if (!parentSignal) return;
      const abort = (): void => {
        const reason = parentSignal.reason ?? new DOMException("Catalog request aborted", "AbortError");
        controller.abort(reason);
        reject(reason);
      };
      if (parentSignal.aborted) abort();
      else {
        parentSignal.addEventListener("abort", abort, { once: true });
        removeParentAbort = () => parentSignal.removeEventListener("abort", abort);
      }
    });
    try {
      return await Promise.race([operation(controller.signal), timeout, parentAbort]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      removeParentAbort();
    }
  }

  #queueConnectedCatalogReconciliation(): Promise<void> {
    if (!this.#connection) {
      this.#catalogEventReconciliationQueued = false;
      return Promise.resolve();
    }
    if (!this.#rawCatalogInventory) {
      // Catalog bootstrap/profile selection can finish while the automatic
      // connection inventory is still being reconciled. Preserve that intent;
      // #finishHardwareOperation will replay it after the raw snapshot exists.
      this.#catalogEventReconciliationQueued = true;
      return Promise.resolve();
    }
    if (this.#hardwareBusy) {
      // SSE events are hints, so coalesce any number received during an MTP
      // transaction into one reconciliation after the hardware operation has
      // released its connection-scoped state.
      this.#catalogEventReconciliationQueued = true;
      return this.#catalogEventReconciliation ?? Promise.resolve();
    }
    if (this.#catalogEventReconciliation) {
      this.#catalogEventReconciliationQueued = true;
      return this.#catalogEventReconciliation;
    }
    let reconciliationConnection: ConnectedKindlePort | undefined;
    const operation = (async () => {
      do {
        this.#catalogEventReconciliationQueued = false;
        const connection = this.#connection;
        const inventory = this.#rawCatalogInventory;
        if (!connection || connection.closed || !inventory || this.#hardwareBusy) return;
        reconciliationConnection = connection;
        await this.#withCatalogDeadline(
          (catalogSignal) => this.#reconcileCatalogInventory(inventory, connection, catalogSignal),
          this.#dependencies.connectedCatalogTimeoutMs ?? DEFAULT_CONNECTED_CATALOG_TIMEOUT_MS,
          "connected-reconciliation",
          this.#deviceAbort?.signal,
        );
      } while (this.#catalogEventReconciliationQueued);
    })().catch((error: unknown) => {
      if (reconciliationConnection && this.#connection === reconciliationConnection && !reconciliationConnection.closed) {
        this.#catalogInventoryEpoch = undefined;
        this.#commit({ ...this.#state, catalogInventoryState: "failed" });
      }
      this.log.warn("Connected Kindle matching could not refresh after a catalog change", {
        code: errorContext(toAppError(error)).code,
      });
    }).finally(() => {
      this.#catalogEventReconciliation = undefined;
    });
    this.#catalogEventReconciliation = operation;
    return operation;
  }

  #inventoryAfterVerifiedTransfer(
    previous: KindleInventorySnapshot | undefined,
    transfer: KindleBookTransferResult,
    managedToken: string,
  ): KindleInventorySnapshot {
    const existing = previous?.objects.filter((object) => object.handle !== transfer.handle) ?? [];
    const retained = existing.slice(-(MAX_SYNTHETIC_INVENTORY_OBJECTS - 1));
    const objects = [...retained, {
      handle: transfer.handle,
      storageId: transfer.storageId,
      parentHandle: transfer.parentHandle,
      objectFormat: 0xb00a,
      protectionStatus: 0,
      associationType: 0,
      size: transfer.size,
      filename: transfer.filename,
      relativePath: transfer.filename,
      depth: 1,
      kind: "file" as const,
      managedToken: extractManagedFilenameToken(transfer.filename) ?? managedToken,
      metadataAdjusted: false,
    }];
    const issue = {
      code: "children-unavailable" as const,
      operation: "list-children" as const,
      detailCode: "POST_TRANSFER_REFRESH_FAILED",
    };
    const priorIssues = previous?.issues.slice(-(MAX_SYNTHETIC_INVENTORY_ISSUES - 1)) ?? [];
    const issues = [...priorIssues, issue];
    return {
      status: "partial",
      storageId: previous?.storageId ?? transfer.storageId,
      documentsHandle: previous?.documentsHandle ?? transfer.parentHandle,
      objects,
      issues,
      issueCount: (previous?.issueCount ?? 0) + 1,
      scannedObjectCount: objects.length,
    };
  }

  async #installVerifiedTransferFallback(
    epoch: number,
    profileId: string,
    book: CatalogSendRequest["book"],
    sourceHash: string,
    inventory: KindleInventorySnapshot,
    connection: ConnectedKindlePort,
    delivery: CreateDeliveryInput,
  ): Promise<void> {
    try {
      const reconciled = await reconcileCatalogIndexes([{
        profileId,
        generatedAt: new Date(this.#dependencies.now()).toISOString(),
        entries: [{
          bookId: book.id,
          title: book.title,
          authors: [...book.authors],
          identifiers: [...book.identifiers],
          sourceFormat: book.format,
          sourceSize: book.size,
          contentHash: book.contentHash ?? sourceHash,
          sourceFilename: book.sourceFilename,
          managedToken: delivery.managedToken as string,
          deliveries: [{
            deviceKey: delivery.deviceKey,
            filename: delivery.filename,
            artifactHash: delivery.artifactHash,
            artifactSize: delivery.size,
            objectIdentity: delivery.objectIdentity,
            managedToken: delivery.managedToken,
            status: "delivered",
            deliveredAt: new Date(this.#dependencies.now()).toISOString(),
          }],
        }],
      }], inventory, {
        deviceLabel: connection.details.model ?? connection.details.productName ?? "Connected Kindle",
        deviceKey: connection.identityKey,
        scannedAt: new Date(this.#dependencies.now()),
      });
      // This local fallback knows exactly what MTP verified, but it cannot
      // prove that the catalog still exposes the same source version under
      // this stable book ID. Keep the association visibly uncertain here;
      // only the authoritative post-send match-index reconciliation below may
      // turn it green.
      const fallbackInventory: CatalogKindleInventory = {
        ...reconciled.inventory,
        items: reconciled.inventory.items.map((item) => (
          item.bookId === book.id && item.match === "confirmed"
            ? { ...item, match: "possible" as const }
            : item
        )),
      };
      const presented: CatalogKindleInventory = {
        ...fallbackInventory,
        matching: { status: "partial", matchedProfiles: 1, failedProfiles: 1 },
      };
      const connectionCurrent = this.#isActiveConnection(epoch, connection);
      if (connectionCurrent) this.#rawCatalogInventory = inventory;
      const safePresentation = connectionCurrent
        ? presented
        : asLastSeenInventory(presented)!;
      this.#catalogInventory = safePresentation;
      // CatalogBrowser merges the verified association into its existing map;
      // fallback evidence remains Possible until a fresh full index confirms it.
      this.#view.setCatalogKindleInventory(safePresentation);
      this.#view.setCatalogKindleBookStatus(
        profileId,
        book.id,
        connectionCurrent ? "possible" : "unknown",
      );
    } catch (error) {
      // Retain raw evidence only while this exact connection still owns the
      // current epoch. A lifecycle-invalidated device may be shown as Last
      // seen, but must never regain live Send authority.
      if (this.#isActiveConnection(epoch, connection)) this.#rawCatalogInventory = inventory;
      // This post-verification presentation failure must never reclassify the
      // MTP write itself as failed.
      this.log.warn("Verified transfer fallback inventory could not be presented", {
        code: errorContext(toAppError(error)).code,
      });
    }
  }

  #markCatalogInventoryLastSeen(): void {
    this.#catalogInventory = asLastSeenInventory(this.#catalogInventory);
    this.#view.setCatalogKindleInventory(this.#catalogInventory);
  }

  #synchronizePendingCleanupFromStorage(): PendingObjectCleanup | undefined {
    const durable = readPendingObjectCleanup();
    if (!durable) return this.#state.pendingObjectCleanup;
    const current = this.#state.pendingObjectCleanup;
    if (current && JSON.stringify(current) === JSON.stringify(durable)) return current;
    this.#commit({ ...this.#state, pendingObjectCleanup: durable });
    this.log.warn("A recovery record from another browser tab now blocks Kindle writes", {
      purpose: durable.purpose,
      stage: durable.stage,
      handleKnown: durable.handle !== undefined,
    });
    return durable;
  }

  #clearCurrentCatalogInventoryAuthority(): void {
    this.#rawCatalogInventory = undefined;
    this.#catalogInventoryEpoch = undefined;
    this.#catalogReadyProfileIds.clear();
    this.#catalogReconciledContentHashes.clear();
  }

  #currentRawCatalogInventory(connection: ConnectedKindlePort): KindleInventorySnapshot | undefined {
    return this.#connection === connection && this.#catalogInventoryEpoch === this.#deviceEpoch
      ? this.#rawCatalogInventory
      : undefined;
  }

  #catalogInventoryReadyForCurrentConnection(connection: ConnectedKindlePort, profileId: string): boolean {
    return this.#state.catalogInventoryState === "ready"
      && this.#currentRawCatalogInventory(connection)?.status === "complete"
      && this.#catalogReadyProfileIds.has(profileId)
      && this.#catalogInventory?.completeness !== "last-seen"
      && this.#catalogInventory?.matching?.status !== "unavailable";
  }

  #hasRetainedDeviceAuthority(): boolean {
    return Boolean(
      this.#connection
      || this.#pendingDevice
      || this.#hardwareBusy
      || ["requesting-permission", "opening", "mtp-reading", "ready", "transferring", "recovering"]
        .includes(this.#state.device.kind)
      || (this.#catalogInventory && this.#catalogInventory.completeness !== "last-seen")
    );
  }

  #lifecycleError(
    reason: BrowserLifecycleInvalidationReason,
    hiddenMilliseconds?: number,
  ): AppError {
    const message = reason === "visibility-gap"
      ? `The Kindle connection expired after this page was hidden for ${Math.ceil((hiddenMilliseconds ?? 0) / 1_000)} seconds. Reconnect the Kindle and let the automatic byte self-test pass before sending.`
      : reason === "bfcache-restore"
        ? "The Kindle connection expired when this page entered or returned from the browser back/forward cache. Reconnect the Kindle and let the automatic byte self-test pass before sending."
        : "The Kindle connection was closed because the browser page lifecycle ended. Reconnect the Kindle and let the automatic byte self-test pass before sending.";
    return new AppError("USB_SESSION_STALE", message, {
      details: {
        reason,
        ...(hiddenMilliseconds === undefined ? {} : { hiddenMilliseconds }),
      },
    });
  }

  #invalidateForBrowserLifecycle(
    reason: BrowserLifecycleInvalidationReason,
    hiddenMilliseconds?: number,
  ): void {
    const hasAuthority = this.#hasRetainedDeviceAuthority();
    const conversionAbort = this.#conversionAbort;
    this.#conversionAbort = undefined;
    conversionAbort?.abort(new DOMException("Browser lifecycle invalidated the operation", "AbortError"));
    if (!hasAuthority) {
      if (this.#state.conversion.kind === "converting") {
        this.#commit({
          ...this.#state,
          conversion: { kind: "selected", file: this.#state.conversion.file },
        });
      }
      return;
    }

    const error = this.#lifecycleError(reason, hiddenMilliseconds);
    const connection = this.#connection;
    const connectionMode = this.#connectionMode;
    const deviceDetails = connection?.details ?? (
      this.#state.device.kind === "disconnected" || this.#state.device.kind === "requesting-permission"
        ? undefined
        : this.#state.device.details
    );
    const cleanupRequired = pendingCleanupInstruction(this.#state.pendingObjectCleanup);
    this.#deviceEpoch += 1;
    this.#deviceAbort?.abort(error);
    this.#deviceAbort = undefined;
    this.#pendingDevice = undefined;
    this.#connection = undefined;
    this.#connectionMode = undefined;
    this.#clearCurrentCatalogInventoryAuthority();
    this.#catalogEventReconciliationQueued = false;

    this.#commit({
      ...this.#state,
      usbAccessProven: false,
      mtpReadProven: false,
      conversion: this.#state.conversion.kind === "converting"
        ? { kind: "selected", file: this.#state.conversion.file }
        : this.#state.conversion,
      device: { kind: "error", ...(deviceDetails === undefined ? {} : { details: deviceDetails }), error },
      selfTest: { kind: "not-run" },
      postConnectStage: "idle",
      catalogInventoryState: "idle",
      integratedTransfer: failInterruptedTransfer(this.#state.integratedTransfer, error, cleanupRequired),
      activeError: error,
    });
    this.#markCatalogInventoryLastSeen();
    if (connectionMode === "catalog" && this.#hardwareBusy) {
      this.#view.setCatalogTransferUpdate({ phase: "failed", message: error.message });
    }
    this.log.warn(error.message, errorContext(error));
    if (connection) {
      const cleanup = this.#closeConnectionAfterLifecycleInvalidation(connection);
      this.#lifecycleCleanup = cleanup;
      void cleanup.finally(() => {
        if (this.#lifecycleCleanup === cleanup) this.#lifecycleCleanup = undefined;
      });
    }
  }

  async #closeConnectionAfterLifecycleInvalidation(connection: ConnectedKindlePort): Promise<void> {
    await this.#waitForHardwareIdle();
    try {
      await connection.disconnect();
      this.log.info("Stale browser-local MTP session closed after lifecycle invalidation");
    } catch (cleanupError) {
      this.log.warn("Cleanup of the stale browser-local MTP session was incomplete", {
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }

  #waitForHardwareIdle(): Promise<void> {
    if (!this.#hardwareBusy) return Promise.resolve();
    return new Promise<void>((resolve) => this.#hardwareIdleWaiters.add(resolve));
  }

  #finishHardwareOperation(): void {
    this.#hardwareBusy = false;
    for (const resolve of this.#hardwareIdleWaiters) resolve();
    this.#hardwareIdleWaiters.clear();
    if (this.#catalogEventReconciliationQueued) {
      void this.#queueConnectedCatalogReconciliation();
    }
  }

  #newArtifactId(): string {
    this.#artifactSequence += 1;
    const timestamp = Math.max(0, Math.floor(this.#dependencies.now())).toString(36);
    return `artifact-${timestamp}-${this.#artifactSequence.toString(36)}`;
  }

  #newRecoveryOperationId(): string {
    this.#recoveryOperationSequence += 1;
    try {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      const nonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `mtp-${nonce}`;
    } catch {
      const timestamp = Math.max(0, Math.floor(this.#dependencies.now())).toString(36);
      return `mtp-${timestamp}-${this.#recoveryOperationSequence.toString(36)}`;
    }
  }

  #integratedUploadRunning(): boolean {
    return this.#state.integratedTransfer.kind === "sending";
  }

  #objectStateHandler(
    purpose: PendingObjectPurpose,
    artifactId: string | undefined,
    details: DeviceDetails,
  ): (event: MtpObjectCreationState) => void {
    const label = (details.model ?? details.productName)?.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 120);
    const operationId = this.#newRecoveryOperationId();
    return (event) => {
      if (event.stage === "cleanup-succeeded" || event.stage === "verified") {
        const pending = this.#state.pendingObjectCleanup;
        if (
          !pending
          || pending.operationId !== operationId
          || pending.filename !== event.filename
          || pending.storageId !== event.storageId
          || pending.parentHandle !== event.parentHandle
          || (pending.handle !== undefined && pending.handle !== event.handle)
        ) {
          return;
        }
        if (!clearPendingObjectCleanup(pending)) {
          this.log.warn("The completed-object recovery record could not be cleared", {
            purpose,
            stage: event.stage,
          });
          return;
        }
        const transferKey = purpose === "integrated" ? "integratedTransfer" : undefined;
        const transfer = transferKey ? this.#state[transferKey] : undefined;
        this.#commit({
          ...this.#state,
          pendingObjectCleanup: undefined,
          ...(event.stage === "verified" && transferKey && transfer?.kind === "sending"
            ? {
                [transferKey]: {
                  ...transfer,
                  filename: event.filename,
                },
              }
            : {}),
        });
        return;
      }

      const entry: PendingObjectCleanup = {
        version: 1,
        purpose,
        stage: event.stage,
        filename: event.filename,
        vendorId: details.vendorId,
        productId: details.productId,
        ...(label ? { deviceLabel: label } : {}),
        storageId: event.storageId,
        parentHandle: event.parentHandle,
        size: event.size,
        ...(event.stage === "handle-assigned" ? { handle: event.handle } : {}),
        ...(artifactId === undefined ? {} : { artifactId }),
        operationId,
        recordedAt: Math.max(0, Math.floor(this.#dependencies.now())),
      };
      if (!persistPendingObjectCleanup(entry)) {
        throw new AppError(
          "INVALID_STATE",
          "Durable browser recovery storage is unavailable, so no MTP object was created.",
        );
      }
      this.#commit({ ...this.#state, pendingObjectCleanup: entry });
    };
  }

  #connectionIdentityError(connection: ConnectedKindlePort): AppError | undefined {
    if (this.#unidentifiedCrossConnectionEvidence) {
      return new AppError(
        "USB_DEVICE_IDENTITY_UNAVAILABLE",
        "The prior Kindle session exposed no stable serial identity, so its retained book evidence cannot be bound to this reconnection. Record a fresh Gate 0 environment before continuing.",
      );
    }
    if (this.#provenDeviceIdentityKey && !connection.identityKey) {
      return new AppError(
        "USB_DEVICE_IDENTITY_UNAVAILABLE",
        "This reconnection exposes no stable serial identity, so it cannot be matched to the Kindle that passed the earlier gates.",
      );
    }
    if (
      this.#provenDeviceIdentityKey
      && connection.identityKey
      && this.#provenDeviceIdentityKey !== connection.identityKey
    ) {
      return new AppError(
        "USB_WRONG_DEVICE",
        "This is not the Kindle that passed the earlier gates. Update the target profile and repeat Gate 0 before switching devices.",
        { details: { vendorId: connection.device.vendorId, productId: connection.device.productId } },
      );
    }
    return undefined;
  }

  #stateAfterDisconnect(state: AppState, connection: ConnectedKindlePort): AppState {
    if (connection.identityKey || this.#connectionMode !== "poc") return state;
    const retainedCrossConnectionEvidence = hasCrossConnectionEvidence(state);
    // A completed upload is evidence from the connection that just closed, so
    // keep its already-proven prerequisites long enough for the required
    // physical Kindle attestation. They cannot authorize another connection:
    // the flag below makes a serial-less reconnect fail explicitly. A mere
    // Gate-3 disconnect has no book evidence and invalidates Gates 1–3.
    const next: AppState = retainedCrossConnectionEvidence
      ? state
      : {
          ...state,
          usbAccessProven: false,
          mtpReadProven: false,
          selfTest: state.selfTest.kind === "passed" ? { kind: "not-run" } : state.selfTest,
        };
    this.#unidentifiedCrossConnectionEvidence = retainedCrossConnectionEvidence;
    this.log.warn(retainedCrossConnectionEvidence
      ? "Stable device identity was unavailable; same-session evidence was retained for physical attestation but cannot authorize a reconnect"
      : "Stable device identity was unavailable; connection-scoped USB/MTP evidence was invalidated", {
      retainedCrossConnectionEvidence: this.#unidentifiedCrossConnectionEvidence,
    });
    return next;
  }

  #readyConnection(message: string): ConnectedKindlePort | undefined {
    if (!this.#connection || this.#connection.closed || this.#state.device.kind !== "ready") {
      this.#invalidState(message);
      return undefined;
    }
    return this.#connection;
  }

  async #retireFaultedConnection(connection: ConnectedKindlePort, error: AppError): Promise<void> {
    if (this.#connection !== connection) return;
    const epoch = this.#deviceEpoch;
    this.#connection = undefined;
    this.#clearCurrentCatalogInventoryAuthority();
    try {
      if (error.code === "USB_DEVICE_DISCONNECTED") {
        await connection.closeAfterPhysicalDisconnect();
      } else {
        await connection.disconnect();
      }
    } catch (cleanupError) {
      this.log.warn("Cleanup of the faulted connection was incomplete", {
        message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    if (epoch !== this.#deviceEpoch) return;
    this.#deviceEpoch += 1;
    this.#deviceAbort = undefined;
    this.#commit(this.#stateAfterDisconnect({
      ...this.#state,
      device: { kind: "error", details: connection.details, error },
      postConnectStage: "idle",
      catalogInventoryState: "idle",
      activeError: error,
    }, connection));
    this.#markCatalogInventoryLastSeen();
    this.#connectionMode = undefined;
  }

  #isDeviceEpoch(epoch: number, abort: AbortController): boolean {
    return epoch === this.#deviceEpoch && this.#deviceAbort === abort && !abort.signal.aborted;
  }

  #isActiveConnection(epoch: number, connection: ConnectedKindlePort): boolean {
    return epoch === this.#deviceEpoch && this.#connection === connection && !connection.closed;
  }

  #assertConnectionCurrent(
    epoch: number,
    connection: ConnectedKindlePort,
    signal: AbortSignal | undefined,
  ): void {
    signal?.throwIfAborted();
    if (this.#isActiveConnection(epoch, connection)) return;
    throw new AppError(
      "USB_SESSION_STALE",
      "The browser-local Kindle session is no longer current. Reconnect the Kindle and let the automatic byte self-test pass before sending.",
    );
  }

  #invalidState(message: string): void {
    const error = new AppError("INVALID_STATE", message);
    this.#commit({ ...this.#state, activeError: error });
    this.log.warn(message, { code: error.code });
  }

  #commit(state: AppState): void {
    this.#state = state;
    this.#view.render(state);
  }
}

// Keep the concrete class checked against the testable controller boundary.
void (ConnectedKindle satisfies new (...args: never[]) => ConnectedKindlePort);
