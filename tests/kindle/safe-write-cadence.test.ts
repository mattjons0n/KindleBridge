import { describe, expect, it } from "vitest";
import {
  createSafeWriteAttestation,
  decideSafeWriteCadence,
  type SafeWriteDecisionInput,
} from "../../client/src/kindle/safe-write-cadence";

const fingerprint = Object.freeze({
  pseudonymousDeviceKey: "a".repeat(64),
  storageId: 0x0001_0001,
  vendorId: 0x1949,
  productId: 0x9981,
  model: "Kindle",
  deviceVersion: "1.0",
  interfaceNumber: 0,
  alternateSetting: 0,
});

function input(overrides: Partial<SafeWriteDecisionInput> = {}): SafeWriteDecisionInput {
  const attestation = createSafeWriteAttestation({
    policyVersion: 1,
    appVersion: "0.1.0",
    fingerprint,
    provedAt: 1_000,
    maxAgeMs: 1_000,
  });
  return {
    policy: "adaptive-experimental",
    policyVersion: 1,
    appVersion: "0.1.0",
    fingerprint,
    attestation,
    now: 1_500,
    browserStorageAvailable: true,
    ...overrides,
  };
}

describe("safe-write cadence policy", () => {
  it("retains every-connection exact-byte proof as the product default", () => {
    expect(decideSafeWriteCadence(input({ policy: undefined }))).toEqual({
      runNow: true,
      reason: "policy-always",
      currentConnectionProven: false,
    });
    expect(decideSafeWriteCadence(input({
      policy: "unknown-policy" as never,
    }))).toMatchObject({ runNow: true, reason: "policy-always" });
  });

  it("rejects attestations whose expiry would exceed safe integer time", () => {
    expect(() => createSafeWriteAttestation({
      policyVersion: 1,
      appVersion: "0.1.0",
      fingerprint,
      provedAt: Number.MAX_SAFE_INTEGER,
      maxAgeMs: 1,
    })).toThrow(TypeError);
  });

  it("allows only a clean browse-only reconnect to defer proof in the experimental policy", () => {
    expect(decideSafeWriteCadence(input())).toMatchObject({
      runNow: false,
      reason: "clean-browse-only-reconnect",
      currentConnectionProven: false,
    });
    expect(decideSafeWriteCadence(input({ mutationRequested: true }))).toMatchObject({
      runNow: true,
      reason: "before-first-mutation",
    });
  });

  it.each([
    ["usbOrMtpFault", "usb-or-mtp-fault"],
    ["uncleanLifecycle", "unclean-lifecycle"],
    ["interruptedWrite", "interrupted-write"],
    ["pendingRecovery", "pending-recovery"],
    ["cleanupFailure", "cleanup-failure"],
    ["explicitDiagnostic", "explicit-diagnostic"],
  ] as const)("forces proof for %s", (field, reason) => {
    expect(decideSafeWriteCadence(input({ [field]: true }))).toMatchObject({ runNow: true, reason });
  });

  it("fails closed for missing, expired, version-changed, or changed-device evidence", () => {
    expect(decideSafeWriteCadence(input({ attestation: undefined }))).toMatchObject({ reason: "first-use" });
    expect(decideSafeWriteCadence(input({ now: 2_000 }))).toMatchObject({ reason: "expired" });
    expect(decideSafeWriteCadence(input({ appVersion: "0.2.0" }))).toMatchObject({ reason: "app-version-change" });
    expect(decideSafeWriteCadence(input({ policyVersion: 2 }))).toMatchObject({ reason: "policy-version-change" });
    expect(decideSafeWriteCadence(input({
      fingerprint: { ...fingerprint, productId: 0x9982 },
    }))).toMatchObject({ reason: "device-fingerprint-change" });
    expect(decideSafeWriteCadence(input({ browserStorageAvailable: false }))).toMatchObject({
      reason: "browser-storage-loss",
    });
  });
});
