import type {
  CatalogKindleStatus,
  CatalogSendQueueEntry,
} from "./catalog-client";
import type { BookActionCapabilities } from "./book-action-capabilities";

interface SendQueueEntryLike {
  readonly bookId: string;
  readonly sourceState: CatalogSendQueueEntry["sourceState"];
  readonly book: {
    readonly title: string;
    readonly format: string;
    readonly size: number;
  } | null;
}

interface SendQueueLike {
  readonly profileId: string;
  readonly revision: number;
  readonly entries: readonly SendQueueEntryLike[];
  readonly totalSourceBytes: number;
}

export interface SendQueueReviewItem {
  readonly bookId: string;
  readonly title: string;
  readonly sourceState: CatalogSendQueueEntry["sourceState"];
  readonly kindleStatus: CatalogKindleStatus;
  readonly transferEligible: boolean;
  readonly reason?: string;
  readonly preparation: "convert-browser-copy" | "validate-kindle-file" | "unavailable";
  readonly sourceBytes: number;
}

export interface SendQueueReview {
  readonly profileId: string;
  readonly revision: number;
  readonly items: readonly SendQueueReviewItem[];
  readonly eligibleBookIds: readonly string[];
  readonly totalSourceBytes: number;
  readonly approximateTransferBytes: number;
  readonly conversionSizeUncertain: boolean;
  readonly fitsApproximateFreeSpace?: boolean;
}

function entryTitle(entry: SendQueueEntryLike): string {
  return entry.book?.title?.trim() || "Unavailable queued book";
}

function transferReason(
  entry: SendQueueEntryLike,
  kindleStatus: CatalogKindleStatus,
  currentComparisonComplete: boolean,
  actions?: Pick<BookActionCapabilities, "send">,
): string | undefined {
  if (entry.sourceState === "source-unavailable") return "Source is temporarily unavailable";
  if (entry.sourceState === "source-changed") return "Source changed after it was queued; review and re-add it";
  if (entry.sourceState === "presentation-changed") return "Metadata or cover changed after it was queued; review and re-add it";
  if (entry.sourceState === "unsupported") return "This format is not supported for transfer";
  if (entry.sourceState === "missing-or-retired") return "The queued catalog book no longer exists";
  if (actions) return actions.send.enabled ? undefined : actions.send.reason ?? "This book is not currently eligible to send";
  if (!currentComparisonComplete) return "Connect and complete the current Kindle comparison";
  if (kindleStatus === "confirmed") return "Already on this Kindle";
  if (kindleStatus === "possible") return "Resolve the possible Kindle match first";
  if (kindleStatus === "unknown") return "Kindle presence could not be verified";
  return undefined;
}

export function buildSendQueueReview(input: {
  readonly queue: SendQueueLike;
  readonly kindleStatusByBookId?: ReadonlyMap<string, CatalogKindleStatus>;
  /**
   * The normal UI supplies the shared per-book projection so queue rows and
   * its Transfer button cannot drift from grid, list, details, or series.
   * The optional fallback keeps this pure helper usable by controller-side
   * revalidation, which repeats the same fail-closed checks before writing.
   */
  readonly actionCapabilitiesByBookId?: ReadonlyMap<string, Pick<BookActionCapabilities, "send">>;
  readonly currentComparisonComplete: boolean;
  readonly freeBytes?: bigint;
}): SendQueueReview {
  const items = input.queue.entries.map((entry): SendQueueReviewItem => {
    const kindleStatus = input.kindleStatusByBookId?.get(entry.bookId) ?? "unknown";
    const reason = transferReason(
      entry,
      kindleStatus,
      input.currentComparisonComplete,
      input.actionCapabilitiesByBookId?.get(entry.bookId),
    );
    const format = entry.book?.format.toLocaleLowerCase("en-US");
    return Object.freeze({
      bookId: entry.bookId,
      title: entryTitle(entry),
      sourceState: entry.sourceState,
      kindleStatus,
      transferEligible: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
      preparation: format === "epub"
        ? "convert-browser-copy"
        : format === "azw3" ? "validate-kindle-file" : "unavailable",
      sourceBytes: entry.book?.size ?? 0,
    });
  });
  const approximateTransferBytes = items.reduce((sum, item) => sum + item.sourceBytes, 0);
  const conversionSizeUncertain = items.some((item) => item.preparation === "convert-browser-copy");
  return Object.freeze({
    profileId: input.queue.profileId,
    revision: input.queue.revision,
    items: Object.freeze(items),
    eligibleBookIds: Object.freeze(items.filter(({ transferEligible }) => transferEligible).map(({ bookId }) => bookId)),
    totalSourceBytes: input.queue.totalSourceBytes,
    approximateTransferBytes,
    conversionSizeUncertain,
    ...(input.freeBytes === undefined ? {} : {
      fitsApproximateFreeSpace: input.freeBytes >= BigInt(approximateTransferBytes),
    }),
  });
}

export function reorderedQueueBookIds(
  queue: SendQueueLike,
  movedBookId: string,
  targetIndex: number,
): readonly string[] {
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= queue.entries.length) {
    throw new RangeError("Queue target index is outside the current queue");
  }
  const ids = queue.entries.map(({ bookId }) => bookId);
  const sourceIndex = ids.indexOf(movedBookId);
  if (sourceIndex < 0) throw new RangeError("The moved book is not in the current queue");
  ids.splice(sourceIndex, 1);
  ids.splice(targetIndex, 0, movedBookId);
  return Object.freeze(ids);
}

/** Keeps only books that were not verified, in their original queue order. */
export function queueBookIdsAfterBatch(
  queue: SendQueueLike,
  verifiedBookIds: ReadonlySet<string>,
): readonly string[] {
  return Object.freeze(queue.entries
    .map(({ bookId }) => bookId)
    .filter((bookId) => !verifiedBookIds.has(bookId)));
}
