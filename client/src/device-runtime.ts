import {
  KindleDevice,
  KindleDeviceError,
  acquireKindleDeviceLease,
  createKindleModificationDateProbe,
  createKindleMetadataCache,
  derivePseudonymousKindleIdentity,
  type KindleBookTransferResult,
  type KindleDeviceLease,
  type KindleDeviceLeaseProvider,
  type KindleDeviceOptions,
  type KindleIdentitySecretProvider,
  type KindleIdentityStability,
  type KindleInventoryOptions,
  type KindleInventorySnapshot,
  type KindleMetadataCache,
  type KindleModificationDateProbe,
  type KindleSelfTestResult,
  type KindleTransferProgress,
} from "./kindle";
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

export interface OpenKindleOptions extends MtpOperationOptions {
  readonly leaseProvider?: KindleDeviceLeaseProvider;
  readonly identitySecretProvider?: KindleIdentitySecretProvider;
  readonly kindleOptions?: KindleDeviceOptions;
  /** Injectable browser-local acceleration; raw Kindle inventory never leaves the browser. */
  readonly metadataCache?: KindleMetadataCache;
  /** Injectable, page-local aggregate probe; it never persists or logs raw device values. */
  readonly modificationDateProbe?: KindleModificationDateProbe;
}

const defaultKindleMetadataCache = createKindleMetadataCache();
const defaultKindleModificationDateProbe = createKindleModificationDateProbe();

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
  ) {
    this.device = device;
    this.details = Object.freeze({ ...details });
    this.#transport = transport;
    this.#session = session;
    this.#kindle = kindle;
    this.#lease = lease;
    this.identityKey = identityKey;
    this.identityKeyStability = identityKeyStability;
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
