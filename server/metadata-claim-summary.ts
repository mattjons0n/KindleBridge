import {
  MAX_MATCH_INDEX_ENTRIES,
  METADATA_CLAIM_BITMAP_BYTES,
  type MetadataClaimSummary,
} from "../shared/catalog-contracts.js";
import {
  normalizeKindleMetadataIdentifier,
  normalizeKindleMetadataWords,
} from "../shared/kindle-metadata-normalization.js";

export interface MetadataClaimBook {
  readonly bookId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly identifiers: readonly string[];
  /** True when some device-scoped reconciliation could have one known size. */
  readonly hasKnownArtifactSize: boolean;
}

export interface MetadataClaimSummaryLimits {
  readonly maxActiveBooks: number;
  readonly maxGlobalBooks: number;
  readonly maxActiveAtoms: number;
  readonly maxGlobalAtoms: number;
  readonly maxNormalizedCodeUnits: number;
  readonly maxComparisons: number;
  readonly maxElapsedMs: number;
}

export const DEFAULT_METADATA_CLAIM_SUMMARY_LIMITS: Readonly<MetadataClaimSummaryLimits> = Object.freeze({
  maxActiveBooks: MAX_MATCH_INDEX_ENTRIES,
  maxGlobalBooks: 100_000,
  maxActiveAtoms: 200_000,
  maxGlobalAtoms: 500_000,
  maxNormalizedCodeUnits: 8 * 1024 * 1024,
  maxComparisons: 2_000_000,
  maxElapsedMs: 1_500,
});

const EMPTY_COLLISION_BITMAP = Buffer.alloc(METADATA_CLAIM_BITMAP_BYTES).toString("base64");

interface ActiveClaim {
  readonly bookId: string;
}

interface TitleLookup {
  readonly candidates: number[];
}

interface NormalizationBudget {
  codeUnits: number;
}

export function incompleteMetadataClaimSummary(): MetadataClaimSummary {
  return {
    complete: false,
    collisionBitmap: EMPTY_COLLISION_BITMAP,
  };
}

function retainCodeUnits(
  budget: NormalizationBudget,
  value: string,
  maximum: number,
): boolean {
  budget.codeUnits += value.length;
  return Number.isSafeInteger(budget.codeUnits) && budget.codeUnits <= maximum;
}

function normalizedSet(
  values: readonly string[],
  normalize: (value: string) => string,
  minimumLength: number,
  budget: NormalizationBudget,
  maximumCodeUnits: number,
): Set<string> | null {
  const result = new Set<string>();
  for (const value of values) {
    const normalized = normalize(value);
    if (!retainCodeUnits(budget, normalized, maximumCodeUnits)) return null;
    if (normalized.length >= minimumLength) result.add(normalized);
  }
  return result;
}

function setCollision(bitmap: Uint8Array, index: number): void {
  bitmap[index >>> 3] = (bitmap[index >>> 3] ?? 0) | (1 << (index & 7));
}

/**
 * Builds a fixed-width, fail-safe collision bitmap without retaining another
 * profile catalog. The server does not see Kindle metadata, so another
 * author-bearing book with the same title and any strong metadata capability
 * must remain a possible cross-tier claimant; one device object may list both
 * books' otherwise-disjoint authors. Exceeding any work/retention bound returns
 * `complete:false`; browser-local source-scoped managed evidence stays
 * authoritative.
 */
export function summarizeGlobalMetadataClaims(
  activeBooks: Iterable<MetadataClaimBook>,
  otherEnabledBooks: Iterable<MetadataClaimBook>,
  overrides: Partial<MetadataClaimSummaryLimits> = {},
): MetadataClaimSummary {
  const limits = { ...DEFAULT_METADATA_CLAIM_SUMMARY_LIMITS, ...overrides };
  if (!Number.isFinite(limits.maxElapsedMs) || limits.maxElapsedMs <= 0) return incompleteMetadataClaimSummary();
  const startedAt = Date.now();
  const deadlineExceeded = (): boolean => Date.now() - startedAt >= limits.maxElapsedMs;
  const normalizationBudget: NormalizationBudget = { codeUnits: 0 };
  const activeClaims: ActiveClaim[] = [];
  const byTitle = new Map<string, TitleLookup>();
  let activeAtoms = 0;

  for (const book of activeBooks) {
    if (deadlineExceeded()) return incompleteMetadataClaimSummary();
    if (activeClaims.length >= limits.maxActiveBooks || activeClaims.length >= MAX_MATCH_INDEX_ENTRIES) {
      return incompleteMetadataClaimSummary();
    }
    const title = normalizeKindleMetadataWords(book.title);
    if (deadlineExceeded()) return incompleteMetadataClaimSummary();
    if (!retainCodeUnits(normalizationBudget, title, limits.maxNormalizedCodeUnits)) return incompleteMetadataClaimSummary();
    const authors = normalizedSet(
      book.authors,
      normalizeKindleMetadataWords,
      1,
      normalizationBudget,
      limits.maxNormalizedCodeUnits,
    );
    if (!authors) return incompleteMetadataClaimSummary();
    activeAtoms += authors.size;
    if (!Number.isSafeInteger(activeAtoms) || activeAtoms > limits.maxActiveAtoms) return incompleteMetadataClaimSummary();

    const activeIndex = activeClaims.length;
    activeClaims.push({ bookId: book.bookId });
    if (!title || authors.size === 0) continue;
    const lookup = byTitle.get(title) ?? { candidates: [] };
    if (!byTitle.has(title)) byTitle.set(title, lookup);
    lookup.candidates.push(activeIndex);
  }

  const collisions = new Uint8Array(METADATA_CLAIM_BITMAP_BYTES);
  let globalBooks = 0;
  let globalAtoms = 0;
  let comparisons = 0;
  for (const book of otherEnabledBooks) {
    if (deadlineExceeded()) return incompleteMetadataClaimSummary();
    globalBooks += 1;
    if (!Number.isSafeInteger(globalBooks) || globalBooks > limits.maxGlobalBooks) return incompleteMetadataClaimSummary();
    const title = normalizeKindleMetadataWords(book.title);
    if (deadlineExceeded()) return incompleteMetadataClaimSummary();
    if (!retainCodeUnits(normalizationBudget, title, limits.maxNormalizedCodeUnits)) return incompleteMetadataClaimSummary();
    const lookup = byTitle.get(title);
    if (!lookup) continue;
    const authors = normalizedSet(
      book.authors,
      normalizeKindleMetadataWords,
      1,
      normalizationBudget,
      limits.maxNormalizedCodeUnits,
    );
    const identifiers = normalizedSet(
      book.identifiers,
      normalizeKindleMetadataIdentifier,
      4,
      normalizationBudget,
      limits.maxNormalizedCodeUnits,
    );
    if (!authors || !identifiers) return incompleteMetadataClaimSummary();
    globalAtoms += authors.size + identifiers.size;
    if (!Number.isSafeInteger(globalAtoms) || globalAtoms > limits.maxGlobalAtoms) return incompleteMetadataClaimSummary();

    const canMakeStrongMetadataClaim = identifiers.size > 0
      || book.hasKnownArtifactSize;
    if (!canMakeStrongMetadataClaim || authors.size === 0) continue;
    // The device object can list multiple authors. Active [Alice] and other
    // [Bob] can therefore both claim one object whose authors are [Alice,Bob],
    // even though the two catalog rows do not overlap each other directly.
    for (const activeIndex of lookup.candidates) {
      comparisons += 1;
      if (!Number.isSafeInteger(comparisons) || comparisons > limits.maxComparisons) {
        return incompleteMetadataClaimSummary();
      }
      if (activeClaims[activeIndex]?.bookId !== book.bookId) setCollision(collisions, activeIndex);
    }
  }

  return {
    complete: true,
    collisionBitmap: Buffer.from(collisions).toString("base64"),
  };
}
