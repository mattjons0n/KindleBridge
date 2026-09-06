import type { CatalogMetadataCandidate, EditableBookMetadata, MetadataCandidateSearchTerms } from "../shared/catalog-contracts.js";
import { normalizeKindleMetadataIdentifier, normalizeKindleMetadataWords } from "../shared/kindle-metadata-normalization.js";

// Fixed queries verified against Hardcover's official schema and Searching guide.
// Search IDs are typed GraphQL values; no third-party search URLs or covers are followed.
const BOOK_FIELDS = `id title
  contributions(limit: 20) { contribution author { name } }
  book_series(limit: 20, order_by: {id: asc}) { series_id position series { name } }`;

export const HARDCOVER_ISBN_QUERY = `query ShelfSendSeriesByIsbn($isbn: String!, $limit: Int!) {
  editions(limit: $limit, order_by: {id: asc}, where: {_or: [{isbn_13: {_eq: $isbn}}, {isbn_10: {_eq: $isbn}}]}) {
    isbn_10 isbn_13 book { ${BOOK_FIELDS} }
  }
}`;

export const HARDCOVER_SEARCH_QUERY = `query ShelfSendSeriesSearch($query: String!, $limit: Int!) {
  search(query: $query, query_type: "book", fields: "title,author_names", weights: "5,2", typos: "2,1", per_page: $limit, page: 1) { ids error }
}`;

export const HARDCOVER_BOOKS_QUERY = `query ShelfSendSeriesBooks($ids: [Int!]!, $limit: Int!) {
  books(where: {id: {_in: $ids}}, limit: $limit) {
    ${BOOK_FIELDS}
    editions(limit: 20, order_by: {id: asc}) { isbn_10 isbn_13 }
  }
}`;

export function hardcoverIsbn(value: string | undefined): string | null {
  const normalized = normalizeKindleMetadataIdentifier(value ?? "");
  return /^(?:\d{9}[\dX]|\d{13})$/u.test(normalized) ? normalized : null;
}

export function hardcoverBookIds(value: unknown, limit: number): number[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647))].slice(0, limit)
    : [];
}

/** A membership is a separate review choice, never an automatically preferred series. */
export function hardcoverMetadataCandidates(
  rows: unknown[],
  terms: MetadataCandidateSearchTerms,
  limit: number,
  editionRows = false,
): CatalogMetadataCandidate[] {
  const results: CatalogMetadataCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, 20)) {
    if (!record(row)) continue;
    const book = editionRows ? row.book : row;
    if (!record(book)) continue;
    const id = hardcoverBookIds([book.id], 1)[0];
    const title = text(book.title, 500);
    if (!id || !title) continue;
    const authors = Array.isArray(book.contributions) ? [...new Set(book.contributions.slice(0, 20).flatMap((item) => {
      if (!record(item) || !record(item.author)) return [];
      const role = typeof item.contribution === "string" ? item.contribution.trim().toLowerCase() : "";
      const name = text(item.author.name, 300);
      return name && (!role || role === "author") ? [name] : [];
    }))] : [];
    const editions = editionRows ? [row] : Array.isArray(book.editions) ? book.editions : [];
    const identifiers = [...new Set(editions.slice(0, 20).flatMap((edition) => {
      if (!record(edition)) return [];
      return [edition.isbn_10, edition.isbn_13].flatMap((value) => {
        const isbn = typeof value === "string" ? hardcoverIsbn(value) : null;
        return isbn ? [`ISBN:${isbn}`] : [];
      });
    }))].slice(0, 20);
    const metadata: Partial<EditableBookMetadata> = {
      title,
      ...(authors.length ? { authors } : {}),
      ...(identifiers.length ? { identifiers } : {}),
    };
    const memberships = Array.isArray(book.book_series) ? book.book_series.slice(0, 20) : [];
    for (const membership of memberships) {
      if (!record(membership) || !record(membership.series)) continue;
      const seriesId = hardcoverBookIds([membership.series_id], 1)[0];
      const series = text(membership.series.name, 500);
      if (!seriesId || !series) continue;
      const candidateId = `book-${id}-series-${seriesId}`;
      if (seen.has(candidateId)) continue;
      seen.add(candidateId);
      const position = membership.position;
      results.push({
        provider: "hardcover",
        candidateId,
        confidence: confidence(terms, metadata),
        metadata: {
          ...metadata,
          series,
          seriesIndex: typeof position === "number" && Number.isFinite(position) && position >= 0 && position <= 1_000_000
            ? position : null,
        },
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

function confidence(terms: MetadataCandidateSearchTerms, metadata: Partial<EditableBookMetadata>): CatalogMetadataCandidate["confidence"] {
  const isbn = hardcoverIsbn(terms.identifier);
  if (isbn && metadata.identifiers?.some((value) => normalizeKindleMetadataIdentifier(value) === isbn)) return "high";
  const title = normalizeKindleMetadataWords(terms.title ?? "");
  const author = normalizeKindleMetadataWords(terms.author ?? "");
  const titleMatches = !!title && title === normalizeKindleMetadataWords(metadata.title ?? "");
  const authorMatches = !!author && metadata.authors?.some((value) => normalizeKindleMetadataWords(value) === author);
  return titleMatches && authorMatches ? "high" : titleMatches || authorMatches ? "medium" : "low";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized && normalized.length <= maximum && !/\p{Cc}/u.test(normalized) ? normalized : null;
}
