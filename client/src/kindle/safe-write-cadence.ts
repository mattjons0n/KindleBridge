export const SAFE_WRITE_ATTESTATION_VERSION = 1;
export const DEFAULT_SAFE_WRITE_POLICY: SafeWriteCadencePolicy = "always";
export const DEFAULT_SAFE_WRITE_ATTESTATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export type SafeWriteCadencePolicy = "always" | "adaptive-experimental";

export type SafeWriteDecisionReason =
  | "policy-always"
  | "first-use"
  | "browser-storage-loss"
  | "app-version-change"
  | "policy-version-change"
  | "device-fingerprint-change"
  | "expired"
  | "usb-or-mtp-fault"
  | "unclean-lifecycle"
  | "interrupted-write"
  | "pending-recovery"
  | "cleanup-failure"
  | "explicit-diagnostic"
  | "before-first-mutation"
  | "clean-browse-only-reconnect";

export interface SafeWriteDeviceFingerprint {
  readonly pseudonymousDeviceKey: string;
  readonly storageId: number;
  readonly vendorId: number;
  readonly productId: number;
  readonly model: string;
  readonly deviceVersion: string;
  readonly interfaceNumber: number;
  readonly alternateSetting: number;
}

export interface SafeWriteAttestation {
  readonly version: 1;
  readonly policyVersion: number;
  readonly appVersion: string;
  readonly fingerprint: SafeWriteDeviceFingerprint;
  readonly provedAt: number;
  readonly expiresAt: number;
}

export interface SafeWriteDecisionInput {
  readonly policy?: SafeWriteCadencePolicy;
  readonly policyVersion: number;
  readonly appVersion: string;
  readonly fingerprint: SafeWriteDeviceFingerprint;
  readonly attestation?: SafeWriteAttestation;
  readonly now: number;
  readonly browserStorageAvailable: boolean;
  readonly usbOrMtpFault?: boolean;
  readonly uncleanLifecycle?: boolean;
  readonly interruptedWrite?: boolean;
  readonly pendingRecovery?: boolean;
  readonly cleanupFailure?: boolean;
  readonly explicitDiagnostic?: boolean;
  /** True when a Send, Remove, Update, or Kindle-cache mutation is requested. */
  readonly mutationRequested?: boolean;
}

export interface SafeWriteCadenceDecision {
  readonly runNow: boolean;
  readonly reason: SafeWriteDecisionReason;
  /** Never true until the current connection has run the exact-byte proof. */
  readonly currentConnectionProven: false;
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/\p{Cc}/u.test(value);
}

export function validSafeWriteDeviceFingerprint(value: unknown): value is SafeWriteDeviceFingerprint {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SafeWriteDeviceFingerprint>;
  return typeof item.pseudonymousDeviceKey === "string"
    && /^[a-f0-9]{64}$/u.test(item.pseudonymousDeviceKey)
    && Number.isInteger(item.storageId) && (item.storageId ?? 0) > 0 && (item.storageId ?? 0) <= 0xffff_ffff
    && Number.isInteger(item.vendorId) && (item.vendorId ?? -1) >= 0 && (item.vendorId ?? 0x1_0000) <= 0xffff
    && Number.isInteger(item.productId) && (item.productId ?? -1) >= 0 && (item.productId ?? 0x1_0000) <= 0xffff
    && validText(item.model, 256)
    && validText(item.deviceVersion, 256)
    && Number.isInteger(item.interfaceNumber) && (item.interfaceNumber ?? -1) >= 0 && (item.interfaceNumber ?? 256) <= 255
    && Number.isInteger(item.alternateSetting) && (item.alternateSetting ?? -1) >= 0 && (item.alternateSetting ?? 256) <= 255;
}

function sameFingerprint(left: SafeWriteDeviceFingerprint, right: SafeWriteDeviceFingerprint): boolean {
  return left.pseudonymousDeviceKey === right.pseudonymousDeviceKey
    && left.storageId === right.storageId
    && left.vendorId === right.vendorId
    && left.productId === right.productId
    && left.model === right.model
    && left.deviceVersion === right.deviceVersion
    && left.interfaceNumber === right.interfaceNumber
    && left.alternateSetting === right.alternateSetting;
}

export function createSafeWriteAttestation(input: {
  readonly policyVersion: number;
  readonly appVersion: string;
  readonly fingerprint: SafeWriteDeviceFingerprint;
  readonly provedAt: number;
  readonly maxAgeMs?: number;
}): SafeWriteAttestation {
  const maxAgeMs = input.maxAgeMs ?? DEFAULT_SAFE_WRITE_ATTESTATION_MAX_AGE_MS;
  const expiresAt = input.provedAt + maxAgeMs;
  if (!Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1
      || !validText(input.appVersion, 128)
      || !validSafeWriteDeviceFingerprint(input.fingerprint)
      || !Number.isSafeInteger(input.provedAt) || input.provedAt < 0
      || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 30 * 24 * 60 * 60 * 1_000
      || !Number.isSafeInteger(expiresAt)) {
    throw new TypeError("Safe-write attestation input is invalid");
  }
  return Object.freeze({
    version: SAFE_WRITE_ATTESTATION_VERSION,
    policyVersion: input.policyVersion,
    appVersion: input.appVersion,
    fingerprint: Object.freeze({ ...input.fingerprint }),
    provedAt: input.provedAt,
    expiresAt,
  });
}

export function decideSafeWriteCadence(input: SafeWriteDecisionInput): SafeWriteCadenceDecision {
  const result = (runNow: boolean, reason: SafeWriteDecisionReason): SafeWriteCadenceDecision => Object.freeze({
    runNow,
    reason,
    currentConnectionProven: false,
  });
  // Unknown values fail back to the shipped eager policy; a corrupted or
  // future setting can never accidentally activate the experimental path.
  if ((input.policy ?? DEFAULT_SAFE_WRITE_POLICY) !== "adaptive-experimental") {
    return result(true, "policy-always");
  }
  if (input.explicitDiagnostic) return result(true, "explicit-diagnostic");
  if (input.pendingRecovery) return result(true, "pending-recovery");
  if (input.cleanupFailure) return result(true, "cleanup-failure");
  if (input.interruptedWrite) return result(true, "interrupted-write");
  if (input.usbOrMtpFault) return result(true, "usb-or-mtp-fault");
  if (input.uncleanLifecycle) return result(true, "unclean-lifecycle");
  if (!input.browserStorageAvailable) return result(true, "browser-storage-loss");
  const attestation = input.attestation;
  if (!attestation || attestation.version !== SAFE_WRITE_ATTESTATION_VERSION) return result(true, "first-use");
  if (attestation.policyVersion !== input.policyVersion) return result(true, "policy-version-change");
  if (attestation.appVersion !== input.appVersion) return result(true, "app-version-change");
  if (!validSafeWriteDeviceFingerprint(input.fingerprint)
      || !validSafeWriteDeviceFingerprint(attestation.fingerprint)
      || !sameFingerprint(attestation.fingerprint, input.fingerprint)) {
    return result(true, "device-fingerprint-change");
  }
  if (!Number.isSafeInteger(input.now) || input.now < attestation.provedAt || input.now >= attestation.expiresAt) {
    return result(true, "expired");
  }
  if (input.mutationRequested) return result(true, "before-first-mutation");
  return result(false, "clean-browse-only-reconnect");
}
