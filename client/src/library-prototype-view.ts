import type { CatalogBrowserSnapshot } from "./catalog-browser";
import type { CatalogBook, CatalogFilterOption, CatalogProfile } from "./catalog-client";
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

function coverClass(bookId: string): string {
  const choices = ["cover-terracotta", "cover-night", "cover-moss", "cover-sea", "cover-rose", "cover-plum", "cover-sand", "cover-cobalt", "cover-crimson", "cover-meadow"];
  let hash = 0;
  for (const character of bookId) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return choices[hash % choices.length];
}

function activeProfile(snapshot: CatalogBrowserSnapshot): CatalogProfile | undefined {
  return snapshot.profiles.find((profile) => profile.id === snapshot.filters.profileId && profile.enabled);
}

function actualDeviceConnected(state: AppState): boolean {
  return state.device.kind === "ready" || state.device.kind === "transferring" || state.device.kind === "recovering";
}

function deviceConnecting(state: AppState): boolean {
  return state.device.kind === "requesting-permission" || state.device.kind === "opening" || state.device.kind === "mtp-reading";
}

function deviceDisconnecting(state: AppState): boolean {
  return state.device.kind === "recovering";
}

function currentKindleComparison(snapshot: CatalogBrowserSnapshot, profileId = snapshot.filters.profileId): boolean {
  return snapshot.kindleInventory !== undefined
    && snapshot.kindleInventory.completeness !== "last-seen"
    && snapshot.kindleInventory.matching?.status !== "unavailable"
    && (profileId === undefined || snapshot.kindleStatusCountsByProfile.has(profileId));
}

function deviceReadyToSend(state: AppState, snapshot: CatalogBrowserSnapshot): boolean {
  return state.device.kind === "ready"
    && state.selfTest.kind === "passed"
    && state.catalogInventoryState === "ready"
    && snapshot.kindleInventory?.completeness === "complete"
    && currentKindleComparison(snapshot)
    && !state.pendingObjectCleanup;
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
    ["all", "▦", "All books", profile?.bookCount ?? 0],
    ["on-kindle", "✓", "On Kindle", counts.onKindle || undefined],
    ["recent", "+", "Recently added", undefined],
    ["settings", "⚙", "Settings", undefined],
  ];
  return items.map(([view, icon, label, count]) => `
    <button type="button" class="library-nav-item${snapshot.filters.view === view ? " active" : ""}${view === "settings" ? " settings" : ""}" data-ui-view="${view}"${snapshot.filters.view === view ? ' aria-current="page"' : ""}>
      <span class="library-nav-icon" aria-hidden="true">${icon}</span>
      <span>${escapeHtml(label)}</span>
      ${count === undefined ? "" : `<span class="library-nav-count">${count}</span>`}
    </button>
  `).join("");
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
    ui.kindle === "all" ? "" : ui.kindle === "on-kindle" ? "On Kindle" : ui.kindle === "possible" ? "Possible match" : "Not on Kindle",
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
    : status === "possible"
      ? '<span class="library-kindle-check possible" role="img" aria-label="Possible Kindle match" title="Possible Kindle match">?</span>'
      : currentUnknown
        ? '<span class="library-kindle-check unknown" role="img" aria-label="Kindle presence could not be verified" title="Kindle presence could not be verified">!</span>'
      : "";
  if (coverUrl) {
    return `<div class="library-cover library-cover-image ${coverClass(book.id)}"><img src="${escapeHtml(coverUrl)}" alt="" loading="lazy" data-library-cover-image /><span class="library-cover-kicker" data-library-cover-fallback hidden aria-hidden="true">${book.metadataComplete ? escapeHtml(book.format) : "Metadata incomplete"}</span><strong data-library-cover-fallback hidden aria-hidden="true">${escapeHtml(book.title)}</strong><span class="library-cover-author" data-library-cover-fallback hidden aria-hidden="true">${escapeHtml(bookAuthor(book))}</span><span class="library-cover-rule" data-library-cover-fallback hidden aria-hidden="true"></span>${badge}</div>`;
  }
  return `<div class="library-cover ${coverClass(book.id)}" aria-hidden="true"><span class="library-cover-kicker">${book.metadataComplete ? escapeHtml(book.format) : "Metadata incomplete"}</span><strong>${escapeHtml(book.title)}</strong><span class="library-cover-author">${escapeHtml(bookAuthor(book))}</span><span class="library-cover-rule"></span>${badge}</div>`;
}

function renderBookCard(book: CatalogBook, snapshot: CatalogBrowserSnapshot, state: AppState): string {
  const status = effectiveKindleStatus(book, snapshot.kindleStatus);
  const confirmed = status === "confirmed";
  const possible = status === "possible";
  const currentUnknown = status === "unknown" && currentKindleComparison(snapshot, book.profileId);
  const root = snapshot.rootsByProfile.get(book.profileId)?.find((candidate) => candidate.id === book.rootId);
  const sourceHealthy = root?.enabled === true && ["available", "watching", "paused", "scanning"].includes(root.status);
  const available = book.available !== false && sourceHealthy;
  const ready = deviceReadyToSend(state, snapshot);
  const connected = actualDeviceConnected(state);
  const connecting = deviceConnecting(state);
  const sendLabel = confirmed
    ? "✓ On Kindle"
    : possible
      ? "Possible match"
    : !available
      ? "Source unavailable"
      : currentUnknown
        ? "Could not verify"
        : ready
          ? "Send to Kindle"
          : connecting
            ? "Connecting Kindle…"
            : connected
              ? state.selfTest.kind === "passed" ? "Inventory unavailable" : "Checking Kindle…"
              : "Connect to send";
  const deviceBlocksSend = !ready || currentUnknown || possible;
  return `
    <article class="library-book-card" data-book-id="${escapeHtml(book.id)}">
      ${renderBookCover(book, status, currentUnknown)}
      <div class="library-card-copy">
        <h3>${escapeHtml(book.title)}</h3>
        <p>${escapeHtml(bookAuthor(book))}</p>
        <div class="library-book-meta"><span>${escapeHtml(bookPublishedYear(book))}</span><span>${escapeHtml(book.format.toLocaleUpperCase())}</span><span>${escapeHtml(formatCatalogBytes(book.size))}</span></div>
        <div class="library-tags">${book.subjects.slice(0, 2).map((subject) => `<span>${escapeHtml(subject)}</span>`).join("")}${book.series ? `<span>${escapeHtml(book.series)}</span>` : ""}${status === "possible" ? "<span>Possible Kindle match</span>" : ""}${currentUnknown ? "<span>Kindle presence unknown</span>" : ""}</div>
      </div>
      <button type="button" class="library-send-button${confirmed ? " installed" : ""}" data-ui-action="send-book" data-book-id="${escapeHtml(book.id)}"${confirmed || !available || snapshot.sendBusy || deviceBlocksSend ? " disabled" : ""}>${sendLabel}</button>
    </article>
  `;
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
    <div class="library-results-head"><p>${summary}</p><span>${snapshot.booksState === "loading" ? "Refreshing…" : snapshot.filters.view === "on-kindle" ? "Device comparison" : "Cover grid"}</span></div>
    ${renderActiveFilters(snapshot)}
    ${books.length > 0 ? `<div class="library-book-grid">${books.map((book) => renderBookCard(book, snapshot, state)).join("")}</div>${renderPagination(snapshot)}` : `
      <div class="library-empty-state"><span aria-hidden="true">⌕</span><h2>${escapeHtml(emptyTitle)}</h2><p>${escapeHtml(emptyMessage)}</p>${hasActiveCatalogFilters(snapshot.filters) ? '<button type="button" data-ui-action="clear-filters">Clear filters</button>' : ""}</div>
    `}
  `;
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
        <label class="settings-field settings-path-field"><span>Container folder path</span><input id="settings-folder-path-${escapeHtml(folder.id)}" data-settings-folder-path value="${escapeHtml(folder.path)}" placeholder="/libraries/husbandlibrary" spellcheck="false" autocomplete="off"${editsDisabled ? " disabled" : ""} /><small>Enter the absolute path mounted inside the Kindle Bridge container, not a host path or smb:// address.</small></label>
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

function renderLibrarySettings(snapshot: CatalogBrowserSnapshot): string {
  const draft = snapshot.settingsDraft;
  const locked = snapshot.serviceStatus?.settingsMode === "read-only";
  const editsDisabled = locked || snapshot.settingsSaving || snapshot.settingsRefreshing || snapshot.settingsConflict;
  return `
    <section class="settings-page" aria-labelledby="settings-heading">
      <header class="settings-page-head"><div><div class="library-eyebrow">Household configuration</div><h1 id="settings-heading" tabindex="-1">Library settings</h1><p>Create libraries and choose which container-mounted folders each one can see.</p></div><button type="button" class="primary" data-ui-action="new-library"${editsDisabled ? " disabled" : ""}>+ New library</button></header>
      <div class="settings-prototype-notice" role="note"><strong>Saved on this server</strong><span>Configuration persists across restarts. Catalog folders must be mounted read-only into the Kindle Bridge container.</span></div>
      ${locked ? '<div class="settings-prototype-notice settings-locked-notice" role="status"><strong>Settings locked</strong><span>This server manages its library configuration outside the browser. You can inspect folders and request a scan, but editing is disabled.</span></div>' : ""}
      <div class="settings-prototype-notice warning" role="note"><strong>No private accounts</strong><span>Anyone who can open this service can switch between every configured household library. Keep it on a trusted LAN or VPN.</span></div>
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
  const buttonAction = transferDone ? "close-send" : ready ? "confirm-catalog-send" : "connect-catalog-device";
  const buttonLabel = transferDone
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
  return `<div class="library-modal-backdrop"${snapshot.sendBusy ? "" : ' data-ui-action="close-send"'} aria-hidden="true"></div><section class="library-send-sheet" role="dialog" aria-modal="true" aria-labelledby="send-preview-title" data-send-book-id="${escapeHtml(book.id)}" tabindex="-1"><button type="button" class="library-sheet-close" data-ui-action="close-send" aria-label="Close send dialog"${snapshot.sendBusy ? " disabled" : ""}>×</button><div class="library-sheet-eyebrow">Send to Kindle</div><h2 id="send-preview-title">${escapeHtml(book.title)}</h2><p class="library-sheet-author">${escapeHtml(bookAuthor(book))}</p><div class="library-send-plan"><div class="${sourceDone ? "done" : ""}"><span>1</span><div><strong>Check source</strong><small>${escapeHtml(book.format.toLocaleUpperCase())} · ${escapeHtml(formatCatalogBytes(book.size))}</small></div></div><div class="${derivativeDone ? "done" : phase === "converting" || phase === "validating" ? "active" : ""}"><span>2</span><div><strong>${book.format.toLocaleLowerCase() === "epub" ? "Convert a copy locally" : "Validate Kindle file"}</strong><small>${book.format.toLocaleLowerCase() === "epub" ? "boko WASM → AZW3 personal document" : "BOOKMOBI and cover checks"}</small></div></div><div class="${transferDone ? "done" : phase === "sending" || phase === "verifying" ? "active" : ""}"><span>3</span><div><strong>Send and verify</strong><small>Collision-safe WebUSB/MTP transfer</small></div></div></div>${phase ? `<div class="library-transfer-status${phase === "failed" ? " failed" : ""}" role="status"><strong>${escapeHtml(phase === "complete" ? "Complete" : phase === "failed" ? "Transfer failed" : phase.replace(/^./u, (value) => value.toLocaleUpperCase()))}</strong><span>${escapeHtml(snapshot.sendMessage ?? "Working locally in this browser")}</span>${progress === undefined ? "" : `<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div>`}</div>` : ""}<div class="library-original-note"><strong>Original protected</strong><span>The source in the container-mounted library remains unchanged.</span></div><button type="button" class="primary library-confirm-send" data-ui-action="${buttonAction}"${snapshot.sendBusy || connecting || (connected && !ready && !transferDone) ? " disabled" : ""}>${buttonLabel}</button></section>`;
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
        : item.match === "possible"
          ? "Possible match"
          : item.managed
            ? "Managed item"
            : unmatchedComparisonComplete
              ? "Only on Kindle"
              : "Comparison unavailable";
    return `<article data-kindle-object-id="${escapeHtml(item.id)}"><span class="library-device-file-icon" aria-hidden="true">${escapeHtml((item.format ?? "DOC").slice(0, 4).toLocaleUpperCase())}</span><span><strong>${escapeHtml(item.title ?? item.filename)}</strong><small>${escapeHtml(item.author ?? item.filename)} · ${escapeHtml(formatCatalogBytes(item.size))}</small>${item.path ? `<code>${escapeHtml(item.path)}</code>` : ""}</span><span class="library-device-match" data-match="${matchTone}">${matchLabel}</span></article>`;
  }).join("") || '<p class="settings-empty-copy">No device items match this search.</p>'}</div>${matchingItems.length > pageSize ? `<nav class="library-pagination library-device-pagination" aria-label="Kindle content pages"><button type="button" data-ui-action="kindle-page" data-page-offset="${Math.max(0, offset - pageSize)}"${offset === 0 ? " disabled" : ""}>Previous</button><span>${offset + 1}–${Math.min(offset + pageSize, matchingItems.length)} of ${matchingItems.length}</span><button type="button" data-ui-action="kindle-page" data-page-offset="${offset + pageSize}"${offset + pageSize >= matchingItems.length ? " disabled" : ""}>Next</button></nav>` : ""}${inventory.truncated ? '<p class="library-device-truncated">The device hierarchy reached its bounded 10,000-object scan limit; this inventory is explicitly partial.</p>' : ""}</section>`;
}

function renderToolbar(snapshot: CatalogBrowserSnapshot): string {
  const ui = snapshot.filters;
  const facets = snapshot.facets;
  const displayedSort = ui.view === "recent" ? "recent" : ui.sort;
  return `<section class="library-toolbar" aria-label="Search, sort, and filter books">
    <label class="library-search"><span class="sr-only">Search books</span><span aria-hidden="true">⌕</span><input id="library-search" type="search" value="${escapeHtml(ui.query)}" placeholder="Search title, author, series, subject, or ISBN…" autocomplete="off" /></label>
    <label><span class="sr-only">Filter by author</span><input id="library-author" list="library-author-options" value="${escapeHtml(ui.author === "all" ? "" : ui.author)}" placeholder="All authors" autocomplete="off" />${renderDatalist("library-author-options", facets.authors)}</label>
    <label><span class="sr-only">Filter by language</span><select id="library-language">${renderOptions(facets.languages, ui.language, "All languages")}</select></label>
    <label><span class="sr-only">Filter by Kindle status</span><select id="library-kindle-filter"><option value="all"${ui.kindle === "all" ? " selected" : ""}>Any Kindle status</option><option value="on-kindle"${ui.kindle === "on-kindle" ? " selected" : ""}>On Kindle</option><option value="not-on-kindle"${ui.kindle === "not-on-kindle" ? " selected" : ""}>Not on Kindle</option><option value="possible"${ui.kindle === "possible" ? " selected" : ""}>Possible match</option></select></label>
    <label><span class="sr-only">Sort books</span><select id="library-sort"${ui.view === "recent" ? " disabled" : ""}><option value="recent"${displayedSort === "recent" ? " selected" : ""}>Added newest</option><option value="title"${displayedSort === "title" ? " selected" : ""}>Title A–Z</option><option value="author"${displayedSort === "author" ? " selected" : ""}>Author A–Z</option><option value="published"${displayedSort === "published" ? " selected" : ""}>Publication date</option><option value="size"${displayedSort === "size" ? " selected" : ""}>File size</option></select></label>
    <details class="library-more-filters"><summary>More filters</summary><div><label><span>Subject</span><input id="library-subject" list="library-subject-options" value="${escapeHtml(ui.subject === "all" ? "" : ui.subject)}" placeholder="All subjects" autocomplete="off" />${renderDatalist("library-subject-options", facets.subjects)}</label><label><span>Publisher</span><input id="library-publisher" list="library-publisher-options" value="${escapeHtml(ui.publisher === "all" ? "" : ui.publisher)}" placeholder="All publishers" autocomplete="off" />${renderDatalist("library-publisher-options", facets.publishers)}</label><label><span>Series</span><input id="library-series" list="library-series-options" value="${escapeHtml(ui.series === "all" ? "" : ui.series)}" placeholder="All series" autocomplete="off" />${renderDatalist("library-series-options", facets.series)}</label><label><span>Publication year</span><select id="library-year">${renderOptions(facets.years, ui.year, "All years")}</select></label><label><span>Format</span><select id="library-format">${renderOptions(facets.formats, ui.format, "All formats")}</select></label><label><span>Source folder</span><select id="library-root-filter">${renderOptions(facets.roots, ui.rootId, "All folders")}</select></label><label><span>Metadata</span><select id="library-metadata"><option value="all"${ui.metadata === "all" ? " selected" : ""}>Any metadata</option><option value="complete"${ui.metadata === "complete" ? " selected" : ""}>Complete metadata</option><option value="partial"${ui.metadata === "partial" ? " selected" : ""}>Missing metadata</option></select></label></div></details>
  </section>`;
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
  const safeWritePassed = state.selfTest.kind === "passed";
  const ready = deviceReadyToSend(state, snapshot);
  const currentComparison = connected
    && state.catalogInventoryState === "ready"
    && currentKindleComparison(snapshot);
  const sendSummary = currentComparison
    ? `<strong>${counts.readyToSend}</strong> ready to send`
    : `<strong>—</strong> ${connecting || connected ? "checking inventory" : "connect to compare"}`;
  const source = sourceSummary(snapshot);
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
  const deviceTitle = disconnecting ? "Disconnecting Kindle…" : connected ? "Kindle connected" : connecting ? "Connecting Kindle…" : "Connect Kindle";
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
      : "Plug in over USB";
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
    : '<button type="button" data-ui-action="connect-catalog-device">Connect Kindle</button>';
  return `<header class="library-topbar"><a class="library-brand" href="#library" aria-label="Kindle Bridge library home"><span class="library-brand-mark" aria-hidden="true">K</span><span><strong>Kindle Bridge</strong><small>Home library</small></span></a><div class="library-topbar-status" data-status="${source.tone}"><span class="library-source-dot"></span><span>${escapeHtml(source.title)}</span><small>${escapeHtml(source.detail)}</small></div><button type="button" class="library-device-button${connected ? " connected" : ""}" data-ui-action="${connected ? "show-kindle" : "connect-catalog-device"}"${connecting || disconnecting ? " disabled" : ""}><span class="library-device-icon" aria-hidden="true">▯</span><span><strong>${deviceTitle}</strong><small>${deviceDetail}</small></span></button></header>
    ${topAlertsHtml ? `<div class="library-global-alerts">${topAlertsHtml}</div>` : ""}
    <div class="library-layout"><aside class="library-sidebar" aria-label="Library profiles and views"><div class="library-sidebar-label">Household</div><div class="library-profile-list">${renderProfileRail(snapshot)}</div><div class="library-sidebar-label library-views-label">Browse</div><nav class="library-nav" aria-label="Library views">${renderLibraryNav(snapshot)}</nav><div class="library-source-card"><div class="library-source-card-head"><span class="library-source-icon" aria-hidden="true">⇄</span><span><strong>Container folders</strong><small>${sourceCardDetail}</small></span></div><div class="library-source-progress"><span style="width:${enabledRoots.length ? Math.round(100 * (profile?.availableRootCount ?? 0) / enabledRoots.length) : 0}%"></span></div><p><span>${profile?.bookCount ?? 0} indexed</span><span>${profile ? `${profile.availableRootCount}/${enabledRoots.length} enabled available · ${profile.rootCount} configured` : "Not configured"}</span></p></div><p class="library-profile-note">No sign-in required. Profiles organize views; they are not access controls.</p></aside>
    <main class="library-main" id="library">${snapshot.loadState === "error" && snapshot.profiles.length === 0 ? `<div class="library-empty-state library-error-state" role="alert"><span aria-hidden="true">!</span><h1>Catalog service unavailable</h1><p>${escapeHtml(snapshot.error ?? "Kindle Bridge could not reach its catalog service.")}</p><button type="button" data-ui-action="retry-catalog">Try again</button></div>` : snapshot.filters.view === "settings" ? renderLibrarySettings(snapshot) : `<section class="library-hero" aria-labelledby="library-heading"><div><div class="library-eyebrow">${escapeHtml(profile?.description ?? "Household collection")}</div><h1 id="library-heading">${escapeHtml(heading)}</h1><p>${profile?.bookCount ?? 0} books from <strong>${escapeHtml(profile?.sourceLabel ?? "configured sources")}</strong></p></div><div class="library-stat-row" aria-label="Library summary"><span><strong>${counts.onKindle}</strong> matched here</span><span><strong>${counts.possible}</strong> possible</span><span>${sendSummary}</span></div></section>${snapshot.filters.view === "on-kindle" ? `<section class="library-kindle-summary" aria-label="Kindle summary"><span class="library-kindle-summary-icon" aria-hidden="true">▯</span><div><strong>${disconnecting ? "Disconnecting Kindle" : connected ? "Connected Kindle" : "Kindle not connected"}</strong><span>${kindleSummaryDetail}</span></div><div class="library-kindle-summary-stats"><span><strong>${counts.onKindle}</strong> confirmed</span><span><strong>${counts.possible}</strong> possible</span></div>${kindleConnectionButton}</section>` : ""}${renderToolbar(snapshot)}<section class="library-results" aria-live="polite">${renderLibraryResults(state, snapshot)}</section>${snapshot.filters.view === "on-kindle" ? renderKindleDeviceContents(snapshot, connected, state.catalogInventoryState) : ""}`}${snapshot.announcement ? `<div class="library-toast" role="status"><span class="library-toast-check">✓</span><span>${escapeHtml(snapshot.announcement)}</span><button type="button" data-ui-action="dismiss-announcement" aria-label="Dismiss notification">×</button></div>` : ""}${renderSendPreview(state, snapshot)}</main></div>`;
}
