import {
  initialLibraryFilters,
  type KindleFilter,
  type LibraryFilters,
  type LibraryLayout,
  type LibrarySort,
  type MetadataFilter,
} from "./library-prototype";
import type { CatalogIssueSeverity, CatalogIssueType } from "../../shared/catalog-issues.js";

export type LibraryDensity = "comfortable" | "compact";

export interface LibraryBrowserContext {
  readonly filters: LibraryFilters;
  readonly layout: LibraryLayout;
  readonly density: LibraryDensity;
  readonly scrollY: number;
  /** Profile-scoped built-in or server shelf identity; the query is reloaded after shelves load. */
  readonly activeShelfId?: string;
  readonly sendQueueOpen?: boolean;
  readonly shelfManagerOpen?: boolean;
  readonly seriesSort?: "name" | "count";
  readonly healthFilter?: {
    readonly type: CatalogIssueType | "all";
    readonly severity: CatalogIssueSeverity | "all";
    readonly ignored: boolean;
  };
}

const STORAGE_KEY = "kindle-bridge.browser-context.v1";
const MAX_STORAGE_BYTES = 64 * 1024;
const MAX_PROFILES = 100;
const SORTS = new Set<LibrarySort>(["recent", "title", "author", "published", "size", "added", "updated", "series", "series-index"]);
const KINDLE_FILTERS = new Set<KindleFilter>(["all", "on-kindle", "not-on-kindle", "possible", "unknown"]);
const METADATA_FILTERS = new Set<MetadataFilter>(["all", "complete", "partial"]);
const HEALTH_TYPES = new Set<CatalogIssueType>([
  "missing-cover", "incomplete-metadata", "metadata-parser-failure", "low-confidence-provider-data",
  "unavailable-source", "suspected-duplicate",
]);
const HEALTH_SEVERITIES = new Set<CatalogIssueSeverity>(["info", "warning", "error"]);

function normalizedHealthFilter(value: LibraryBrowserContext["healthFilter"]): NonNullable<LibraryBrowserContext["healthFilter"]> {
  const type = value?.type;
  const severity = value?.severity;
  return {
    type: type === "all" || HEALTH_TYPES.has(type as CatalogIssueType) ? type as CatalogIssueType | "all" : "all",
    severity: severity === "all" || HEALTH_SEVERITIES.has(severity as CatalogIssueSeverity)
      ? severity as CatalogIssueSeverity | "all"
      : "all",
    ignored: value?.ignored === true,
  };
}

interface StoredEntry {
  readonly profileId: string;
  readonly filters: Omit<LibraryFilters, "profileId">;
  readonly layout: LibraryLayout;
  readonly density: LibraryDensity;
  readonly scrollY: number;
  readonly activeShelfId?: string;
  readonly sendQueueOpen?: boolean;
  readonly shelfManagerOpen?: boolean;
  readonly seriesSort?: "name" | "count";
  readonly healthFilter?: LibraryBrowserContext["healthFilter"];
}

interface StoredPayload {
  readonly version: 1;
  readonly entries: readonly StoredEntry[];
}

type BrowserStorage = Pick<Storage, "getItem" | "setItem">;

function shortString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length <= 2_048 ? value : fallback;
}

function option(value: unknown, fallback: string): string {
  const candidate = shortString(value, fallback);
  return candidate.length > 0 ? candidate : fallback;
}

function boundedShelfId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  return candidate.length > 0 && candidate.length <= 100 && !/\p{Cc}/u.test(candidate)
    ? candidate
    : undefined;
}

function safeOffset(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000
    ? value
    : 0;
}

function safeLimit(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 200 ? value : 24;
}

function parseEntry(value: unknown, profileId: string): LibraryBrowserContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Partial<StoredEntry>;
  if (entry.profileId !== profileId || !entry.filters || typeof entry.filters !== "object") return undefined;
  const candidate = entry.filters as Partial<Omit<LibraryFilters, "profileId">>;
  const defaults = initialLibraryFilters(profileId);
  const view = candidate.view === "on-kindle" || candidate.view === "recent" || candidate.view === "series"
    || candidate.view === "attention" || candidate.view === "all"
    ? candidate.view
    : "all";
  const sort = SORTS.has(candidate.sort as LibrarySort) ? candidate.sort as LibrarySort : defaults.sort;
  const kindle = KINDLE_FILTERS.has(candidate.kindle as KindleFilter) ? candidate.kindle as KindleFilter : "all";
  const metadata = METADATA_FILTERS.has(candidate.metadata as MetadataFilter) ? candidate.metadata as MetadataFilter : "all";
  const health = entry.healthFilter;
  const activeShelfId = boundedShelfId(entry.activeShelfId);
  return {
    filters: {
      ...defaults,
      profileId,
      view,
      query: shortString(candidate.query, ""),
      author: option(candidate.author, "all"),
      language: option(candidate.language, "all"),
      subject: option(candidate.subject, "all"),
      publisher: option(candidate.publisher, "all"),
      series: option(candidate.series, "all"),
      format: option(candidate.format, "all"),
      rootId: option(candidate.rootId, "all"),
      year: option(candidate.year, "all"),
      metadata,
      kindle,
      sort,
      offset: safeOffset(candidate.offset),
      limit: safeLimit(candidate.limit),
    },
    layout: entry.layout === "list" ? "list" : "grid",
    density: entry.density === "compact" ? "compact" : "comfortable",
    scrollY: safeOffset(entry.scrollY),
    ...(activeShelfId ? { activeShelfId } : {}),
    sendQueueOpen: entry.sendQueueOpen === true,
    shelfManagerOpen: entry.shelfManagerOpen === true,
    seriesSort: entry.seriesSort === "count" ? "count" : "name",
    healthFilter: normalizedHealthFilter(health),
  };
}

function readPayload(storage: BrowserStorage | undefined): StoredPayload {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw || raw.length > MAX_STORAGE_BYTES) return { version: 1, entries: [] };
    const parsed = JSON.parse(raw) as Partial<StoredPayload>;
    return parsed.version === 1 && Array.isArray(parsed.entries)
      ? { version: 1, entries: parsed.entries.slice(0, MAX_PROFILES) as StoredEntry[] }
      : { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

export function readLibraryBrowserContext(
  storage: BrowserStorage | undefined,
  profileId: string,
): LibraryBrowserContext {
  const entry = readPayload(storage).entries.find((candidate) => (
    candidate && typeof candidate === "object" && candidate.profileId === profileId
  ));
  return parseEntry(entry, profileId) ?? {
    filters: initialLibraryFilters(profileId),
    layout: "grid",
    density: "comfortable",
    scrollY: 0,
    sendQueueOpen: false,
    shelfManagerOpen: false,
    seriesSort: "name",
    healthFilter: { type: "all", severity: "all", ignored: false },
  };
}

export function writeLibraryBrowserContext(
  storage: BrowserStorage | undefined,
  context: LibraryBrowserContext,
): void {
  const profileId = context.filters.profileId;
  if (!storage || !profileId) return;
  const { profileId: _ignored, ...filters } = context.filters;
  const activeShelfId = boundedShelfId(context.activeShelfId);
  const entry: StoredEntry = {
    profileId,
    filters: { ...filters, view: filters.view === "settings" ? "all" : filters.view },
    layout: context.layout,
    density: context.density,
    scrollY: safeOffset(context.scrollY),
    ...(activeShelfId ? { activeShelfId } : {}),
    sendQueueOpen: context.sendQueueOpen === true,
    shelfManagerOpen: context.shelfManagerOpen === true,
    seriesSort: context.seriesSort === "count" ? "count" : "name",
    healthFilter: normalizedHealthFilter(context.healthFilter),
  };
  try {
    const payload = readPayload(storage);
    const entries = [entry, ...payload.entries.filter((candidate) => candidate.profileId !== profileId)].slice(0, MAX_PROFILES);
    const raw = JSON.stringify({ version: 1, entries });
    if (raw.length <= MAX_STORAGE_BYTES) storage.setItem(STORAGE_KEY, raw);
  } catch {
    // Browser context is a convenience and must never block catalog access.
  }
}

export const LIBRARY_BROWSER_CONTEXT_STORAGE_KEY = STORAGE_KEY;
