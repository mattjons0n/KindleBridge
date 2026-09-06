import type { CatalogBrowserSnapshot } from "./catalog-browser";
import type { CatalogHealthIssue } from "./catalog-client";
import { bookAuthor, formatCatalogBytes } from "./library-prototype";
import { libraryIcon } from "./library-icons";

const ISSUE_LABELS = {
  "missing-cover": "Missing cover",
  "incomplete-metadata": "Incomplete book details",
  "metadata-parser-failure": "Couldn't read a file",
  "low-confidence-provider-data": "Suggestions need review",
  "unavailable-source": "File unavailable",
  "suspected-duplicate": "Possible duplicate",
} as const;

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function relativeTime(value: string): string {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} hr ago` : `${Math.floor(hours / 24)} days ago`;
}

function issueExplanation(issue: CatalogHealthIssue): string {
  switch (issue.type) {
    case "missing-cover": return "Add a cover so this book is easier to recognise in your library.";
    case "incomplete-metadata": return "Some book details are missing. Check the title and author, then fill in what you know.";
    case "low-confidence-provider-data": return "The online results may be for another edition. Review the suggestions before using them.";
    case "unavailable-source": return "This book's file can't be reached. Check that its library folder is available, then check again.";
    case "metadata-parser-failure": return "ShelfSend couldn't read this file. Check the file in its library folder, then try again.";
    case "suspected-duplicate":
      return issue.reasonCode === "duplicate-content-hash"
        ? "These entries contain the same file. Compare them and choose a preferred entry."
        : issue.reasonCode === "duplicate-identifier"
          ? "These entries share a book identifier. Compare them to see whether they are the same edition."
          : "These entries have the same title and author. Compare them to see whether they are the same book.";
  }
}

function issueTitle(issue: CatalogHealthIssue, snapshot: CatalogBrowserSnapshot): string {
  const book = snapshot.healthBooks.get(issue.bookIds[0] ?? "");
  if (book) return book.title;
  const label = issue.displayLabels[0];
  if (label) return label.split(/[\\/]/u).filter(Boolean).at(-1) ?? label;
  return snapshot.rootsByProfile.get(issue.profileId)?.find((root) => issue.rootIds.includes(root.id))?.label
    ?? "Library file";
}

function metadataButton(bookId: string, label: string, busy: boolean, primary = false): string {
  return `<button type="button"${primary ? ' class="primary health-primary-action"' : ""} data-ui-action="review-issue-metadata" data-book-id="${escapeHtml(bookId)}"${busy ? " disabled" : ""}>${escapeHtml(label)}</button>`;
}

function ignoredButton(issue: CatalogHealthIssue, busy: boolean, primary = false): string {
  const ignored = issue.disposition.ignored;
  return `<button type="button"${primary ? ' class="primary health-primary-action"' : ""} data-ui-action="set-catalog-issue-ignored" data-issue-signature="${escapeHtml(issue.signature)}" data-ignored="${!ignored}"${busy ? " disabled" : ""}>${ignored ? "Restore to review" : issue.type === "suspected-duplicate" ? "These aren't duplicates" : "Dismiss for now"}</button>`;
}

function lookupButton(issue: CatalogHealthIssue, busy: boolean): string {
  return `<button type="button" data-ui-action="lookup-issue-metadata" data-issue-signature="${escapeHtml(issue.signature)}" data-provider="open-library"${busy || issue.disposition.ignored || !issue.bookIds.length ? " disabled" : ""}>${issue.type === "missing-cover" ? "Search for cover suggestions" : "Search for book details"}</button>`;
}

function renderIssueDetails(issue: CatalogHealthIssue, snapshot: CatalogBrowserSnapshot, busy: boolean): string {
  const roots = issue.rootIds.map((id) => snapshot.rootsByProfile.get(issue.profileId)?.find((root) => root.id === id));
  const canLookup = ["missing-cover", "incomplete-metadata", "low-confidence-provider-data"].includes(issue.type);
  return `<details class="health-issue-details"><summary>More options &amp; details</summary><div class="health-details-body">
    <div class="health-secondary-actions">
      ${canLookup ? lookupButton(issue, busy || snapshot.metadataLookupBusy) : ""}
      ${issue.type === "suspected-duplicate" && issue.disposition.preferredBookId ? `<button type="button" data-ui-action="set-duplicate-preference" data-issue-signature="${escapeHtml(issue.signature)}" data-book-id=""${busy ? " disabled" : ""}>Clear preferred entry</button>` : ""}
      ${issue.rootIds.length ? `<button type="button" data-ui-action="retry-catalog-issue" data-issue-signature="${escapeHtml(issue.signature)}"${busy || issue.disposition.ignored ? " disabled" : ""}>${busy ? "Checking…" : "Check again"}</button>` : ""}
      ${issue.disposition.ignored ? "" : ignoredButton(issue, busy)}
    </div>
    ${!issue.disposition.ignored ? '<p class="health-option-note">Dismissed items can be restored using “Show dismissed only” in the filters.</p>' : ""}
    <dl class="health-source-details" aria-label="Affected source context">
      <div><dt>File access</dt><dd>${issue.currentAvailable ? "Current source available" : "Current source unavailable"}</dd></div>
      ${roots.map((root) => `<div><dt>Library folder</dt><dd><strong>${escapeHtml(root?.label ?? "Folder unavailable")}</strong>${root ? `<code>${escapeHtml(root.path)}</code><span>${escapeHtml(root.status.replaceAll("-", " "))}</span>` : ""}</dd></div>`).join("")}
      ${issue.displayLabels.length ? `<div><dt>Affected ${issue.displayLabels.length === 1 ? "entry" : "entries"}</dt><dd>${issue.displayLabels.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}</dd></div>` : ""}
      <div><dt>Last checked</dt><dd><time datetime="${escapeHtml(issue.lastObservedAt)}">${escapeHtml(relativeTime(issue.lastObservedAt))}</time></dd></div>
      ${issue.disposition.lastRetryAt ? `<div><dt>Last requested check</dt><dd>${escapeHtml(relativeTime(issue.disposition.lastRetryAt))} · ${issue.disposition.retryCount} ${issue.disposition.retryCount === 1 ? "attempt" : "attempts"}</dd></div>` : ""}
      <div><dt>Diagnostic code</dt><dd><code>${escapeHtml(issue.reasonCode)}</code></dd></div>
    </dl>
  </div></details>`;
}

function renderDuplicateChoices(issue: CatalogHealthIssue, snapshot: CatalogBrowserSnapshot, busy: boolean): string {
  const preferred = issue.disposition.preferredBookId;
  return `<details class="health-duplicate-review"${preferred ? " open" : ""}><summary class="health-compare-action">${preferred ? "Review preferred entry" : `Compare ${issue.bookIds.length} entries`}<span aria-hidden="true">↓</span></summary><div class="health-duplicate-body"><p>Choose which entry you prefer. This saves a preference; it does not merge entries or delete any files.</p><ul class="health-duplicate-entries">${issue.bookIds.map((bookId, index) => {
    const book = snapshot.healthBooks.get(bookId);
    const selected = preferred === bookId;
    const filename = book?.sourceFilename.split(/[\\/]/u).at(-1);
    return `<li${selected ? ' data-preferred="true"' : ""}><span class="health-entry-number" aria-hidden="true">${index + 1}</span><div class="health-entry-info"><strong>${escapeHtml(book?.title ?? `Entry ${index + 1}`)}</strong><span>${escapeHtml(book ? bookAuthor(book) : "Book details unavailable")}</span>${book ? `<small>${escapeHtml(book.format.toLocaleUpperCase())} · ${escapeHtml(formatCatalogBytes(book.size))}${filename ? ` · ${escapeHtml(filename)}` : ""}</small>` : ""}${selected ? '<span class="health-preferred-label">✓ Your preferred entry</span>' : ""}</div><div class="health-entry-actions">${book ? metadataButton(bookId, "Edit details", busy) : ""}<button type="button" data-ui-action="set-duplicate-preference" data-issue-signature="${escapeHtml(issue.signature)}" data-book-id="${escapeHtml(bookId)}" aria-pressed="${selected}"${busy || issue.disposition.ignored ? " disabled" : ""}>${selected ? "Preferred entry" : "Prefer this entry"}</button></div></li>`;
  }).join("")}</ul></div></details>`;
}

function renderIssue(issue: CatalogHealthIssue, snapshot: CatalogBrowserSnapshot): string {
  const busy = snapshot.healthBusySignature === issue.signature;
  const book = snapshot.healthBooks.get(issue.bookIds[0] ?? "");
  const isDuplicate = issue.type === "suspected-duplicate";
  const fileIssue = issue.type === "unavailable-source" || issue.type === "metadata-parser-failure";
  const action = issue.disposition.ignored ? ignoredButton(issue, busy, true)
    : isDuplicate ? ""
      : fileIssue || !book ? `<button type="button" class="primary health-primary-action" data-ui-view="settings"${busy ? " disabled" : ""}>Check library folder</button>`
        : metadataButton(book.id, issue.type === "missing-cover" ? "Add a cover" : issue.type === "low-confidence-provider-data" ? "Review book details" : "Complete book details", busy, true);
  return `<li class="attention-issue health-issue" data-severity="${escapeHtml(issue.severity)}" data-issue-type="${escapeHtml(issue.type)}"${busy ? ' aria-busy="true"' : ""}>
    <div class="health-issue-main"><span class="health-issue-icon" aria-hidden="true">${libraryIcon(fileIssue ? "attention" : isDuplicate ? "series" : "book")}</span><div class="health-issue-copy"><div class="health-issue-label">${escapeHtml(ISSUE_LABELS[issue.type])}${issue.disposition.ignored ? '<span class="health-dismissed-label">Dismissed</span>' : ""}</div><h2>${escapeHtml(issueTitle(issue, snapshot))}</h2>${book ? `<span class="health-issue-author">${escapeHtml(bookAuthor(book))}</span>` : ""}<p>${escapeHtml(issueExplanation(issue))}</p></div>${action ? `<div class="health-issue-action">${action}</div>` : ""}</div>
    ${isDuplicate ? renderDuplicateChoices(issue, snapshot, busy) : ""}
    ${renderIssueDetails(issue, snapshot, busy)}
  </li>`;
}

function lookupStatus(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    queued: "Waiting to start", pending: "Waiting", running: "Searching", searching: "Searching", paused: "Paused",
    completed: "Finished", cancelled: "Cancelled", ready: "Suggestions ready", failed: "Search failed",
    "no-results": "No suggestions found", accepted: "Changes applied", imported: "Changes applied",
  };
  return labels[status] ?? status.replaceAll("-", " ");
}

function renderLookupJobs(snapshot: CatalogBrowserSnapshot): string {
  const page = snapshot.metadataLookupJobs;
  const active = snapshot.activeMetadataLookupJob;
  const busy = snapshot.metadataLookupBusy;
  const summaries = page?.items ?? [];
  const open = active || snapshot.metadataLookupError || summaries.some((job) => job.status === "running" || job.status === "paused");
  const detail = !active ? "" : `<section class="metadata-job-detail" aria-labelledby="metadata-job-detail-title"><header><div><h3 id="metadata-job-detail-title">Book suggestions</h3><p>${active.ready} ready to review · ${active.pending} waiting${active.failed ? ` · ${active.failed} couldn't be searched` : ""}${active.noResults ? ` · ${active.noResults} with no results` : ""}</p></div><button type="button" data-ui-action="close-metadata-job" aria-label="Close search details">×</button></header>
    ${snapshot.metadataLookupError ? `<div class="health-error" role="alert">${escapeHtml(snapshot.metadataLookupError)}</div>` : ""}
    <div class="metadata-job-controls"><span class="metadata-job-status" data-status="${escapeHtml(active.status)}">${escapeHtml(lookupStatus(active.status))}</span>${active.status === "paused" ? `<button type="button" data-ui-action="control-metadata-job" data-job-action="resume"${busy ? " disabled" : ""}>Resume search</button>` : active.status === "running" ? '<button type="button" data-ui-action="control-metadata-job" data-job-action="pause">Pause search</button>' : ""}${active.status === "completed" && active.failed > 0 ? `<button type="button" data-ui-action="control-metadata-job" data-job-action="retry"${busy ? " disabled" : ""}>Retry failed searches</button>` : ""}${active.status !== "completed" && active.status !== "cancelled" ? `<button type="button" class="primary" data-ui-action="run-metadata-job"${busy || active.status === "paused" ? " disabled" : ""}>${busy ? "Searching…" : "Search now"}</button><button type="button" data-ui-action="control-metadata-job" data-job-action="cancel">Cancel search</button>` : ""}</div>
    <div class="metadata-job-progress"><div class="progress-track" role="progressbar" aria-label="Book search progress" aria-valuemin="0" aria-valuemax="${Math.max(1, active.total)}" aria-valuenow="${Math.max(0, active.total - active.pending)}"><span style="width:${active.total > 0 ? Math.round(100 * (active.total - active.pending) / active.total) : 0}%"></span></div><small>${active.total - active.pending} of ${active.total} books searched</small></div>
    <ol class="metadata-job-entries">${active.entries.map((entry) => {
      const book = snapshot.healthBooks.get(entry.bookId);
      const candidate = entry.candidates[0];
      return `<li data-status="${escapeHtml(entry.status)}"><span><strong>${escapeHtml(book?.title ?? `Book ${entry.rank + 1}`)}</strong><small>${entry.acceptedAt ? "Changes applied" : escapeHtml(lookupStatus(entry.status))}</small>${entry.errorCode ? `<details class="health-search-error"><summary>Why did this fail?</summary><code>${escapeHtml(entry.errorCode)}</code></details>` : ""}</span>${candidate && !entry.acceptedAt ? `<button type="button" data-ui-action="review-metadata-job-candidate" data-job-id="${escapeHtml(active.id)}" data-book-id="${escapeHtml(entry.bookId)}" data-candidate-id="${escapeHtml(candidate.candidateId)}">Review ${entry.candidates.length} ${entry.candidates.length === 1 ? "suggestion" : "suggestions"}</button>` : ""}</li>`;
    }).join("")}</ol><p class="metadata-job-safety">You choose which details and covers to use. Nothing is changed until you review and apply a suggestion.</p></section>`;
  return `<details class="health-searches"${open ? " open" : ""}><summary>Online book searches<span>${active ? escapeHtml(lookupStatus(active.status)) : `${summaries.length} recent`}</span></summary><div class="health-searches-body"><div class="attention-section-head"><div><h2>Search history</h2><p>Find covers and book details, then review the suggestions here.</p></div><button type="button" data-ui-action="reload-metadata-jobs"${snapshot.metadataLookupState === "loading" ? " disabled" : ""}>Refresh</button></div>${snapshot.metadataLookupError && !active ? `<div class="health-error" role="alert">${escapeHtml(snapshot.metadataLookupError)}</div>` : ""}${snapshot.metadataLookupState === "loading" && !page ? '<p role="status">Loading searches…</p>' : summaries.length === 0 ? '<p>No searches yet. Use a book’s options to search for a cover or book details.</p>' : `<div class="metadata-job-list">${summaries.map((job) => `<button type="button" data-ui-action="open-metadata-job" data-job-id="${escapeHtml(job.id)}"${active?.id === job.id ? ' aria-current="true"' : ""}><span><strong>${escapeHtml(job.provider === "google-books" ? "Google Books" : "Open Library")}</strong><small>${escapeHtml(relativeTime(job.updatedAt))}</small></span><span>${job.ready} of ${job.total} ready</span><em data-status="${escapeHtml(job.status)}">${escapeHtml(lookupStatus(job.status))}</em></button>`).join("")}</div>`}${detail}</div></details>`;
}

export function renderNeedsAttention(snapshot: CatalogBrowserSnapshot): string {
  const page = snapshot.healthPage;
  const filter = snapshot.healthFilter;
  const counts = page?.counts;
  const issues = page?.items ?? [];
  const pagination = page && page.total > page.limit
    ? `<nav class="library-pagination" aria-label="Needs attention pages"><button type="button" data-ui-action="catalog-health-page" data-page-offset="${Math.max(0, page.offset - page.limit)}"${page.offset === 0 || snapshot.healthState === "loading" ? " disabled" : ""}>Previous</button><span>${page.offset + 1}–${Math.min(page.offset + page.items.length, page.total)} of ${page.total}</span><button type="button" data-ui-action="catalog-health-page" data-page-offset="${page.offset + page.limit}"${page.offset + page.items.length >= page.total || snapshot.healthState === "loading" ? " disabled" : ""}>Next</button></nav>`
    : "";
  const filtered = filter.type !== "all" || filter.severity !== "all";
  const emptyTitle = snapshot.healthState === "error" ? "Couldn't load library checks"
    : filter.ignored ? "No dismissed items" : filtered ? "No items match these filters" : "Your library looks good";
  const emptyCopy = snapshot.healthState === "error" ? "Try refreshing to see which books need a review."
    : filter.ignored ? "Items you dismiss will appear here until the underlying issue is fixed."
      : filtered ? "Try another filter to see the rest of your library checks." : "No missing details or file issues were found in the latest check.";
  return `<section class="attention-page health-page" aria-labelledby="attention-heading"><header class="attention-page-head"><div><div class="library-eyebrow">Library review</div><h1 id="attention-heading" tabindex="-1">Needs attention</h1><p>Missing covers, incomplete details, and files to check. Pick an item to get started.</p></div>${counts ? `<div class="health-review-count"><strong>${filter.ignored ? counts.ignored : counts.active}</strong><span>${filter.ignored ? "dismissed" : "to review"}</span></div>` : ""}</header>
    <div class="health-filter-bar"><label><span>Show</span><select id="catalog-health-type"><option value="all">All items</option>${Object.entries(ISSUE_LABELS).map(([value, label]) => `<option value="${value}"${filter.type === value ? " selected" : ""}>${escapeHtml(label)}${counts ? ` (${counts.byType[value as keyof typeof ISSUE_LABELS]})` : ""}</option>`).join("")}</select></label><details class="health-extra-filters"${filter.severity !== "all" || filter.ignored ? " open" : ""}><summary>More filters${filter.severity !== "all" || filter.ignored ? " · active" : ""}</summary><div><label><span>Priority</span><select id="catalog-health-severity"><option value="all">All priorities</option>${(["error", "warning", "info"] as const).map((severity) => `<option value="${severity}"${filter.severity === severity ? " selected" : ""}>${({ error: "Files to fix", warning: "Worth checking", info: "Optional improvements" })[severity]}</option>`).join("")}</select></label><label class="health-dismissed-toggle"><input id="catalog-health-ignored" type="checkbox"${filter.ignored ? " checked" : ""} /><span>Show dismissed only</span></label></div></details><button type="button" data-ui-action="reload-catalog-health"${snapshot.healthState === "loading" ? " disabled" : ""}>${snapshot.healthState === "loading" ? "Refreshing…" : "Refresh"}</button></div>
    ${snapshot.healthError ? `<div class="health-error" role="alert"><span>${escapeHtml(snapshot.healthError)}</span><button type="button" data-ui-action="reload-catalog-health">Try again</button></div>` : ""}
    ${snapshot.healthState === "loading" && !page ? '<div class="health-empty" role="status"><span class="health-empty-icon" aria-hidden="true">↻</span><h2>Checking your library…</h2><p>Looking for missing details and files that need a review.</p></div>' : issues.length === 0 ? `<div class="health-empty"><span class="health-empty-icon" aria-hidden="true">${snapshot.healthState === "error" ? "!" : "✓"}</span><h2>${emptyTitle}</h2><p>${emptyCopy}</p></div>` : `<ol class="attention-issue-list health-issue-list">${issues.map((issue) => renderIssue(issue, snapshot)).join("")}</ol>`}
    ${pagination}${renderLookupJobs(snapshot)}
  </section>`;
}
