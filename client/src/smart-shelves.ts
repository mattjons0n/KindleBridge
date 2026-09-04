import type { SmartShelf, SmartShelfQuery } from "../../shared/catalog-contracts.js";
import { normalizeSmartShelfQuery } from "../../shared/shelf-query.js";
import { initialLibraryFilters, type LibraryFilters } from "./library-prototype";

export interface BuiltInSmartShelf {
  readonly id:
    | "builtin-recent"
    | "builtin-not-on-kindle"
    | "builtin-favorites"
    | "builtin-want-to-read"
    | "builtin-missing-cover";
  readonly name: string;
  readonly query: SmartShelfQuery;
}

export const BUILT_IN_SMART_SHELVES: readonly BuiltInSmartShelf[] = Object.freeze([
  Object.freeze({ id: "builtin-recent", name: "Recently added", query: Object.freeze({ version: 1, catalog: Object.freeze({ sort: "recent", order: "desc" }) }) }),
  Object.freeze({ id: "builtin-not-on-kindle", name: "Not on Kindle", query: Object.freeze({ version: 1, kindleStatus: "not-on-kindle" }) }),
  Object.freeze({ id: "builtin-favorites", name: "Favorites", query: Object.freeze({ version: 1, personal: Object.freeze({ favorite: true }) }) }),
  Object.freeze({ id: "builtin-want-to-read", name: "Want to read", query: Object.freeze({ version: 1, personal: Object.freeze({ wantToRead: true }) }) }),
  Object.freeze({ id: "builtin-missing-cover", name: "Missing cover", query: Object.freeze({ version: 1, catalog: Object.freeze({ coverAvailable: false }) }) }),
]);

function nonDefault(value: string): string | undefined {
  return value === "all" || value.trim().length === 0 ? undefined : value;
}

export function libraryFiltersToSmartShelfQuery(filters: LibraryFilters): SmartShelfQuery {
  const sort = filters.view === "recent" ? "recent" : filters.sort;
  const catalog = {
    ...(filters.query.trim() ? { q: filters.query.trim() } : {}),
    ...(nonDefault(filters.author) ? { author: filters.author } : {}),
    ...(nonDefault(filters.language) ? { language: filters.language } : {}),
    ...(nonDefault(filters.subject) ? { subject: filters.subject } : {}),
    ...(nonDefault(filters.publisher) ? { publisher: filters.publisher } : {}),
    ...(nonDefault(filters.series) ? { series: filters.series } : {}),
    ...(nonDefault(filters.year) ? { year: filters.year } : {}),
    ...(nonDefault(filters.format) ? { format: filters.format.toLocaleLowerCase("en-US") } : {}),
    ...(nonDefault(filters.rootId) ? { rootId: filters.rootId } : {}),
    ...(filters.metadata === "all" ? {} : { metadata: filters.metadata }),
    sort,
    order: sort === "title" || sort === "author" || sort === "series" || sort === "series-index"
      ? "asc" as const
      : "desc" as const,
  };
  return normalizeSmartShelfQuery({
    version: 1,
    catalog,
    ...(filters.view !== "on-kindle" && filters.kindle === "all" ? {} : {
      kindleStatus: filters.view === "on-kindle" || filters.kindle === "on-kindle" ? "confirmed" : filters.kindle,
    }),
  });
}

export function smartShelfQueryToLibraryFilters(
  profileId: string,
  queryInput: SmartShelfQuery,
): LibraryFilters {
  const query = normalizeSmartShelfQuery(queryInput);
  const defaults = initialLibraryFilters(profileId);
  const catalog = query.catalog ?? {};
  return {
    ...defaults,
    query: catalog.q ?? "",
    author: catalog.author ?? "all",
    language: catalog.language ?? "all",
    subject: catalog.subject ?? "all",
    publisher: catalog.publisher ?? "all",
    series: catalog.series ?? "all",
    format: catalog.format ?? "all",
    rootId: catalog.rootId ?? "all",
    year: catalog.year ?? "all",
    metadata: catalog.metadata ?? "all",
    kindle: query.kindleStatus === "confirmed"
      ? "on-kindle"
      : query.kindleStatus === "not-on-kindle" || query.kindleStatus === "possible" || query.kindleStatus === "unknown"
        ? query.kindleStatus
        : "all",
    sort: catalog.sort === "title" || catalog.sort === "author" || catalog.sort === "published" || catalog.sort === "size"
      || catalog.sort === "added" || catalog.sort === "updated" || catalog.sort === "series" || catalog.sort === "series-index"
      ? catalog.sort
      : "recent",
    offset: 0,
  };
}

export function orderedPinnedSmartShelves(shelves: readonly SmartShelf[]): readonly SmartShelf[] {
  return Object.freeze(shelves.filter((shelf) => shelf.pinnedRank !== null)
    .sort((left, right) => (left.pinnedRank ?? Number.MAX_SAFE_INTEGER) - (right.pinnedRank ?? Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
      || left.id.localeCompare(right.id)));
}
