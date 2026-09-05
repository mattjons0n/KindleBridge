import {
  MAX_SMART_SHELF_QUERY_BYTES,
  type BookQuery,
  type CatalogSort,
  type SmartShelfKindleStatus,
  type SmartShelfQuery,
} from "./catalog-contracts.js";
import { canonicalSeriesKey } from "./series.js";

const CATALOG_KEYS = [
  "q", "author", "language", "subject", "publisher", "series", "seriesKey", "year",
  "format", "rootId", "metadata", "available", "coverAvailable", "sort", "order",
] as const;
const PERSONAL_KEYS = ["favorite", "wantToRead", "readBook"] as const;
const SORTS: readonly CatalogSort[] = [
  "recent", "title", "author", "published", "size", "added", "updated", "series", "series-index",
];
const KINDLE_STATUSES: readonly SmartShelfKindleStatus[] = ["confirmed", "possible", "not-on-kindle", "unknown"];

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export class SmartShelfQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmartShelfQueryError";
  }
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SmartShelfQueryError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(object: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(object).find((key) => !allowed.includes(key));
  if (unknown) throw new SmartShelfQueryError(`${field} contains unsupported field ${unknown}.`);
}

function optionalString(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new SmartShelfQueryError(`${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\0\r\n]/u.test(normalized)) {
    throw new SmartShelfQueryError(`${field} is invalid.`);
  }
  return normalized;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new SmartShelfQueryError(`${field} must be a boolean.`);
  return value;
}

function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

export function normalizeSmartShelfQuery(value: unknown): SmartShelfQuery {
  const root = objectValue(value, "Shelf query");
  rejectUnknown(root, ["version", "catalog", "personal", "kindleStatus"], "Shelf query");
  if (root.version !== 1) throw new SmartShelfQueryError("Shelf query version is not supported.");

  const query: SmartShelfQuery = { version: 1 };
  if (root.catalog !== undefined) {
    const input = objectValue(root.catalog, "catalog");
    rejectUnknown(input, CATALOG_KEYS, "catalog");
    const catalog: NonNullable<SmartShelfQuery["catalog"]> = {};
    for (const key of ["q", "author", "language", "subject", "publisher", "series"] as const) {
      assign(catalog, key, optionalString(input[key], `catalog.${key}`, 500));
    }
    const seriesKey = optionalString(input.seriesKey, "catalog.seriesKey", 500);
    if (seriesKey !== undefined && canonicalSeriesKey(seriesKey) !== seriesKey) {
      throw new SmartShelfQueryError("catalog.seriesKey is invalid.");
    }
    assign(catalog, "seriesKey", seriesKey);
    const year = optionalString(input.year, "catalog.year", 4);
    if (year !== undefined && !/^\d{4}$/u.test(year)) throw new SmartShelfQueryError("catalog.year must contain four digits.");
    assign(catalog, "year", year);
    if (input.format !== undefined) {
      if (input.format !== "epub" && input.format !== "azw3") throw new SmartShelfQueryError("catalog.format is invalid.");
      catalog.format = input.format;
    }
    const rootId = optionalString(input.rootId, "catalog.rootId", 100);
    if (rootId !== undefined && !/^root_[A-Za-z0-9_-]{8,80}$/u.test(rootId)) {
      throw new SmartShelfQueryError("catalog.rootId is invalid.");
    }
    assign(catalog, "rootId", rootId);
    if (input.metadata !== undefined) {
      if (input.metadata !== "complete" && input.metadata !== "partial") {
        throw new SmartShelfQueryError("catalog.metadata is invalid.");
      }
      catalog.metadata = input.metadata;
    }
    assign(catalog, "available", optionalBoolean(input.available, "catalog.available"));
    assign(catalog, "coverAvailable", optionalBoolean(input.coverAvailable, "catalog.coverAvailable"));
    if (input.sort !== undefined) {
      if (!SORTS.includes(input.sort as CatalogSort)) throw new SmartShelfQueryError("catalog.sort is invalid.");
      catalog.sort = input.sort as CatalogSort;
    }
    if (input.order !== undefined) {
      if (input.order !== "asc" && input.order !== "desc") throw new SmartShelfQueryError("catalog.order is invalid.");
      catalog.order = input.order;
    }
    if (Object.keys(catalog).length > 0) query.catalog = catalog;
  }

  if (root.personal !== undefined) {
    const input = objectValue(root.personal, "personal");
    rejectUnknown(input, PERSONAL_KEYS, "personal");
    const personal: NonNullable<SmartShelfQuery["personal"]> = {};
    assign(personal, "favorite", optionalBoolean(input.favorite, "personal.favorite"));
    assign(personal, "wantToRead", optionalBoolean(input.wantToRead, "personal.wantToRead"));
    assign(personal, "readBook", optionalBoolean(input.readBook, "personal.readBook"));
    if (Object.keys(personal).length > 0) query.personal = personal;
  }
  if (root.kindleStatus !== undefined) {
    if (!KINDLE_STATUSES.includes(root.kindleStatus as SmartShelfKindleStatus)) {
      throw new SmartShelfQueryError("kindleStatus is invalid.");
    }
    query.kindleStatus = root.kindleStatus as SmartShelfKindleStatus;
  }

  if (utf8Bytes(JSON.stringify(query)) > MAX_SMART_SHELF_QUERY_BYTES) {
    throw new SmartShelfQueryError("Shelf query exceeds its storage limit.");
  }
  return query;
}

export function encodeSmartShelfQuery(value: unknown): string {
  return JSON.stringify(normalizeSmartShelfQuery(value));
}

export function decodeSmartShelfQuery(value: string): SmartShelfQuery {
  if (utf8Bytes(value) > MAX_SMART_SHELF_QUERY_BYTES) {
    throw new SmartShelfQueryError("Shelf query exceeds its storage limit.");
  }
  try {
    return normalizeSmartShelfQuery(JSON.parse(value));
  } catch (error) {
    if (error instanceof SmartShelfQueryError) throw error;
    throw new SmartShelfQueryError("Shelf query is not valid JSON.");
  }
}

/** Returns only the server-resolvable subset. A Kindle constraint remains in
 * the shelf DTO for fresh browser-local reconciliation. */
export function smartShelfQueryToBookQuery(query: SmartShelfQuery): BookQuery {
  return {
    ...query.catalog,
    ...(query.personal?.favorite === undefined ? {} : { favorite: query.personal.favorite }),
    ...(query.personal?.wantToRead === undefined ? {} : { wantToRead: query.personal.wantToRead }),
    ...(query.personal?.readBook === undefined ? {} : { readBook: query.personal.readBook }),
  };
}
