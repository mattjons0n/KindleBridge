import type { CatalogBrowserSnapshot } from "./catalog-browser";
import type { CatalogBook, CatalogKindleStatus } from "./catalog-client";
import { effectiveKindleStatus } from "./library-prototype";
import type { AppState } from "./state";

export interface BookActionCapability {
  readonly enabled: boolean;
  readonly reason?: string;
}

export interface BookActionCapabilities {
  readonly kindleStatus: CatalogKindleStatus;
  readonly currentComparison: boolean;
  readonly sourceAvailable: boolean;
  readonly exactKindleAssociation: boolean;
  readonly select: BookActionCapability;
  readonly edit: BookActionCapability;
  readonly send: BookActionCapability & { readonly label: string };
  readonly queue: BookActionCapability & { readonly label: string; readonly queued: boolean };
  readonly update: BookActionCapability & { readonly priorFilename?: string };
  readonly matchReview: BookActionCapability & {
    readonly decisionEnabled: boolean;
    readonly decisionReason?: string;
  };
  readonly favorite: BookActionCapability & { readonly active: boolean };
  readonly wantToRead: BookActionCapability & { readonly active: boolean };
  readonly remove: BookActionCapability;
}

export interface BulkBookActionCapabilities {
  readonly send: BookActionCapability & { readonly count: number };
  readonly remove: BookActionCapability & { readonly count: number };
}

export function actualDeviceConnected(state: AppState): boolean {
  return state.device.kind === "ready" || state.device.kind === "transferring" || state.device.kind === "recovering";
}

export function deviceConnecting(state: AppState): boolean {
  return state.device.kind === "requesting-permission" || state.device.kind === "opening" || state.device.kind === "mtp-reading";
}

export function currentKindleComparison(
  snapshot: CatalogBrowserSnapshot,
  profileId = snapshot.filters.profileId,
): boolean {
  return snapshot.kindleInventory !== undefined
    && snapshot.kindleInventory.completeness !== "last-seen"
    && snapshot.kindleInventory.matching?.status !== "unavailable"
    && (profileId === undefined || snapshot.kindleStatusCountsByProfile.has(profileId));
}

export function deviceReadyToSend(state: AppState, snapshot: CatalogBrowserSnapshot): boolean {
  return state.device.kind === "ready"
    && state.selfTest.kind === "passed"
    && state.catalogInventoryState === "ready"
    && snapshot.kindleInventory?.completeness === "complete"
    && currentKindleComparison(snapshot)
    && !state.pendingObjectCleanup
    && (state.pendingReplacementCleanups?.length ?? 0) === 0;
}

export function sourceBookAvailable(book: CatalogBook, snapshot: CatalogBrowserSnapshot): boolean {
  const root = snapshot.rootsByProfile.get(book.profileId)?.find((candidate) => candidate.id === book.rootId);
  const sourceHealthy = root?.enabled === true && ["available", "watching", "paused", "scanning"].includes(root.status);
  return book.available !== false && sourceHealthy;
}

export function hasExactCurrentKindleAssociation(bookId: string, snapshot: CatalogBrowserSnapshot): boolean {
  return snapshot.kindleInventory?.completeness === "complete"
    && snapshot.kindleInventory.matching?.status === "complete"
    && snapshot.kindleInventory.items.some((item) => (
      item.bookId === bookId && (
        item.match === "confirmed"
        || (item.stalePresentation === true && item.managed === true && item.match === "possible")
      )
    ));
}

export function deviceReadyToRemove(state: AppState, snapshot: CatalogBrowserSnapshot): boolean {
  return state.device.kind === "ready"
    && state.selfTest.kind === "passed"
    && state.catalogInventoryState === "ready"
    && snapshot.kindleInventory?.completeness === "complete"
    && snapshot.kindleInventory.matching?.status === "complete"
    && !state.pendingObjectCleanup
    && (state.pendingReplacementCleanups?.length ?? 0) === 0;
}

/**
 * The single UI projection for every per-book and bulk action surface. Keeping
 * policy here prevents the grid, list, and details drawer from drifting apart.
 */
export function bookActionCapabilities(
  book: CatalogBook,
  state: AppState,
  snapshot: CatalogBrowserSnapshot,
): BookActionCapabilities {
  const kindleStatus = effectiveKindleStatus(book, snapshot.kindleStatus);
  const comparison = currentKindleComparison(snapshot, book.profileId);
  const currentUnknown = kindleStatus === "unknown" && comparison;
  const sourceAvailable = sourceBookAvailable(book, snapshot);
  const exactKindleAssociation = hasExactCurrentKindleAssociation(book.id, snapshot);
  const busy = snapshot.sendBusy || snapshot.bulkActionBusy || snapshot.sendQueueBusy;
  const connected = actualDeviceConnected(state);
  const readyToSend = deviceReadyToSend(state, snapshot);
  const readyToRemove = deviceReadyToRemove(state, snapshot);
  const queued = snapshot.sendQueue?.entries.some((entry) => entry.bookId === book.id) ?? false;
  const replacementCleanupPending = (state.pendingReplacementCleanups?.length ?? 0) > 0;
  const annotation = snapshot.annotations?.get(book.id);

  const sendLabel = kindleStatus === "confirmed"
    ? "✓ On Kindle"
    : kindleStatus === "possible"
      ? "Possible match"
      : !sourceAvailable
        ? "Source unavailable"
        : currentUnknown
          ? "Could not verify"
          : readyToSend
            ? "Send to Kindle"
            : deviceConnecting(state)
              ? "Connecting Kindle…"
              : connected
                ? replacementCleanupPending
                  ? "Cleanup required"
                  : state.selfTest.kind === "passed" ? "Inventory unavailable" : "Checking Kindle…"
                : "Connect to send";

  const sendEnabled = !busy
    && kindleStatus === "not-on-kindle"
    && sourceAvailable
    && readyToSend;
  const sendReason = busy
    ? "Another Kindle action is in progress"
    : kindleStatus === "confirmed"
      ? "This edition is already on the Kindle"
      : kindleStatus === "possible" || currentUnknown
        ? "Kindle presence is not certain enough to send safely"
        : !sourceAvailable
          ? "The read-only source file is unavailable"
          : !connected
            ? "Connect the Kindle to send this book"
            : replacementCleanupPending
              ? "Finish the verified replacement cleanup first"
              : "Complete the Kindle safety and inventory checks first";
  const removeEnabled = !busy && exactKindleAssociation && readyToRemove;
  const removeReason = busy
    ? "Another Kindle action is in progress"
    : !connected
      ? "Connect the Kindle to remove this book"
      : !exactKindleAssociation
        ? "No exact current Kindle association"
      : replacementCleanupPending
        ? "Finish the verified replacement cleanup first"
        : "Complete the Kindle safety and inventory checks first";
  const queueEnabled = !busy
    && sourceAvailable
    && !queued
    && kindleStatus !== "confirmed"
    && kindleStatus !== "possible"
    && snapshot.sendQueueState === "ready";
  const queueReason = busy
    ? "Another Kindle action is in progress"
    : queued
      ? "Already in Send later"
      : kindleStatus === "confirmed"
        ? "This edition is already on the Kindle"
        : kindleStatus === "possible"
          ? "Resolve the possible Kindle match before queuing it"
      : !sourceAvailable
        ? "The read-only source file is unavailable"
        : "The Send later queue is unavailable";
  const claimedKindleItems = snapshot.kindleInventory?.items.filter((item) => item.bookId === book.id) ?? [];
  const candidateKindleItems = snapshot.kindleInventory?.items.filter((item) => (
    item.bookId === book.id || item.candidates?.some((candidate) => candidate.bookId === book.id)
  )) ?? [];
  const staleManagedPresentation = claimedKindleItems.length === 1
    && claimedKindleItems[0]?.stalePresentation === true
    && claimedKindleItems[0].managed === true
    && claimedKindleItems[0].match === "possible"
    ? claimedKindleItems[0]
    : undefined;
  const edited = book.metadataEdited === true || book.coverEdited === true;
  const editableEpubPresentation = book.format.toLocaleUpperCase("en-US") === "EPUB";
  const updateVersionReady = typeof book.contentHash === "string"
    && typeof book.presentationVersion === "string"
    && Number.isSafeInteger(book.metadataRevision)
    && (book.metadataRevision ?? -1) >= 0;
  const updateEnabled = !busy
    && sourceAvailable
    && editableEpubPresentation
    && edited
    && updateVersionReady
    && staleManagedPresentation !== undefined
    && readyToSend
    && readyToRemove;
  const updateReason = busy
    ? "Another Kindle action is in progress"
    : !editableEpubPresentation
      ? "Only an edited EPUB can replace a prior Kindle copy; edited AZW3 files cannot be rebuilt safely"
      : !edited
        ? "Edit this EPUB's metadata or cover before updating its Kindle copy"
        : !sourceAvailable
          ? "The read-only source file is unavailable"
          : !updateVersionReady
            ? "Refresh this book to load its exact source and presentation versions"
            : staleManagedPresentation === undefined
              ? claimedKindleItems.length > 1
                ? "More than one Kindle file claims this book; resolve the ambiguity first"
                : "Update requires exactly one prior Kindle Bridge-managed presentation"
              : !connected
                ? "Connect the Kindle to update this book"
                : "Complete the Kindle safety and inventory checks first";
  const possibleOrCandidate = kindleStatus === "possible" || candidateKindleItems.length > 0;
  const matchReviewEnabled = possibleOrCandidate && !busy;
  const matchDecisionEnabled = matchReviewEnabled
    && candidateKindleItems.length > 0
    && snapshot.kindleInventory?.completeness === "complete"
    && snapshot.kindleInventory.matching?.status === "complete";
  const matchReviewReason = busy
    ? "Another Kindle action is in progress"
    : !possibleOrCandidate
      ? "This book has no possible Kindle match to review"
      : undefined;
  const matchDecisionReason = busy
    ? "Another Kindle action is in progress"
    : candidateKindleItems.length === 0
      ? "A complete scan has not identified a specific Kindle file"
      : snapshot.kindleInventory?.completeness !== "complete"
        || snapshot.kindleInventory.matching?.status !== "complete"
        ? "Reconnect and complete the current Kindle comparison before choosing"
        : undefined;

  return {
    kindleStatus,
    currentComparison: comparison,
    sourceAvailable,
    exactKindleAssociation,
    select: { enabled: !busy, ...(busy ? { reason: "Another Kindle action is in progress" } : {}) },
    edit: { enabled: !busy, ...(busy ? { reason: "Another Kindle action is in progress" } : {}) },
    send: { enabled: sendEnabled, label: sendLabel, ...(!sendEnabled ? { reason: sendReason } : {}) },
    queue: {
      enabled: queueEnabled,
      label: queued ? "Queued" : "Send later",
      queued,
      ...(!queueEnabled ? { reason: queueReason } : {}),
    },
    update: {
      enabled: updateEnabled,
      ...(staleManagedPresentation ? { priorFilename: staleManagedPresentation.filename } : {}),
      ...(!updateEnabled ? { reason: updateReason } : {}),
    },
    matchReview: {
      enabled: matchReviewEnabled,
      decisionEnabled: matchDecisionEnabled,
      ...(matchReviewReason === undefined ? {} : { reason: matchReviewReason }),
      ...(matchDecisionReason === undefined ? {} : { decisionReason: matchDecisionReason }),
    },
    favorite: { enabled: !busy, active: annotation?.favorite ?? false },
    wantToRead: { enabled: !busy, active: annotation?.wantToRead ?? false },
    remove: { enabled: removeEnabled, ...(!removeEnabled ? { reason: removeReason } : {}) },
  };
}

/**
 * Aggregates the per-book projection for List view and activity retries. Book
 * IDs selected on another page stay provisional until the existing send path
 * hydrates and revalidates their source immediately before transfer.
 */
export function bulkBookActionCapabilities(
  visibleBooks: readonly CatalogBook[],
  selectedBookIds: ReadonlySet<string>,
  state: AppState,
  snapshot: CatalogBrowserSnapshot,
): BulkBookActionCapabilities {
  const selectedVisible = visibleBooks.filter(({ id }) => selectedBookIds.has(id));
  const visibleIds = new Set(selectedVisible.map(({ id }) => id));
  const capabilities = selectedVisible.map((book) => bookActionCapabilities(book, state, snapshot));
  const busy = snapshot.sendBusy || snapshot.bulkActionBusy || snapshot.sendQueueBusy;
  const provisionalOffPageSendCount = !busy && deviceReadyToSend(state, snapshot)
    ? [...selectedBookIds].filter((bookId) => (
        !visibleIds.has(bookId) && snapshot.kindleStatus.get(bookId) === "not-on-kindle"
      )).length
    : 0;
  const sendCount = capabilities.filter(({ send }) => send.enabled).length + provisionalOffPageSendCount;
  const removeCount = !busy && deviceReadyToRemove(state, snapshot)
    ? new Set((snapshot.kindleInventory?.items ?? [])
        .filter((item) => item.bookId && selectedBookIds.has(item.bookId) && (
          item.match === "confirmed"
          || (item.match === "possible" && item.managed && item.stalePresentation)
        ))
        .map((item) => item.bookId)).size
    : 0;
  return Object.freeze({
    send: {
      enabled: sendCount > 0,
      count: sendCount,
      ...(sendCount > 0 ? {} : { reason: busy
        ? "Another Kindle action is in progress"
        : "No selected book is currently eligible to send" }),
    },
    remove: {
      enabled: removeCount > 0,
      count: removeCount,
      ...(removeCount > 0 ? {} : { reason: busy
        ? "Another Kindle action is in progress"
        : "No selected book has an exact current Kindle association" }),
    },
  });
}
