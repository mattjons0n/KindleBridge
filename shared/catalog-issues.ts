import { normalizeKindleMetadataIdentifier, normalizeKindleMetadataWords } from "./kindle-metadata-normalization.js";

export const CATALOG_ISSUE_MODEL_VERSION = 1;
export const MAX_DERIVED_CATALOG_ISSUES = 20_000;

export type CatalogIssueType =
  | "missing-cover"
  | "incomplete-metadata"
  | "metadata-parser-failure"
  | "low-confidence-provider-data"
  | "unavailable-source"
  | "suspected-duplicate";

export type CatalogIssueSeverity = "info" | "warning" | "error";

export interface CatalogIssueBookFacts {
  readonly profileId: string;
  readonly bookId: string;
  readonly sourceId?: string;
  readonly sourceLabel?: string;
  readonly rootId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly identifiers: readonly string[];
  readonly contentHash?: string;
  readonly coverAvailable: boolean;
  readonly metadataComplete: boolean;
  readonly sourceAvailable: boolean;
  readonly parserErrorCode?: string;
  readonly lowConfidenceProviderData?: boolean;
  readonly firstObservedAt?: string;
  readonly lastObservedAt: string;
}

export interface CatalogIssueSourceFacts {
  readonly profileId: string;
  readonly sourceId?: string;
  readonly rootId: string;
  readonly displayLabel?: string;
  readonly errorCode?: string;
  readonly sourceAvailable: boolean;
  readonly firstObservedAt?: string;
  readonly lastObservedAt: string;
}

export interface DerivedCatalogIssue {
  readonly version: 1;
  readonly signature: string;
  readonly profileId: string;
  readonly type: CatalogIssueType;
  readonly severity: CatalogIssueSeverity;
  readonly reasonCode: string;
  readonly bookIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly rootIds: readonly string[];
  readonly displayLabels: readonly string[];
  readonly currentAvailable: boolean;
  readonly firstObservedAt?: string;
  readonly lastObservedAt: string;
}

export interface CatalogIssueDisposition {
  readonly ignored: boolean;
  /** Presentation preference only. It never merges sources or supplies Kindle-presence evidence. */
  readonly preferredBookId: string | null;
  readonly revision: number;
  readonly retryCount: number;
  readonly lastRetryAt: string | null;
}

export interface CatalogHealthIssue extends DerivedCatalogIssue {
  readonly disposition: CatalogIssueDisposition;
}

export interface CatalogHealthCounts {
  readonly total: number;
  readonly active: number;
  readonly ignored: number;
  readonly byType: Readonly<Record<CatalogIssueType, number>>;
  readonly bySeverity: Readonly<Record<CatalogIssueSeverity, number>>;
}

export interface CatalogHealthPage {
  readonly items: readonly CatalogHealthIssue[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly counts: CatalogHealthCounts;
}

export interface CatalogHealthQuery {
  readonly type?: CatalogIssueType;
  readonly severity?: CatalogIssueSeverity;
  readonly ignored?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface CatalogIssueDispositionInput {
  readonly expectedRevision: number;
  readonly ignored: boolean;
}

export interface CatalogIssueRetryInput {
  readonly expectedRevision: number;
}

export interface CatalogDuplicatePreferenceInput {
  readonly expectedRevision: number;
  readonly preferredBookId: string | null;
}

export interface CatalogIssueRetryResult {
  readonly issue: CatalogHealthIssue;
  readonly acceptedRootIds: readonly string[];
  readonly blockedRootIds: readonly string[];
}

function safeToken(value: string | undefined, maximum = 512): string {
  if (!value || value.length > maximum || /\p{Cc}/u.test(value)) return "";
  return value;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function signature(
  profileId: string,
  type: CatalogIssueType,
  reasonCode: string,
  bookIds: readonly string[],
  sourceIds: readonly string[],
  rootIds: readonly string[],
): string {
  // Book-backed issues follow stable book identity through an index rebuild;
  // rebuildable source row IDs remain useful context but cannot participate in
  // the durable disposition key. Source-only failures still key by source ID.
  const stableSourceIds = bookIds.length === 0 ? [...sourceIds].sort() : [];
  const stableRootIds = bookIds.length === 0 && sourceIds.length === 0 ? [...rootIds].sort() : [];
  return `issue-${fnv1a64(JSON.stringify([
    CATALOG_ISSUE_MODEL_VERSION,
    profileId,
    type,
    reasonCode,
    [...bookIds].sort(),
    stableSourceIds,
    stableRootIds,
  ]))}`;
}

function makeIssue(input: Omit<DerivedCatalogIssue, "version" | "signature">): DerivedCatalogIssue {
  const bookIds = Object.freeze([...new Set(input.bookIds)].sort());
  const sourceIds = Object.freeze([...new Set(input.sourceIds)].sort());
  const rootIds = Object.freeze([...new Set(input.rootIds)].sort());
  const displayLabels = Object.freeze([...new Set(input.displayLabels)].sort());
  return Object.freeze({
    version: CATALOG_ISSUE_MODEL_VERSION,
    signature: signature(input.profileId, input.type, input.reasonCode, bookIds, sourceIds, rootIds),
    ...input,
    bookIds,
    sourceIds,
    rootIds,
    displayLabels,
  });
}

function duplicateKeys(book: CatalogIssueBookFacts): readonly [string, string][] {
  const keys: [string, string][] = [];
  const contentHash = safeToken(book.contentHash, 128).toLocaleLowerCase("en-US");
  if (/^[a-f0-9]{64}$/u.test(contentHash)) keys.push(["content-hash", contentHash]);
  for (const identifier of book.identifiers) {
    const normalized = normalizeKindleMetadataIdentifier(identifier);
    if (normalized.length >= 4) keys.push(["identifier", normalized]);
  }
  const title = normalizeKindleMetadataWords(book.title);
  const authors = book.authors.map(normalizeKindleMetadataWords).filter(Boolean).join("|");
  if (title.length >= 3 && authors.length >= 2) keys.push(["title-author", `${title}|${authors}`]);
  return keys;
}

export function deriveCatalogIssues(
  profileId: string,
  input: readonly CatalogIssueBookFacts[],
  sourceInput: readonly CatalogIssueSourceFacts[] = [],
): readonly DerivedCatalogIssue[] {
  if (!safeToken(profileId, 256)) throw new TypeError("A valid profile ID is required");
  if (input.length > 100_000) throw new RangeError("Catalog issue derivation input exceeds its 100,000-book limit");
  if (sourceInput.length > 100_000) throw new RangeError("Catalog source-issue input exceeds its 100,000-source limit");
  const books = input.filter((book) => book.profileId === profileId);
  const issues: DerivedCatalogIssue[] = [];
  const add = (issue: Omit<DerivedCatalogIssue, "version" | "signature">): void => {
    if (issues.length >= MAX_DERIVED_CATALOG_ISSUES) {
      throw new RangeError(`Catalog issue result exceeds ${MAX_DERIVED_CATALOG_ISSUES} rows`);
    }
    issues.push(makeIssue(issue));
  };

  for (const book of books) {
    const common = {
      profileId,
      bookIds: [book.bookId],
      sourceIds: book.sourceId ? [book.sourceId] : [],
      rootIds: [book.rootId],
      displayLabels: [book.title, ...(book.sourceLabel ? [book.sourceLabel] : [])],
      currentAvailable: book.sourceAvailable,
      ...(book.firstObservedAt ? { firstObservedAt: book.firstObservedAt } : {}),
      lastObservedAt: book.lastObservedAt,
    };
    if (!book.coverAvailable) add({ ...common, type: "missing-cover", severity: "info", reasonCode: "cover-missing" });
    if (!book.metadataComplete) {
      add({ ...common, type: "incomplete-metadata", severity: "warning", reasonCode: "core-fields-incomplete" });
    }
    if (safeToken(book.parserErrorCode, 128)) {
      add({ ...common, type: "metadata-parser-failure", severity: "error", reasonCode: book.parserErrorCode! });
    }
    if (book.lowConfidenceProviderData) {
      add({
        ...common,
        type: "low-confidence-provider-data",
        severity: "warning",
        reasonCode: "provider-candidates-low-confidence",
      });
    }
    if (!book.sourceAvailable) {
      add({ ...common, type: "unavailable-source", severity: "warning", reasonCode: "source-unavailable" });
    }
  }

  for (const source of sourceInput.filter((candidate) => candidate.profileId === profileId)) {
    const errorCode = safeToken(source.errorCode, 128);
    const common = {
      profileId,
      bookIds: [],
      sourceIds: source.sourceId ? [source.sourceId] : [],
      rootIds: [source.rootId],
      displayLabels: source.displayLabel ? [source.displayLabel] : [],
      currentAvailable: source.sourceAvailable,
      ...(source.firstObservedAt ? { firstObservedAt: source.firstObservedAt } : {}),
      lastObservedAt: source.lastObservedAt,
    };
    if (errorCode) add({ ...common, type: "metadata-parser-failure", severity: "error", reasonCode: errorCode });
    if (!source.sourceAvailable) {
      add({ ...common, type: "unavailable-source", severity: "warning", reasonCode: "source-unavailable" });
    }
  }

  const duplicateBuckets = new Map<string, { evidence: string; books: CatalogIssueBookFacts[] }>();
  for (const book of books) {
    for (const [evidence, value] of duplicateKeys(book)) {
      const key = `${evidence}\u0000${value}`;
      const bucket = duplicateBuckets.get(key) ?? { evidence, books: [] };
      bucket.books.push(book);
      duplicateBuckets.set(key, bucket);
    }
  }
  const emittedGroups = new Set<string>();
  for (const bucket of duplicateBuckets.values()) {
    const uniqueBooks = [...new Map(bucket.books.map((book) => [book.bookId, book])).values()];
    if (uniqueBooks.length < 2) continue;
    const groupKey = uniqueBooks.map(({ bookId }) => bookId).sort().join("\u0000");
    // Prefer the strongest explanation for an identical group.
    const priority = bucket.evidence === "content-hash" ? 3 : bucket.evidence === "identifier" ? 2 : 1;
    const current = [...emittedGroups].find((entry) => entry.endsWith(`\u0001${groupKey}`));
    if (current) {
      const currentPriority = Number(current.split("\u0001", 1)[0]);
      if (currentPriority >= priority) continue;
      emittedGroups.delete(current);
      const priorIndex = issues.findIndex((issue) => issue.type === "suspected-duplicate"
        && issue.bookIds.join("\u0000") === groupKey);
      if (priorIndex >= 0) issues.splice(priorIndex, 1);
    }
    emittedGroups.add(`${priority}\u0001${groupKey}`);
    add({
      profileId,
      type: "suspected-duplicate",
      severity: "info",
      reasonCode: `duplicate-${bucket.evidence}`,
      bookIds: uniqueBooks.map(({ bookId }) => bookId),
      sourceIds: uniqueBooks.flatMap(({ sourceId }) => sourceId ? [sourceId] : []),
      rootIds: uniqueBooks.map(({ rootId }) => rootId),
      displayLabels: uniqueBooks.map(({ title }) => title),
      currentAvailable: uniqueBooks.every(({ sourceAvailable }) => sourceAvailable),
      lastObservedAt: uniqueBooks.map(({ lastObservedAt }) => lastObservedAt).sort().at(-1)!,
    });
  }

  return Object.freeze(issues.sort((left, right) => {
    const severity = { error: 0, warning: 1, info: 2 } as const;
    const type = {
      "metadata-parser-failure": 0,
      "incomplete-metadata": 1,
      "low-confidence-provider-data": 2,
      "unavailable-source": 3,
      "missing-cover": 4,
      "suspected-duplicate": 5,
    } as const;
    return severity[left.severity] - severity[right.severity]
      || right.lastObservedAt.localeCompare(left.lastObservedAt)
      || type[left.type] - type[right.type]
      || left.signature.localeCompare(right.signature);
  }));
}
