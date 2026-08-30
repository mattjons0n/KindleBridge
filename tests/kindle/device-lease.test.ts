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

  async request<T>(
    name: string,
    _options: { mode: "exclusive"; ifAvailable: true; signal?: AbortSignal },
    callback: (lock: { name: string } | null) => Promise<T> | T,
  ): Promise<T> {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
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
    controller.abort(new DOMException("cancelled", "AbortError"));

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
