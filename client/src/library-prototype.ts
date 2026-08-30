import type {
  CatalogBook,
  CatalogBookPage,
  CatalogBookQuery,
  CatalogBookSort,
  CatalogFilters,
  CatalogKindleStatus,
  CatalogKindleStatusCounts,
  CatalogProfile,
} from "./catalog-client";

export type LibraryProfileId = string;
export type LibraryView = "all" | "on-kindle" | "recent" | "settings";
export type LibrarySort = CatalogBookSort;
export type KindleFilter = "all" | "on-kindle" | "not-on-kindle" | "possible";
export type MetadataFilter = "all" | "complete" | "partial";
export type PrototypeBook = CatalogBook;
export type LibraryProfile = CatalogProfile;

export interface LibraryFilters {
  readonly profileId?: LibraryProfileId;
  readonly view: LibraryView;
  readonly query: string;
  readonly author: string;
  readonly language: string;
  readonly subject: string;
  readonly publisher: string;
  readonly series: string;
  readonly format: string;
  readonly rootId: string;
  readonly year: string;
  readonly metadata: MetadataFilter;
  readonly kindle: KindleFilter;
  readonly sort: LibrarySort;
  readonly offset: number;
  readonly limit: number;
}

export interface LibraryCounts {
  readonly total: number;
  readonly onKindle: number;
  readonly possible: number;
  readonly readyToSend: number;
}

export const EMPTY_CATALOG_FILTERS: CatalogFilters = Object.freeze({
  authors: [],
  languages: [],
  subjects: [],
  publishers: [],
  series: [],
  formats: [],
  roots: [],
  years: [],
  metadata: [],
});

export function initialLibraryFilters(profileId?: LibraryProfileId): LibraryFilters {
  return {
    profileId,
    view: "all",
    query: "",
    author: "all",
    language: "all",
    subject: "all",
    publisher: "all",
    series: "all",
    format: "all",
    rootId: "all",
    year: "all",
    metadata: "all",
    kindle: "all",
    sort: "recent",
    offset: 0,
    limit: 24,
  };
}

export function bookAuthor(book: Pick<CatalogBook, "authors">): string {
  return book.authors.join(", ") || "Unknown author";
}

export function bookPublishedYear(book: Pick<CatalogBook, "publishedAt">): string {
  if (!book.publishedAt) return "Unknown year";
  const match = /^(-?\d{1,4})/u.exec(book.publishedAt);
  if (!match) return "Unknown year";
  const year = Number(match[1]);
  return year < 0 ? `${Math.abs(year)} BCE` : String(year);
}

export function formatCatalogBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  if (bytes < 1_000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1_000;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1_000; index += 1) {
    value /= 1_000;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

export function effectiveKindleStatus(
  book: CatalogBook,
  overrides: ReadonlyMap<string, CatalogKindleStatus>,
): CatalogKindleStatus {
  return overrides.get(book.id) ?? book.kindleStatus ?? "unknown";
}

export function booksForKindleView(
  books: readonly CatalogBook[],
  filters: Pick<LibraryFilters, "view" | "kindle">,
  overrides: ReadonlyMap<string, CatalogKindleStatus>,
): readonly CatalogBook[] {
  return books.filter((book) => {
    const status = effectiveKindleStatus(book, overrides);
    if (filters.view === "on-kindle" && status !== "confirmed" && status !== "possible") return false;
    if (filters.kindle === "on-kindle" && status !== "confirmed") return false;
    if (filters.kindle === "not-on-kindle" && status !== "not-on-kindle") return false;
    if (filters.kindle === "possible" && status !== "possible") return false;
    return true;
  });
}

export function catalogQuery(filters: LibraryFilters): CatalogBookQuery {
  const sort = filters.view === "recent" ? "recent" : filters.sort;
  return {
    q: filters.query.trim() || undefined,
    author: filters.author === "all" ? undefined : filters.author,
    language: filters.language === "all" ? undefined : filters.language,
    subject: filters.subject === "all" ? undefined : filters.subject,
    publisher: filters.publisher === "all" ? undefined : filters.publisher,
    series: filters.series === "all" ? undefined : filters.series,
    format: filters.format === "all" ? undefined : filters.format,
    rootId: filters.rootId === "all" ? undefined : filters.rootId,
    year: filters.year === "all" ? undefined : filters.year,
    metadata: filters.metadata === "all" ? undefined : filters.metadata,
    sort,
    order: sort === "title" || sort === "author" ? "asc" : "desc",
    limit: filters.limit,
    offset: filters.offset,
  };
}

export function countLibraryBooks(
  profile: CatalogProfile | undefined,
  page: CatalogBookPage | undefined,
  overrides: ReadonlyMap<string, CatalogKindleStatus>,
  statusCountsByProfile: ReadonlyMap<string, CatalogKindleStatusCounts> = new Map(),
): LibraryCounts {
  const visible = page?.items ?? [];
  const profileCounts = profile ? statusCountsByProfile.get(profile.id) : undefined;
  const onKindle = profileCounts?.confirmed
    ?? visible.filter((book) => effectiveKindleStatus(book, overrides) === "confirmed").length;
  const possible = profileCounts?.possible
    ?? visible.filter((book) => effectiveKindleStatus(book, overrides) === "possible").length;
  const absent = profileCounts?.notOnKindle
    ?? visible.filter((book) => effectiveKindleStatus(book, overrides) === "not-on-kindle").length;
  const total = profile?.bookCount ?? page?.total ?? 0;
  return {
    total,
    onKindle,
    possible,
    readyToSend: absent,
  };
}

export function hasActiveCatalogFilters(filters: LibraryFilters): boolean {
  return Boolean(filters.query.trim()) || [
    filters.author,
    filters.language,
    filters.subject,
    filters.publisher,
    filters.series,
    filters.format,
    filters.rootId,
    filters.year,
    filters.metadata,
    filters.kindle,
  ].some((value) => value !== "all");
}

export function clearCatalogFilters(filters: LibraryFilters): LibraryFilters {
  return {
    ...filters,
    query: "",
    author: "all",
    language: "all",
    subject: "all",
    publisher: "all",
    series: "all",
    format: "all",
    rootId: "all",
    year: "all",
    metadata: "all",
    kindle: "all",
    offset: 0,
  };
}
