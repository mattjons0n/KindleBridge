import type { AppError } from "./app-error";
import type { ConversionResult } from "./api/convert";
import {
  readReplacementCleanupRecords,
  type ReplacementCleanupRecord,
} from "./replacement-cleanup-journal";

export type GateStatus = "pending" | "active" | "passed" | "failed";

export type ConversionState =
  | { readonly kind: "empty" }
  | { readonly kind: "selected"; readonly file: File }
  | { readonly kind: "converting"; readonly file: File }
  | { readonly kind: "ready"; readonly file: File; readonly result: ConversionResult; readonly artifactId: string; readonly downloaded: boolean; readonly validated: boolean }
  | { readonly kind: "error"; readonly file?: File; readonly error: AppError };

export interface DeviceDetails {
  readonly manufacturerName?: string;
  readonly productName?: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly serialNumber?: string;
  readonly configurationValue?: number;
  readonly interfaceNumber?: number;
  readonly alternateSetting?: number;
  readonly bulkInEndpoint?: number;
  readonly bulkOutEndpoint?: number;
  readonly model?: string;
  readonly operationsSupported?: readonly number[];
  readonly storageId?: number;
  readonly storageDescription?: string;
  readonly capacityBytes?: bigint;
  readonly freeBytes?: bigint;
  readonly documentsHandle?: number;
}

export type DeviceState =
  | { readonly kind: "disconnected" }
  | { readonly kind: "requesting-permission" }
  | { readonly kind: "opening"; readonly details: DeviceDetails }
  | { readonly kind: "mtp-reading"; readonly details: DeviceDetails }
  | { readonly kind: "ready"; readonly details: DeviceDetails }
  | { readonly kind: "transferring"; readonly details: DeviceDetails }
  | { readonly kind: "recovering"; readonly details: DeviceDetails }
  | { readonly kind: "error"; readonly details?: DeviceDetails; readonly error: AppError };

export type SelfTestState =
  | { readonly kind: "not-run" }
  | { readonly kind: "running" }
  | { readonly kind: "passed"; readonly byteLength: number }
  | { readonly kind: "failed"; readonly error: AppError; readonly cleanupRequired?: string };

export type CatalogInventoryState = "idle" | "loading" | "ready" | "failed";

/** The user-visible phase of the automatic work that follows an MTP connection. */
export type PostConnectStage = "idle" | "safe-write" | "inventory" | "reconciliation";

export type TransferPurpose = "integrated";

export interface TargetProfile {
  readonly macModel: string;
  readonly macosVersion: string;
  readonly chromeVersion: string;
  readonly kindleModel: string;
  readonly kindleFirmware: string;
  readonly usbCable: string;
  readonly kindleUsbMode: string;
}

export type TransferState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly purpose: TransferPurpose; readonly filename: string; readonly artifactId?: string; readonly sentBytes: number; readonly totalBytes: number }
  | { readonly kind: "verified"; readonly purpose: TransferPurpose; readonly filename: string; readonly artifactId?: string; readonly totalBytes: number; readonly physicalOpenConfirmed: boolean }
  | { readonly kind: "failed"; readonly purpose: TransferPurpose; readonly filename: string; readonly artifactId?: string; readonly error: AppError; readonly cleanupRequired?: string };

export type PendingObjectPurpose = "self-test" | "catalog" | "metadata-cache" | TransferPurpose;
export type PendingObjectStage = "send-object-info-intent" | "handle-assigned";

/**
 * Small, metadata-only recovery record. It deliberately excludes device
 * serials, source paths, conversion diagnostics, and object bytes.
 */
export interface PendingObjectCleanup {
  readonly version: 1;
  readonly purpose: PendingObjectPurpose;
  readonly stage: PendingObjectStage;
  readonly filename: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly deviceLabel?: string;
  readonly storageId: number;
  readonly parentHandle: number;
  readonly size: number;
  readonly handle?: number;
  readonly artifactId?: string;
  /** Per-write nonce used for compare-and-delete across browser tabs. */
  readonly operationId?: string;
  readonly recordedAt: number;
}

export interface AppState {
  readonly secureContext: boolean;
  readonly webUsbAvailable: boolean;
  readonly targetProfile: TargetProfile;
  readonly usbAccessProven: boolean;
  readonly mtpReadProven: boolean;
  readonly conversion: ConversionState;
  readonly device: DeviceState;
  readonly selfTest: SelfTestState;
  readonly postConnectStage: PostConnectStage;
  /** Current-connection Kindle inventory and catalog matching readiness. */
  readonly catalogInventoryState: CatalogInventoryState;
  readonly integratedTransfer: TransferState;
  readonly pendingObjectCleanup?: PendingObjectCleanup;
  /** Durable, non-authoritative reminders for verified replacement duplicates. */
  readonly pendingReplacementCleanups?: readonly ReplacementCleanupRecord[];
  readonly activeError?: AppError;
}

const PROFILE_STORAGE_KEY = "kindle-poc-target-profile";
const PENDING_OBJECT_STORAGE_KEY = "kindle-poc-pending-object-v1";
const MAX_PENDING_OBJECT_JSON_LENGTH = 2_048;
const UINT32_MAX = 0xffff_ffff;

export const EMPTY_TARGET_PROFILE: TargetProfile = Object.freeze({
  macModel: "",
  macosVersion: "",
  chromeVersion: "",
  kindleModel: "",
  kindleFirmware: "",
  usbCable: "",
  kindleUsbMode: "File transfer / browse mode",
});

function readTargetProfile(): TargetProfile {
  try {
    const raw = window.localStorage?.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return EMPTY_TARGET_PROFILE;
    const saved = JSON.parse(raw) as Partial<Record<keyof TargetProfile, unknown>>;
    return Object.fromEntries(
      Object.keys(EMPTY_TARGET_PROFILE).map((key) => [
        key,
        typeof saved[key as keyof TargetProfile] === "string"
          ? saved[key as keyof TargetProfile]
          : EMPTY_TARGET_PROFILE[key as keyof TargetProfile],
      ]),
    ) as unknown as TargetProfile;
  } catch {
    return EMPTY_TARGET_PROFILE;
  }
}

export function targetProfileComplete(profile: TargetProfile): boolean {
  return Object.values(profile).every((value) => value.trim().length > 0);
}

export function persistTargetProfile(profile: TargetProfile): void {
  try {
    window.localStorage?.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Persistence is a convenience; the in-memory gate remains authoritative.
  }
}

function isUint32(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= UINT32_MAX;
}

function isPendingObjectPurpose(value: unknown): value is PendingObjectPurpose {
  return value === "self-test"
    || value === "catalog"
    || value === "metadata-cache"
    || value === "integrated";
}

function isPendingObjectStage(value: unknown): value is PendingObjectStage {
  return value === "send-object-info-intent" || value === "handle-assigned";
}

function parsePendingObjectCleanup(value: unknown): PendingObjectCleanup | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Partial<Record<keyof PendingObjectCleanup, unknown>>;
  if (
    entry.version !== 1
    || !isPendingObjectPurpose(entry.purpose)
    || !isPendingObjectStage(entry.stage)
    || typeof entry.filename !== "string"
    || entry.filename.length < 1
    || entry.filename.length > 254
    || /[\u0000-\u001f\u007f/\\]/u.test(entry.filename)
    || !isUint32(entry.vendorId)
    || !isUint32(entry.productId)
    || (entry.deviceLabel !== undefined && (
      typeof entry.deviceLabel !== "string"
      || entry.deviceLabel.length < 1
      || entry.deviceLabel.length > 120
      || /[\u0000-\u001f\u007f]/u.test(entry.deviceLabel)
    ))
    || !isUint32(entry.storageId)
    || !isUint32(entry.parentHandle)
    || typeof entry.size !== "number"
    || !Number.isSafeInteger(entry.size)
    || entry.size < 0
    || typeof entry.recordedAt !== "number"
    || !Number.isSafeInteger(entry.recordedAt)
    || entry.recordedAt < 0
    || (entry.handle !== undefined && (!isUint32(entry.handle) || entry.handle === 0 || entry.handle === UINT32_MAX))
    || (entry.stage === "handle-assigned" && entry.handle === undefined)
    || (entry.artifactId !== undefined && (
      typeof entry.artifactId !== "string"
      || entry.artifactId.length < 1
      || entry.artifactId.length > 96
      || !/^[a-zA-Z0-9._:-]+$/u.test(entry.artifactId)
    ))
    || (entry.operationId !== undefined && (
      typeof entry.operationId !== "string"
      || entry.operationId.length < 1
      || entry.operationId.length > 96
      || !/^[a-zA-Z0-9._:-]+$/u.test(entry.operationId)
    ))
  ) {
    return undefined;
  }
  return {
    version: 1,
    purpose: entry.purpose,
    stage: entry.stage,
    filename: entry.filename,
    vendorId: entry.vendorId,
    productId: entry.productId,
    ...(entry.deviceLabel === undefined ? {} : { deviceLabel: entry.deviceLabel }),
    storageId: entry.storageId,
    parentHandle: entry.parentHandle,
    size: entry.size,
    ...(entry.handle === undefined ? {} : { handle: entry.handle }),
    ...(entry.artifactId === undefined ? {} : { artifactId: entry.artifactId }),
    ...(entry.operationId === undefined ? {} : { operationId: entry.operationId }),
    recordedAt: entry.recordedAt,
  };
}

export function samePendingObjectCleanup(
  left: PendingObjectCleanup | undefined,
  right: PendingObjectCleanup | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const validatedLeft = parsePendingObjectCleanup(left);
  const validatedRight = parsePendingObjectCleanup(right);
  return validatedLeft !== undefined
    && validatedRight !== undefined
    && JSON.stringify(validatedLeft) === JSON.stringify(validatedRight);
}

export function readPendingObjectCleanup(): PendingObjectCleanup | undefined {
  try {
    const raw = window.localStorage?.getItem(PENDING_OBJECT_STORAGE_KEY);
    if (!raw || raw.length > MAX_PENDING_OBJECT_JSON_LENGTH) return undefined;
    return parsePendingObjectCleanup(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Returns false if durable browser storage was unavailable. */
export function persistPendingObjectCleanup(entry: PendingObjectCleanup): boolean {
  const validated = parsePendingObjectCleanup(entry);
  if (!validated) return false;
  try {
    const raw = JSON.stringify(validated);
    if (raw.length > MAX_PENDING_OBJECT_JSON_LENGTH) return false;
    window.localStorage?.setItem(PENDING_OBJECT_STORAGE_KEY, raw);
    return window.localStorage?.getItem(PENDING_OBJECT_STORAGE_KEY) === raw;
  } catch {
    return false;
  }
}

/**
 * Returns false when storage could not be cleared. When `expected` is supplied,
 * a newer/different tab's journal is never removed.
 */
export function clearPendingObjectCleanup(expected?: PendingObjectCleanup): boolean {
  try {
    if (expected !== undefined) {
      const raw = window.localStorage?.getItem(PENDING_OBJECT_STORAGE_KEY);
      const current = raw ? parsePendingObjectCleanup(JSON.parse(raw)) : undefined;
      if (!samePendingObjectCleanup(current, expected)) return false;
    }
    window.localStorage?.removeItem(PENDING_OBJECT_STORAGE_KEY);
    return window.localStorage?.getItem(PENDING_OBJECT_STORAGE_KEY) === null;
  } catch {
    return false;
  }
}

export function initialAppState(): AppState {
  return {
    secureContext: window.isSecureContext,
    webUsbAvailable: typeof navigator !== "undefined" && "usb" in navigator,
    targetProfile: readTargetProfile(),
    usbAccessProven: false,
    mtpReadProven: false,
    conversion: { kind: "empty" },
    device: { kind: "disconnected" },
    selfTest: { kind: "not-run" },
    postConnectStage: "idle",
    catalogInventoryState: "idle",
    integratedTransfer: { kind: "idle" },
    pendingObjectCleanup: readPendingObjectCleanup(),
    pendingReplacementCleanups: readReplacementCleanupRecords(),
  };
}

function transferGateStatus(transfer: TransferState, prerequisiteMet: boolean): GateStatus {
  if (transfer.kind === "failed") return "failed";
  if (transfer.kind === "verified" && transfer.physicalOpenConfirmed) return "passed";
  if (transfer.kind === "sending" || transfer.kind === "verified") return "active";
  return prerequisiteMet ? "active" : "pending";
}

export function deriveGateStatuses(state: AppState): readonly GateStatus[] {
  const gate0: GateStatus = state.conversion.kind === "error"
    ? "failed"
    : state.conversion.kind === "ready" && state.conversion.validated
      ? "passed"
      : "active";
  const gate1: GateStatus = gate0 !== "passed"
    ? "pending"
    : state.usbAccessProven
      ? "passed"
      : state.device.kind === "error"
        ? "failed"
        : "active";
  const gate2: GateStatus = gate1 !== "passed"
    ? "pending"
    : state.mtpReadProven
      ? "passed"
      : state.device.kind === "error"
        ? "failed"
        : "active";
  const gate3: GateStatus = gate2 !== "passed"
    ? "pending"
    : state.selfTest.kind === "failed"
      ? "failed"
      : state.selfTest.kind === "passed"
        ? "passed"
        : "active";
  const integratedArtifactMatches = state.conversion.kind === "ready"
    && state.integratedTransfer.kind !== "idle"
    && state.integratedTransfer.artifactId === state.conversion.artifactId;
  const gate4: GateStatus = gate3 === "passed"
    ? integratedArtifactMatches
      ? state.integratedTransfer.kind === "failed"
        ? "failed"
        : state.integratedTransfer.kind === "verified"
          ? "passed"
          : "active"
      : "active"
    : "pending";
  const gate5: GateStatus = gate4 === "passed"
    ? transferGateStatus(state.integratedTransfer, true)
    : "pending";

  return [gate0, gate1, gate2, gate3, gate4, gate5];
}
