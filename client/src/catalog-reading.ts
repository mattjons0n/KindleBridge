import type { CatalogKindleInventory } from "./catalog-browser";
import { validateKindleReadingEvidence, type KindleReadingEvidence } from "./kindle/reading-state";

/** Browser-only projection. Device presence never implies reading completion. */
export function catalogReadingEvidence(inventory: CatalogKindleInventory | undefined): ReadonlyMap<string, KindleReadingEvidence> {
  const result = new Map<string, KindleReadingEvidence>();
  if (!inventory || inventory.completeness !== "complete" || inventory.truncated
      || inventory.matching?.status !== "complete" || inventory.items.length > 10_000) return result;
  const books = new Map<string, number>();
  const objects = new Map<string, number>();
  for (const item of inventory.items) {
    objects.set(item.id, (objects.get(item.id) ?? 0) + 1);
    if (item.bookId) books.set(item.bookId, (books.get(item.bookId) ?? 0) + 1);
    for (const candidate of item.candidates ?? []) {
      if (candidate.bookId !== item.bookId) books.set(candidate.bookId, (books.get(candidate.bookId) ?? 0) + 1);
    }
  }
  for (const item of inventory.items) {
    if (!item.bookId || !/^book_[A-Za-z0-9_-]{8,80}$/u.test(item.bookId)
        || item.match !== "confirmed" || item.stalePresentation || books.get(item.bookId) !== 1 || objects.get(item.id) !== 1) continue;
    const evidence = validateKindleReadingEvidence(item.readingEvidence);
    if (evidence?.freshness === "live") result.set(item.bookId, evidence);
  }
  return result;
}

/** Only durable membership may cross to the server. */
export function completedReadingBookIds(evidence: ReadonlyMap<string, KindleReadingEvidence>): readonly string[] {
  return [...evidence].filter(([, value]) => value.freshness === "live" && value.explicitState && value.status === "read").map(([id]) => id);
}
