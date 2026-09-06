import type { CatalogBook } from "./catalog-client";

const MAX_SERIES_INDEX = 1_000_000;

export interface CatalogSeriesGroup {
  readonly key: string;
  readonly name: string;
  readonly books: readonly CatalogBook[];
  readonly duplicateIndices: readonly number[];
  /** Positive integer gaps between the lowest and highest integer volume only. */
  readonly missingIntegerIndices: readonly number[];
  readonly unnumberedCount: number;
}

export function canonicalSeriesKey(value: string | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu)?.join(" ")
    .trim() ?? "";
}

export function usableSeriesIndex(value: number | undefined): number | undefined {
  return value !== undefined
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_SERIES_INDEX
    ? value
    : undefined;
}

export function compareSeriesBooks(left: CatalogBook, right: CatalogBook): number {
  const leftIndex = usableSeriesIndex(left.seriesIndex);
  const rightIndex = usableSeriesIndex(right.seriesIndex);
  if (leftIndex !== undefined && rightIndex !== undefined && leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }
  if (leftIndex !== undefined && rightIndex === undefined) return -1;
  if (leftIndex === undefined && rightIndex !== undefined) return 1;
  const title = left.title.localeCompare(right.title, undefined, { sensitivity: "base", numeric: true });
  return title || left.id.localeCompare(right.id);
}

function preferredSeriesName(books: readonly CatalogBook[]): string {
  const counts = new Map<string, number>();
  for (const book of books) {
    const name = book.series?.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]
    || left[0].localeCompare(right[0], undefined, { sensitivity: "base" }))[0]?.[0] ?? "Unnamed series";
}

export function buildCatalogSeriesGroups(books: readonly CatalogBook[]): readonly CatalogSeriesGroup[] {
  const grouped = new Map<string, CatalogBook[]>();
  for (const book of books) {
    const key = canonicalSeriesKey(book.series);
    if (!key) continue;
    const bucket = grouped.get(key) ?? [];
    bucket.push(book);
    grouped.set(key, bucket);
  }

  return [...grouped.entries()].map(([key, members]) => {
    const ordered = [...members].sort(compareSeriesBooks);
    const counts = new Map<number, number>();
    const integerIndices: number[] = [];
    let unnumberedCount = 0;
    for (const book of ordered) {
      const index = usableSeriesIndex(book.seriesIndex);
      if (index === undefined) {
        unnumberedCount += 1;
        continue;
      }
      counts.set(index, (counts.get(index) ?? 0) + 1);
      if (Number.isInteger(index)) integerIndices.push(index);
    }
    const duplicateIndices = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([index]) => index)
      .sort((left, right) => left - right);
    const missingIntegerIndices: number[] = [];
    const uniqueIntegers = new Set(integerIndices);
    if (uniqueIntegers.size > 1) {
      const minimum = Math.min(...uniqueIntegers);
      const maximum = Math.max(...uniqueIntegers);
      // A gap is a review hint only within the observed positive integer span.
      for (let index = minimum; index <= maximum && missingIntegerIndices.length < 1_000; index += 1) {
        if (!uniqueIntegers.has(index)) missingIntegerIndices.push(index);
      }
    }
    return Object.freeze({
      key,
      name: preferredSeriesName(ordered),
      books: Object.freeze(ordered),
      duplicateIndices: Object.freeze(duplicateIndices),
      missingIntegerIndices: Object.freeze(missingIntegerIndices),
      unnumberedCount,
    });
  }).sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true })
    || left.key.localeCompare(right.key));
}

export function nextMissingKindleSeriesBook(
  group: CatalogSeriesGroup,
  statusByBookId: ReadonlyMap<string, "confirmed" | "possible" | "not-on-kindle" | "unknown">,
): CatalogBook | undefined {
  return group.books.find((book) => statusByBookId.get(book.id) === "not-on-kindle" && book.available);
}

export function allMissingKindleSeriesBooks(
  group: CatalogSeriesGroup,
  statusByBookId: ReadonlyMap<string, "confirmed" | "possible" | "not-on-kindle" | "unknown">,
): readonly CatalogBook[] {
  return group.books.filter((book) => statusByBookId.get(book.id) === "not-on-kindle" && book.available);
}
