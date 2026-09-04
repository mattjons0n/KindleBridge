export type KindleReadingStatus = "unread" | "in-progress" | "read" | "unknown";
export type KindleReadingSidecarFormat = "azw3f" | "azw3r" | "yjf" | "yjr" | "mbs" | "mbp1";

export interface KindleReadingEvidence {
  readonly status: KindleReadingStatus;
  readonly progressPercent?: number;
  readonly lastReadAt?: string;
  readonly provenance: KindleReadingSidecarFormat;
  readonly freshness: "live" | "last-seen";
  /** True only for a physically established explicit read/unread field. */
  readonly explicitState: boolean;
}

export interface KindleReadingAssociation {
  readonly bookId: string;
  readonly evidence: KindleReadingEvidence;
}

const FORMATS = new Set<KindleReadingSidecarFormat>(["azw3f", "azw3r", "yjf", "yjr", "mbs", "mbp1"]);

export function validateKindleReadingEvidence(value: unknown): KindleReadingEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<KindleReadingEvidence>;
  if (item.status !== "unread" && item.status !== "in-progress" && item.status !== "read" && item.status !== "unknown") {
    return undefined;
  }
  if (!FORMATS.has(item.provenance as KindleReadingSidecarFormat)
      || (item.freshness !== "live" && item.freshness !== "last-seen")
      || typeof item.explicitState !== "boolean") {
    return undefined;
  }
  if (item.progressPercent !== undefined
      && (!Number.isFinite(item.progressPercent) || item.progressPercent < 0 || item.progressPercent > 100)) {
    return undefined;
  }
  if (item.lastReadAt !== undefined
      && (typeof item.lastReadAt !== "string" || item.lastReadAt.length > 64 || Number.isNaN(Date.parse(item.lastReadAt)))) {
    return undefined;
  }
  // A percentage is never enough to claim the Kindle's explicit Read/Unread
  // state. Until a physical format-specific parser proves that field, those
  // labels must remain unknown or in-progress.
  if ((item.status === "read" || item.status === "unread") && !item.explicitState) return undefined;
  if (item.status === "unknown" && item.explicitState) return undefined;
  if (item.status === "unread" && item.progressPercent !== undefined && item.progressPercent > 0) return undefined;
  if (item.status === "in-progress"
      && (item.progressPercent === undefined || item.progressPercent <= 0 || item.progressPercent > 100)) {
    return undefined;
  }
  return Object.freeze({
    status: item.status,
    ...(item.progressPercent === undefined ? {} : { progressPercent: item.progressPercent }),
    ...(item.lastReadAt === undefined ? {} : { lastReadAt: new Date(item.lastReadAt).toISOString() }),
    provenance: item.provenance as KindleReadingSidecarFormat,
    freshness: item.freshness,
    explicitState: item.explicitState,
  });
}

export function unknownKindleReadingEvidence(
  provenance: KindleReadingSidecarFormat,
  freshness: "live" | "last-seen" = "live",
): KindleReadingEvidence {
  return Object.freeze({ status: "unknown", provenance, freshness, explicitState: false });
}

/**
 * Maps sidecar evidence only after one strong, unique catalog association.
 * Possible or duplicate associations deliberately return no catalog mapping.
 */
export function associateKindleReadingEvidence(input: {
  readonly bookId?: string;
  readonly match: "confirmed" | "possible" | "unmatched";
  readonly duplicateBookClaim: boolean;
  readonly evidence: unknown;
}): KindleReadingAssociation | undefined {
  if (!input.bookId || input.match !== "confirmed" || input.duplicateBookClaim) return undefined;
  const evidence = validateKindleReadingEvidence(input.evidence);
  if (!evidence) return undefined;
  return Object.freeze({ bookId: input.bookId, evidence });
}

export function filterBookIdsByReadingStatus(
  bookIds: readonly string[],
  evidenceByBookId: ReadonlyMap<string, KindleReadingEvidence>,
  filter: "any" | KindleReadingStatus,
): readonly string[] {
  if (filter === "any") return Object.freeze([...bookIds]);
  return Object.freeze(bookIds.filter((bookId) => (evidenceByBookId.get(bookId)?.status ?? "unknown") === filter));
}

export function retireKindleReadingEvidence(
  evidenceByBookId: ReadonlyMap<string, KindleReadingEvidence>,
): ReadonlyMap<string, KindleReadingEvidence> {
  return new Map([...evidenceByBookId].map(([bookId, evidence]) => [bookId, Object.freeze({
    ...evidence,
    freshness: "last-seen" as const,
    // Explicit states discovered during a live scan remain labelled last seen,
    // while action authority is held elsewhere and is always revoked.
  })]));
}
