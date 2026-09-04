import {
  initialLibraryFilters,
  type LibraryFilters,
  type LibraryLayout,
  type LibrarySort,
  type LibraryView,
} from "./library-prototype";
import type { LibraryDensity } from "./library-browser-context";

export const LIBRARY_ROUTE_VERSION = 1;

export interface LibraryRouteOverlays {
  readonly bookId?: string;
  readonly matchItemId?: string;
  readonly matchBookId?: string;
  readonly seriesKey?: string;
  readonly sendQueueOpen: boolean;
  readonly shelfManagerOpen: boolean;
  readonly activityOpen: boolean;
}

export interface LibraryRouteState {
  readonly version: 1;
  readonly profileId?: string;
  /** Profile-scoped shelf identity; the query is reloaded from the shelf catalog. */
  readonly activeShelfId?: string;
  readonly filters: LibraryFilters;
  readonly layout: LibraryLayout;
  readonly density: LibraryDensity;
  readonly overlays: LibraryRouteOverlays;
}

const VIEWS = new Set<LibraryView>(["all", "on-kindle", "recent", "series", "attention", "settings"]);
const SORTS = new Set<LibrarySort>(["recent", "title", "author", "published", "size", "added", "updated", "series", "series-index"]);
const SHORT_MAX = 2_048;

function bounded(value: string | null, maximum = SHORT_MAX): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= maximum && !/\p{Cc}/u.test(trimmed) ? trimmed : undefined;
}

function choice<T extends string>(value: string | null, allowed: ReadonlySet<T>, fallback: T): T {
  return value !== null && allowed.has(value as T) ? value as T : fallback;
}

function facet(params: URLSearchParams, key: string): string {
  return bounded(params.get(key)) ?? "all";
}

export function decodeLibraryRoute(hash: string): LibraryRouteState | undefined {
  const [path, raw = ""] = hash.replace(/^#/u, "").split("?", 2);
  if (path !== "library") return undefined;
  const params = new URLSearchParams(raw);
  const profileId = bounded(params.get("p"), 100);
  const defaults = initialLibraryFilters(profileId);
  const version = params.get("v");
  if (version === null && raw === "") return undefined;
  // Read the prior overlay-only links during migration; every newly written
  // link is explicitly versioned and carries its profile and view context.
  if (version !== null && version !== String(LIBRARY_ROUTE_VERSION)) return undefined;
  const view = choice(params.get("view"), VIEWS, defaults.view);
  const activeShelfId = profileId && view !== "settings"
    ? bounded(params.get("shelf"), 100)
    : undefined;
  const sort = choice(params.get("sort"), SORTS, defaults.sort);
  const limitValue = Number(params.get("limit"));
  const offsetValue = Number(params.get("offset"));
  const overlaysAllowed = view !== "settings";
  const bookId = overlaysAllowed ? bounded(params.get("book"), 100) : undefined;
  const matchItemId = overlaysAllowed && !bookId ? bounded(params.get("match"), 100) : undefined;
  const matchBookId = matchItemId ? bounded(params.get("match-book"), 100) : undefined;
  const seriesKey = overlaysAllowed && !bookId && !matchItemId ? bounded(params.get("series"), 512) : undefined;
  const sendQueueOpen = overlaysAllowed && !bookId && !matchItemId && !seriesKey && params.get("queue") === "1";
  const shelfManagerOpen = overlaysAllowed && !bookId && !matchItemId && !seriesKey && !sendQueueOpen && params.get("shelves") === "1";
  const activityOpen = overlaysAllowed && !bookId && !matchItemId && !seriesKey && !sendQueueOpen && !shelfManagerOpen && params.get("activity") === "1";
  return Object.freeze({
    version: 1,
    ...(profileId ? { profileId } : {}),
    ...(activeShelfId ? { activeShelfId } : {}),
    filters: Object.freeze({
      ...defaults,
      profileId,
      view,
      query: bounded(params.get("q")) ?? "",
      author: facet(params, "author"),
      language: facet(params, "language"),
      subject: facet(params, "subject"),
      publisher: facet(params, "publisher"),
      series: facet(params, "series-filter"),
      format: facet(params, "format"),
      rootId: facet(params, "root"),
      year: facet(params, "year"),
      metadata: params.get("metadata") === "complete" || params.get("metadata") === "partial"
        ? params.get("metadata") as "complete" | "partial"
        : "all",
      kindle: params.get("kindle") === "on-kindle" || params.get("kindle") === "not-on-kindle" || params.get("kindle") === "possible" || params.get("kindle") === "unknown"
        ? params.get("kindle") as "on-kindle" | "not-on-kindle" | "possible" | "unknown"
        : "all",
      sort,
      limit: Number.isSafeInteger(limitValue) && limitValue >= 1 && limitValue <= 200 ? limitValue : defaults.limit,
      offset: Number.isSafeInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0,
    }),
    layout: params.get("layout") === "list" ? "list" : "grid",
    density: params.get("density") === "compact" ? "compact" : "comfortable",
    overlays: Object.freeze({
      ...(bookId ? { bookId } : {}),
      ...(matchItemId ? { matchItemId } : {}),
      ...(matchBookId ? { matchBookId } : {}),
      ...(seriesKey ? { seriesKey } : {}),
      sendQueueOpen,
      shelfManagerOpen,
      activityOpen,
    }),
  });
}

function setNonDefault(params: URLSearchParams, key: string, value: string, fallback: string): void {
  if (value !== fallback) params.set(key, value);
}

export function encodeLibraryRoute(state: LibraryRouteState): string {
  const params = new URLSearchParams({ v: String(LIBRARY_ROUTE_VERSION) });
  if (state.profileId) params.set("p", state.profileId);
  params.set("view", state.filters.view);
  params.set("sort", state.filters.sort);
  params.set("layout", state.layout);
  if (state.density === "compact") params.set("density", "compact");
  const activeShelfId = state.profileId && state.filters.view !== "settings"
    ? bounded(state.activeShelfId ?? null, 100)
    : undefined;
  if (activeShelfId) params.set("shelf", activeShelfId);
  setNonDefault(params, "q", state.filters.query.trim(), "");
  setNonDefault(params, "author", state.filters.author, "all");
  setNonDefault(params, "language", state.filters.language, "all");
  setNonDefault(params, "subject", state.filters.subject, "all");
  setNonDefault(params, "publisher", state.filters.publisher, "all");
  setNonDefault(params, "series-filter", state.filters.series, "all");
  setNonDefault(params, "format", state.filters.format, "all");
  setNonDefault(params, "root", state.filters.rootId, "all");
  setNonDefault(params, "year", state.filters.year, "all");
  setNonDefault(params, "metadata", state.filters.metadata, "all");
  setNonDefault(params, "kindle", state.filters.kindle, "all");
  if (state.filters.offset > 0) params.set("offset", String(state.filters.offset));
  if (state.filters.limit !== 24) params.set("limit", String(state.filters.limit));
  if (state.filters.view !== "settings") {
    if (state.overlays.bookId) params.set("book", state.overlays.bookId);
    else if (state.overlays.matchItemId) {
      params.set("match", state.overlays.matchItemId);
      if (state.overlays.matchBookId) params.set("match-book", state.overlays.matchBookId);
    }
    else if (state.overlays.seriesKey) params.set("series", state.overlays.seriesKey);
    else if (state.overlays.sendQueueOpen) params.set("queue", "1");
    else if (state.overlays.shelfManagerOpen) params.set("shelves", "1");
    else if (state.overlays.activityOpen) params.set("activity", "1");
  }
  return `#library?${params.toString()}`;
}
