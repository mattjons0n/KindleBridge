import type { KindleInventoryObject } from "./inventory";
import {
  retireKindleReadingEvidence,
  validateKindleReadingEvidence,
  type KindleReadingEvidence,
  type KindleReadingStatus,
} from "./reading-state";

export const KINDLE_READING_PRESENTATION_GATE_VERSION = 1 as const;
export const MAX_KINDLE_READING_PROJECTION_OBJECTS = 100_000;
export const MAX_KINDLE_READING_PROJECTION_ASSOCIATIONS = 20_000;
export const MAX_KINDLE_READING_FILTER_BOOK_IDS = 20_000;

export interface KindleReadingPresentationGate {
  readonly version: typeof KINDLE_READING_PRESENTATION_GATE_VERSION;
  readonly enabled: boolean;
}

/**
 * Reading-state presentation remains internal and disabled until the physical
 * sidecar/state matrix has passed. Unknown or future gate versions fail off.
 */
export const DEFAULT_KINDLE_READING_PRESENTATION_GATE: KindleReadingPresentationGate = Object.freeze({
  version: KINDLE_READING_PRESENTATION_GATE_VERSION,
  enabled: false,
});

export function isKindleReadingPresentationEnabled(value: unknown): value is KindleReadingPresentationGate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const gate = value as Partial<KindleReadingPresentationGate>;
  return gate.version === KINDLE_READING_PRESENTATION_GATE_VERSION && gate.enabled === true;
}

export interface KindleReadingMatchedItem {
  /** Exact handle of the current live Kindle inventory item. */
  readonly objectHandle: number;
  /** Opaque catalog identifier; no path or device evidence is accepted here. */
  readonly bookId?: string;
  readonly match: "confirmed" | "possible" | "unmatched";
}

export interface KindleReadingProjection {
  readonly profileId: string;
  readonly state: "disabled" | "live" | "last-seen" | "empty" | "limit-exceeded";
  readonly evidenceByBookId: ReadonlyMap<string, KindleReadingEvidence>;
}

export interface KindleReadingProjectionOptions {
  readonly gate?: unknown;
  readonly maxObjects?: number;
  readonly maxAssociations?: number;
}

function isObjectHandle(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 0xffff_ffff;
}

function isOpaqueCatalogId(value: unknown, prefix: "book" | "prf"): value is string {
  return typeof value === "string"
    && new RegExp(`^${prefix}_[A-Za-z0-9_-]{8,80}$`, "u").test(value);
}

function requireOpaqueProfileId(value: string): void {
  if (!isOpaqueCatalogId(value, "prf")) {
    throw new TypeError("A valid opaque profile ID is required for Kindle reading evidence.");
  }
}

function boundedLimit(value: number | undefined, fallback: number, hardMaximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > hardMaximum) {
    throw new RangeError(`Reading-state limit must be an integer from 1 to ${hardMaximum}.`);
  }
  return value;
}

function emptyProjection(
  profileId: string,
  state: KindleReadingProjection["state"],
): KindleReadingProjection {
  return Object.freeze({ profileId, state, evidenceByBookId: new Map() });
}

/**
 * Projects live browser-side sidecar evidence onto catalog IDs only after the
 * matching layer supplies exactly one confirmed item for both the object and
 * the book. Possible, duplicate, stale, malformed, or missing evidence is
 * omitted and consequently presents as Unknown.
 */
export function projectKindleReadingEvidence(input: {
  readonly profileId: string;
  readonly inventoryObjects: readonly KindleInventoryObject[];
  readonly matchedItems: readonly KindleReadingMatchedItem[];
  readonly options?: KindleReadingProjectionOptions;
}): KindleReadingProjection {
  requireOpaqueProfileId(input.profileId);
  if (!isKindleReadingPresentationEnabled(input.options?.gate)) {
    return emptyProjection(input.profileId, "disabled");
  }

  const maxObjects = boundedLimit(
    input.options?.maxObjects,
    MAX_KINDLE_READING_PROJECTION_OBJECTS,
    MAX_KINDLE_READING_PROJECTION_OBJECTS,
  );
  const maxAssociations = boundedLimit(
    input.options?.maxAssociations,
    MAX_KINDLE_READING_PROJECTION_ASSOCIATIONS,
    MAX_KINDLE_READING_PROJECTION_ASSOCIATIONS,
  );
  if (input.inventoryObjects.length > maxObjects || input.matchedItems.length > maxAssociations) {
    return emptyProjection(input.profileId, "limit-exceeded");
  }

  const objectByHandle = new Map<number, KindleInventoryObject | null>();
  for (const object of input.inventoryObjects) {
    if (!isObjectHandle(object.handle)) continue;
    objectByHandle.set(object.handle, objectByHandle.has(object.handle) ? null : object);
  }

  const claimCountByHandle = new Map<number, number>();
  const claimCountByBookId = new Map<string, number>();
  for (const item of input.matchedItems) {
    if (!isObjectHandle(item.objectHandle) || !isOpaqueCatalogId(item.bookId, "book")) continue;
    claimCountByHandle.set(item.objectHandle, (claimCountByHandle.get(item.objectHandle) ?? 0) + 1);
    claimCountByBookId.set(item.bookId, (claimCountByBookId.get(item.bookId) ?? 0) + 1);
  }

  const evidenceByBookId = new Map<string, KindleReadingEvidence>();
  for (const item of input.matchedItems) {
    if (item.match !== "confirmed"
      || !isObjectHandle(item.objectHandle)
      || !isOpaqueCatalogId(item.bookId, "book")
      || claimCountByHandle.get(item.objectHandle) !== 1
      || claimCountByBookId.get(item.bookId) !== 1) {
      continue;
    }
    const object = objectByHandle.get(item.objectHandle);
    if (!object || object.kind !== "file") continue;
    const evidence = validateKindleReadingEvidence(object.readingEvidence);
    if (!evidence || evidence.freshness !== "live") continue;
    evidenceByBookId.set(item.bookId, evidence);
  }

  return Object.freeze({
    profileId: input.profileId,
    state: "live" as const,
    evidenceByBookId,
  });
}

/** Retains bounded display evidence as Last seen but confers no live authority. */
export function retireKindleReadingProjection(
  projection: KindleReadingProjection,
): KindleReadingProjection {
  if (projection.state === "disabled" || projection.state === "limit-exceeded") return projection;
  return Object.freeze({
    profileId: projection.profileId,
    state: projection.evidenceByBookId.size === 0 ? "empty" as const : "last-seen" as const,
    evidenceByBookId: retireKindleReadingEvidence(projection.evidenceByBookId),
  });
}

/** Profile changes always clear prior-profile evidence instead of carrying it across. */
export function clearKindleReadingProjectionForProfile(
  projection: KindleReadingProjection,
  nextProfileId: string,
): KindleReadingProjection {
  requireOpaqueProfileId(nextProfileId);
  return emptyProjection(
    nextProfileId,
    projection.state === "disabled" ? "disabled" : "empty",
  );
}

export interface KindleReadingFilterOptions {
  readonly maxBookIds?: number;
}

/**
 * Selects across the caller's complete profile ID set, independent of the
 * currently rendered page. The return value contains opaque IDs only and is
 * safe to pass as a scoped include-ID query; evidence never crosses the API.
 */
export function selectOpaqueBookIdsByReadingStatus(input: {
  readonly profileId: string;
  readonly allProfileBookIds: readonly string[];
  readonly projection: KindleReadingProjection;
  readonly filter: "any" | KindleReadingStatus;
  readonly options?: KindleReadingFilterOptions;
}): readonly string[] {
  requireOpaqueProfileId(input.profileId);
  if (input.projection.profileId !== input.profileId) {
    throw new TypeError("Kindle reading evidence belongs to a different profile.");
  }
  if (input.projection.state === "disabled" || input.projection.state === "limit-exceeded") {
    throw new Error("Kindle reading-state filtering is unavailable.");
  }
  const maxBookIds = boundedLimit(
    input.options?.maxBookIds,
    MAX_KINDLE_READING_FILTER_BOOK_IDS,
    MAX_KINDLE_READING_FILTER_BOOK_IDS,
  );
  if (input.allProfileBookIds.length > maxBookIds) {
    throw new RangeError("The reading-state filter exceeds its bounded catalog ID set.");
  }
  if (input.filter !== "any"
    && input.filter !== "unread"
    && input.filter !== "in-progress"
    && input.filter !== "read"
    && input.filter !== "unknown") {
    throw new TypeError("Unknown Kindle reading-state filter.");
  }

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const bookId of input.allProfileBookIds) {
    if (!isOpaqueCatalogId(bookId, "book")) {
      throw new TypeError("Reading-state filters accept opaque catalog book IDs only.");
    }
    if (seen.has(bookId)) continue;
    seen.add(bookId);
    const status = input.projection.evidenceByBookId.get(bookId)?.status ?? "unknown";
    if (input.filter === "any" || status === input.filter) selected.push(bookId);
  }
  return Object.freeze(selected);
}
