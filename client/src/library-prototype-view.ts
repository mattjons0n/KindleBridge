import {
  catalogPossibleMatchReviewId,
  type CatalogBrowserSnapshot,
  type CatalogMatchEvidenceBreakdown,
} from "./catalog-browser";
import type {
  BookMetadataOverrides,
  CatalogBook,
  CatalogHealthIssue,
  CatalogBookMetadataState,
  CatalogFilterOption,
  CatalogProfile,
  EditableBookMetadata,
} from "./catalog-client";
import {
  bookAuthor,
  bookPublishedYear,
  booksForKindleView,
  countLibraryBooks,
  effectiveKindleStatus,
  formatCatalogBytes,
  hasActiveCatalogFilters,
  type LibraryFilters,
  type LibraryView,
} from "./library-prototype";
import type { LibraryFolderDraft, LibrarySettingsDraft } from "./library-settings-prototype";
import type { AppState } from "./state";
import { libraryIcon } from "./library-icons";
import { describeKindleReadingPresentation } from "./kindle/reading-presentation";
import { renderRecordedReadingData } from "./recorded-reading-view";
import {
  actualDeviceConnected,
  bookActionCapabilities,
  bulkBookActionCapabilities,
  currentKindleComparison,
  deviceConnecting,
  deviceReadyToSend,
} from "./book-action-capabilities";
import { buildSendQueueReview } from "./send-queue";
import { canonicalSeriesKey } from "./series-browser";
import { BUILT_IN_SMART_SHELVES, orderedPinnedSmartShelves } from "./smart-shelves";
import { buildMetadataCandidateDiff, type MetadataCandidateField } from "./metadata-candidates";
import {
  buildKindleBridgeActivityHistory,
  projectKindleBridgeActivityCenter,
  type KindleBridgeActivityEvent,
} from "./activity-center";

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sameOriginCoverUrl(book: CatalogBook): string | undefined {
  if (!book.coverUrl) return undefined;
  try {
    const base = typeof window === "undefined" ? "http://127.0.0.1" : window.location.href;
    const url = new URL(book.coverUrl, base);
    const origin = new URL(base).origin;
    if (url.origin !== origin || !url.pathname.startsWith("/api/profiles/")) return undefined;
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

function sameOriginMetadataImageUrl(value: string | null | undefined, revision?: number): string | undefined {
  if (!value) return undefined;
  try {
    const base = typeof window === "undefined" ? "http://127.0.0.1" : window.location.href;
    const url = new URL(value, base);
    if (url.origin !== new URL(base).origin || !url.pathname.startsWith("/api/profiles/")) return undefined;
    if (revision !== undefined) url.searchParams.set("v", String(revision));
    return `${url.pathname}${url.search}`;
  } catch {
    return undefined;
  }
}

function coverClass(bookId: string): string {
  const choices = ["cover-terracotta", "cover-night", "cover-moss", "cover-sea", "cover-rose", "cover-plum", "cover-sand", "cover-cobalt", "cover-crimson", "cover-meadow"];
  let hash = 0;
  for (const character of bookId) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return choices[hash % choices.length];
}

function activeProfile(snapshot: CatalogBrowserSnapshot): CatalogProfile | undefined {
  return snapshot.profiles.find((profile) => profile.id === snapshot.filters.profileId && profile.enabled);
}

function deviceDisconnecting(state: AppState): boolean {
  return state.device.kind === "recovering";
}

function renderProfileRail(snapshot: CatalogBrowserSnapshot): string {
  const enabled = snapshot.profiles.filter((profile) => profile.enabled);
  if (enabled.length === 0) return '<p class="library-sidebar-empty">No enabled libraries</p>';
  return enabled.map((profile) => `
    <button type="button" class="library-profile${profile.id === snapshot.filters.profileId ? " active" : ""}" data-ui-profile="${escapeHtml(profile.id)}" aria-label="Switch to ${escapeHtml(profile.name)}, ${profile.bookCount.toLocaleString()} ${profile.bookCount === 1 ? "book" : "books"}"${profile.id === snapshot.filters.profileId ? ' aria-current="true"' : ""}>
      <span class="library-avatar" aria-hidden="true">${escapeHtml(profile.initial)}</span>
      <span><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(profile.sourceLabel)} · ${profile.bookCount.toLocaleString()} ${profile.bookCount === 1 ? "book" : "books"}</small></span>
    </button>
  `).join("");
}

function renderLibraryNav(snapshot: CatalogBrowserSnapshot): string {
  const profile = activeProfile(snapshot);
  const counts = countLibraryBooks(
    profile,
    snapshot.page,
    snapshot.kindleStatus,
    snapshot.kindleStatusCountsByProfile,
  );
  const items: ReadonlyArray<readonly [LibraryView, string, string, number | undefined]> = [
    ["all", libraryIcon("book"), "All books", profile?.bookCount ?? 0],
    ["on-kindle", libraryIcon("device"), "On Kindle", counts.onKindle || undefined],
    ["recent", libraryIcon("clock"), "Recently added", undefined],
    ["series", libraryIcon("series"), "Series", snapshot.seriesPage?.total],
    ["attention", libraryIcon("attention"), "Needs attention", snapshot.healthPage?.counts.active || undefined],
  ];
  return items.map(([view, icon, label, count]) => `
    <button type="button" class="library-nav-item${snapshot.filters.view === view ? " active" : ""}${view === "settings" ? " settings" : ""}" data-ui-view="${view}"${snapshot.filters.view === view ? ' aria-current="page"' : ""}>
      <span class="library-nav-icon" aria-hidden="true">${icon}</span>
      <span>${escapeHtml(label)}</span>
      ${count === undefined ? "" : `<span class="library-nav-count">${count}</span>`}
    </button>
  `).join("");
}

function renderSmartShelfRail(snapshot: CatalogBrowserSnapshot): string {
  const custom = orderedPinnedSmartShelves(snapshot.smartShelves ?? []);
  const shelves = [...BUILT_IN_SMART_SHELVES, ...custom];
  return `<div class="library-sidebar-label library-shelves-label">Your shelves</div><nav class="library-shelf-list" aria-label="Smart shelves">${shelves.map((shelf) => {
    const active = snapshot.activeShelf?.id === shelf.id;
    const count = "serverCount" in shelf ? shelf.serverCount : null;
    return `<button type="button" class="library-shelf-item${active ? " active" : ""}" data-ui-action="apply-smart-shelf" data-shelf-id="${escapeHtml(shelf.id)}"${active ? ' aria-current="page"' : ""}><span aria-hidden="true">${libraryIcon(shelf.id === "builtin-favorites" ? "heart" : shelf.id === "builtin-want-to-read" ? "bookmark" : shelf.id === "builtin-read-books" ? "check" : "book")}</span><span>${escapeHtml(shelf.name)}</span>${count === null ? "" : `<small>${count}</small>`}</button>`;
  }).join("")}<button type="button" class="library-shelf-item manage" data-ui-action="manage-smart-shelves"><span aria-hidden="true">＋</span><span>Manage shelves</span></button></nav>`;
}

function renderActiveShelf(snapshot: CatalogBrowserSnapshot): string {
  const shelf = snapshot.activeShelf;
  if (!shelf) return "";
  return `<div class="library-active-shelf" role="status"><span><strong>${escapeHtml(shelf.name)}</strong><small>${shelf.builtIn ? "Built-in smart shelf" : "Saved smart shelf"}</small></span><button type="button" data-ui-action="clear-smart-shelf">Show all books</button></div>`;
}

function renderOptions(options: readonly CatalogFilterOption[], current: string, allLabel: string): string {
  return [`<option value="all">${escapeHtml(allLabel)}</option>`, ...options.map((option) => (
    `<option value="${escapeHtml(option.value)}"${option.value === current ? " selected" : ""}>${escapeHtml(option.label)}${option.count === undefined ? "" : ` (${option.count})`}</option>`
  ))].join("");
}

function renderDatalist(id: string, options: readonly CatalogFilterOption[]): string {
  return `<datalist id="${id}">${options.map((option) => (
    `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}${option.count === undefined ? "" : ` (${option.count})`}</option>`
  )).join("")}</datalist>`;
}

function optionLabel(options: readonly CatalogFilterOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function renderActiveFilters(snapshot: CatalogBrowserSnapshot): string {
  const ui = snapshot.filters;
  const facets = snapshot.facets;
  const values = [
    ui.author === "all" ? "" : optionLabel(facets.authors, ui.author),
    ui.language === "all" ? "" : optionLabel(facets.languages, ui.language),
    ui.subject === "all" ? "" : optionLabel(facets.subjects, ui.subject),
    ui.publisher === "all" ? "" : optionLabel(facets.publishers, ui.publisher),
    ui.series === "all" ? "" : optionLabel(facets.series, ui.series),
    ui.format === "all" ? "" : optionLabel(facets.formats, ui.format),
    ui.rootId === "all" ? "" : optionLabel(facets.roots, ui.rootId),
    ui.year === "all" ? "" : `Published ${optionLabel(facets.years, ui.year)}`,
    ui.metadata === "all" ? "" : ui.metadata === "complete" ? "Complete metadata" : "Missing metadata",
    ui.kindle === "all" ? "" : ui.kindle === "on-kindle" ? "On Kindle" : ui.kindle === "possible" ? "Possible match" : ui.kindle === "unknown" ? "Not yet compared" : "Not on Kindle",
    ui.query.trim() ? `“${ui.query.trim()}”` : "",
  ].filter(Boolean);
  if (values.length === 0) return "";
  return `<div class="library-active-filters" aria-label="Active filters">${values.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}<button type="button" data-ui-action="clear-filters">Clear all</button></div>`;
}

function renderBookCover(
  book: CatalogBook,
  status: ReturnType<typeof effectiveKindleStatus>,
  currentUnknown: boolean,
): string {
  const coverUrl = sameOriginCoverUrl(book);
  const badge = status === "confirmed"
    ? '<span class="library-kindle-check" role="img" aria-label="Already on this Kindle" title="Already on this Kindle">✓</span>'
    : currentUnknown
        ? '<span class="library-kindle-check unknown" role="img" aria-label="Kindle presence could not be verified" title="Kindle presence could not be verified">!</span>'
      : "";
  if (coverUrl) {
    return `<div class="library-cover library-cover-image ${coverClass(book.id)}"><img src="${escapeHtml(coverUrl)}" alt="" loading="lazy" data-library-cover-image /><span class="library-cover-kicker" data-library-cover-fallback hidden aria-hidden="true">${book.metadataComplete ? escapeHtml(book.format) : "Metadata incomplete"}</span><strong data-library-cover-fallback hidden aria-hidden="true">${escapeHtml(book.title)}</strong><span class="library-cover-author" data-library-cover-fallback hidden aria-hidden="true">${escapeHtml(bookAuthor(book))}</span><span class="library-cover-rule" data-library-cover-fallback hidden aria-hidden="true"></span>${badge}</div>`;
  }
  return `<div class="library-cover ${coverClass(book.id)}" aria-hidden="true"><span class="library-cover-kicker">${book.metadataComplete ? escapeHtml(book.format) : "Metadata incomplete"}</span><strong>${escapeHtml(book.title)}</strong><span class="library-cover-author">${escapeHtml(bookAuthor(book))}</span><span class="library-cover-rule"></span>${badge}</div>`;
}

function renderBookMenu(
  book: CatalogBook,
  snapshot: CatalogBrowserSnapshot,
  state: AppState,
): string {
  const actions = bookActionCapabilities(book, state, snapshot);
  const reviewItem = snapshot.kindleInventory?.items.find((item) =>
    item.bookId === book.id || item.candidates?.some((candidate) => candidate.bookId === book.id));
  const reviewItemId = reviewItem?.id ?? catalogPossibleMatchReviewId(book.id);
  const updateAction = book.metadataEdited || book.coverEdited
    ? `<button type="button" data-ui-action="update-book-on-kindle" data-book-id="${escapeHtml(book.id)}"${actions.update.enabled ? "" : ` disabled title="${escapeHtml(actions.update.reason ?? "Unavailable")}"`}>Update Kindle copy</button>`
    : "";
  return `<details class="library-book-menu"><summary aria-label="More actions for ${escapeHtml(book.title)}" title="More actions"><span aria-hidden="true">•••</span></summary><div>${actions.kindleStatus === "possible" ? `<button type="button" data-ui-action="open-match-review" data-item-id="${escapeHtml(reviewItemId)}" data-book-id="${escapeHtml(book.id)}"${actions.matchReview.enabled ? "" : ` disabled title="${escapeHtml(actions.matchReview.reason ?? "Unavailable")}"`}>Review possible match</button>` : ""}${updateAction}<button type="button" data-ui-action="add-book-to-queue" data-book-id="${escapeHtml(book.id)}"${actions.queue.enabled ? "" : ` disabled title="${escapeHtml(actions.queue.reason ?? "Unavailable")}"`}>${escapeHtml(actions.queue.label)}</button><button type="button" data-ui-action="toggle-book-favorite" data-book-id="${escapeHtml(book.id)}" aria-pressed="${actions.favorite.active}"${actions.favorite.enabled ? "" : " disabled"}>${actions.favorite.active ? "★ Favorite" : "☆ Favorite"}</button><button type="button" data-ui-action="toggle-book-want-to-read" data-book-id="${escapeHtml(book.id)}" aria-pressed="${actions.wantToRead.active}"${actions.wantToRead.enabled ? "" : " disabled"}>${actions.wantToRead.active ? "✓ Want to read" : "+ Want to read"}</button><button type="button" data-ui-action="edit-book-metadata" data-book-id="${escapeHtml(book.id)}"${actions.edit.enabled ? "" : ` disabled title="${escapeHtml(actions.edit.reason ?? "Unavailable")}"`}>Edit metadata &amp; cover</button><button type="button" class="danger" data-ui-action="remove-book-from-kindle" data-book-id="${escapeHtml(book.id)}"${actions.remove.enabled ? "" : ` disabled title="${escapeHtml(actions.remove.reason ?? "Unavailable")}"`}>Remove from Kindle</button></div></details>`;
}

export function renderBookReading(bookId: string, snapshot: CatalogBrowserSnapshot): string {
  const evidence = snapshot.readingEvidence?.get(bookId);
  const descriptor = describeKindleReadingPresentation({
    gate: { version: 1, enabled: snapshot.readingEnabled === true },
    layout: snapshot.layout,
    evidence,
  });
  if (descriptor.visibility === "hidden") return "";
  const progress = descriptor.progress;
  return `<div class="library-reading" aria-label="Reading information">${progress.kind === "known"
    ? `<div class="library-reading-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.valueNow}" aria-label="${escapeHtml(progress.accessibleLabel)}"><span style="width:${progress.valueNow}%"></span></div><small>${evidence?.freshness === "last-seen" ? "Last seen: " : ""}${escapeHtml(progress.text)} read</small>`
    : `<small role="status">${escapeHtml(progress.accessibleLabel)}</small>`}${descriptor.stateIndicator ? `<span class="library-reading-state"><span aria-hidden="true">${descriptor.stateIndicator.state === "read" ? "▣" : "▤"}</span> ${escapeHtml(descriptor.stateIndicator.accessibleLabel)}</span>` : ""}</div>`;
}

function renderBookCard(book: CatalogBook, snapshot: CatalogBrowserSnapshot, state: AppState): string {
  const actions = bookActionCapabilities(book, state, snapshot);
  const status = actions.kindleStatus;
  const confirmed = status === "confirmed";
  const currentUnknown = status === "unknown" && actions.currentComparison;
  const list = snapshot.layout === "list";
  const selected = list && snapshot.selectedBookIds.has(book.id);
  const disconnectedQueuePrimary = !actualDeviceConnected(state) && (actions.queue.enabled || actions.queue.queued);
  const primaryAction = disconnectedQueuePrimary ? "add-book-to-queue" : "send-book";
  const primaryEnabled = disconnectedQueuePrimary ? actions.queue.enabled : actions.send.enabled;
  const primaryLabel = disconnectedQueuePrimary ? actions.queue.label : actions.send.label;
  const primaryReason = disconnectedQueuePrimary ? actions.queue.reason : actions.send.reason;
  const possibleItem = status === "possible"
    ? snapshot.kindleInventory?.items.find((item) => item.bookId === book.id
      || item.candidates?.some((candidate) => candidate.bookId === book.id))
    : undefined;
  const possibleBadge = status === "possible"
    ? `<button type="button" class="library-kindle-check possible" data-ui-action="open-match-review" data-item-id="${escapeHtml(possibleItem?.id ?? catalogPossibleMatchReviewId(book.id))}" data-book-id="${escapeHtml(book.id)}" aria-label="Review possible Kindle match for ${escapeHtml(book.title)}" title="${escapeHtml(actions.matchReview.reason ?? "Review possible Kindle match")}"${actions.matchReview.enabled ? "" : " disabled"}>?</button>`
    : "";
  return `
    <article class="library-book-card${list ? " library-book-row" : ""}${selected ? " selected" : ""}" data-book-id="${escapeHtml(book.id)}"${selected ? ' data-selected="true"' : ""}>
      ${list ? `<label class="library-book-selection"><input type="checkbox" data-ui-action="toggle-book-selection" data-book-id="${escapeHtml(book.id)}" aria-label="Select ${escapeHtml(book.title)}"${selected ? " checked" : ""}${actions.select.enabled ? "" : " disabled"} /><span aria-hidden="true"></span></label>` : ""}
      <div class="library-book-cover-shell"><button type="button" class="library-book-cover-trigger" data-ui-action="open-book-details" data-book-id="${escapeHtml(book.id)}" aria-label="View details for ${escapeHtml(book.title)}">${renderBookCover(book, status, currentUnknown)}</button>${possibleBadge}${list ? "" : renderBookReading(book.id, snapshot)}</div>
      <div class="library-card-copy">
        <h3><button type="button" class="library-book-title-trigger" data-ui-action="open-book-details" data-book-id="${escapeHtml(book.id)}">${escapeHtml(book.title)}</button></h3>
        <p>${escapeHtml(bookAuthor(book))}</p>
        ${list ? renderBookReading(book.id, snapshot) : ""}
        <div class="library-book-meta"><span>${escapeHtml(bookPublishedYear(book))}</span><span>${escapeHtml(book.format.toLocaleUpperCase())}</span><span>${escapeHtml(formatCatalogBytes(book.size))}</span></div>
        <div class="library-tags">${actions.favorite.active ? "<span>★ Favorite</span>" : ""}${actions.wantToRead.active ? "<span>Want to read</span>" : ""}${book.subjects.slice(0, 2).map((subject) => `<span>${escapeHtml(subject)}</span>`).join("")}${book.series ? `<button type="button" data-ui-action="open-series" data-series-key="${escapeHtml(canonicalSeriesKey(book.series))}" title="Open ${escapeHtml(book.series)} in reading order">${escapeHtml(book.series)}</button>` : ""}${book.metadataEdited ? "<span>Metadata edited</span>" : ""}${book.coverEdited ? "<span>Custom cover</span>" : ""}${status === "possible" ? "<span>Possible Kindle match</span>" : ""}${currentUnknown ? "<span>Kindle presence unknown</span>" : ""}</div>
      </div>
      <div class="library-card-actions"><button type="button" class="library-send-button${confirmed ? " installed" : ""}${disconnectedQueuePrimary ? " queue" : ""}" data-ui-action="${primaryAction}" data-book-id="${escapeHtml(book.id)}"${primaryEnabled ? "" : ` disabled title="${escapeHtml(primaryReason ?? "Unavailable")}"`}>${libraryIcon(confirmed ? "check" : disconnectedQueuePrimary ? "queue" : "send")}<span>${escapeHtml(primaryLabel)}</span></button>${renderBookMenu(book, snapshot, state)}</div>
    </article>
  `;
}

function renderLayoutControls(snapshot: CatalogBrowserSnapshot): string {
  const disabled = snapshot.sendBusy || snapshot.bulkActionBusy ? " disabled" : "";
  const density = snapshot.density ?? "comfortable";
  return `<div class="library-display-controls"><div class="library-layout-toggle" role="group" aria-label="Book layout"><button type="button" data-ui-action="set-library-layout" data-layout="grid" aria-pressed="${snapshot.layout === "grid"}" aria-label="Grid view" title="Grid view"${disabled}>${libraryIcon("grid")}</button><button type="button" data-ui-action="set-library-layout" data-layout="list" aria-pressed="${snapshot.layout === "list"}" aria-label="List view" title="List view"${disabled}>${libraryIcon("list")}</button></div><div class="library-layout-toggle library-density-toggle" role="group" aria-label="Book density"><button type="button" data-ui-action="set-library-density" data-density="comfortable" aria-pressed="${density === "comfortable"}" aria-label="Comfortable density" title="Comfortable"${disabled}><span aria-hidden="true">↕</span></button><button type="button" data-ui-action="set-library-density" data-density="compact" aria-pressed="${density === "compact"}" aria-label="Compact density" title="Compact"${disabled}><span aria-hidden="true">≡</span></button></div></div>`;
}

function renderBulkActions(
  books: readonly CatalogBook[],
  snapshot: CatalogBrowserSnapshot,
  state: AppState,
): string {
  const selected = books.filter((book) => snapshot.selectedBookIds.has(book.id));
  const selectedCount = selected.length;
  const allSelected = books.length > 0 && selectedCount === books.length;
  const busy = snapshot.bulkActionBusy || snapshot.sendBusy || snapshot.sendQueueBusy;
  const bulk = bulkBookActionCapabilities(books, snapshot.selectedBookIds, state, snapshot);
  const sendableCount = bulk.send.count;
  const removableCount = bulk.remove.count;
  const canBulkSend = bulk.send.enabled;
  const canBulkRemove = bulk.remove.enabled;
  return `<div class="library-bulk-actions" role="toolbar" aria-label="Selected book actions"><div class="library-bulk-selection"><strong>${snapshot.selectedBookIds.size}</strong> selected</div><button type="button" data-ui-action="select-visible-books" aria-pressed="${allSelected}"${busy || books.length === 0 ? " disabled" : ""}>${allSelected ? "Deselect page" : "Select visible"}</button><button type="button" data-ui-action="select-all-filtered"${busy ? " disabled" : ""}>Select all filtered</button><button type="button" data-ui-action="select-all-filtered-missing"${busy ? " disabled" : ""}>Select all missing</button><button type="button" data-ui-action="clear-book-selection"${busy || snapshot.selectedBookIds.size === 0 ? " disabled" : ""}>Clear</button><span class="library-bulk-spacer"></span><label class="library-bulk-provider"><span class="sr-only">Metadata provider</span><select id="bulk-metadata-provider"${busy || snapshot.selectedBookIds.size === 0 ? " disabled" : ""}><option value="open-library">Open Library</option><option value="google-books">Google Books</option></select></label><button type="button" data-ui-action="bulk-find-metadata"${busy || snapshot.selectedBookIds.size === 0 || snapshot.selectedBookIds.size > 100 ? " disabled" : ""}>Find metadata</button><button type="button" data-ui-action="bulk-add-to-queue"${busy || snapshot.selectedBookIds.size === 0 ? " disabled" : ""}>Send later <span>${snapshot.selectedBookIds.size}</span></button><button type="button" class="primary" data-ui-action="bulk-send-to-kindle" data-book-count="${sendableCount}"${canBulkSend ? "" : ` disabled title="${escapeHtml(bulk.send.reason ?? "Unavailable")}"`}>Send to Kindle <span aria-label="${sendableCount} eligible">${sendableCount}</span></button><button type="button" class="danger" data-ui-action="bulk-remove-from-kindle" data-book-count="${removableCount}"${canBulkRemove ? "" : ` disabled title="${escapeHtml(bulk.remove.reason ?? "Unavailable")}"`}>Remove from Kindle <span aria-label="${removableCount} eligible">${removableCount}</span></button></div>`;
}

function renderPagination(snapshot: CatalogBrowserSnapshot): string {
  const page = snapshot.page;
  if (!page || page.total <= page.limit) return "";
  const start = page.total === 0 ? 0 : page.offset + 1;
  const end = Math.min(page.total, page.offset + page.items.length);
  return `<nav class="library-pagination" aria-label="Catalog pages"><button type="button" data-ui-action="catalog-page" data-page-offset="${Math.max(0, page.offset - page.limit)}"${page.offset === 0 ? " disabled" : ""}>Previous</button><span>${start}–${end} of ${page.total}</span><button type="button" data-ui-action="catalog-page" data-page-offset="${page.offset + page.limit}"${page.offset + page.limit >= page.total ? " disabled" : ""}>Next</button></nav>`;
}

function resultsEmptyCopy(snapshot: CatalogBrowserSnapshot): readonly [string, string] {
  const profile = activeProfile(snapshot);
  if ((profile?.bookCount ?? 0) === 0 && !hasActiveCatalogFilters(snapshot.filters)) {
    return ["No books indexed yet", "Add a supported book to an enabled container folder or check the source in Settings."];
  }
  const activeShelfNeedsKindle = snapshot.activeShelf?.query.kindleStatus !== undefined;
  const hasCurrentProfileComparison = profile !== undefined
    && snapshot.kindleStatusCountsByProfile.has(profile.id);
  if (activeShelfNeedsKindle && !hasCurrentProfileComparison) {
    return ["Connect to compare", "Connect and scan a Kindle to evaluate this smart shelf for the current library."];
  }
  if (snapshot.filters.view === "on-kindle") {
    return ["No Kindle matches yet", "Connect and scan a Kindle to compare its Documents with this library."];
  }
  return ["No books found", "Try a different search or clear your filters."];
}

export function renderLibraryResults(state: AppState, snapshot: CatalogBrowserSnapshot): string {
  const enabledProfile = snapshot.profiles.find((profile) => profile.enabled);
  if (!enabledProfile) {
    const configured = snapshot.profiles.length > 0;
    return `<div class="library-empty-state"><span aria-hidden="true">${configured ? "○" : "+"}</span><h2>${configured ? "No library enabled" : "No library configured"}</h2><p>${configured ? "Enable a household library in Settings to browse its books." : "Create a household library and add a container-mounted folder in Settings."}</p><button type="button" data-ui-view="settings">Open Settings</button></div>`;
  }
  if (snapshot.booksState === "loading" && !snapshot.page) {
    return `<div class="library-loading-state" role="status"><span aria-hidden="true"></span><strong>Loading this library…</strong><small>Reading catalog metadata and covers</small></div>`;
  }
  if (snapshot.booksState === "error" && !snapshot.page) {
    return `<div class="library-empty-state library-error-state" role="alert"><span aria-hidden="true">!</span><h2>Library unavailable</h2><p>${escapeHtml(snapshot.error ?? "The catalog service could not load this library.")}</p><button type="button" data-ui-action="retry-catalog">Try again</button></div>`;
  }
  const page = snapshot.page;
  const books = booksForKindleView(page?.items ?? [], snapshot.filters, snapshot.kindleStatus);
  const summary = snapshot.filters.view === "on-kindle"
    ? `<strong>${books.length}</strong> matched items in these results`
    : `<strong>${page?.total ?? 0}</strong> books`;
  const [emptyTitle, emptyMessage] = resultsEmptyCopy(snapshot);
  return `
    ${snapshot.stale ? `<div class="library-stale-notice" role="status"><strong>Catalog temporarily unavailable.</strong> Showing the most recent results in this browser. <button type="button" data-ui-action="retry-catalog">Retry</button></div>` : ""}
    <div class="library-results-head"><p>${summary}</p><div class="library-results-controls"><span>${snapshot.booksState === "loading" ? "Refreshing…" : snapshot.filters.view === "on-kindle" ? "Device comparison" : snapshot.layout === "list" ? "List view" : "Cover grid"}</span>${renderLayoutControls(snapshot)}</div></div>
    ${renderActiveFilters(snapshot)}
    ${snapshot.readingHistoryError ? `<p role="alert">Read books could not be fully saved: ${escapeHtml(snapshot.readingHistoryError)} Reconnect to retry.</p>` : ""}
    ${snapshot.activeShelf?.id === "builtin-read-books" ? `<p class="library-reading-note">Books confirmed Read on your Kindle stay here after disconnecting or removing the Kindle copy.${snapshot.readingEnabled ? "" : " Automatic reading detection is awaiting physical Kindle validation; no completion is inferred from percentage alone."}</p>` : ""}
    ${books.length > 0 ? `${snapshot.layout === "list" ? renderBulkActions(books, snapshot, state) : ""}<div class="library-book-grid${snapshot.layout === "list" ? " library-book-list" : ""}" data-layout="${snapshot.layout}">${books.map((book) => renderBookCard(book, snapshot, state)).join("")}</div>${renderPagination(snapshot)}` : `
      <div class="library-empty-state"><span aria-hidden="true">⌕</span><h2>${escapeHtml(emptyTitle)}</h2><p>${escapeHtml(emptyMessage)}</p>${hasActiveCatalogFilters(snapshot.filters) ? '<button type="button" data-ui-action="clear-filters">Clear filters</button>' : ""}</div>
    `}
  `;
}

function renderSeriesBrowser(snapshot: CatalogBrowserSnapshot, state: AppState): string {
  const detail = snapshot.seriesDetail;
  if (snapshot.seriesState === "loading" && !detail) {
    return '<div class="library-loading-state" role="status"><span></span><strong>Loading series…</strong><small>Ordering volumes by series number</small></div>';
  }
  if (detail) {
    const profileId = snapshot.filters.profileId;
    const comparisonComplete = profileId !== undefined
      && snapshot.kindleInventory?.completeness === "complete"
      && snapshot.kindleInventory.matching?.status === "complete"
      && snapshot.kindleStatusCountsByProfile.has(profileId);
    const queueable = detail.books.items.filter((book) => bookActionCapabilities(book, state, snapshot).queue.enabled);
    const missing = queueable.filter((book) => snapshot.kindleStatus.get(book.id) === "not-on-kindle");
    const seriesQueueable = comparisonComplete ? missing : queueable;
    const hints = [
      detail.duplicateIndices.length ? `Duplicate volume numbers: ${detail.duplicateIndices.join(", ")}` : "",
      detail.missingIntegerIndices.length ? `Numbering gaps: ${detail.missingIntegerIndices.join(", ")}` : "",
      detail.unnumberedCount ? `${detail.unnumberedCount} unnumbered ${detail.unnumberedCount === 1 ? "book" : "books"}` : "",
    ].filter(Boolean);
    return `<section class="series-detail"><button type="button" data-ui-action="close-series">← All series</button><header><div><span class="library-eyebrow">Series</span><h1>${escapeHtml(detail.name)}</h1><p>${detail.books.total} ${detail.books.total === 1 ? "volume" : "volumes"}, ordered by series number</p></div><div class="series-queue-actions"><button type="button" data-ui-action="queue-series" data-mode="next"${seriesQueueable.length === 0 ? " disabled" : ""}>Send next later</button><button type="button" class="primary" data-ui-action="queue-series" data-mode="all"${seriesQueueable.length === 0 ? " disabled" : ""}>Send all ${seriesQueueable.length} ${comparisonComplete ? "missing" : "eligible"} later</button></div></header>${!comparisonComplete ? '<div class="library-stale-notice"><strong>Kindle absence is not known yet.</strong> You can queue this explicit series set now; every book will be checked against a fresh complete Kindle inventory before it is sent.</div>' : ""}${hints.length ? `<div class="series-quality-hints" role="note">${hints.map((hint) => `<span>${escapeHtml(hint)}</span>`).join("")}</div>` : ""}<ol class="series-book-list">${detail.books.items.map((book) => {
      const actions = bookActionCapabilities(book, state, snapshot);
      const number = book.seriesIndex === undefined ? "—" : String(book.seriesIndex);
      const sourceRoot = snapshot.rootsByProfile.get(book.profileId)?.find(({ id }) => id === book.rootId);
      const rowQueueEnabled = actions.queue.enabled && (!comparisonComplete || actions.kindleStatus === "not-on-kindle");
      const rowQueueReason = comparisonComplete && actions.kindleStatus !== "not-on-kindle"
        ? "Only a book confirmed missing by the current Kindle comparison can be queued here"
        : actions.queue.reason;
      return `<li><span class="series-volume">${escapeHtml(number)}</span><button type="button" class="series-book-cover" data-ui-action="open-book-details" data-book-id="${escapeHtml(book.id)}" aria-label="View details for ${escapeHtml(book.title)}">${renderBookCover(book, actions.kindleStatus, actions.kindleStatus === "unknown" && actions.currentComparison)}</button><div class="series-book-copy"><button type="button" class="series-book-title" data-ui-action="open-book-details" data-book-id="${escapeHtml(book.id)}"><strong>${escapeHtml(book.title)}</strong><small>${escapeHtml(bookAuthor(book))}</small></button><p class="series-book-description">${escapeHtml(book.description?.trim() || "No description available.")}</p><span class="series-source-state" data-available="${actions.sourceAvailable}">${actions.sourceAvailable ? "Source available" : "Source unavailable"}${sourceRoot ? ` · ${escapeHtml(sourceRoot.label)}` : ""}</span></div><div class="series-book-actions"><span class="library-device-match" data-match="${escapeHtml(actions.kindleStatus)}">${actions.kindleStatus === "confirmed" ? "✓ On Kindle" : actions.kindleStatus === "possible" ? "Possible" : actions.kindleStatus === "not-on-kindle" ? "Missing" : "Unknown"}</span><button type="button" data-ui-action="edit-book-metadata" data-book-id="${escapeHtml(book.id)}"${actions.edit.enabled ? "" : ` disabled title="${escapeHtml(actions.edit.reason ?? "Unavailable")}"`}>Edit metadata</button><button type="button" data-ui-action="add-book-to-queue" data-book-id="${escapeHtml(book.id)}"${rowQueueEnabled ? "" : ` disabled title="${escapeHtml(rowQueueReason ?? "Unavailable")}"`}>${escapeHtml(actions.queue.label)}</button></div></li>`;
    }).join("")}</ol></section>`;
  }
  const page = snapshot.seriesPage;
  const seriesItems = [...(page?.items ?? [])].sort((left, right) => snapshot.seriesSort === "count"
    ? right.bookCount - left.bookCount || left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
    : left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true }));
  return `<section class="series-browser"><header><div><span class="library-eyebrow">Browse in order</span><h1>Series</h1><p>Open a series to find gaps, duplicates, and the next volume missing from a Kindle.</p></div><div class="series-browser-controls"><label><span class="sr-only">Search series</span><input id="series-search" type="search" value="${escapeHtml(snapshot.seriesQuery)}" placeholder="Search series…" autocomplete="off" /></label><label><span class="sr-only">Sort series</span><select id="series-sort" aria-label="Sort series"><option value="name"${snapshot.seriesSort === "name" ? " selected" : ""}>Series name</option><option value="count"${snapshot.seriesSort === "count" ? " selected" : ""}>Most books</option></select></label></div></header>${snapshot.seriesState === "error" ? `<div class="library-stale-notice"><strong>Series unavailable.</strong> ${escapeHtml(snapshot.error ?? "Try again.")}</div>` : ""}<div class="series-card-grid">${seriesItems.map((series) => `<button type="button" data-ui-action="open-series" data-series-key="${escapeHtml(series.key)}"><span aria-hidden="true">≋</span><strong>${escapeHtml(series.name)}</strong><small>${series.bookCount} books · ${series.numberedCount} numbered${series.unnumberedCount ? ` · ${series.unnumberedCount} unnumbered` : ""}</small></button>`).join("") || '<div class="library-empty-state compact"><span aria-hidden="true">≋</span><h2>No series found</h2><p>Series metadata appears here as books are indexed or edited.</p></div>'}</div></section>`;
}

function relativeScanTime(value: string | undefined): string {
  if (!value) return "not scanned yet";
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "recently";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function folderHealth(folder: LibraryFolderDraft): string {
  if (!folder.enabled) return "Folder disabled";
  if (!folder.path.trim()) return "Path not set";
  if (folder.status === "pending" || folder.status === "unknown") return "Not checked";
  if (folder.status === "scanning") return "Scanning source…";
  if (folder.status === "permission-denied") return "Permission denied";
  if (folder.status === "unavailable") return `Source unavailable · last scan ${relativeScanTime(folder.lastScanAt)}`;
  if (folder.status === "error") return folder.lastErrorCode ? `Source error · ${folder.lastErrorCode}` : "Source error";
  if (folder.lastErrorCode === "watch_unavailable" || (folder.watchForChanges && folder.status === "paused")) {
    return "Available · automatic watch unavailable; scheduled checks continue";
  }
  if (folder.lastErrorCode) return `Available with source errors · ${folder.lastErrorCode}`;
  if (!folder.watchForChanges) return "Available · watch paused";
  if (folder.status === "available") return "Available · scheduled checks active";
  return `Watching · last scan ${relativeScanTime(folder.lastScanAt)}`;
}

function renderSettingsLibraryList(snapshot: CatalogBrowserSnapshot): string {
  return snapshot.profiles.map((profile) => `
    <button type="button" class="settings-library-option${profile.id === snapshot.settingsLibraryId ? " active" : ""}" data-settings-library-id="${escapeHtml(profile.id)}"${profile.id === snapshot.settingsLibraryId ? ' aria-current="page"' : ""}${snapshot.settingsSaving || snapshot.settingsRefreshing ? " disabled" : ""}>
      <span class="library-avatar" aria-hidden="true">${escapeHtml(profile.initial)}</span>
      <span><strong>${escapeHtml(profile.name)}</strong><small>${profile.availableRootCount} available · ${profile.rootCount} configured · ${profile.enabled ? "Enabled" : "Hidden"}</small></span>
      <span class="settings-library-chevron" aria-hidden="true">›</span>
    </button>
  `).join("");
}

function renderSettingsFolder(folder: LibraryFolderDraft, index: number, folderCount: number, snapshot: CatalogBrowserSnapshot, locked: boolean): string {
  const rescanning = snapshot.rescanningRootIds.has(folder.id);
  const editsDisabled = locked || snapshot.settingsSaving || snapshot.settingsRefreshing || snapshot.settingsConflict;
  return `
    <fieldset class="settings-folder-card" data-settings-folder-id="${escapeHtml(folder.id)}" data-settings-folder-persisted="${folder.persisted}">
      <legend>Folder ${index + 1}</legend>
      <div class="settings-folder-head"><span class="settings-health" data-health="${escapeHtml(folder.status)}"><span aria-hidden="true"></span>${escapeHtml(folderHealth(folder))}</span><span class="settings-folder-controls">${folder.persisted ? `<button type="button" class="ghost" data-ui-action="rescan-settings-folder" data-folder-id="${escapeHtml(folder.id)}"${!folder.enabled || rescanning || snapshot.settingsSaving || snapshot.settingsRefreshing ? " disabled" : ""}${!folder.enabled ? ' title="Enable and save this folder before checking it"' : ""}>${rescanning ? "Starting scan…" : "Check source"}</button>` : ""}<button type="button" class="ghost danger" data-ui-action="remove-settings-folder" data-folder-id="${escapeHtml(folder.id)}"${folderCount === 1 || editsDisabled ? " disabled" : ""}>Remove folder</button></span></div>
      <div class="settings-fields-grid">
        <label class="settings-field"><span>Folder label</span><input id="settings-folder-label-${escapeHtml(folder.id)}" data-settings-folder-label value="${escapeHtml(folder.label)}" placeholder="e.g. Husband library" autocomplete="off"${editsDisabled ? " disabled" : ""} /></label>
        <label class="settings-field settings-path-field"><span>Container folder path</span><input id="settings-folder-path-${escapeHtml(folder.id)}" data-settings-folder-path value="${escapeHtml(folder.path)}" placeholder="/libraries/husbandlibrary" spellcheck="false" autocomplete="off"${editsDisabled ? " disabled" : ""} /><small>Enter the absolute path mounted inside the ShelfSend container, not a host path or smb:// address.</small></label>
        <label class="settings-field settings-sentinel-field"><span>Mount sentinel file <em>optional</em></span><input id="settings-folder-sentinel-${escapeHtml(folder.id)}" data-settings-folder-sentinel value="${escapeHtml(folder.sentinel)}" placeholder=".kindle-bridge-volume" spellcheck="false" autocomplete="off"${editsDisabled ? " disabled" : ""} /><small>Relative marker file that must exist in this folder. It prevents an empty or wrong backing mount from looking healthy.</small></label>
      </div>
      <div class="settings-toggle-row">
        <label><input id="settings-folder-enabled-${escapeHtml(folder.id)}" type="checkbox" data-settings-folder-enabled${folder.enabled ? " checked" : ""}${editsDisabled ? " disabled" : ""} /><span><strong>Enable folder</strong><small>Include this source in the catalog</small></span></label>
        <label><input id="settings-folder-recursive-${escapeHtml(folder.id)}" type="checkbox" data-settings-folder-recursive${folder.includeSubfolders ? " checked" : ""}${folder.enabled && !editsDisabled ? "" : " disabled"} /><span><strong>Include subfolders</strong><small>Scan nested folders recursively</small></span></label>
        <label><input id="settings-folder-watch-${escapeHtml(folder.id)}" type="checkbox" data-settings-folder-watch${folder.watchForChanges ? " checked" : ""}${folder.enabled && !editsDisabled ? "" : " disabled"} /><span><strong>Watch for changes</strong><small>Index new and changed books automatically</small></span></label>
      </div>
    </fieldset>
  `;
}

function renderDeleteConfirmation(snapshot: CatalogBrowserSnapshot, draft: LibrarySettingsDraft): string {
  if (snapshot.confirmDeleteLibraryId !== draft.id) return "";
  return `<div class="settings-delete-confirmation" role="alertdialog" aria-labelledby="delete-library-title"><div><strong id="delete-library-title">Delete “${escapeHtml(draft.name)}”?</strong><span>This removes its catalog configuration. Original source files are not changed.</span></div><button type="button" data-ui-action="cancel-delete-library"${snapshot.settingsSaving ? " disabled" : ""}>Keep library</button><button type="button" class="danger" data-ui-action="confirm-delete-library"${snapshot.settingsSaving || snapshot.settingsRefreshing || snapshot.settingsConflict ? " disabled" : ""}>${snapshot.settingsSaving ? "Deleting…" : "Delete library"}</button></div>`;
}

function renderCoverProviderSettings(snapshot: CatalogBrowserSnapshot): string {
  const settings = snapshot.coverProviderSettings;
  const locked = snapshot.serviceStatus?.settingsMode === "read-only";
  if (!settings || settings.loadState === "idle") return "";
  if (settings.loadState === "loading") {
    return '<section class="settings-provider-card" aria-busy="true"><div><strong>Online cover search</strong><span>Loading provider status…</span></div></section>';
  }
  if (settings.loadState === "error" && !settings.googleBooks) {
    return `<section class="settings-provider-card error" role="status"><div><strong>Online cover search</strong><span>${escapeHtml(settings.error ?? "Provider settings unavailable.")}</span></div><button type="button" data-ui-action="retry-cover-provider-settings">Retry</button></section>`;
  }
  const provider = settings.googleBooks;
  const configured = provider?.configured === true;
  const status = !configured
    ? "Not configured"
    : provider.status === "working"
      ? "Working"
      : provider.errorCode === "invalid-or-restricted-key"
        ? "Key rejected or restricted"
        : provider.errorCode === "quota-exhausted"
          ? "Quota exhausted"
          : provider.errorCode === "provider-unavailable"
            ? "Provider unavailable"
            : provider.status === "error" ? "Test failed" : "Not tested";
  const tone = !configured ? "neutral" : provider?.status === "working" ? "ok" : provider?.status === "error" ? "error" : "warning";
  const disable = locked || settings.busy;
  return `<details class="settings-provider-card" data-status="${tone}"${settings.editing ? " open" : ""}><summary><span><strong>Online cover search</strong><small>Google Books API key</small></span><span class="settings-provider-status"><i aria-hidden="true"></i>${escapeHtml(status)}</span></summary><div class="settings-provider-body">${locked ? '<p>This server has locked Settings. Provider credentials can only be viewed here.</p>' : settings.editing ? `<label><span>Google Books API key</span><input id="settings-google-books-key" type="password" value="" autocomplete="new-password" spellcheck="false" placeholder="Paste API key"${settings.busy ? " disabled" : ""} /><small>The saved key is never returned to this browser. Leaving this field closes it empty.</small></label>${settings.error ? `<p class="settings-provider-error" role="alert">${escapeHtml(settings.error)}</p>` : ""}<div class="settings-provider-actions"><button type="button" data-ui-action="cancel-google-books-key"${settings.busy ? " disabled" : ""}>Cancel</button>${configured ? `<button type="button" class="danger" data-ui-action="remove-google-books-key"${settings.busy ? " disabled" : ""}>Remove</button>` : ""}<button type="button" class="primary" data-ui-action="save-test-google-books-key"${settings.busy ? " disabled" : ""}>${settings.busy ? "Saving and testing…" : "Save & test"}</button></div>` : `<p>${configured ? `A server-stored key is configured${provider?.lastTestedAt ? ` and was last tested ${escapeHtml(relativeScanTime(provider.lastTestedAt))}` : ""}. ShelfSend only displays a fixed mask.` : "Open Library works without a key. Add a key only if you also want Google Books results."}</p>${settings.error ? `<p class="settings-provider-error" role="alert">${escapeHtml(settings.error)}</p>` : ""}<div class="settings-provider-actions">${configured ? `<button type="button" class="danger" data-ui-action="remove-google-books-key"${disable ? " disabled" : ""}>Remove</button>` : ""}<button type="button" data-ui-action="edit-google-books-key"${disable ? " disabled" : ""}>${configured ? "Replace key" : "Add key"}</button></div>`}</div></details>`;
}

export function renderOnboarding(snapshot: CatalogBrowserSnapshot, state: AppState): string {
  const wizard = snapshot.onboarding;
  if (!wizard) return "";
  const steps = ["welcome", "library", "indexing", "kindle"];
  const roots = snapshot.rootsByProfile.get(snapshot.settingsLibraryId ?? snapshot.filters.profileId ?? "") ?? [];
  const busy = wizard.busy || snapshot.settingsSaving || snapshot.settingsRefreshing;
  const supported = state.secureContext && state.webUsbAvailable;
  const content = wizard.step === "welcome"
    ? `<h2>Welcome to ShelfSend</h2><p>Set up your household library in a few steps. Your original books stay untouched, and no account or provider API key is required.</p>`
    : wizard.step === "library"
      ? `<h2>Create your library</h2><p>Give it a name and add a folder in the form below. Use the path inside the container, such as <code>/libraries/books</code>—not a host path or SMB address. Save the library to continue.</p>`
      : wizard.step === "indexing"
        ? `<h2>Your library is being indexed</h2><p>Books appear automatically as the folder is scanned. You can continue while indexing runs.</p><ul>${roots.map((root) => `<li><strong>${escapeHtml(root.label)}</strong>: ${escapeHtml(root.status)}${root.lastErrorCode ? ` — ${escapeHtml(root.lastErrorCode)}` : ""}</li>`).join("")}</ul><p>${snapshot.profiles.find((profile) => profile.id === snapshot.settingsLibraryId)?.bookCount ?? 0} books indexed.</p>`
        : `<h2>Connect your Kindle — optional</h2><p>${actualDeviceConnected(state) ? "Kindle connected. Connection checks and inventory run automatically; wait for the ready state before sending." : supported ? "Plug your Kindle into this computer, then choose Connect Kindle. You can also finish now and connect later." : "USB transfer needs a supported desktop Chromium browser and HTTPS (or localhost). You can still browse and finish setup here."}</p>${!actualDeviceConnected(state) ? `<button type="button" data-ui-action="connect-catalog-device"${!supported || deviceConnecting(state) ? " disabled" : ""}>${deviceConnecting(state) ? "Connecting…" : "Connect Kindle"}</button>` : ""}`;
  return `<section class="onboarding-wizard" aria-label="Setup wizard" aria-busy="${Boolean(busy)}"><p class="library-eyebrow">Setup · Step ${steps.indexOf(wizard.step) + 1} of 4</p>${content}${wizard.error ? `<p role="alert">${escapeHtml(wizard.error)}</p>` : ""}<div class="onboarding-actions">${wizard.step !== "library" ? `<button type="button" class="primary" data-ui-action="onboarding-next"${busy ? " disabled" : ""}>${wizard.step === "welcome" ? "Get started" : wizard.step === "kindle" ? "Finish setup" : "Continue"}</button>` : ""}<button type="button" data-ui-action="onboarding-skip"${busy ? " disabled" : ""}>Skip for now</button></div></section>`;
}

function renderLibrarySettings(snapshot: CatalogBrowserSnapshot): string {
  if (snapshot.onboarding && snapshot.onboarding.step !== "library") return "";
  const draft = snapshot.settingsDraft;
  const locked = snapshot.serviceStatus?.settingsMode === "read-only";
  const editsDisabled = locked || snapshot.settingsSaving || snapshot.settingsRefreshing || snapshot.settingsConflict;
  return `
    <section class="settings-page${snapshot.onboarding ? " settings-onboarding" : ""}" aria-labelledby="settings-heading">
      <header class="settings-page-head"><div><div class="library-eyebrow">Household configuration</div><h1 id="settings-heading" tabindex="-1">Library settings</h1><p>Create libraries and choose which container-mounted folders each one can see.</p></div><button type="button" class="primary" data-ui-action="new-library"${editsDisabled ? " disabled" : ""}>+ New library</button></header>
      <div class="settings-prototype-notice" role="note"><strong>Saved on this server</strong><span>Configuration persists across restarts. Catalog folders must be mounted read-only into the ShelfSend container.</span></div>
      ${locked ? '<div class="settings-prototype-notice settings-locked-notice" role="status"><strong>Settings locked</strong><span>This server manages its library configuration outside the browser. You can inspect folders and request a scan, but editing is disabled.</span></div>' : ""}
      <div class="settings-prototype-notice warning" role="note"><strong>No private accounts</strong><span>Anyone who can open this service can switch between every configured household library. Keep it on a trusted LAN or VPN.</span></div>
      ${snapshot.onboarding ? "" : `<button type="button" data-ui-action="onboarding-open"${editsDisabled ? " disabled" : ""}>Run setup wizard</button>${renderCoverProviderSettings(snapshot)}`}
      ${snapshot.settingsError && draft ? `<div class="settings-error-summary" role="alert" tabindex="-1"><strong>Check these settings</strong><span>${escapeHtml(snapshot.settingsError)}</span></div>` : ""}
      <div class="settings-layout">
        <aside class="settings-library-picker" aria-label="Configured libraries"><div class="settings-section-label">Household libraries</div><div class="settings-library-options">${renderSettingsLibraryList(snapshot) || '<p class="settings-empty-copy">No libraries configured yet.</p>'}</div><div class="settings-picker-note"><strong>${snapshot.profiles.length} configured</strong><span>Each library can contain multiple container folders.</span></div></aside>
        ${draft ? `<form class="settings-editor" aria-label="Edit ${escapeHtml(draft.name)}" data-settings-library-id="${escapeHtml(draft.id)}"${snapshot.settingsSaving || snapshot.settingsRefreshing ? ' aria-busy="true"' : ""}>
          <div class="settings-editor-head"><div><span class="settings-library-icon" aria-hidden="true">${escapeHtml(draft.initial)}</span><span><strong>${draft.persisted ? "Edit library" : "Create library"}</strong><small>${draft.persisted ? `Profile ID · ${escapeHtml(draft.id)}` : "Not saved yet"}</small></span></div><span class="settings-unsaved-chip${snapshot.settingsDirty ? " dirty" : ""}">${snapshot.settingsDirty ? "Unsaved changes" : "Server configuration"}</span></div>
          <div class="settings-library-fields"><label class="settings-field"><span>Display name</span><input id="settings-library-name" value="${escapeHtml(draft.name)}" maxlength="50" placeholder="e.g. Family classics" autocomplete="off"${editsDisabled ? " disabled" : ""} /><small>Shown in the household library switcher.</small></label><label class="settings-library-enabled"><input id="settings-library-enabled" type="checkbox"${draft.enabled ? " checked" : ""}${editsDisabled ? " disabled" : ""} /><span><strong>Enable this library</strong><small>Disabled libraries stay configured but are hidden from the main switcher.</small></span></label></div>
          <div class="settings-folders-head"><div><strong>Container-mounted folders</strong><span>Each enabled folder is indexed independently.</span></div><button type="button" data-ui-action="add-settings-folder"${editsDisabled ? " disabled" : ""}>+ Add folder</button></div>
          <div class="settings-folder-list">${draft.folders.map((folder, index) => renderSettingsFolder(folder, index, draft.folders.length, snapshot, locked)).join("")}</div>
          ${renderDeleteConfirmation(snapshot, draft)}
          <div class="settings-actions"><span>Original files remain read-only.</span>${draft.persisted ? `<button type="button" class="danger settings-delete-button" data-ui-action="delete-library"${editsDisabled ? " disabled" : ""}>Delete library…</button>` : ""}<button type="button" data-ui-action="cancel-library-settings"${snapshot.settingsSaving || snapshot.settingsRefreshing ? " disabled" : ""}>Cancel</button><button type="button" class="primary" data-ui-action="save-library-settings"${editsDisabled ? " disabled" : ""}>${snapshot.settingsSaving ? "Saving…" : snapshot.settingsRefreshing ? "Refreshing…" : draft.persisted ? "Save changes" : "Create library"}</button></div>
        </form>` : snapshot.settingsError ? `<div class="library-empty-state library-error-state settings-load-error" role="alert"><span aria-hidden="true">!</span><h2>Library settings unavailable</h2><p>${escapeHtml(snapshot.settingsError)}</p><button type="button" data-ui-action="retry-settings-library">Try again</button></div>` : `<div class="library-loading-state" role="status"><span aria-hidden="true"></span><strong>Loading library settings…</strong></div>`}
        <aside class="settings-guidance" aria-label="Settings guidance"><div class="settings-guidance-card"><span class="settings-guidance-icon" aria-hidden="true">⇄</span><strong>Automatic indexing</strong><p>File watching is backed by periodic reconciliation, so one new book does not re-import an unchanged library.</p></div><div class="settings-guidance-card warning"><span class="settings-guidance-icon" aria-hidden="true">⌂</span><strong>Private network only</strong><p>Without login, profiles organize views but do not restrict access.</p></div><div class="settings-guidance-card"><span class="settings-guidance-icon" aria-hidden="true">✓</span><strong>Safe source policy</strong><p>Only a browser-created derivative is converted and sent. The source book is never changed.</p></div></aside>
      </div>
    </section>
  `;
}

function renderBatchTransferBooks(snapshot: CatalogBrowserSnapshot): string {
  const batch = snapshot.batchTransfer;
  if (!batch) return "";
  const verified = batch.verifiedBooks.length === 0
    ? '<p class="library-batch-empty">No books verified yet.</p>'
    : `<ul class="library-batch-book-list">${batch.verifiedBooks.map(({ title }) => `<li><span aria-hidden="true">✓</span>${escapeHtml(title)}</li>`).join("")}</ul>`;
  const failure = batch.failedBook
    ? `<div class="library-batch-failure"><strong>Failed</strong><span>${escapeHtml(batch.failedBook.title)}</span></div>`
    : "";
  const retry = batch.retryBooks.length === 0
    ? ""
    : `<div class="library-batch-retry"><strong>Selected for retry</strong><ul>${batch.retryBooks.map(({ title }) => `<li>${escapeHtml(title)}</li>`).join("")}</ul></div>`;
  return `<div class="library-batch-book-results"><strong>Transferred and verified</strong>${verified}${failure}${retry}</div>`;
}

function renderSendPreview(state: AppState, snapshot: CatalogBrowserSnapshot): string {
  if (!snapshot.pendingBookId) return "";
  const book = snapshot.pendingBook;
  if (!book) return "";
  const ready = deviceReadyToSend(state, snapshot);
  const connected = actualDeviceConnected(state);
  const connecting = deviceConnecting(state);
  const phase = snapshot.sendPhase;
  const sourceDone = Boolean(phase);
  const derivativeDone = phase === "sending" || phase === "verifying" || phase === "complete";
  const transferDone = phase === "complete";
  const batch = snapshot.batchTransfer;
  const batchSucceeded = Boolean(batch && phase === "complete" && batch.verifiedBooks.length === batch.total);
  const batchFailed = Boolean(batch?.failedBook && phase === "failed");
  const buttonAction = batchSucceeded || batchFailed || transferDone
    ? "close-send"
    : ready ? "confirm-catalog-send" : "connect-catalog-device";
  const buttonLabel = batchFailed
    ? `Review ${batch!.retryBooks.length} selected`
    : batchSucceeded || transferDone
    ? "Done"
    : phase === "failed"
      ? "Try again"
      : snapshot.sendBusy
        ? "Transfer in progress…"
        : ready
          ? "Send to Kindle"
          : connecting
            ? "Connecting Kindle…"
            : connected
              ? state.selfTest.kind === "passed" ? "Kindle inventory unavailable" : "Waiting for safe-write test"
              : "Connect Kindle";
  const progress = snapshot.sendProgress;
  const overallProgress = batch
    ? phase === "failed"
      ? Math.round(100 * batch.verifiedBooks.length / batch.total)
      : Math.round(100 * ((batch.position - 1) + (progress ?? 0) / 100) / batch.total)
    : progress;
  const heading = batchSucceeded
    ? "Batch complete"
    : batchFailed
      ? `Stopped at “${book.title}”`
      : book.title;
  const author = batchSucceeded
    ? `${batch!.total} selected books`
    : bookAuthor(book);
  const statusTitle = batchSucceeded
    ? "Batch complete"
    : batchFailed
      ? "Batch stopped"
      : phase === "complete"
        ? batch ? "Verified" : "Complete"
        : phase === "failed"
          ? "Transfer failed"
          : phase?.replace(/^./u, (value) => value.toLocaleUpperCase());
  const progressDetail = batch && overallProgress !== undefined
    ? `<small class="library-batch-progress-detail">Overall ${overallProgress}% · Current book ${progress ?? 0}%</small>`
    : "";
  return `<div class="library-modal-backdrop"${snapshot.sendBusy ? "" : ' data-ui-action="close-send"'} aria-hidden="true"></div><section class="library-send-sheet" role="dialog" aria-modal="true" aria-labelledby="send-preview-title" data-send-book-id="${escapeHtml(book.id)}" tabindex="-1"><button type="button" class="library-sheet-close" data-ui-action="close-send" aria-label="Close send dialog"${snapshot.sendBusy ? " disabled" : ""}>×</button><div class="library-sheet-eyebrow">${batch ? `Book ${batch.position} of ${batch.total}` : "Send to Kindle"}</div><h2 id="send-preview-title">${escapeHtml(heading)}</h2><p class="library-sheet-author">${escapeHtml(author)}</p><div class="library-send-plan"><div class="${sourceDone ? "done" : ""}"><span>1</span><div><strong>Check source</strong><small>${escapeHtml(book.format.toLocaleUpperCase())} · ${escapeHtml(formatCatalogBytes(book.size))}</small></div></div><div class="${derivativeDone ? "done" : phase === "converting" || phase === "validating" ? "active" : ""}"><span>2</span><div><strong>${book.format.toLocaleLowerCase() === "epub" ? "Convert a copy locally" : "Validate Kindle file"}</strong><small>${book.format.toLocaleLowerCase() === "epub" ? "boko WASM → AZW3 personal document" : "BOOKMOBI and cover checks"}</small></div></div><div class="${transferDone ? "done" : phase === "sending" || phase === "verifying" ? "active" : ""}"><span>3</span><div><strong>Send and verify</strong><small>Collision-safe WebUSB/MTP transfer</small></div></div></div>${phase ? `<div class="library-transfer-status${phase === "failed" ? " failed" : ""}" role="status"><strong>${escapeHtml(statusTitle ?? "Working")}</strong><span>${escapeHtml(snapshot.sendMessage ?? "Working locally in this browser")}</span>${progressDetail}${overallProgress === undefined ? "" : `<div class="progress-track" role="progressbar" aria-label="${batch ? "Overall batch progress" : "Book transfer progress"}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${overallProgress}"><span style="width:${overallProgress}%"></span></div>`}</div>` : ""}${renderBatchTransferBooks(snapshot)}<div class="library-original-note"><strong>Original protected</strong><span>The source in the container-mounted library remains unchanged.</span></div><button type="button" class="primary library-confirm-send" data-ui-action="${buttonAction}"${snapshot.sendBusy || connecting || (connected && !ready && !transferDone && !batchFailed) ? " disabled" : ""}>${buttonLabel}</button></section>`;
}

function renderRemovalConfirmation(snapshot: CatalogBrowserSnapshot): string {
  const request = snapshot.pendingRemoval;
  if (!request || request.targets.length === 0) return "";
  const fileCount = request.targets.length;
  const bookCount = new Set(request.targets.map(({ bookId }) => bookId)).size;
  const currentAuthority = snapshot.kindleInventory?.completeness === "complete"
    && snapshot.kindleInventory.matching?.status === "complete";
  const removalLocked = snapshot.bulkActionBusy || !currentAuthority;
  const actionLabel = snapshot.bulkActionBusy
    ? "Removing…"
    : currentAuthority
      ? `Remove ${fileCount === 1 ? "file" : `${fileCount} files`}`
      : "Reconnect to remove";
  return `<div class="library-modal-backdrop" data-ui-action="cancel-remove-from-kindle" aria-hidden="true"></div><section class="library-remove-sheet" role="alertdialog" aria-modal="true" aria-labelledby="remove-kindle-title" aria-describedby="remove-kindle-description" tabindex="-1"><div class="library-sheet-eyebrow">Kindle cleanup</div><h2 id="remove-kindle-title">Remove ${bookCount === 1 ? `“${escapeHtml(request.targets[0]!.title)}”` : `${bookCount} books`} from this Kindle?</h2><p id="remove-kindle-description">This deletes only the ${fileCount} exact matched ${fileCount === 1 ? "file" : "files"} shown below from the connected Kindle. Library originals are not changed.</p>${snapshot.bulkActionError ? `<div class="library-transfer-status failed" role="alert"><strong>Removal did not complete</strong><span>${escapeHtml(snapshot.bulkActionError)}</span></div>` : ""}<ul class="library-remove-targets">${request.targets.map((target) => `<li><span><strong>${escapeHtml(target.title)}</strong><small>${escapeHtml(target.filename)}</small></span><span>${escapeHtml(formatCatalogBytes(target.size))}</span></li>`).join("")}</ul><div class="library-remove-warning" role="note"><strong>This cannot be undone on the Kindle.</strong><span>You can send the library copy again later.</span></div><div class="library-remove-actions"><button type="button" data-ui-action="cancel-remove-from-kindle"${snapshot.bulkActionBusy ? " disabled" : ""}>Cancel</button><button type="button" class="danger" data-ui-action="confirm-remove-from-kindle"${removalLocked ? " disabled" : ""}>${actionLabel}</button></div></section>`;
}

function renderUpdateConfirmation(snapshot: CatalogBrowserSnapshot): string {
  const pending = snapshot.pendingUpdate;
  if (!pending) return "";
  const result = pending.result;
  const phase = snapshot.sendPhase;
  const finished = result !== undefined;
  const progress = snapshot.sendProgress;
  const recovery = result && result.status !== "updated"
    ? `<div class="library-update-recovery" role="alert"><strong>${result.duplicateCleanupRequired ? "Keep both copies for now" : "Replacement verified; refresh the comparison"}</strong><span>${escapeHtml(result.message)}</span><ul>${result.deliveryRecordingRequired ? "<li>The verified replacement still needs a durable delivery record.</li>" : ""}${result.duplicateCleanupRequired ? "<li>The exact prior copy still needs guarded cleanup on a later connection.</li>" : ""}${result.reconciliationRequired ? `<li>${result.duplicateCleanupRequired ? "Reconnect or refresh" : "The prior copy was removed; reconnect or refresh"} the Kindle comparison before another update.</li>` : ""}</ul></div>`
    : "";
  const resultFiles = result
    ? `<dl class="library-update-files"><div><dt>Prior copy</dt><dd><code>${escapeHtml(result.priorFilename)}</code></dd></div><div><dt>Replacement</dt><dd><code>${escapeHtml(result.replacementFilename)}</code></dd></div></dl>`
    : "";
  const stage = phase
    ? `<div class="library-transfer-status${phase === "failed" ? " failed" : ""}" role="status"><strong>${phase === "complete" ? "Update complete" : phase === "failed" ? "Update needs attention" : "Updating Kindle copy"}</strong><span>${escapeHtml(snapshot.sendMessage ?? "Working locally in this browser")}</span>${progress === undefined ? "" : `<div class="progress-track" role="progressbar" aria-label="Kindle update progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${Math.max(0, Math.min(100, progress))}%"></span></div>`}</div>`
    : "";
  const presentationLabel = pending.book.presentationVersion
    ? `${pending.book.presentationVersion.slice(0, 12)}…`
    : "pending local preparation";
  return `<div class="library-modal-backdrop"${snapshot.sendBusy ? "" : ' data-ui-action="cancel-kindle-update"'} aria-hidden="true"></div><section class="library-update-sheet" role="alertdialog" aria-modal="true" aria-labelledby="kindle-update-title" aria-describedby="kindle-update-description" tabindex="-1"><button type="button" class="library-sheet-close" data-ui-action="cancel-kindle-update" aria-label="Close Kindle update"${snapshot.sendBusy ? " disabled" : ""}>×</button><div class="library-sheet-eyebrow">Guarded Kindle update</div><h2 id="kindle-update-title">Update “${escapeHtml(pending.book.title)}” on this Kindle?</h2><p id="kindle-update-description">The current presentation is <code>${escapeHtml(pending.priorFilename)}</code>. ShelfSend will build the edited presentation “${escapeHtml(pending.book.title)}” (metadata revision ${pending.book.metadataRevision ?? 0}, presentation ${escapeHtml(presentationLabel)}); its final collision-safe filename is determined during local preparation. It is uploaded and verified first while the prior file remains intact. Both files exist temporarily, so the Kindle must have enough free space for the full replacement. Only then is the exact prior managed copy removed.</p>${pending.error ? `<div class="library-transfer-status failed" role="alert"><strong>Update did not complete</strong><span>${escapeHtml(pending.error)}</span></div>` : stage}${resultFiles}${recovery}<ol class="library-update-plan"><li><span>1</span><div><strong>Build edited copy</strong><small>The read-only EPUB original stays unchanged.</small></div></li><li><span>2</span><div><strong>Upload beside prior copy</strong><small>Capacity is checked before this temporary coexistence.</small></div></li><li><span>3</span><div><strong>Verify and record replacement</strong><small>The new copy must be proven durable first.</small></div></li><li><span>4</span><div><strong>Remove exact prior copy</strong><small>Deletion is last and limited to the revalidated managed file.</small></div></li></ol><div class="library-remove-actions"><button type="button" data-ui-action="cancel-kindle-update"${snapshot.sendBusy ? " disabled" : ""}>${finished ? "Done" : "Cancel"}</button>${finished ? "" : `<button type="button" class="primary" data-ui-action="confirm-kindle-update"${snapshot.sendBusy ? " disabled" : ""}>${snapshot.sendBusy ? "Updating…" : pending.error ? "Try update again" : "Update Kindle copy"}</button>`}</div></section>`;
}

function renderSendQueue(snapshot: CatalogBrowserSnapshot, state: AppState): string {
  if (!snapshot.sendQueueOpen) return "";
  const queue = snapshot.sendQueue;
  if (!queue) {
    return `<div class="library-modal-backdrop" data-ui-action="close-send-queue" aria-hidden="true"></div><aside class="library-queue-sheet" role="dialog" aria-modal="true" aria-labelledby="send-queue-title" tabindex="-1"><button type="button" class="library-sheet-close" data-ui-action="close-send-queue" aria-label="Close Send later">×</button><div class="library-loading-state" role="status"><span></span><strong id="send-queue-title">${snapshot.sendQueueState === "error" ? "Send later unavailable" : "Loading Send later…"}</strong><small>${escapeHtml(snapshot.sendQueueError ?? "Reading the persistent server queue")}</small></div></aside>`;
  }
  const comparisonComplete = snapshot.kindleInventory?.completeness === "complete"
    && snapshot.kindleInventory.matching?.status === "complete"
    && snapshot.kindleStatusCountsByProfile.has(queue.profileId);
  const actionCapabilitiesByBookId = new Map(queue.entries.flatMap((entry) => (
    entry.book === null
      ? []
      : [[entry.bookId, bookActionCapabilities(entry.book, state, snapshot)] as const]
  )));
  const review = buildSendQueueReview({
    queue,
    kindleStatusByBookId: snapshot.kindleStatus,
    actionCapabilitiesByBookId,
    currentComparisonComplete: comparisonComplete,
    ...(state.device.kind === "ready" ? { freeBytes: state.device.details.freeBytes } : {}),
  });
  const rows = review.items.map((item, index) => `<li data-queue-book-id="${escapeHtml(item.bookId)}"><div><strong>${escapeHtml(item.title)}</strong><small>${item.reason ? escapeHtml(item.reason) : item.preparation === "convert-browser-copy" ? "Ready · browser copy will be converted" : "Ready · Kindle file will be validated"}</small></div><span>${escapeHtml(formatCatalogBytes(item.sourceBytes))}</span><div><button type="button" data-ui-action="move-queue-book" data-book-id="${escapeHtml(item.bookId)}" data-direction="-1" aria-label="Move ${escapeHtml(item.title)} up"${index === 0 || snapshot.sendQueueBusy ? " disabled" : ""}>↑</button><button type="button" data-ui-action="move-queue-book" data-book-id="${escapeHtml(item.bookId)}" data-direction="1" aria-label="Move ${escapeHtml(item.title)} down"${index === review.items.length - 1 || snapshot.sendQueueBusy ? " disabled" : ""}>↓</button><button type="button" data-ui-action="remove-queue-book" data-book-id="${escapeHtml(item.bookId)}"${snapshot.sendQueueBusy ? " disabled" : ""}>Remove</button></div></li>`).join("");
  const capacity = review.fitsApproximateFreeSpace === undefined
    ? "Connect a Kindle to estimate capacity."
    : review.fitsApproximateFreeSpace
      ? "Approximately enough free space."
      : "The source-byte estimate exceeds current free space.";
  return `<div class="library-modal-backdrop"${snapshot.sendQueueBusy ? "" : ' data-ui-action="close-send-queue"'} aria-hidden="true"></div><aside class="library-queue-sheet" role="dialog" aria-modal="true" aria-labelledby="send-queue-title" aria-describedby="send-queue-description" tabindex="-1"><button type="button" class="library-sheet-close" data-ui-action="close-send-queue" aria-label="Close Send later"${snapshot.sendQueueBusy ? " disabled" : ""}>×</button><header><div class="library-sheet-eyebrow">Persistent queue</div><h2 id="send-queue-title">Send later</h2><p id="send-queue-description">Review books before connecting a Kindle. Queue state is saved on this server.</p></header>${snapshot.sendQueueError ? `<div class="metadata-editor-error" role="alert"><strong>Queue action failed</strong><span>${escapeHtml(snapshot.sendQueueError)}</span></div>` : ""}${rows ? `<ol class="library-queue-list">${rows}</ol>` : '<div class="library-empty-state compact"><span aria-hidden="true">✓</span><h3>Nothing waiting</h3><p>Add books while browsing and they will stay here until verified on a Kindle.</p></div>'}<div class="library-queue-totals"><span><strong>${review.items.length}</strong> queued</span><span><strong>${escapeHtml(formatCatalogBytes(review.totalSourceBytes))}</strong> source bytes</span><span><strong>Approximate transfer size</strong> ${escapeHtml(formatCatalogBytes(review.approximateTransferBytes))}${review.conversionSizeUncertain ? " · EPUB conversion can change it" : ""}</span><small>${escapeHtml(capacity)} This is an estimate, not a reservation.</small></div><footer><button type="button" class="danger" data-ui-action="clear-send-queue"${queue.entries.length === 0 || snapshot.sendQueueBusy ? " disabled" : ""}>Clear</button><button type="button" class="primary" data-ui-action="send-queued-books"${review.eligibleBookIds.length === 0 ? " disabled" : ""}>Send ${review.eligibleBookIds.length} eligible</button></footer></aside>`;
}

function renderShelfManager(snapshot: CatalogBrowserSnapshot): string {
  if (!snapshot.shelfManagerOpen) return "";
  const busy = snapshot.smartShelvesState === "loading";
  const pinned = orderedPinnedSmartShelves(snapshot.smartShelves);
  const customRows = snapshot.smartShelves.map((shelf) => {
    const pinnedIndex = pinned.findIndex(({ id }) => id === shelf.id);
    return `<li><span><strong>${escapeHtml(shelf.name)}</strong><small>${shelf.serverCount === null ? "Count needs a Kindle comparison" : `${shelf.serverCount} matching ${shelf.serverCount === 1 ? "book" : "books"}`}</small></span><div><button type="button" data-ui-action="toggle-smart-shelf-pin" data-shelf-id="${escapeHtml(shelf.id)}"${busy ? " disabled" : ""}>${shelf.pinnedRank === null ? "Pin" : "Unpin"}</button>${pinnedIndex >= 0 ? `<button type="button" data-ui-action="move-smart-shelf" data-shelf-id="${escapeHtml(shelf.id)}" data-direction="-1" aria-label="Move ${escapeHtml(shelf.name)} up"${busy || pinnedIndex === 0 ? " disabled" : ""}>↑</button><button type="button" data-ui-action="move-smart-shelf" data-shelf-id="${escapeHtml(shelf.id)}" data-direction="1" aria-label="Move ${escapeHtml(shelf.name)} down"${busy || pinnedIndex === pinned.length - 1 ? " disabled" : ""}>↓</button>` : ""}<button type="button" class="danger" data-ui-action="delete-smart-shelf" data-shelf-id="${escapeHtml(shelf.id)}"${busy ? " disabled" : ""}>Delete</button></div><details class="smart-shelf-edit"><summary>Edit shelf</summary><form data-smart-shelf-rename="${escapeHtml(shelf.id)}"><label><span>Name</span><input value="${escapeHtml(shelf.name)}" maxlength="80" required autocomplete="off"${busy ? " disabled" : ""} /></label><button type="submit"${busy ? " disabled" : ""}>Rename</button><button type="button" data-ui-action="update-smart-shelf-query" data-shelf-id="${escapeHtml(shelf.id)}"${busy ? " disabled" : ""}>Update to current view</button></form></details></li>`;
  }).join("");
  return `<div class="library-modal-backdrop" data-ui-action="close-smart-shelves" aria-hidden="true"></div><aside class="library-shelf-sheet" role="dialog" aria-modal="true" aria-labelledby="smart-shelf-title" aria-describedby="smart-shelf-description" tabindex="-1"><button type="button" class="library-sheet-close" data-ui-action="close-smart-shelves" aria-label="Close smart shelves">×</button><header><div class="library-sheet-eyebrow">Reusable views</div><h2 id="smart-shelf-title">Smart shelves</h2><p id="smart-shelf-description">Save the current search, filters, sort, and Kindle status as a profile-specific view.</p></header><form class="smart-shelf-save-form"><label for="smart-shelf-name">Shelf name</label><div><input id="smart-shelf-name" name="name" maxlength="80" required autocomplete="off" placeholder="e.g. Holiday reading" /><button type="submit" class="primary" data-ui-action="save-smart-shelf"${busy ? " disabled" : ""}>Save current view</button></div></form><section><h3>Built in</h3><div class="smart-shelf-builtins">${BUILT_IN_SMART_SHELVES.map((shelf) => `<button type="button" data-ui-action="apply-smart-shelf" data-shelf-id="${escapeHtml(shelf.id)}">${escapeHtml(shelf.name)}</button>`).join("")}</div></section><section><h3>Your shelves</h3>${snapshot.smartShelvesState === "error" ? '<p role="alert">Saved shelves could not be loaded.</p>' : customRows ? `<ul class="smart-shelf-list">${customRows}</ul>` : "<p>No custom shelves yet.</p>"}</section><footer><small>Favorites and Want to read are manual profile choices. They do not infer reading progress from the Kindle.</small><button type="button" data-ui-action="close-smart-shelves">Done</button></footer></aside>`;
}

function matchEvidenceTierLabel(tier: CatalogMatchEvidenceBreakdown["tier"]): string {
  const labels: Readonly<Record<CatalogMatchEvidenceBreakdown["tier"], string>> = {
    "delivery-persistent-id": "Prior verified delivery identity",
    "delivery-managed-token-size": "Prior delivery token + exact size",
    "managed-token-size": "ShelfSend token + exact size",
    "identifier-title-author": "Identifier + normalized title + author",
    "title-author-size": "Normalized title + author + exact size",
    "managed-token": "ShelfSend token",
    identifier: "Identifier only",
    "title-author": "Normalized title + author",
    "filename-similarity": "Filename similarity",
    "inventory-partial": "Incomplete inventory",
    none: "No exact candidate",
    "prior-presentation": "Exact prior presentation",
    "reconciliation-incomplete": "Incomplete catalog comparison",
  };
  return labels[tier];
}

function matchComparisonLabel(value: CatalogMatchEvidenceBreakdown["comparisons"][keyof CatalogMatchEvidenceBreakdown["comparisons"]]): string {
  if (value === "match") return "Matches";
  if (value === "different") return "Different";
  if (value === "unavailable") return "Unavailable";
  return "Not compared";
}

function renderMatchEvidence(evidence: CatalogMatchEvidenceBreakdown): string {
  const comparisonRows = [
    ["Title", evidence.comparisons.title],
    ["Authors", evidence.comparisons.authors],
    ["Identifiers", evidence.comparisons.identifiers],
    ["Filename", evidence.comparisons.filename],
    ["Exact size", evidence.comparisons.size],
  ] as const;
  const candidates = evidence.candidateCount === 0
    ? "No exact device candidate"
    : `${evidence.candidateCount} device ${evidence.candidateCount === 1 ? "candidate" : "candidates"}${evidence.ambiguous ? " · ambiguous" : ""}`;
  return `<div class="match-review-evidence"><dl><div><dt>Evidence tier</dt><dd>${escapeHtml(matchEvidenceTierLabel(evidence.tier))}</dd></div><div><dt>Current inventory</dt><dd>${escapeHtml(evidence.inventoryCompleteness)}</dd></div><div><dt>Candidates</dt><dd>${escapeHtml(candidates)}</dd></div>${comparisonRows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd data-comparison="${escapeHtml(value)}">${escapeHtml(matchComparisonLabel(value))}</dd></div>`).join("")}</dl><p><strong>Why this is not green:</strong> ${escapeHtml(evidence.strongerProofUnavailable)}</p></div>`;
}

function renderMatchReview(snapshot: CatalogBrowserSnapshot, state: AppState): string {
  const review = snapshot.matchReview;
  if (!review) return "";
  const item = snapshot.kindleInventory?.items.find(({ id }) => id === review.itemId);
  const explanation = review.explanation;
  if (!item && !explanation) return "";
  const profileId = snapshot.filters.profileId;
  const candidates = [...(item?.candidates ?? [])]
    .filter((candidate) => !profileId || candidate.profileId === profileId)
    .sort((left, right) => left.bookId === review.requestedBookId ? -1 : right.bookId === review.requestedBookId ? 1 : 0);
  const currentEvidence = snapshot.kindleInventory?.completeness === "complete"
    && snapshot.kindleInventory.matching?.status === "complete";
  const candidateCards = candidates.map((candidate) => {
    const book = review.books.get(candidate.bookId);
    const matchReview = book ? bookActionCapabilities(book, state, snapshot).matchReview : undefined;
    const controlsDisabled = review.busy || matchReview?.decisionEnabled !== true;
    const controlsReason = matchReview?.decisionReason ?? "Current book evidence is unavailable";
    const decision = candidate.decision;
    const title = book?.title ?? "Catalog candidate";
    const author = book ? bookAuthor(book) : `Book ${candidate.bookId.slice(0, 12)}`;
    return `<article class="match-review-candidate" data-decision="${escapeHtml(decision ?? "undecided")}"><div><span class="library-sheet-eyebrow">Catalog candidate</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(author)}</p>${book ? `<small>${escapeHtml(book.format.toLocaleUpperCase())} · ${escapeHtml(formatCatalogBytes(book.size))}${book.identifiers.length ? ` · ${escapeHtml(book.identifiers.join(", "))}` : ""}</small>` : ""}</div><p class="match-review-reason">${escapeHtml(candidate.reason)}</p>${renderMatchEvidence(candidate.evidence)}${decision ? `<div class="match-review-decision"><strong>${decision === "same-book" ? "Marked as the same book" : "Rejected as a different book"}</strong><button type="button" data-ui-action="manual-match-decision" data-profile-id="${escapeHtml(candidate.profileId)}" data-book-id="${escapeHtml(candidate.bookId)}" data-decision="undo"${controlsDisabled ? ` disabled title="${escapeHtml(controlsReason)}"` : ""}>Undo</button></div>` : `<div class="match-review-actions"><button type="button" class="primary" data-ui-action="manual-match-decision" data-profile-id="${escapeHtml(candidate.profileId)}" data-book-id="${escapeHtml(candidate.bookId)}" data-decision="same-book"${controlsDisabled ? ` disabled title="${escapeHtml(controlsReason)}"` : ""}>Same book</button><button type="button" data-ui-action="manual-match-decision" data-profile-id="${escapeHtml(candidate.profileId)}" data-book-id="${escapeHtml(candidate.bookId)}" data-decision="not-this-book"${controlsDisabled ? ` disabled title="${escapeHtml(controlsReason)}"` : ""}>Not this book</button></div>`}</article>`;
  }).join("");
  const explanationBook = explanation ? review.books.get(explanation.bookId) : undefined;
  const explanationCard = explanation
    ? `<article class="match-review-candidate" data-decision="explanation"><div><span class="library-sheet-eyebrow">Catalog book</span><h3>${escapeHtml(explanationBook?.title ?? "Catalog book")}</h3><p>${escapeHtml(explanationBook ? bookAuthor(explanationBook) : `Book ${explanation.bookId.slice(0, 12)}`)}</p>${explanationBook ? `<small>${escapeHtml(explanationBook.format.toLocaleUpperCase())} · ${escapeHtml(formatCatalogBytes(explanationBook.size))}${explanationBook.identifiers.length ? ` · ${escapeHtml(explanationBook.identifiers.join(", "))}` : ""}</small>` : ""}</div><p class="match-review-reason">${escapeHtml(explanation.reason)}</p>${renderMatchEvidence(explanation.evidence)}</article>`
    : "";
  const associatedBook = item?.bookId ? review.books.get(item.bookId) : undefined;
  const associatedActions = associatedBook ? bookActionCapabilities(associatedBook, state, snapshot) : undefined;
  const exactAssociation = associatedActions?.exactKindleAssociation === true;
  const sourceStatus = !item?.bookId
    ? "No catalog source is associated with this Kindle file. Any books shown below are comparison candidates only."
    : !associatedBook
      ? "A catalog reference exists, but its source record could not be loaded."
      : exactAssociation
        ? `${associatedActions.sourceAvailable ? "Available" : "Unavailable"} read-only source: ${associatedBook.title}.`
        : `Possible catalog source: ${associatedBook.title}. Its read-only source is currently ${associatedActions?.sourceAvailable ? "available" : "unavailable"}, but this comparison is not an exact association.`;
  const removalEnabled = review.busy !== true && associatedBook !== undefined && associatedActions?.remove.enabled === true;
  const removalReason = review.busy
    ? "The comparison is still being updated."
    : !exactAssociation
      ? "Not eligible: a possible title, author, identifier, filename, or manual candidate is never enough authority to delete a Kindle file."
      : associatedActions?.remove.reason ?? "The exact file can be removed after the current Kindle safety checks pass.";
  const sourceAndRemoval = item
    ? `<section class="match-review-source-removal"><div><span class="library-sheet-eyebrow">Library source status</span><p>${escapeHtml(sourceStatus)}</p></div><div data-removal-eligible="${removalEnabled}"><span class="library-sheet-eyebrow">Deletion eligibility</span><p>${escapeHtml(removalEnabled ? "Eligible: the current complete comparison identifies this exact Kindle file. Removal still requires confirmation." : removalReason)}</p><button type="button" class="danger" data-ui-action="remove-book-from-kindle"${associatedBook ? ` data-book-id="${escapeHtml(associatedBook.id)}"` : ""}${removalEnabled ? "" : ` disabled title="${escapeHtml(removalReason)}"`}>Remove from Kindle</button></div></section>`
    : "";
  const deviceSection = item
    ? `<section class="match-review-device"><span class="library-sheet-eyebrow">Exact device file</span><h3>${escapeHtml(item.title ?? item.filename)}</h3><p>${escapeHtml(item.author ?? "Author unavailable")}</p><dl><div><dt>Path</dt><dd><code>${escapeHtml(item.path ?? item.filename)}</code></dd></div><div><dt>Size</dt><dd>${escapeHtml(formatCatalogBytes(item.size))}</dd></div><div><dt>Format</dt><dd>${escapeHtml(item.format ?? "Unknown")} · object 0x${(item.objectFormat ?? 0).toString(16).padStart(4, "0")}</dd></div><div><dt>Modified</dt><dd>${escapeHtml(item.modificationDate ?? "Not supplied by device")}</dd></div></dl></section>`
    : '<section class="match-review-device"><span class="library-sheet-eyebrow">Device evidence</span><h3>No exact Kindle file identified</h3><p>The incomplete scan cannot safely prove that this catalog book is absent, so ShelfSend keeps it yellow instead of risking a duplicate.</p></section>';
  const body = review.loadState === "loading"
    ? '<div class="library-loading-state compact" role="status"><span aria-hidden="true"></span><strong>Loading match evidence…</strong></div>'
    : candidateCards || explanationCard || '<div class="library-empty-state compact"><span aria-hidden="true">◇</span><h3>Only on this Kindle</h3><p>No book in the selected library currently matches this file. It remains visible here without being assigned to a catalog book.</p></div>';
  const heading = item ? "Is this the same book?" : "Why is this a possible match?";
  const description = item
    ? "A choice is remembered only while this exact Kindle file, catalog presentation, and metadata remain unchanged."
    : "No decision is offered until a complete scan identifies a specific current Kindle file.";
  return `<div class="library-modal-backdrop"${review.busy ? "" : ' data-ui-action="close-match-review"'} aria-hidden="true"></div><aside class="library-match-review-sheet" role="dialog" aria-modal="true" aria-labelledby="match-review-title" aria-describedby="match-review-description" tabindex="-1"><button type="button" class="library-sheet-close" data-ui-action="close-match-review" aria-label="Close match review"${review.busy ? " disabled" : ""}>×</button><header><div class="library-sheet-eyebrow">Kindle comparison</div><h2 id="match-review-title">${escapeHtml(heading)}</h2><p id="match-review-description">${escapeHtml(description)}</p></header>${review.error ? `<div class="metadata-editor-error" role="alert"><strong>Choice not saved</strong><span>${escapeHtml(review.error)}</span></div>` : ""}${deviceSection}${sourceAndRemoval}${body}${!currentEvidence ? '<p class="library-stale-notice"><strong>Reconnect before choosing.</strong> A complete current inventory and library comparison are required.</p>' : ""}<footer><span>A review never bypasses the fresh exact-file checks required before removal.</span><button type="button" data-ui-action="close-match-review"${review.busy ? " disabled" : ""}>Done</button></footer></aside>`;
}

type MetadataField = keyof EditableBookMetadata;

function metadataValue(value: EditableBookMetadata[MetadataField] | undefined): string {
  if (Array.isArray(value)) return value.join("\n");
  return value === null || value === undefined ? "" : String(value);
}

function metadataSourceSummary(value: EditableBookMetadata[MetadataField]): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join(" · ") : "Not set";
  return value === null || value === "" ? "Not set" : String(value);
}

function renderMetadataField(
  data: CatalogBookMetadataState,
  draft: BookMetadataOverrides,
  field: MetadataField,
  label: string,
  kind: "text" | "textarea" | "number" = "text",
  wide = false,
): string {
  const overridden = Object.hasOwn(draft, field);
  const value = overridden ? draft[field] : data.sourceMetadata[field];
  const id = `metadata-${field}`;
  const control = kind === "textarea"
    ? `<textarea id="${id}" data-metadata-field="${field}" rows="${field === "description" ? 5 : 3}"${overridden ? "" : " disabled"}>${escapeHtml(metadataValue(value))}</textarea>`
    : `<input id="${id}" data-metadata-field="${field}" type="${kind}"${kind === "number" ? ' min="0" step="any"' : ""} value="${escapeHtml(metadataValue(value))}" autocomplete="off"${overridden ? "" : " disabled"} />`;
  return `<div class="metadata-field${wide ? " wide" : ""}" data-metadata-field-row="${field}"><div class="metadata-field-head"><label for="${id}">${escapeHtml(label)}</label><label class="metadata-override-toggle"><input type="checkbox" data-metadata-override="${field}"${overridden ? " checked" : ""} /><span>${overridden ? "Override active" : "Use source"}</span></label></div>${control}<small><strong>Source:</strong> ${escapeHtml(metadataSourceSummary(data.sourceMetadata[field]))}</small></div>`;
}

function renderMetadataCover(label: string, url: string | undefined, fallback: string, edited = false): string {
  return `<figure class="metadata-cover-preview${edited ? " edited" : ""}">${url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" data-metadata-cover-image />` : `<div class="metadata-cover-placeholder" aria-hidden="true">No cover</div>`}<figcaption><strong>${escapeHtml(label)}</strong><span>${escapeHtml(fallback)}</span></figcaption></figure>`;
}

function renderMetadataCoverSearch(snapshot: CatalogBrowserSnapshot): string {
  const editor = snapshot.metadataEditor!;
  const search = editor.coverSearch;
  if (search.loadState === "loading") {
    return '<div class="metadata-cover-search-status" role="status">Searching cover providers…</div>';
  }
  if (search.loadState === "error") {
    const needsSettings = search.provider === "google-books" && /api key|configured/iu.test(search.error ?? "");
    return `<div class="metadata-cover-search-status error" role="alert"><span>${escapeHtml(search.error ?? "Cover search failed.")}</span>${needsSettings ? '<button type="button" data-ui-action="open-cover-provider-settings">Open Settings</button>' : ""}</div>`;
  }
  if (search.loadState === "ready" && search.items.length === 0) {
    return '<div class="metadata-cover-search-status">No covers found. Try title plus author or another provider.</div>';
  }
  if (search.items.length === 0) return "";
  const disabled = editor.busy || !editor.data?.book.contentHash;
  return `<div class="metadata-cover-results" aria-label="Cover search results">${search.items.map((candidate) => {
    const thumbnail = sameOriginMetadataImageUrl(candidate.thumbnailUrl);
    return `<article>${thumbnail ? `<img src="${escapeHtml(thumbnail)}" alt="Cover candidate for ${escapeHtml(candidate.title)}" loading="lazy" data-metadata-cover-image />` : '<div class="metadata-cover-placeholder" aria-hidden="true">No preview</div>'}<div><strong>${escapeHtml(candidate.title)}</strong><small>${escapeHtml(candidate.authors.join(", ") || "Unknown author")}${candidate.publishedAt ? ` · ${escapeHtml(candidate.publishedAt)}` : ""}</small><button type="button" data-ui-action="import-metadata-cover" data-candidate-id="${escapeHtml(candidate.candidateId)}"${disabled || !thumbnail ? " disabled" : ""}>Use this cover</button></div></article>`;
  }).join("")}</div>`;
}

const METADATA_FIELD_LABELS: Readonly<Record<MetadataCandidateField, string>> = Object.freeze({
  title: "Title",
  authors: "Authors",
  authorSort: "Author sort",
  language: "Language",
  publisher: "Publisher",
  publishedAt: "Published date",
  series: "Series",
  seriesIndex: "Series number",
  description: "Description",
  subjects: "Subjects",
  identifiers: "Identifiers",
});

function effectiveEditableMetadata(data: CatalogBookMetadataState): EditableBookMetadata {
  const book = data.book;
  return {
    title: book.title,
    authors: [...book.authors],
    authorSort: book.authorSort || null,
    language: book.language ?? null,
    publisher: book.publisher ?? null,
    publishedAt: book.publishedAt ?? null,
    series: book.series ?? null,
    seriesIndex: book.seriesIndex ?? null,
    description: book.description ?? null,
    subjects: [...book.subjects],
    identifiers: [...book.identifiers],
  };
}

function renderMetadataCandidateDiscovery(snapshot: CatalogBrowserSnapshot): string {
  const editor = snapshot.metadataEditor!;
  const data = editor.data!;
  const search = editor.metadataSearch;
  const google = snapshot.coverProviderSettings?.googleBooks;
  const googleReady = google?.configured === true;
  const selected = search.items.find(({ candidateId }) => candidateId === search.selectedCandidateId);
  const disabled = editor.busy;
  const resultStatus = search.loadState === "loading"
    ? '<p class="metadata-candidate-status" role="status">Searching the selected provider…</p>'
    : search.loadState === "error"
      ? `<div class="metadata-candidate-status error" role="alert"><span>${escapeHtml(search.error ?? "Metadata search failed.")}</span>${search.provider === "google-books" && !googleReady ? '<button type="button" data-ui-action="open-cover-provider-settings">Open Settings</button>' : ""}</div>`
      : search.loadState === "ready" && search.items.length === 0
        ? '<p class="metadata-candidate-status">No candidates found. Try fewer fields or another provider.</p>'
        : "";
  const cards = search.items.length === 0 ? "" : `<div class="metadata-candidate-list" aria-label="Metadata candidates">${search.items.map((candidate) => {
    const title = candidate.metadata.title ?? "Untitled result";
    const authors = candidate.metadata.authors?.join(", ") || "Unknown author";
    const chosen = candidate.candidateId === search.selectedCandidateId;
    return `<button type="button" class="metadata-candidate-card${chosen ? " selected" : ""}" data-ui-action="select-metadata-candidate" data-candidate-id="${escapeHtml(candidate.candidateId)}" aria-pressed="${chosen}"${disabled ? " disabled" : ""}><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(authors)}</small></span><span class="metadata-confidence" data-confidence="${escapeHtml(candidate.confidence)}">${escapeHtml(candidate.confidence)} confidence</span></button>`;
  }).join("")}</div>`;
  let review = "";
  if (selected) {
    const rows = buildMetadataCandidateDiff(data.sourceMetadata, effectiveEditableMetadata(data), selected);
    const choiceCount = search.selectedFields.size + (search.includeCover ? 1 : 0);
    review = `<section class="metadata-candidate-review" aria-labelledby="metadata-candidate-review-title"><header><div><h4 id="metadata-candidate-review-title">Choose what to import</h4><p>Nothing is selected automatically. Compare source, current presentation, and provider data.</p></div><span>${choiceCount} selected</span></header><div class="metadata-candidate-diff" role="table" aria-label="Metadata changes"><div class="metadata-candidate-diff-head" role="row"><span role="columnheader">Use</span><span role="columnheader">Field</span><span role="columnheader">Current</span><span role="columnheader">Provider</span></div>${rows.map((row) => `<label role="row" class="${row.changed ? "changed" : "unchanged"}"><span role="cell"><input type="checkbox" data-ui-action="toggle-metadata-candidate-field" data-field="${escapeHtml(row.field)}"${search.selectedFields.has(row.field) ? " checked" : ""}${disabled ? " disabled" : ""} aria-label="Import ${escapeHtml(METADATA_FIELD_LABELS[row.field])}" /></span><strong role="cell">${escapeHtml(METADATA_FIELD_LABELS[row.field])}</strong><span role="cell">${escapeHtml(metadataSourceSummary(row.currentValue as EditableBookMetadata[MetadataField]))}</span><span role="cell">${escapeHtml(metadataSourceSummary(row.candidateValue as EditableBookMetadata[MetadataField]))}</span></label>`).join("")}</div>${selected.coverCandidateId ? `<label class="metadata-candidate-cover-choice"><input type="checkbox" data-ui-action="toggle-metadata-candidate-cover"${search.includeCover ? " checked" : ""}${disabled ? " disabled" : ""} /><span><strong>Use this provider cover too</strong><small>The image is fetched and validated by the server only after you import.</small></span></label>` : ""}${search.error && search.loadState !== "error" ? `<p class="metadata-candidate-status error" role="alert">${escapeHtml(search.error)}</p>` : ""}<div class="metadata-candidate-review-actions"><button type="button" class="primary" data-ui-action="import-metadata-candidate"${disabled || choiceCount === 0 ? " disabled" : ""}>${editor.busy ? "Importing…" : "Import selected changes"}</button></div></section>`;
  }
  return `<details class="metadata-candidate-discovery"${search.loadState !== "idle" || search.lookupJobId ? " open" : ""}><summary><span><strong>Find better metadata</strong><small>Review provider suggestions field by field</small></span><span aria-hidden="true">⌕</span></summary><div class="metadata-candidate-body"><div class="metadata-provider-note"><strong>${search.provider === "google-books" ? "Google Books" : "Open Library"}</strong><span>${search.provider === "google-books" ? googleReady ? `API key configured${google?.status === "working" ? " and working" : "; test status is not confirmed"}.` : "API key not configured. Choose Open Library or add a key in Settings." : "No API key required. Results are still suggestions and are never auto-applied."}</span></div><div class="metadata-candidate-controls"><label><span>Provider</span><select id="metadata-candidate-provider"${disabled ? " disabled" : ""}><option value="open-library"${search.provider === "open-library" ? " selected" : ""}>Open Library</option><option value="google-books"${search.provider === "google-books" ? " selected" : ""}>Google Books${googleReady ? "" : " · key needed"}</option></select></label><label><span>Title</span><input id="metadata-candidate-title" value="${escapeHtml(search.terms.title ?? "")}" autocomplete="off"${disabled ? " disabled" : ""} /></label><label><span>Author</span><input id="metadata-candidate-author" value="${escapeHtml(search.terms.author ?? "")}" autocomplete="off"${disabled ? " disabled" : ""} /></label><label><span>ISBN or identifier</span><input id="metadata-candidate-identifier" value="${escapeHtml(search.terms.identifier ?? "")}" autocomplete="off"${disabled ? " disabled" : ""} /></label><button type="button" data-ui-action="search-metadata-candidates"${disabled || !(search.terms.title?.trim() || search.terms.author?.trim() || search.terms.identifier?.trim()) ? " disabled" : ""}>Search metadata</button></div>${resultStatus}${cards}${review}</div></details>`;
}

function renderMetadataEditor(snapshot: CatalogBrowserSnapshot, state: AppState): string {
  const editor = snapshot.metadataEditor;
  if (!editor) return "";
  const closeDisabled = editor.busy ? " disabled" : "";
  if (editor.loadState === "loading") {
    return `<div class="library-modal-backdrop" aria-hidden="true"></div><section class="library-metadata-sheet" role="dialog" aria-modal="true" aria-labelledby="metadata-editor-title" aria-describedby="metadata-editor-description" tabindex="-1"><button type="button" class="library-sheet-close" data-ui-action="close-metadata-editor" aria-label="Close metadata editor"${closeDisabled}>×</button><div class="library-loading-state" role="status"><span aria-hidden="true"></span><strong id="metadata-editor-title">Loading “${escapeHtml(editor.title)}”</strong><small id="metadata-editor-description">Reading source metadata and saved presentation edits</small></div></section>`;
  }
  const data = editor.data;
  if (!data) {
    return `<div class="library-modal-backdrop" data-ui-action="close-metadata-editor" aria-hidden="true"></div><section class="library-metadata-sheet compact" role="dialog" aria-modal="true" aria-labelledby="metadata-editor-title" tabindex="-1"><button type="button" class="library-sheet-close" data-ui-action="close-metadata-editor" aria-label="Close metadata editor">×</button><div class="library-empty-state library-error-state" role="alert"><span aria-hidden="true">!</span><h2 id="metadata-editor-title">Metadata editor unavailable</h2><p>${escapeHtml(editor.error ?? "The editable metadata could not be loaded.")}</p><button type="button" data-ui-action="close-metadata-editor">Close</button></div></section>`;
  }
  const draft = editor.draftOverrides;
  const currentCoverUrl = sameOriginMetadataImageUrl(data.book.coverUrl, data.revision);
  const sourceCoverUrl = sameOriginMetadataImageUrl(data.sourceCoverUrl);
  const activeCustomCover = Boolean(data.coverOverride && !data.sourceChanged);
  const mutationDisabled = editor.busy || !data.book.contentHash;
  const update = bookActionCapabilities(data.book, state, snapshot).update;
  const editedPresentation = data.book.metadataEdited === true || data.book.coverEdited === true;
  const updateNote = editedPresentation
    ? `<div class="metadata-existing-copy-note" role="note"><strong>${update.enabled ? "Edited EPUB ready to update" : "Kindle update unavailable"}</strong><span>${update.enabled ? `Replace <code>${escapeHtml(update.priorFilename ?? "the prior managed copy")}</code> through the guarded upload-first flow.` : escapeHtml(update.reason ?? "Connect and complete a current Kindle comparison first.")}</span>${update.enabled ? `<button type="button" data-ui-action="update-book-on-kindle" data-book-id="${escapeHtml(data.book.id)}">Update Kindle copy</button>` : ""}</div>`
    : '<div class="metadata-existing-copy-note" role="note"><strong>Library originals are never rewritten.</strong><span>Save an EPUB metadata or cover edit first. A guarded Update Kindle copy action appears when exactly one prior ShelfSend-managed presentation is connected.</span></div>';
  const formatNotice = data.book.format.toLocaleLowerCase() === "azw3"
    ? '<div class="metadata-format-note warning" role="note"><strong>AZW3 send limitation</strong><span>These edits update the catalog and its search results, but edited metadata or covers cannot yet be embedded into an AZW3 Send. The AZW3 source remains unchanged.</span></div>'
    : '<div class="metadata-format-note" role="note"><strong>Applied on Send</strong><span>For EPUB, ShelfSend embeds these edits in a temporary browser-created derivative. The source EPUB remains byte-for-byte unchanged.</span></div>';
  const fields = [
    renderMetadataField(data, draft, "title", "Title"),
    renderMetadataField(data, draft, "authors", "Authors (one per line)", "textarea"),
    renderMetadataField(data, draft, "authorSort", "Author sort"),
    renderMetadataField(data, draft, "language", "Language"),
    renderMetadataField(data, draft, "publisher", "Publisher"),
    renderMetadataField(data, draft, "publishedAt", "Published date"),
    renderMetadataField(data, draft, "series", "Series"),
    renderMetadataField(data, draft, "seriesIndex", "Series number", "number"),
    renderMetadataField(data, draft, "description", "Description", "textarea", true),
    renderMetadataField(data, draft, "subjects", "Subjects (one per line)", "textarea", true),
    renderMetadataField(data, draft, "identifiers", "Identifiers (one per line)", "textarea", true),
  ].join("");
  return `<div class="library-modal-backdrop"${editor.busy ? "" : ' data-ui-action="close-metadata-editor"'} aria-hidden="true"></div><section class="library-metadata-sheet" role="dialog" aria-modal="true" aria-labelledby="metadata-editor-title" aria-describedby="metadata-editor-description" tabindex="-1">
    <button type="button" class="library-sheet-close" data-ui-action="close-metadata-editor" aria-label="Close metadata editor"${closeDisabled}>×</button>
    <header class="metadata-editor-head"><div><div class="library-sheet-eyebrow">Presentation overlay</div><h2 id="metadata-editor-title">Edit metadata &amp; cover</h2><p id="metadata-editor-description">Change how “${escapeHtml(data.book.title)}” appears in ShelfSend and future browser-created transfers.</p></div><span class="metadata-revision-chip">Revision ${data.revision}</span></header>
    ${editor.error ? `<div class="metadata-editor-error" role="alert"><strong>Changes were not saved</strong><span>${escapeHtml(editor.error)}</span></div>` : ""}
    ${data.sourceChanged ? '<div class="metadata-editor-rebase" role="status"><strong>The read-only source changed</strong><span>The prior metadata and custom cover are retained but inactive. Saving now will explicitly rebase your chosen overrides and saved cover onto this current source version.</span></div>' : ""}
    <div class="metadata-editor-body"><section class="metadata-fields-panel" aria-labelledby="metadata-fields-title"><div class="metadata-section-head"><div><h3 id="metadata-fields-title">Book details</h3><p>Turn on an override only for fields ShelfSend should replace.</p></div><span>${Object.keys(draft).length} overridden</span></div><form class="metadata-editor-form" data-metadata-book-id="${escapeHtml(editor.bookId)}" novalidate>${fields}</form><div class="metadata-panel-actions"><button type="button" data-ui-action="reset-book-metadata"${mutationDisabled || Object.keys(data.overrides).length === 0 ? " disabled" : ""}>Reset metadata</button><button type="button" class="primary" data-ui-action="save-book-metadata"${mutationDisabled ? " disabled" : ""}>${editor.busy ? "Saving…" : "Save metadata"}</button></div>${renderMetadataCandidateDiscovery(snapshot)}</section>
    <section class="metadata-cover-panel" aria-labelledby="metadata-cover-title"><div class="metadata-section-head"><div><h3 id="metadata-cover-title">Cover</h3><p>Current presentation beside the cover read from the source.</p></div>${activeCustomCover ? '<span>Custom</span>' : data.coverOverride ? '<span>Saved for prior source</span>' : '<span>Source</span>'}</div><div class="metadata-cover-comparison">${renderMetadataCover("Current cover", currentCoverUrl, activeCustomCover && data.coverOverride ? `${data.coverOverride.width} × ${data.coverOverride.height} · custom` : data.coverOverride ? "Source cover · saved custom cover is inactive" : "From source", activeCustomCover)}${renderMetadataCover("Source cover", sourceCoverUrl, "Read-only original")}</div><div class="metadata-cover-local"><label class="metadata-file-button"><input type="file" accept="image/jpeg,image/png,image/webp" data-ui-action="upload-metadata-cover"${mutationDisabled ? " disabled" : ""} /><span>Choose image…</span></label><div class="metadata-cover-dropzone" data-metadata-cover-dropzone tabindex="${mutationDisabled ? "-1" : "0"}" role="button" aria-disabled="${mutationDisabled}" aria-label="Drop or paste a cover image"><strong>Drop an image here</strong><span>or focus this area and paste a copied image</span><small>JPEG, PNG, or WebP · up to 12 MiB</small></div>${data.coverOverride ? `<button type="button" data-ui-action="reset-book-cover"${mutationDisabled ? " disabled" : ""}>Use source cover</button>` : ""}</div><div class="metadata-cover-search"><div class="metadata-cover-search-controls"><label><span>Provider</span><select id="metadata-cover-provider"${editor.busy ? " disabled" : ""}><option value="google-books"${editor.coverSearch.provider === "google-books" ? " selected" : ""}>Google Books</option><option value="open-library"${editor.coverSearch.provider === "open-library" ? " selected" : ""}>Open Library</option></select></label><label><span>Title, author, or ISBN</span><input id="metadata-cover-query" value="${escapeHtml(editor.coverSearch.query)}" autocomplete="off"${editor.busy ? " disabled" : ""} /></label><button type="button" data-ui-action="search-metadata-covers"${editor.busy || !editor.coverSearch.query.trim() ? " disabled" : ""}>Search</button></div>${renderMetadataCoverSearch(snapshot)}</div></section></div>
    ${formatNotice}${updateNote}<footer class="metadata-editor-footer"><span>Overrides and custom covers are stored under durable <code>/data</code>; torrent/source files stay untouched.</span><button type="button" data-ui-action="close-metadata-editor"${closeDisabled}>Done</button></footer></section>`;
}

function detailsFilterButton(key: keyof LibraryFilters, value: string | undefined, label: string): string {
  if (!value) return "";
  return `<button type="button" data-ui-action="book-details-filter" data-filter-key="${escapeHtml(key)}" data-filter-value="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
}

function renderBookDetails(snapshot: CatalogBrowserSnapshot, state: AppState): string {
  const details = snapshot.bookDetails;
  if (!details) return "";
  const book = details.data?.book ?? details.book;
  if (!book) {
    const failed = details.loadState === "error";
    return `<div class="library-modal-backdrop" data-ui-action="close-book-details" aria-hidden="true"></div><aside class="library-book-details-sheet compact" role="dialog" aria-modal="true" aria-labelledby="book-details-title" tabindex="-1"><button type="button" class="library-sheet-close" data-ui-action="close-book-details" aria-label="Close book details">×</button><div class="library-loading-state" role="${failed ? "alert" : "status"}"><span aria-hidden="true">${failed ? "!" : ""}</span><strong id="book-details-title">${failed ? "Book details unavailable" : "Loading book details…"}</strong><small>${escapeHtml(details.error ?? "Reading effective and source metadata")}</small></div></aside>`;
  }
  const actions = bookActionCapabilities(book, state, snapshot);
  const data = details.data;
  const overrides = new Set(Object.keys(data?.overrides ?? {}));
  const root = snapshot.rootsByProfile.get(book.profileId)?.find((candidate) => candidate.id === book.rootId);
  const source = data && "source" in data ? data.source : undefined;
  const latestDelivery = data && "latestVerifiedDelivery" in data ? data.latestVerifiedDelivery : undefined;
  const coverUrl = sameOriginCoverUrl(book);
  const kindleItems = snapshot.kindleInventory?.items.filter((item) => item.bookId === book.id) ?? [];
  const kindleLabel = actions.kindleStatus === "confirmed"
    ? "Confirmed on this Kindle"
    : actions.kindleStatus === "possible"
      ? "Possible Kindle match"
      : actions.kindleStatus === "not-on-kindle"
        ? "Not on this Kindle"
        : "Kindle presence unknown";
  const queuePrimary = !actualDeviceConnected(state) && (actions.queue.enabled || actions.queue.queued);
  const primaryAction = queuePrimary ? "add-book-to-queue" : "send-book";
  const primaryEnabled = queuePrimary ? actions.queue.enabled : actions.send.enabled;
  const primaryLabel = queuePrimary ? actions.queue.label : actions.send.label;
  const primaryReason = queuePrimary ? actions.queue.reason : actions.send.reason;
  const updateAction = book.metadataEdited || book.coverEdited
    ? `<button type="button" data-ui-action="update-book-on-kindle" data-book-id="${escapeHtml(book.id)}"${actions.update.enabled ? "" : ` disabled title="${escapeHtml(actions.update.reason ?? "Unavailable")}"`}>Update Kindle copy</button>`
    : "";
  const field = (key: keyof BookMetadataOverrides, label: string, value: string | number | undefined): string => {
    const shown = value === undefined || value === "" ? "Not set" : String(value);
    return `<div><dt>${escapeHtml(label)}${overrides.has(key) ? '<span title="Presentation override">Edited</span>' : ""}</dt><dd>${escapeHtml(shown)}</dd></div>`;
  };
  const sourceField = (label: string, value: string | number | readonly string[] | null | undefined): string => {
    const shown = Array.isArray(value) ? value.join(", ") : value;
    return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(shown === undefined || shown === null || shown === "" ? "Not set" : shown)}</dd></div>`;
  };
  const filterButtons = [
    ...book.authors.map((author) => detailsFilterButton("author", author, author)),
    book.series ? `<button type="button" data-ui-action="open-series" data-series-key="${escapeHtml(canonicalSeriesKey(book.series))}">Open ${escapeHtml(book.series)} in reading order</button>` : "",
    book.series ? detailsFilterButton("series", book.series, `Filter to ${book.series}`) : "",
    detailsFilterButton("publisher", book.publisher, book.publisher ?? ""),
    detailsFilterButton("language", book.language, book.language ? book.language.toLocaleUpperCase() : ""),
    ...book.subjects.map((subject) => detailsFilterButton("subject", subject, subject)),
  ].join("");
  return `<div class="library-modal-backdrop" data-ui-action="close-book-details" aria-hidden="true"></div><aside class="library-book-details-sheet" role="dialog" aria-modal="true" aria-labelledby="book-details-title" aria-describedby="book-details-subtitle" tabindex="-1">
    <button type="button" class="library-sheet-close" data-ui-action="close-book-details" aria-label="Close book details">×</button>
    <div class="book-details-hero"><div class="book-details-cover">${coverUrl ? `<img src="${escapeHtml(coverUrl)}" alt="Cover of ${escapeHtml(book.title)}" data-library-cover-image />` : renderBookCover(book, actions.kindleStatus, actions.kindleStatus === "unknown" && actions.currentComparison)}</div><div><div class="library-sheet-eyebrow">Effective catalog presentation</div><h2 id="book-details-title">${escapeHtml(book.title)}</h2><p id="book-details-subtitle">${escapeHtml(bookAuthor(book))}</p><div class="book-details-badges"><span>${escapeHtml(book.format.toLocaleUpperCase())}</span>${book.metadataEdited ? "<span>Metadata edited</span>" : ""}${book.coverEdited ? "<span>Custom cover</span>" : ""}${data?.sourceChanged ? "<span class=\"warning\">Source changed</span>" : ""}</div></div></div>
    ${details.error ? `<div class="book-details-warning" role="status">Some source-versus-override details could not be loaded: ${escapeHtml(details.error)}</div>` : ""}
    <section class="book-details-section" aria-labelledby="book-details-metadata"><h3 id="book-details-metadata">Book information</h3><dl class="book-details-metadata">${field("authors", "Authors", book.authors.join(", "))}${field("authorSort", "Author sort", book.authorSort)}${field("series", "Series", book.series)}${field("seriesIndex", "Series number", book.seriesIndex)}${field("publisher", "Publisher", book.publisher)}${field("publishedAt", "Published", book.publishedAt)}${field("language", "Language", book.language)}${field("identifiers", "Identifiers", book.identifiers.join(", "))}</dl>${book.description ? `<p class="book-details-description">${escapeHtml(book.description)}</p>` : ""}${filterButtons ? `<div class="book-details-filters" aria-label="Browse related books">${filterButtons}</div>` : ""}</section>
    <section class="book-details-section" aria-labelledby="book-details-source"><h3 id="book-details-source">Read-only source</h3><dl class="book-details-metadata"><div><dt>Folder</dt><dd>${escapeHtml(source?.rootLabel ?? root?.label ?? "Unknown folder")}</dd></div><div><dt>Container path</dt><dd><code>${escapeHtml(source?.rootPath ?? root?.path ?? "Unavailable")}</code></dd></div><div><dt>Source file</dt><dd><code>${escapeHtml(source?.relativePath ?? book.sourceFilename)}</code></dd></div><div><dt>File size</dt><dd>${escapeHtml(formatCatalogBytes(book.size))}</dd></div><div><dt>Source status</dt><dd>${source ? `${source.available ? "Available" : "Unavailable"} · ${source.rootStatus.replaceAll("_", " ")}` : actions.sourceAvailable ? "Available" : "Unavailable"}</dd></div>${source?.rootLastScanAt ? `<div><dt>Last source scan</dt><dd>${escapeHtml(relativeScanTime(source.rootLastScanAt))}</dd></div>` : ""}${source?.rootLastErrorCode ? `<div><dt>Source issue</dt><dd>${escapeHtml(source.rootLastErrorCode.replaceAll("_", " "))}</dd></div>` : ""}</dl>${data ? `<details class="book-details-source-metadata"><summary>Source metadata</summary><dl class="book-details-metadata">${sourceField("Title", data.sourceMetadata.title)}${sourceField("Authors", data.sourceMetadata.authors)}${sourceField("Author sort", data.sourceMetadata.authorSort)}${sourceField("Series", data.sourceMetadata.series)}${sourceField("Series number", data.sourceMetadata.seriesIndex)}${sourceField("Publisher", data.sourceMetadata.publisher)}${sourceField("Published", data.sourceMetadata.publishedAt)}${sourceField("Language", data.sourceMetadata.language)}${sourceField("Subjects", data.sourceMetadata.subjects)}${sourceField("Identifiers", data.sourceMetadata.identifiers)}</dl></details>` : ""}<p class="book-details-provenance">${data ? `${Object.keys(data.overrides).length} metadata override${Object.keys(data.overrides).length === 1 ? "" : "s"}; source revision ${data.revision}.` : "Showing effective catalog metadata; detailed source provenance is unavailable on this server."} The original file is never modified.</p></section>
    <section class="book-details-section" aria-labelledby="book-details-kindle"><h3 id="book-details-kindle">Kindle comparison</h3><p class="book-details-kindle-status" data-status="${escapeHtml(actions.kindleStatus)}">${escapeHtml(kindleLabel)}</p>${kindleItems.length ? `<ul class="book-details-kindle-files">${kindleItems.map((item) => `<li><span><strong>${escapeHtml(item.title ?? item.filename)}</strong><code>${escapeHtml(item.filename)}</code></span><small>${escapeHtml(formatCatalogBytes(item.size))} · ${item.managed ? "ShelfSend transfer" : "Existing device file"}</small>${actions.kindleStatus === "possible" ? `<button type="button" data-ui-action="open-match-review" data-item-id="${escapeHtml(item.id)}" data-book-id="${escapeHtml(book.id)}"${actions.matchReview.enabled ? "" : ` disabled title="${escapeHtml(actions.matchReview.reason ?? "Unavailable")}"`}>Review match</button>` : ""}</li>`).join("")}</ul>` : `<p class="book-details-provenance">${snapshot.kindleInventory ? `No associated object in the inventory scanned ${escapeHtml(relativeScanTime(snapshot.kindleInventory.scannedAt))}.` : "Connect a Kindle to compare this title with its Documents."}</p>${actions.kindleStatus === "possible" ? `<button type="button" data-ui-action="open-match-review" data-item-id="${escapeHtml(catalogPossibleMatchReviewId(book.id))}" data-book-id="${escapeHtml(book.id)}"${actions.matchReview.enabled ? "" : ` disabled title="${escapeHtml(actions.matchReview.reason ?? "Unavailable")}"`}>Why is this a possible match?</button>` : ""}`}${latestDelivery ? `<div class="book-details-last-delivery"><strong>Last verified transfer</strong><span>${escapeHtml(latestDelivery.filename ?? "Recorded ShelfSend transfer")} · ${latestDelivery.size === undefined ? "size not recorded" : escapeHtml(formatCatalogBytes(latestDelivery.size))} · ${escapeHtml(relativeScanTime(latestDelivery.deliveredAt))}</span><small>${latestDelivery.currentPresentation ? "Matches the current catalog presentation" : "A prior catalog presentation; use Update Kindle copy after connecting"}</small></div>` : ""}</section>
    ${renderRecordedReadingData(book.id, snapshot.kindleInventory)}
    <footer class="book-details-actions"><button type="button" class="primary" data-ui-action="${primaryAction}" data-book-id="${escapeHtml(book.id)}"${primaryEnabled ? "" : ` disabled title="${escapeHtml(primaryReason ?? "Unavailable")}"`}>${escapeHtml(primaryLabel)}</button>${updateAction}<button type="button" data-ui-action="edit-book-metadata" data-book-id="${escapeHtml(book.id)}"${actions.edit.enabled ? "" : " disabled"}>Edit metadata &amp; cover</button><button type="button" class="danger" data-ui-action="remove-book-from-kindle" data-book-id="${escapeHtml(book.id)}"${actions.remove.enabled ? "" : ` disabled title="${escapeHtml(actions.remove.reason ?? "Unavailable")}"`}>Remove from Kindle</button></footer>
  </aside>`;
}

export function renderKindleDeviceContents(
  snapshot: CatalogBrowserSnapshot,
  connected: boolean,
  inventoryState: AppState["catalogInventoryState"] = "idle",
): string {
  const inventory = snapshot.kindleInventory;
  if (!inventory) {
    return `<section class="library-device-contents" aria-labelledby="device-contents-title"><div class="library-device-contents-head"><div><span class="library-eyebrow">Device contents</span><h2 id="device-contents-title">Kindle Documents</h2></div><span class="library-inventory-chip">No inventory</span></div><div class="library-empty-state compact"><span aria-hidden="true">▯</span><h3>No Kindle inventory available</h3><p>${connected ? inventoryState === "failed" ? "The automatic inventory failed. Disconnect and reconnect the Kindle to try again." : "The connected-device scan has not completed yet." : "Connect a Kindle to read its Documents content."}</p></div></section>`;
  }
  const query = snapshot.filters.query.trim().toLocaleLowerCase();
  const matchingItems = inventory.items.filter((item) => !query || [item.title, item.author, item.filename, item.format, item.path].filter(Boolean).join(" ").toLocaleLowerCase().includes(query));
  const pageSize = 100;
  const maximumOffset = Math.max(0, Math.floor((matchingItems.length - 1) / pageSize) * pageSize);
  const offset = Math.min(maximumOffset, Math.max(0, snapshot.kindleInventoryOffset));
  const shown = matchingItems.slice(offset, offset + pageSize);
  const effectiveCompleteness = connected ? inventory.completeness : "last-seen";
  const completeness = effectiveCompleteness === "complete" ? "Complete scan" : effectiveCompleteness === "partial" ? "Partial scan" : "Last seen";
  const metadataNotice = inventory.metadata && inventory.metadata.status !== "complete"
    ? `<div class="library-stale-notice"><strong>Book metadata comparison is ${escapeHtml(inventory.metadata.status)}.</strong> ${inventory.metadata.enriched} of ${inventory.metadata.eligible} eligible Kindle files supplied matching metadata; unread files remain unknown rather than being called absent.</div>`
    : "";
  const matchingNotice = inventory.matching && inventory.matching.status !== "complete"
    ? `<div class="library-stale-notice library-matching-notice"><strong>Catalog matching is ${escapeHtml(inventory.matching.status)}.</strong> ${inventory.matching.failedProfiles} library comparison${inventory.matching.failedProfiles === 1 ? "" : "s"} could not be loaded, so missing matches remain unknown and no green check is inferred.</div>`
    : "";
  const unmatchedComparisonComplete = effectiveCompleteness === "complete"
    && !inventory.truncated
    && inventory.metadata?.status === "complete"
    && inventory.metadata.truncated === false
    && inventory.matching?.status === "complete";
  return `<section class="library-device-contents" aria-labelledby="device-contents-title"><div class="library-device-contents-head"><div><span class="library-eyebrow">Device contents</span><h2 id="device-contents-title">${escapeHtml(inventory.deviceLabel)} Documents</h2><p>${inventory.total} items · scanned ${escapeHtml(relativeScanTime(inventory.scannedAt))}</p></div><span class="library-inventory-chip" data-completeness="${effectiveCompleteness}">${escapeHtml(completeness)}</span></div>${effectiveCompleteness !== "complete" ? '<div class="library-stale-notice"><strong>This is not a complete current inventory.</strong> Green checks are shown only for confirmed matches in the supplied scan.</div>' : ""}${metadataNotice}${matchingNotice}<div class="library-device-list">${shown.map((item) => {
    const staleMatch = effectiveCompleteness === "last-seen";
    const matchTone = staleMatch ? "last-seen" : item.match;
    const matchLabel = staleMatch
      ? item.match === "unmatched" ? "Last seen unmatched" : "Last seen match"
      : item.match === "confirmed"
        ? "✓ In library"
        : item.stalePresentation
          ? "Prior ShelfSend presentation"
        : item.match === "possible"
          ? "Possible match"
          : item.managed
            ? "Managed item"
            : unmatchedComparisonComplete
              ? "Only on Kindle"
              : "Comparison unavailable";
    return `<article data-kindle-object-id="${escapeHtml(item.id)}"><span class="library-device-file-icon" aria-hidden="true">${escapeHtml((item.format ?? "DOC").slice(0, 4).toLocaleUpperCase())}</span><span><strong>${escapeHtml(item.title ?? item.filename)}</strong><small>${escapeHtml(item.author ?? item.filename)} · ${escapeHtml(formatCatalogBytes(item.size))}</small>${item.path ? `<code>${escapeHtml(item.path)}</code>` : ""}</span><span class="library-device-match" data-match="${matchTone}">${matchLabel}</span><button type="button" class="library-device-review" data-ui-action="open-match-review" data-item-id="${escapeHtml(item.id)}"${item.bookId ? ` data-book-id="${escapeHtml(item.bookId)}"` : ""}>Compare</button></article>`;
  }).join("") || '<p class="settings-empty-copy">No device items match this search.</p>'}</div>${matchingItems.length > pageSize ? `<nav class="library-pagination library-device-pagination" aria-label="Kindle content pages"><button type="button" data-ui-action="kindle-page" data-page-offset="${Math.max(0, offset - pageSize)}"${offset === 0 ? " disabled" : ""}>Previous</button><span>${offset + 1}–${Math.min(offset + pageSize, matchingItems.length)} of ${matchingItems.length}</span><button type="button" data-ui-action="kindle-page" data-page-offset="${offset + pageSize}"${offset + pageSize >= matchingItems.length ? " disabled" : ""}>Next</button></nav>` : ""}${inventory.truncated ? '<p class="library-device-truncated">The device hierarchy reached its bounded 10,000-object scan limit; this inventory is explicitly partial.</p>' : ""}</section>`;
}

const ISSUE_TYPE_LABELS = Object.freeze({
  "missing-cover": "Missing cover",
  "incomplete-metadata": "Incomplete metadata",
  "metadata-parser-failure": "Metadata parser failure",
  "low-confidence-provider-data": "Low-confidence provider result",
  "unavailable-source": "Source unavailable",
  "suspected-duplicate": "Possible duplicate",
} as const);

function issueReason(reasonCode: string): string {
  const known: Readonly<Record<string, string>> = {
    "cover-missing": "No usable cover is available for this book.",
    "core-fields-incomplete": "One or more core metadata fields could not be read.",
    "provider-candidates-low-confidence": "The latest provider lookup returned only low-confidence suggestions.",
    "source-unavailable": "The indexed source file is not currently accessible.",
    "duplicate-content-hash": "These entries have identical source content.",
    "duplicate-identifier": "These entries share an identifier such as ISBN.",
    "duplicate-title-author": "These entries have the same normalized title and author.",
  };
  return known[reasonCode] ?? reasonCode.replaceAll("-", " ").replace(/^./u, (letter) => letter.toLocaleUpperCase());
}

function renderMetadataLookupJobs(snapshot: CatalogBrowserSnapshot): string {
  const page = snapshot.metadataLookupJobs;
  const active = snapshot.activeMetadataLookupJob;
  const busy = snapshot.metadataLookupBusy;
  if (snapshot.metadataLookupState === "loading" && !page) {
    return '<section class="attention-jobs"><div class="library-loading-state compact" role="status"><span></span><strong>Loading metadata lookups…</strong></div></section>';
  }
  const summaries = page?.items ?? [];
  const detail = !active ? "" : `<section class="metadata-job-detail" aria-labelledby="metadata-job-detail-title"><header><div><span class="library-eyebrow">${escapeHtml(active.provider === "google-books" ? "Google Books" : "Open Library")}</span><h3 id="metadata-job-detail-title">Lookup job</h3><p>${active.ready} ready · ${active.pending} pending · ${active.failed} failed · ${active.noResults} without results</p></div><button type="button" data-ui-action="close-metadata-job" aria-label="Close lookup details">×</button></header>${snapshot.metadataLookupError ? `<div class="metadata-candidate-status error" role="alert">${escapeHtml(snapshot.metadataLookupError)}</div>` : ""}<div class="metadata-job-controls"><span class="metadata-job-status" data-status="${escapeHtml(active.status)}">${escapeHtml(active.status)}</span>${active.status === "paused" ? `<button type="button" data-ui-action="control-metadata-job" data-job-action="resume"${busy ? " disabled" : ""}>Resume and continue</button>` : active.status === "running" ? `<button type="button" data-ui-action="control-metadata-job" data-job-action="pause">Pause</button>` : ""}${active.status === "completed" && active.failed > 0 ? `<button type="button" data-ui-action="control-metadata-job" data-job-action="retry"${busy ? " disabled" : ""}>Retry failed</button>` : ""}${active.status !== "completed" && active.status !== "cancelled" ? `<button type="button" data-ui-action="run-metadata-job"${busy || active.status === "paused" ? " disabled" : ""}>${busy ? "Looking up books…" : "Start lookup"}</button><button type="button" class="danger" data-ui-action="control-metadata-job" data-job-action="cancel">Cancel</button>` : ""}</div><div class="metadata-job-progress"><div class="progress-track" role="progressbar" aria-label="Metadata lookup progress" aria-valuemin="0" aria-valuemax="${Math.max(1, active.total)}" aria-valuenow="${Math.max(0, active.total - active.pending)}"><span style="width:${active.total > 0 ? Math.round(100 * (active.total - active.pending) / active.total) : 0}%"></span></div><small>${active.total - active.pending} of ${active.total} checked</small></div><ol class="metadata-job-entries">${active.entries.map((entry) => {
    const book = snapshot.healthBooks.get(entry.bookId);
    const candidate = entry.candidates[0];
    return `<li data-status="${escapeHtml(entry.status)}"><span><strong>${escapeHtml(book?.title ?? `Book ${entry.rank + 1}`)}</strong><small>${escapeHtml(entry.status.replaceAll("-", " "))}${entry.errorCode ? ` · ${escapeHtml(entry.errorCode.replaceAll("-", " "))}` : ""}${entry.acceptedAt ? " · imported" : ""}</small></span>${candidate && !entry.acceptedAt ? `<button type="button" data-ui-action="review-metadata-job-candidate" data-job-id="${escapeHtml(active.id)}" data-book-id="${escapeHtml(entry.bookId)}" data-candidate-id="${escapeHtml(candidate.candidateId)}">Review ${entry.candidates.length} ${entry.candidates.length === 1 ? "suggestion" : "suggestions"}</button>` : ""}</li>`;
  }).join("")}</ol><p class="metadata-job-safety">Suggestions remain review-only. ShelfSend never changes metadata or covers until you choose fields and import them.</p></section>`;
  return `<section class="attention-jobs" aria-labelledby="metadata-jobs-title"><div class="attention-section-head"><div><h2 id="metadata-jobs-title">Metadata lookups</h2><p>Bounded provider searches for up to 100 explicitly selected books.</p></div><button type="button" data-ui-action="reload-metadata-jobs"${snapshot.metadataLookupState === "loading" ? " disabled" : ""}>Refresh</button></div>${snapshot.metadataLookupError && !active ? `<div class="metadata-candidate-status error" role="alert">${escapeHtml(snapshot.metadataLookupError)}</div>` : ""}${summaries.length === 0 ? '<div class="attention-empty compact"><strong>No lookup jobs yet</strong><span>Select books in List view and choose Find metadata.</span></div>' : `<div class="metadata-job-list">${summaries.map((job) => `<button type="button" data-ui-action="open-metadata-job" data-job-id="${escapeHtml(job.id)}"${active?.id === job.id ? ' aria-current="true"' : ""}><span><strong>${escapeHtml(job.provider === "google-books" ? "Google Books" : "Open Library")}</strong><small>${escapeHtml(relativeScanTime(job.updatedAt))}</small></span><span>${job.ready} ready / ${job.total}</span><em data-status="${escapeHtml(job.status)}">${escapeHtml(job.status)}</em></button>`).join("")}</div>`}${detail}</section>`;
}

function renderCatalogIssueContext(issue: CatalogHealthIssue, snapshot: CatalogBrowserSnapshot): string {
  const roots = issue.rootIds.map((rootId) => ({
    rootId,
    root: snapshot.rootsByProfile.get(issue.profileId)?.find(({ id }) => id === rootId),
  }));
  const labels = issue.displayLabels.length > 0
    ? `<div class="attention-issue-labels"><strong>Affected ${issue.displayLabels.length === 1 ? "entry" : "entries"}</strong>${issue.displayLabels.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}</div>`
    : '<div class="attention-issue-labels"><strong>Affected entry</strong><span>Label unavailable</span></div>';
  const rootContext = roots.length > 0
    ? `<div class="attention-issue-roots">${roots.map(({ rootId, root }) => `<span><strong>${escapeHtml(root?.label ?? `Catalog root ${rootId.slice(0, 12)}`)}</strong><code>${escapeHtml(root?.path ?? "Container path unavailable")}</code><small>${root ? escapeHtml(root.status.replaceAll("-", " ")) : "Root configuration unavailable"}</small></span>`).join("")}</div>`
    : '<div class="attention-issue-roots"><span><strong>Catalog source</strong><code>Container path unavailable</code></span></div>';
  return `<div class="attention-issue-context" aria-label="Affected source context"><span class="attention-source-state" data-available="${issue.currentAvailable}">${issue.currentAvailable ? "Current source available" : "Current source unavailable"}</span>${labels}${rootContext}</div>`;
}

function renderNeedsAttention(snapshot: CatalogBrowserSnapshot): string {
  const page = snapshot.healthPage;
  const filter = snapshot.healthFilter;
  const counts = page?.counts;
  const issues = page?.items ?? [];
  const pagination = page && page.total > page.limit
    ? `<nav class="library-pagination" aria-label="Needs attention pages"><button type="button" data-ui-action="catalog-health-page" data-page-offset="${Math.max(0, page.offset - page.limit)}"${page.offset === 0 || snapshot.healthState === "loading" ? " disabled" : ""}>Previous</button><span>${page.offset + 1}–${Math.min(page.offset + page.items.length, page.total)} of ${page.total}</span><button type="button" data-ui-action="catalog-health-page" data-page-offset="${page.offset + page.limit}"${page.offset + page.items.length >= page.total || snapshot.healthState === "loading" ? " disabled" : ""}>Next</button></nav>`
    : "";
  return `<section class="attention-page" aria-labelledby="attention-heading"><header class="attention-page-head"><div><div class="library-eyebrow">Catalog health</div><h1 id="attention-heading" tabindex="-1">Needs attention</h1><p>Fix index and presentation problems without changing a mounted source file.</p></div><div class="attention-counts" aria-label="Issue summary"><span><strong>${counts?.active ?? 0}</strong> active</span><span><strong>${counts?.bySeverity.error ?? 0}</strong> errors</span><span><strong>${counts?.ignored ?? 0}</strong> ignored</span></div></header><div class="attention-filter-bar"><label><span>Issue type</span><select id="catalog-health-type"><option value="all">All types</option>${Object.entries(ISSUE_TYPE_LABELS).map(([value, label]) => `<option value="${value}"${filter.type === value ? " selected" : ""}>${escapeHtml(label)}${counts ? ` (${counts.byType[value as keyof typeof ISSUE_TYPE_LABELS]})` : ""}</option>`).join("")}</select></label><label><span>Severity</span><select id="catalog-health-severity"><option value="all">All severities</option>${(["error", "warning", "info"] as const).map((severity) => `<option value="${severity}"${filter.severity === severity ? " selected" : ""}>${severity.replace(/^./u, (letter) => letter.toLocaleUpperCase())}${counts ? ` (${counts.bySeverity[severity]})` : ""}</option>`).join("")}</select></label><label class="attention-ignored-toggle"><input id="catalog-health-ignored" type="checkbox"${filter.ignored ? " checked" : ""} /><span>Show ignored only</span></label><button type="button" data-ui-action="reload-catalog-health"${snapshot.healthState === "loading" ? " disabled" : ""}>Refresh</button></div>${snapshot.healthError ? `<div class="metadata-candidate-status error" role="alert"><span>${escapeHtml(snapshot.healthError)}</span><button type="button" data-ui-action="reload-catalog-health">Try again</button></div>` : ""}${snapshot.healthState === "loading" && !page ? '<div class="library-loading-state" role="status"><span></span><strong>Checking catalog health…</strong><small>Deriving current issues from the durable index</small></div>' : issues.length === 0 ? `<div class="attention-empty"><span aria-hidden="true">✓</span><strong>${filter.ignored ? "No ignored issues" : "Nothing needs attention"}</strong><p>${filter.ignored ? "Ignored issues will appear here while their underlying evidence still exists." : "The current catalog has no issues matching these filters."}</p></div>` : `<ol class="attention-issue-list">${issues.map((issue) => {
    const busy = snapshot.healthBusySignature === issue.signature;
    const books = issue.bookIds.map((bookId) => snapshot.healthBooks.get(bookId));
    const canLookup = issue.type === "missing-cover" || issue.type === "incomplete-metadata" || issue.type === "low-confidence-provider-data";
    const preferred = issue.disposition.preferredBookId;
    return `<li class="attention-issue" data-severity="${escapeHtml(issue.severity)}"><header><span class="attention-severity" aria-label="${escapeHtml(issue.severity)}"></span><div><span class="library-eyebrow">${escapeHtml(issue.severity)}</span><h2>${escapeHtml(ISSUE_TYPE_LABELS[issue.type])}</h2><p>${escapeHtml(issueReason(issue.reasonCode))}</p></div><time datetime="${escapeHtml(issue.lastObservedAt)}">${escapeHtml(relativeScanTime(issue.lastObservedAt))}</time></header>${renderCatalogIssueContext(issue, snapshot)}${books.length ? `<ul class="attention-issue-books">${issue.bookIds.map((bookId, index) => {
      const book = books[index];
      const preferredBook = preferred === bookId;
      return `<li${preferredBook ? ' data-preferred="true"' : ""}><span><strong>${escapeHtml(book?.title ?? `Catalog book ${bookId.slice(0, 12)}`)}</strong><small>${escapeHtml(book ? bookAuthor(book) : bookId)}${preferredBook ? " · preferred entry" : ""}</small></span>${issue.type === "suspected-duplicate" ? `<button type="button" data-ui-action="set-duplicate-preference" data-issue-signature="${escapeHtml(issue.signature)}" data-book-id="${escapeHtml(bookId)}" aria-pressed="${preferredBook}"${busy ? " disabled" : ""}>${preferredBook ? "Preferred" : "Keep this entry"}</button>` : `<button type="button" data-ui-action="review-issue-metadata" data-book-id="${escapeHtml(bookId)}"${busy ? " disabled" : ""}>Review metadata</button>`}</li>`;
    }).join("")}</ul>` : ""}<footer><span>${issue.disposition.lastRetryAt ? `Last retry ${escapeHtml(relativeScanTime(issue.disposition.lastRetryAt))} · ${issue.disposition.retryCount} ${issue.disposition.retryCount === 1 ? "attempt" : "attempts"}` : "Not retried yet"}</span><div>${issue.type === "suspected-duplicate" && preferred ? `<button type="button" data-ui-action="set-duplicate-preference" data-issue-signature="${escapeHtml(issue.signature)}" data-book-id=""${busy ? " disabled" : ""}>Clear preference</button>` : ""}${canLookup ? `<button type="button" data-ui-action="lookup-issue-metadata" data-issue-signature="${escapeHtml(issue.signature)}" data-provider="open-library"${busy || issue.disposition.ignored ? " disabled" : ""}>Find metadata</button>` : ""}${issue.rootIds.length ? `<button type="button" data-ui-action="retry-catalog-issue" data-issue-signature="${escapeHtml(issue.signature)}"${busy || issue.disposition.ignored ? " disabled" : ""}>${busy ? "Requesting…" : "Retry / rescan"}</button>` : ""}<button type="button"${issue.disposition.ignored ? "" : ' class="danger"'} data-ui-action="set-catalog-issue-ignored" data-issue-signature="${escapeHtml(issue.signature)}" data-ignored="${issue.disposition.ignored ? "false" : "true"}"${busy ? " disabled" : ""}>${issue.disposition.ignored ? "Restore" : issue.type === "suspected-duplicate" ? "Reject grouping" : "Ignore"}</button></div></footer></li>`;
  }).join("")}</ol>`}${pagination}${renderMetadataLookupJobs(snapshot)}</section>`;
}

function activityActionLabel(action: KindleBridgeActivityEvent["action"]): string {
  if (action === "open-queue") return "Open queue";
  if (action === "retry-transfer") return "Retry unsent";
  if (action === "open-attention") return "Needs attention";
  if (action === "reconnect") return "Reconnect";
  if (action === "rescan") return "Review sources";
  if (action === "open-settings") return "Open Settings";
  return "Retry";
}

function activityActionAttributes(
  event: KindleBridgeActivityEvent,
  state: AppState,
  snapshot: CatalogBrowserSnapshot,
): string {
  if (event.action !== "retry-transfer") return "";
  const projected = bulkBookActionCapabilities(
    snapshot.page?.items ?? [],
    snapshot.selectedBookIds,
    state,
    snapshot,
  );
  const enabled = snapshot.layout === "list" && projected.send.enabled;
  const reason = snapshot.layout !== "list" || snapshot.selectedBookIds.size === 0
    ? "Return to List view with the unsent books selected before retrying"
    : projected.send.reason ?? "The unsent books are not currently eligible to retry";
  return enabled
    ? ""
    : ` disabled title="${reason}"`;
}

function renderActivityCenter(state: AppState, snapshot: CatalogBrowserSnapshot): string {
  if (!snapshot.activityOpen) return "";
  const status = projectKindleBridgeActivityCenter(state, snapshot);
  const history = buildKindleBridgeActivityHistory(snapshot.activityEvents, status.phase);
  const phaseLabel = `${status.phase.replaceAll("-", " ").replace(/^./u, (letter) => letter.toLocaleUpperCase())}${status.newlyIndexed ? ` · ${status.newlyIndexed} newly indexed` : ""}`;
  const capacity = status.freeBytes === undefined
    ? "Connect a Kindle to see free space"
    : `${formatCatalogBytes(Number(status.freeBytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : status.freeBytes))} free${status.capacityBytes === undefined ? "" : ` of ${formatCatalogBytes(Number(status.capacityBytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : status.capacityBytes))}`}`;
  const connectSupported = state.secureContext && state.webUsbAvailable;
  const metadataLookup = status.metadataLookupJob;
  const metadataLookupFact = metadataLookup
    ? `<div class="activity-metadata-job" data-job-status="${escapeHtml(metadataLookup.status)}"><dt>Metadata lookup</dt><dd><strong>${metadataLookup.provider === "google-books" ? "Google Books" : "Open Library"} · ${escapeHtml(metadataLookup.status)}</strong><span>${metadataLookup.ready} ready · ${metadataLookup.pending} pending · ${metadataLookup.failed} failed · ${metadataLookup.noResults} without results</span><button type="button" data-ui-action="open-activity-metadata-job" data-job-id="${escapeHtml(metadataLookup.id)}">Open in Needs Attention</button></dd></div>`
    : "";
  return `<div class="library-modal-backdrop" data-ui-action="close-activity-center" aria-hidden="true"></div><aside class="library-activity-sheet" role="dialog" aria-modal="true" aria-labelledby="activity-center-title" tabindex="-1"><button type="button" class="library-sheet-close" data-ui-action="close-activity-center" aria-label="Close activity center">×</button><header><div class="library-sheet-eyebrow">Current work</div><h2 id="activity-center-title">Activity &amp; device</h2><p>Plain-language status for this browser, Kindle, and the selected library.</p></header><section class="activity-current" data-phase="${escapeHtml(status.phase)}"><span class="activity-current-icon" aria-hidden="true">${status.phase === "ready" ? "✓" : status.phase === "needs-attention" ? "!" : status.phase === "disconnected" ? "▯" : "↻"}</span><div><strong>${escapeHtml(phaseLabel)}</strong><span>${status.currentTitle ? `${status.batchPosition ? `Book ${status.batchPosition} of ${status.batchTotal}: ` : ""}${escapeHtml(status.currentTitle)}` : status.phase === "disconnected" ? "No Kindle is connected" : `${escapeHtml(status.deviceLabel)} · ${capacity}`}</span>${status.currentProgress === undefined ? "" : `<div class="progress-track" role="progressbar" aria-label="Current book progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${status.currentProgress}"><span style="width:${status.currentProgress}%"></span></div>`}</div></section><dl class="activity-facts"><div><dt>Send later</dt><dd>${status.queueCount} ${status.queueCount === 1 ? "book" : "books"} · ${formatCatalogBytes(status.queuedSourceBytes)}${status.approximateQueueCapacity === "unknown" ? " estimated" : status.approximateQueueCapacity === "fits" ? " · likely fits" : " · may exceed free space"}</dd></div><div><dt>Kindle inventory</dt><dd>${status.lastInventoryAt ? `${escapeHtml(relativeScanTime(status.lastInventoryAt))} · ${escapeHtml(status.inventoryCompleteness ?? "unknown")}` : "Not read in this session"}</dd></div><div><dt>Library index</dt><dd>${status.indexedBooks} books · ${status.scanningRoots ? `${status.scanningRoots} scanning` : "watching"}${status.sourceWarnings ? ` · ${status.sourceWarnings} source warnings` : ""}</dd></div>${metadataLookupFact}<div><dt>Needs attention</dt><dd>${snapshot.healthPage?.counts.active ?? 0} current catalog issues</dd></div></dl><div class="activity-quick-actions"><button type="button" data-ui-action="open-send-queue">Open Send later</button><button type="button" data-ui-view="attention">Needs attention</button>${status.phase === "disconnected" ? `<button type="button" class="primary" data-ui-action="connect-catalog-device"${connectSupported ? "" : " disabled"}>Connect Kindle</button>` : ""}</div><section class="activity-history" aria-labelledby="activity-history-title"><div class="attention-section-head"><div><h3 id="activity-history-title">Recent activity</h3><p>Bounded to the latest 100 events in this browser.</p></div><button type="button" data-ui-action="clear-activity-history"${history.events.length === 0 ? " disabled" : ""}>Clear</button></div>${history.events.length === 0 ? '<div class="attention-empty compact"><strong>No recent results</strong><span>Transfers, removals, scans, lookups, and actionable failures will appear here.</span></div>' : `<ol>${history.events.slice(0, 20).map((event) => `<li data-tone="${escapeHtml(event.tone)}"${event.acknowledged ? ' data-acknowledged="true"' : ""}><span aria-hidden="true"></span><div><strong>${escapeHtml(event.title)}</strong>${event.detail ? `<small>${escapeHtml(event.detail)}</small>` : ""}<time datetime="${escapeHtml(event.at)}">${escapeHtml(relativeScanTime(event.at))}</time></div>${event.action ? `<button type="button" data-ui-action="activity-event-action" data-event-action="${escapeHtml(event.action)}" data-event-id="${escapeHtml(event.id)}"${activityActionAttributes(event, state, snapshot)}>${escapeHtml(activityActionLabel(event.action))}</button>` : !event.acknowledged ? `<button type="button" data-ui-action="acknowledge-activity" data-event-id="${escapeHtml(event.id)}" aria-label="Dismiss ${escapeHtml(event.title)}">×</button>` : ""}</li>`).join("")}</ol>`}</section><details class="activity-advanced"><summary>Advanced diagnostics</summary><div><p>Detailed debug and Kindle metadata-cache diagnostics stay out of the everyday interface.</p><div class="activity-advanced-actions"><button type="button" data-action="copy-log">Copy full debug log</button><button type="button" data-ui-action="export-activity-report">Download activity report</button></div><div data-ui-partial-object-probe></div></div></details></aside>`;
}

function renderToolbar(snapshot: CatalogBrowserSnapshot): string {
  const ui = snapshot.filters;
  const facets = snapshot.facets;
  const displayedSort = ui.view === "recent" ? "recent" : ui.sort;
  return `<section class="library-toolbar" aria-label="Search, sort, and filter books">
    <label class="library-search"><span class="sr-only">Search books</span><span aria-hidden="true">${libraryIcon("search")}</span><input id="library-search" type="search" value="${escapeHtml(ui.query)}" placeholder="Search title, author, series, subject, or ISBN…" autocomplete="off" /></label>
    <details class="library-more-filters"><summary>${libraryIcon("settings")} Filters</summary><div>    <label><span>author</span><input id="library-author" list="library-author-options" value="${escapeHtml(ui.author === "all" ? "" : ui.author)}" placeholder="All authors" autocomplete="off" />${renderDatalist("library-author-options", facets.authors)}</label>
    <label><span>language</span><select id="library-language">${renderOptions(facets.languages, ui.language, "All languages")}</select></label>
    <label><span>Kindle status</span><select id="library-kindle-filter"><option value="all"${ui.kindle === "all" ? " selected" : ""}>Any Kindle status</option><option value="on-kindle"${ui.kindle === "on-kindle" ? " selected" : ""}>On Kindle</option><option value="not-on-kindle"${ui.kindle === "not-on-kindle" ? " selected" : ""}>Not on Kindle</option><option value="possible"${ui.kindle === "possible" ? " selected" : ""}>Possible match</option><option value="unknown"${ui.kindle === "unknown" ? " selected" : ""}>Not yet compared</option></select></label>
    ${snapshot.readingEnabled ? `<label><span>Reading status</span><select id="library-reading-filter">${[["any","Any reading status"],["unread","Unread"],["in-progress","In progress"],["read","Read"],["unknown","Unknown"]].map(([value,label]) => `<option value="${value}"${(snapshot.readingFilter ?? "any") === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>` : ""}

<label><span>Subject</span><input id="library-subject" list="library-subject-options" value="${escapeHtml(ui.subject === "all" ? "" : ui.subject)}" placeholder="All subjects" autocomplete="off" />${renderDatalist("library-subject-options", facets.subjects)}</label><label><span>Publisher</span><input id="library-publisher" list="library-publisher-options" value="${escapeHtml(ui.publisher === "all" ? "" : ui.publisher)}" placeholder="All publishers" autocomplete="off" />${renderDatalist("library-publisher-options", facets.publishers)}</label><label><span>Series</span><input id="library-series" list="library-series-options" value="${escapeHtml(ui.series === "all" ? "" : ui.series)}" placeholder="All series" autocomplete="off" />${renderDatalist("library-series-options", facets.series)}</label><label><span>Publication year</span><select id="library-year">${renderOptions(facets.years, ui.year, "All years")}</select></label><label><span>Format</span><select id="library-format">${renderOptions(facets.formats, ui.format, "All formats")}</select></label><label><span>Source folder</span><select id="library-root-filter">${renderOptions(facets.roots, ui.rootId, "All folders")}</select></label><label><span>Metadata</span><select id="library-metadata"><option value="all"${ui.metadata === "all" ? " selected" : ""}>Any metadata</option><option value="complete"${ui.metadata === "complete" ? " selected" : ""}>Complete metadata</option><option value="partial"${ui.metadata === "partial" ? " selected" : ""}>Missing metadata</option></select></label></div></details>
        <label><span class="sr-only">Sort books</span><select id="library-sort"${ui.view === "recent" ? " disabled" : ""}><option value="recent"${displayedSort === "recent" ? " selected" : ""}>Added newest</option><option value="title"${displayedSort === "title" ? " selected" : ""}>Title A–Z</option><option value="author"${displayedSort === "author" ? " selected" : ""}>Author A–Z</option><option value="series"${displayedSort === "series" ? " selected" : ""}>Series A–Z</option><option value="series-index"${displayedSort === "series-index" ? " selected" : ""}>Series reading order</option><option value="published"${displayedSort === "published" ? " selected" : ""}>Publication date</option><option value="size"${displayedSort === "size" ? " selected" : ""}>File size</option></select></label>
  </section>
  <nav class="library-quick-tabs" aria-label="Quick Kindle filters">${([["all", "All books"], ["on-kindle", "On Kindle"], ["not-on-kindle", "Not on Kindle"]] as const).map(([value, label]) => `<button type="button" data-ui-kindle-filter="${value}" aria-pressed="${ui.kindle === value}">${label}</button>`).join("")}
  </nav>`;
}

function sourceSummary(snapshot: CatalogBrowserSnapshot): { readonly title: string; readonly detail: string; readonly tone: string } {
  if (snapshot.loadState === "loading") return { title: "Connecting to catalog…", detail: "Loading household libraries", tone: "loading" };
  if (snapshot.loadState === "error") return { title: "Catalog service unavailable", detail: "Open Settings or retry the connection", tone: "error" };
  if (snapshot.serviceStatus?.database === "error" || snapshot.serviceStatus?.state === "unavailable") {
    return { title: "Catalog database unavailable", detail: "Durable storage needs operator attention", tone: "error" };
  }
  if (snapshot.serviceStatus?.cache === "degraded") {
    return { title: "Derived cache degraded", detail: "Books are retained; covers and source snapshots will retry", tone: "warning" };
  }
  const profile = activeProfile(snapshot);
  if (!profile) return snapshot.profiles.length > 0
    ? { title: "No library enabled", detail: "Enable a library in Settings", tone: "warning" }
    : { title: "No library configured", detail: "Create one in Settings", tone: "warning" };
  if (snapshot.stale) return { title: "Catalog connection interrupted", detail: "Showing previous browser results", tone: "warning" };
  if (snapshot.booksState === "error" && !snapshot.page) {
    return { title: "Library unavailable", detail: snapshot.error ?? "The selected library could not be loaded", tone: "error" };
  }
  const roots = snapshot.rootsByProfile.get(profile.id) ?? [];
  if (!snapshot.rootsByProfile.has(profile.id) || (snapshot.booksState === "loading" && !snapshot.page)) {
    return { title: "Loading library sources…", detail: "Checking container folders", tone: "loading" };
  }
  const enabledRoots = roots.filter((root) => root.enabled);
  if (roots.length > 0 && enabledRoots.length === 0) return { title: "No library sources enabled", detail: "Enable a container folder in Settings", tone: "warning" };
  if (profile.rootCount === 0) return { title: "No library sources configured", detail: "Add a container folder in Settings", tone: "warning" };
  if (enabledRoots.some((root) => root.status === "scanning") || snapshot.serviceStatus?.state === "indexing") {
    return { title: "Indexing library…", detail: "New and changed books will appear automatically", tone: "loading" };
  }
  const enabledRootCount = roots.length > 0 ? enabledRoots.length : profile.rootCount;
  if (profile.availableRootCount === 0 && enabledRootCount > 0) return { title: "Library sources unavailable", detail: `${enabledRootCount} enabled container folders`, tone: "error" };
  if (profile.availableRootCount < enabledRootCount) return { title: "Some sources unavailable", detail: `${profile.availableRootCount} of ${enabledRootCount} enabled sources available`, tone: "warning" };
  const rootsNeedingAttention = roots.filter((root) => root.enabled && root.lastErrorCode);
  if (rootsNeedingAttention.length > 0) {
    return {
      title: rootsNeedingAttention.some((root) => root.lastErrorCode?.startsWith("source_errors:"))
        ? "Some books could not be indexed"
        : "Library source needs attention",
      detail: `Review ${rootsNeedingAttention.length} source ${rootsNeedingAttention.length === 1 ? "warning" : "warnings"} in Settings`,
      tone: "warning",
    };
  }
  const allWatched = enabledRoots.every((root) => root.watch && root.status === "watching");
  return {
    title: "Library index up to date",
    detail: allWatched
      ? (snapshot.liveUpdatesConnected ? "Watching container folders" : "Live updates reconnecting…")
      : "Scheduled folder checks active",
    tone: "ok",
  };
}

export function renderLibraryPrototype(
  state: AppState,
  snapshot: CatalogBrowserSnapshot,
  topAlertsHtml = "",
): string {
  const profile = activeProfile(snapshot);
  const counts = countLibraryBooks(
    profile,
    snapshot.page,
    snapshot.kindleStatus,
    snapshot.kindleStatusCountsByProfile,
  );
  const connected = actualDeviceConnected(state);
  const connecting = deviceConnecting(state);
  const disconnecting = deviceDisconnecting(state);
  const webUsbUsable = state.secureContext && state.webUsbAvailable;
  const compatibilityNotice = webUsbUsable
    ? ""
    : `<div class="notice warning library-compatibility-notice" role="status"><div><strong>Kindle connection unavailable</strong>${state.secureContext
      ? "Use Chrome or another WebUSB-compatible Chromium browser."
      : "Open ShelfSend over trusted HTTPS or localhost."} Browsing, metadata editing, and Send later remain available.</div></div>`;
  const visibleTopAlerts = `${topAlertsHtml}${compatibilityNotice}`;
  const safeWritePassed = state.selfTest.kind === "passed";
  const ready = deviceReadyToSend(state, snapshot);
  const currentComparison = connected
    && state.catalogInventoryState === "ready"
    && currentKindleComparison(snapshot);
  const sendSummary = currentComparison
    ? `<strong>${counts.readyToSend}</strong> ready to send`
    : `<strong>—</strong> ${connecting || connected ? "checking inventory" : "connect to compare"}`;
  const source = sourceSummary(snapshot);
  const activityStatus = projectKindleBridgeActivityCenter(state, snapshot);
  const activityHistory = buildKindleBridgeActivityHistory(snapshot.activityEvents, activityStatus.phase);
  const activityAttention = activityHistory.needsAttention
    + (snapshot.healthPage?.counts.active ?? 0)
    + activityStatus.replacementCleanupCount;
  const activityLabel = activityStatus.phase.replaceAll("-", " ").replace(/^./u, (letter) => letter.toLocaleUpperCase());
  const heading = snapshot.filters.view === "on-kindle" ? "Books on Kindle" : snapshot.filters.view === "recent" ? "Recently added" : profile?.name ?? "Household library";
  const roots = profile ? snapshot.rootsByProfile.get(profile.id) ?? [] : [];
  const enabledRoots = roots.filter((root) => root.enabled);
  const sourceCardDetail = enabledRoots.length === 0
    ? (roots.length === 0 ? "No folders configured" : "No folders enabled")
    : enabledRoots.some((root) => root.status === "scanning")
      ? "Scanning for changes"
      : enabledRoots.some((root) => root.lastErrorCode || root.status === "paused")
      ? "Scheduled checks continue"
      : "Monitoring automatically";
  const deviceTitle = disconnecting
    ? "Disconnecting Kindle…"
    : connected
      ? "Kindle connected"
      : connecting
        ? "Connecting Kindle…"
        : !state.secureContext
          ? "HTTPS required"
          : !state.webUsbAvailable
            ? "WebUSB unavailable"
            : "Connect Kindle";
  const deviceDetail = disconnecting
    ? "Closing the MTP session…"
    : connected
      ? state.postConnectStage === "safe-write"
        ? "Checking safe writes…"
        : state.postConnectStage === "inventory"
          ? "Reading Kindle Documents…"
          : state.postConnectStage === "reconciliation"
            ? "Comparing Kindle with library…"
            : state.pendingObjectCleanup
              ? "Recovery inspection required"
              : ready ? "Safe-write and inventory checks passed" : "Kindle inventory unavailable"
      : webUsbUsable ? "Plug in over USB" : "Library access is still available";
  const kindleSummaryDetail = disconnecting
    ? "Closing the MTP session and releasing USB"
    : connected
      ? state.postConnectStage === "safe-write"
        ? "Checking safe writes…"
        : state.postConnectStage === "inventory"
          ? safeWritePassed ? "Safe-write passed; reading Documents inventory…" : "Reading Documents for recovery…"
          : state.postConnectStage === "reconciliation"
            ? "Kindle inventory read; comparing it with this library…"
            : state.pendingObjectCleanup
              ? "Inspect and acknowledge the recorded object before safe writes resume"
              : ready ? "Exact-byte safe-write and inventory checks passed" : "Inventory unavailable; disconnect and reconnect to retry"
      : "Connect to build a current Documents inventory";
  const disconnectBlocked = disconnecting || snapshot.sendBusy || state.postConnectStage !== "idle" || state.selfTest.kind === "running";
  const kindleConnectionButton = connected
    ? `<button type="button" data-ui-action="disconnect-catalog-device"${disconnectBlocked ? " disabled" : ""}>${disconnecting ? "Disconnecting…" : snapshot.sendBusy ? "Transfer in progress…" : "Disconnect"}</button>`
    : `<button type="button" data-ui-action="connect-catalog-device"${webUsbUsable ? "" : ' disabled aria-disabled="true" title="Kindle connection requires a secure page and a WebUSB-compatible browser"'}>Connect Kindle</button>`;
  return `<div class="library-workspace"><header class="library-topbar"><span class="library-breadcrumb">Your library <span aria-hidden="true">/</span> ${escapeHtml(profile?.name ?? "Getting started")}</span><div class="library-topbar-status" data-status="${source.tone}"><span class="library-source-dot"></span><span>${escapeHtml(source.title)}</span><small>${escapeHtml(source.detail)}</small></div><button type="button" class="library-activity-button" data-ui-action="open-activity-center" aria-expanded="${snapshot.activityOpen}" aria-label="Open activity and device center${activityAttention ? `, ${activityAttention} items need attention` : ""}"><span class="library-source-dot" data-status="${escapeHtml(activityStatus.phase)}"></span><span><strong>${escapeHtml(activityLabel)}</strong><small>Activity${activityAttention ? ` · ${activityAttention}` : ""}</small></span></button><button type="button" class="library-queue-button" data-ui-action="open-send-queue" aria-label="Open Send later queue">${libraryIcon("queue")}<strong>${snapshot.sendQueue?.total ?? 0}</strong><small>Send later</small></button><button type="button" class="library-device-button${connected ? " connected" : ""}" data-ui-action="${connected ? "show-kindle" : "connect-catalog-device"}"${connecting || disconnecting || (!connected && !webUsbUsable) ? " disabled" : ""}><span class="library-device-icon" aria-hidden="true">${libraryIcon("device")}</span><span><strong>${deviceTitle}</strong><small>${deviceDetail}</small></span></button></header>
    ${visibleTopAlerts ? `<div class="library-global-alerts">${visibleTopAlerts}</div>` : ""}
    <div class="library-layout" data-density="${escapeHtml(snapshot.density ?? "comfortable")}"><aside class="library-sidebar" aria-label="Library profiles and views"><a class="library-brand" href="#library" aria-label="ShelfSend library home"><span class="library-brand-mark" aria-hidden="true">${libraryIcon("shelfSend")}</span><span><strong>ShelfSend</strong><small>Browser to reader</small></span></a><div class="library-sidebar-label">Household</div><div class="library-profile-list">${renderProfileRail(snapshot)}</div><div class="library-sidebar-label library-views-label">Browse</div><nav class="library-nav" aria-label="Library views">${renderLibraryNav(snapshot)}</nav>${renderSmartShelfRail(snapshot)}<div class="library-sidebar-bottom"><button type="button" class="library-nav-item settings${snapshot.filters.view === "settings" ? " active" : ""}" data-ui-view="settings"${snapshot.filters.view === "settings" ? ' aria-current="page"' : ""}>${libraryIcon("settings")}<span>Settings</span></button><div class="library-source-card"><div class="library-source-card-head"><span class="library-source-icon" aria-hidden="true">⇄</span><span><strong>Container folders</strong><small>${sourceCardDetail}</small></span></div><div class="library-source-progress"><span style="width:${enabledRoots.length ? Math.round(100 * (profile?.availableRootCount ?? 0) / enabledRoots.length) : 0}%"></span></div><p><span>${profile?.bookCount ?? 0} indexed</span><span>${profile ? `${profile.availableRootCount}/${enabledRoots.length} enabled available · ${profile.rootCount} configured` : "Not configured"}</span></p></div><p class="library-profile-note">No sign-in required. Profiles organize views; they are not access controls.</p><div class="library-sidebar-sync" data-status="${source.tone}"><span class="library-source-dot"></span><span>${escapeHtml(source.title)}<small>${escapeHtml(source.detail)}</small></span></div></div></aside>
    <main class="library-main" id="library">${renderOnboarding(snapshot, state)}${snapshot.loadState === "error" && snapshot.profiles.length === 0 ? `<div class="library-empty-state library-error-state" role="alert"><span aria-hidden="true">!</span><h1>Catalog service unavailable</h1><p>${escapeHtml(snapshot.error ?? "ShelfSend could not reach its catalog service.")}</p><button type="button" data-ui-action="retry-catalog">Try again</button></div>` : snapshot.filters.view === "settings" ? renderLibrarySettings(snapshot) : snapshot.filters.view === "series" ? renderSeriesBrowser(snapshot, state) : snapshot.filters.view === "attention" ? renderNeedsAttention(snapshot) : `${renderActiveShelf(snapshot)}<section class="library-hero" aria-labelledby="library-heading"><div><div class="library-eyebrow">${escapeHtml(profile?.description ?? "A space for your stories")}</div><h1 id="library-heading">${escapeHtml(heading)}</h1><p>${profile?.bookCount ?? 0} books from <strong>${escapeHtml(profile?.sourceLabel ?? "configured sources")}</strong></p></div><div class="library-stat-row" aria-label="Library summary"><span><strong>${counts.onKindle}</strong> matched here</span><span><strong>${counts.possible}</strong> possible</span><span>${sendSummary}</span></div></section>${snapshot.filters.view === "on-kindle" ? `<section class="library-kindle-summary" aria-label="Kindle summary"><span class="library-kindle-summary-icon" aria-hidden="true">▯</span><div><strong>${disconnecting ? "Disconnecting Kindle" : connected ? "Kindle connected" : "Kindle not connected"}</strong><span>${kindleSummaryDetail}</span></div><div class="library-kindle-summary-stats"><span><strong>${counts.onKindle}</strong> confirmed</span><span><strong>${counts.possible}</strong> possible</span></div>${kindleConnectionButton}</section>` : ""}${renderToolbar(snapshot)}<section class="library-results" aria-live="polite">${renderLibraryResults(state, snapshot)}</section>${snapshot.filters.view === "on-kindle" ? renderKindleDeviceContents(snapshot, connected, state.catalogInventoryState) : ""}`}${snapshot.announcement ? `<div class="library-toast" role="status"><span class="library-toast-check">✓</span><span>${escapeHtml(snapshot.announcement)}</span><button type="button" data-ui-action="dismiss-announcement" aria-label="Dismiss notification">×</button></div>` : ""}${renderSendPreview(state, snapshot)}${renderRemovalConfirmation(snapshot)}${renderUpdateConfirmation(snapshot)}${renderMetadataEditor(snapshot, state)}${renderBookDetails(snapshot, state)}${renderMatchReview(snapshot, state)}${renderSendQueue(snapshot, state)}${renderShelfManager(snapshot)}${renderActivityCenter(state, snapshot)}</main></div></div>`;
}
