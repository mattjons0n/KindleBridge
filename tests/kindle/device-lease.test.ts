import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KindleDeviceLeaseError,
  KindleDeviceLeaseUnavailableError,
  acquireKindleDeviceLease,
  type BrowserLockManagerLike,
} from "../../client/src/kindle/device-lease";

afterEach(() => vi.unstubAllGlobals());

class FakeBrowserLocks implements BrowserLockManagerLike {
  readonly held = new Set<string>();
  readonly requests: Array<{
    readonly name: string;
    readonly options: Readonly<Record<string, unknown>>;
  }> = [];

  async request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: { name: string } | null) => Promise<T> | T,
  ): Promise<T> {
    const rawOptions = options as unknown as Readonly<Record<string, unknown>>;
    if (rawOptions.ifAvailable === true && Object.hasOwn(rawOptions, "signal")) {
      throw new DOMException(
        "The 'signal' and 'ifAvailable' options cannot be used together",
        "NotSupportedError",
      );
    }
    this.requests.push({ name, options: { ...rawOptions } });
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

class DeferredBrowserLocks implements BrowserLockManagerLike {
  held = false;
  requested = false;
  #grant: (() => Promise<void>) | undefined;

  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: { name: string } | null) => Promise<T> | T,
  ): Promise<T> {
    this.requested = true;
    const rawOptions = options as unknown as Readonly<Record<string, unknown>>;
    if (rawOptions.ifAvailable === true && Object.hasOwn(rawOptions, "signal")) {
      return Promise.reject(new DOMException(
        "The 'signal' and 'ifAvailable' options cannot be used together",
        "NotSupportedError",
      ));
    }
    return new Promise<T>((resolve, reject) => {
      this.#grant = async () => {
        this.held = true;
        try {
          resolve(await callback({ name }));
        } catch (error) {
          reject(error);
        } finally {
          this.held = false;
        }
      };
    });
  }

  async grant(): Promise<void> {
    if (!this.#grant) throw new Error("No pending lock request");
    await this.#grant();
  }
}

describe("Kindle device lease", () => {
  it("holds a browser-wide Web Lock until explicit release", async () => {
    const lockManager = new FakeBrowserLocks();
    const first = await acquireKindleDeviceLease({ lockManager });

    expect(first.scope).toBe("browser");
    expect(lockManager.held.size).toBe(1);
    await expect(acquireKindleDeviceLease({ lockManager }))
      .rejects.toBeInstanceOf(KindleDeviceLeaseError);

    await first.release();
    expect(first.released).toBe(true);
    expect(lockManager.held.size).toBe(0);

    const next = await acquireKindleDeviceLease({ lockManager });
    await next.release();
  });

  it("uses Chromium-compatible immediate lock options when a signal is present", async () => {
    const lockManager = new FakeBrowserLocks();
    const controller = new AbortController();
    const lease = await acquireKindleDeviceLease({
      lockManager,
      signal: controller.signal,
    });

    expect(lockManager.requests).toEqual([{
      name: "kindle-bridge:webusb-device",
      options: { mode: "exclusive", ifAvailable: true },
    }]);
    expect(Object.hasOwn(lockManager.requests[0]!.options, "signal")).toBe(false);

    controller.abort(new DOMException("cancelled after acquisition", "AbortError"));
    expect(lease.released).toBe(false);
    expect(lockManager.held.size).toBe(1);
    await lease.release();
  });

  it("rejects a pending browser lock on abort and releases any late grant", async () => {
    const lockManager = new DeferredBrowserLocks();
    const controller = new AbortController();
    const acquisition = acquireKindleDeviceLease({
      lockManager,
      signal: controller.signal,
    });
    expect(lockManager.requested).toBe(true);

    controller.abort(new DOMException("cancelled while pending", "AbortError"));
    await expect(acquisition).rejects.toMatchObject({ name: "AbortError" });
    await lockManager.grant();
    expect(lockManager.held).toBe(false);
  });

  it("falls back to a same-realm exclusive lease when Web Locks are unavailable", async () => {
    const lockName = "kindle-bridge:test-realm-device";
    const first = await acquireKindleDeviceLease({ lockManager: null, lockName });
    await expect(acquireKindleDeviceLease({ lockManager: null, lockName }))
      .rejects.toMatchObject({ code: "KINDLE_DEVICE_BUSY" });
    await first.release();

    const next = await acquireKindleDeviceLease({ lockManager: null, lockName });
    await next.release();
  });

  it("honors cancellation before acquiring either lease implementation", async () => {
    const controller = new AbortController();
    const lockManager = new FakeBrowserLocks();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(acquireKindleDeviceLease({
      lockManager,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(lockManager.requests).toHaveLength(0);

    await expect(acquireKindleDeviceLease({
      lockManager: null,
      lockName: "kindle-bridge:test-abort-device",
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails closed in a browser when cross-tab Web Locks are unavailable", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});

    await expect(acquireKindleDeviceLease()).rejects.toBeInstanceOf(
      KindleDeviceLeaseUnavailableError,
    );
  });
});
