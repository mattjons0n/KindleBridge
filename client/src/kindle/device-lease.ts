const DEFAULT_LOCK_NAME = "kindle-bridge:webusb-device";
const realmLocks = new Set<string>();

export interface BrowserLockLike {
  readonly name: string;
}

export interface BrowserLockManagerLike {
  request<T>(
    name: string,
    options: {
      readonly mode: "exclusive";
      readonly ifAvailable: true;
    },
    callback: (lock: BrowserLockLike | null) => Promise<T> | T,
  ): Promise<T>;
}

export interface KindleDeviceLease {
  readonly scope: "browser" | "realm";
  readonly released: boolean;
  release(): Promise<void>;
}

export interface KindleDeviceLeaseOptions {
  readonly signal?: AbortSignal;
  readonly lockManager?: BrowserLockManagerLike | null;
  readonly lockName?: string;
}

export interface KindleDeviceLeaseProvider {
  acquire(options?: KindleDeviceLeaseOptions): Promise<KindleDeviceLease>;
}

export class KindleDeviceLeaseError extends Error {
  readonly code = "KINDLE_DEVICE_BUSY" as const;

  constructor() {
    super("Another Kindle Bridge tab or operation already holds the Kindle device lease.");
    this.name = "KindleDeviceLeaseError";
  }
}

export class KindleDeviceLeaseUnavailableError extends Error {
  readonly code = "KINDLE_DEVICE_LEASE_UNAVAILABLE" as const;

  constructor() {
    super("This browser cannot provide the cross-tab Web Lock required for safe Kindle writes.");
    this.name = "KindleDeviceLeaseUnavailableError";
  }
}

function defaultLockManager(): BrowserLockManagerLike | null {
  const manager = typeof navigator === "undefined" ? undefined : navigator.locks;
  return manager ? manager as unknown as BrowserLockManagerLike : null;
}

function assertLockName(value: string): string {
  if (!/^[a-z0-9:_-]{1,128}$/iu.test(value)) {
    throw new RangeError("lockName must be a bounded non-sensitive identifier");
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

async function acquireBrowserLock(
  manager: BrowserLockManagerLike,
  lockName: string,
  signal: AbortSignal | undefined,
): Promise<KindleDeviceLease> {
  throwIfAborted(signal);
  let resolveAcquisition: (lease: KindleDeviceLease | undefined) => void = () => undefined;
  let rejectAcquisition: (error: unknown) => void = () => undefined;
  let resolveHold: () => void = () => undefined;
  const acquired = new Promise<KindleDeviceLease | undefined>((resolve, reject) => {
    resolveAcquisition = resolve;
    rejectAcquisition = reject;
  });
  const hold = new Promise<void>((resolve) => {
    resolveHold = resolve;
  });
  let released = false;
  let requestCompletion: Promise<void>;
  const lease: KindleDeviceLease = {
    scope: "browser",
    get released() {
      return released;
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      resolveHold();
      await requestCompletion;
    },
  };

  const rejectOnAbort = (): void => {
    try {
      throwIfAborted(signal);
    } catch (error) {
      rejectAcquisition(error);
    }
  };
  signal?.addEventListener("abort", rejectOnAbort, { once: true });

  try {
    requestCompletion = manager.request(
      lockName,
      {
        mode: "exclusive",
        ifAvailable: true,
      },
      async (lock) => {
        // Web Locks forbids combining `signal` with `ifAvailable`. Preserve
        // cancellation by rejecting while pending and refusing any late grant.
        throwIfAborted(signal);
        if (!lock) {
          resolveAcquisition(undefined);
          return;
        }
        resolveAcquisition(lease);
        await hold;
      },
    );
  } catch (error) {
    signal?.removeEventListener("abort", rejectOnAbort);
    throw error;
  }
  void requestCompletion.catch((error) => rejectAcquisition(error));

  let result: KindleDeviceLease | undefined;
  try {
    result = await acquired;
  } finally {
    signal?.removeEventListener("abort", rejectOnAbort);
  }
  if (!result) {
    // The callback has already completed when `ifAvailable` returns null.
    await requestCompletion;
    throw new KindleDeviceLeaseError();
  }
  try {
    throwIfAborted(signal);
  } catch (error) {
    // An abort may win between the lock callback and this continuation. Do not
    // leave a browser-wide lock held by a caller that never received the lease.
    await result.release();
    throw error;
  }
  return result;
}

async function acquireRealmLock(
  lockName: string,
  signal: AbortSignal | undefined,
): Promise<KindleDeviceLease> {
  throwIfAborted(signal);
  if (realmLocks.has(lockName)) throw new KindleDeviceLeaseError();
  realmLocks.add(lockName);
  let released = false;
  return {
    scope: "realm",
    get released() {
      return released;
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      realmLocks.delete(lockName);
    },
  };
}

export async function acquireKindleDeviceLease(
  options: KindleDeviceLeaseOptions = {},
): Promise<KindleDeviceLease> {
  const lockName = assertLockName(options.lockName ?? DEFAULT_LOCK_NAME);
  throwIfAborted(options.signal);
  const manager = options.lockManager === undefined ? defaultLockManager() : options.lockManager;
  if (options.lockManager === undefined && !manager && typeof window !== "undefined") {
    // The supported browser path must be browser-wide. Silently falling back
    // to a per-tab Set would allow two tabs to write concurrently.
    throw new KindleDeviceLeaseUnavailableError();
  }
  return manager
    ? acquireBrowserLock(manager, lockName, options.signal)
    : acquireRealmLock(lockName, options.signal);
}

export const kindleDeviceLeaseProvider: KindleDeviceLeaseProvider = Object.freeze({
  acquire: acquireKindleDeviceLease,
});
