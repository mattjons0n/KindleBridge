// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { CatalogBrowser, type CatalogBrowserSnapshot } from "../../client/src/catalog-browser";
import type { CatalogApi, CatalogBook, CatalogHealthIssue, CatalogHealthPage, CatalogRoot, MetadataLookupJob } from "../../client/src/catalog-client";
import { renderNeedsAttention } from "../../client/src/library-health-view";

const ROOT: CatalogRoot = {
  id: "root_books", profileId: "profile_one", label: "Fiction", path: "/libraries/fiction",
  recursive: true, watch: true, enabled: true, status: "watching",
};
const BOOK: CatalogBook = {
  id: "book_one", profileId: ROOT.profileId, rootId: ROOT.id, title: "Old Man's War",
  sourceFilename: "Old Man's War.epub", authors: ["John Scalzi"], authorSort: "Scalzi, John",
  subjects: [], identifiers: [], format: "EPUB", size: 1_024, addedAt: "2026-09-01T12:00:00Z",
  updatedAt: "2026-09-01T12:00:00Z", metadataComplete: true, available: true,
};

function issue(overrides: Partial<CatalogHealthIssue> = {}): CatalogHealthIssue {
  return {
    version: 1, signature: "issue_one", profileId: ROOT.profileId, type: "missing-cover", severity: "info",
    reasonCode: "cover-missing", bookIds: [BOOK.id], sourceIds: ["source_one"], rootIds: [ROOT.id],
    displayLabels: [BOOK.title, "John Scalzi/Old Man's War.epub"], currentAvailable: true,
    lastObservedAt: "2026-09-01T12:00:00Z",
    disposition: { ignored: false, preferredBookId: null, revision: 0, retryCount: 0, lastRetryAt: null },
    ...overrides,
  };
}

function snapshot(issues: CatalogHealthIssue[], overrides: Partial<CatalogBrowserSnapshot> = {}): CatalogBrowserSnapshot {
  const base = new CatalogBrowser({} as CatalogApi, {}, () => {}, undefined).snapshot;
  const counts: CatalogHealthPage["counts"] = {
    total: issues.length, active: issues.filter((item) => !item.disposition.ignored).length,
    ignored: issues.filter((item) => item.disposition.ignored).length,
    byType: {
      "missing-cover": 0, "incomplete-metadata": 0, "metadata-parser-failure": 0,
      "low-confidence-provider-data": 0, "unavailable-source": 0, "suspected-duplicate": 0,
    },
    bySeverity: { error: 0, warning: 0, info: 0 },
  };
  return {
    ...base, healthState: "ready", metadataLookupState: "ready",
    rootsByProfile: new Map([[ROOT.profileId, [ROOT]]]), healthBooks: new Map([[BOOK.id, BOOK]]),
    healthPage: { items: issues, total: issues.length, limit: 100, offset: 0, counts },
    ...overrides,
  };
}

function render(state: CatalogBrowserSnapshot): HTMLDivElement {
  const root = document.createElement("div");
  root.innerHTML = renderNeedsAttention(state);
  return root;
}

describe("library review presentation", () => {
  it("leads a missing cover with the book and one action, preserving search/rescan/dismiss under details", () => {
    const root = render(snapshot([issue()]));
    const card = root.querySelector(".health-issue")!;
    const main = card.querySelector(".health-issue-main")!;
    expect(main.querySelector("h2")?.textContent).toBe(BOOK.title);
    const actions = main.querySelectorAll<HTMLButtonElement>("button");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.textContent).toBe("Add a cover");
    expect(actions[0]?.dataset.uiAction).toBe("review-issue-metadata");
    expect(actions[0]?.dataset.bookId).toBe(BOOK.id);
    expect(main.textContent).not.toContain(ROOT.path);
    const details = card.querySelector<HTMLDetailsElement>(".health-issue-details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain(ROOT.path);
    expect(details.querySelector<HTMLButtonElement>('[data-ui-action="lookup-issue-metadata"]')?.dataset.provider).toBe("open-library");
    expect(details.querySelector('[data-ui-action="retry-catalog-issue"]')?.textContent).toBe("Check again");
    expect(details.querySelector<HTMLButtonElement>('[data-ui-action="set-catalog-issue-ignored"]')?.dataset.ignored).toBe("true");
    expect(root.querySelector<HTMLDetailsElement>(".health-searches")?.open).toBe(false);
  });

  it.each(["unavailable-source", "metadata-parser-failure"] as const)("gives %s a folder action even when no catalog book was created", (type) => {
    const root = render(snapshot([issue({
      type, bookIds: [], displayLabels: ["nested/broken-book.epub"],
      currentAvailable: false, severity: "error", reasonCode: "epub-invalid-container",
    })]));
    const main = root.querySelector(".health-issue-main")!;
    expect(main.querySelector("h2")?.textContent).toBe("broken-book.epub");
    expect(main.querySelector<HTMLButtonElement>("button")?.dataset.uiView).toBe("settings");
    expect(main.textContent).not.toContain("epub-invalid-container");
    expect(main.textContent).not.toContain("nested/");
    expect(root.querySelector(".health-source-details")?.textContent).toContain("nested/broken-book.epub");
    expect(root.querySelector(".health-source-details")?.textContent).toContain("Current source unavailable");
    expect(root.querySelector('[data-ui-action="retry-catalog-issue"]')).not.toBeNull();
  });

  it("explains duplicate preference, distinguishes entries, and preserves the selected choice and undo", () => {
    const second = { ...BOOK, id: "book_two", sourceFilename: "Old Man's War.azw3", format: "AZW3", size: 2_048 };
    const duplicate = issue({ type: "suspected-duplicate", reasonCode: "duplicate-title-author", bookIds: [BOOK.id, second.id] });
    const state = snapshot([duplicate], { healthBooks: new Map([[BOOK.id, BOOK], [second.id, second]]) });
    const root = render(state);
    const review = root.querySelector<HTMLDetailsElement>(".health-duplicate-review")!;
    expect(review.open).toBe(false);
    expect(review.querySelector("summary")?.textContent).toContain("Compare 2 entries");
    expect(review.textContent).toContain("does not merge entries or delete any files");
    expect(review.textContent).toContain(second.sourceFilename);
    expect(review.querySelectorAll('[data-ui-action="set-duplicate-preference"]')).toHaveLength(2);
    expect(root.querySelector('[data-ui-action="set-catalog-issue-ignored"]')?.textContent).toBe("These aren't duplicates");

    const selected = render(snapshot([{ ...duplicate, disposition: { ...duplicate.disposition, preferredBookId: second.id } }], { healthBooks: state.healthBooks }));
    expect(selected.querySelector<HTMLDetailsElement>(".health-duplicate-review")?.open).toBe(true);
    const preferred = selected.querySelector('[data-preferred="true"]')!;
    expect(preferred.textContent).toContain("Your preferred entry");
    expect(preferred.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.dataset.bookId).toBe(second.id);
    expect(selected.querySelector<HTMLButtonElement>('[data-ui-action="set-duplicate-preference"][data-book-id=""]')?.textContent).toBe("Clear preferred entry");
    expect(selected.querySelector('[data-ui-action*="remove"]')).toBeNull();
  });

  it("restores dismissed items and disables checks and lookup while dismissed or busy", () => {
    const dismissed = issue({ disposition: { ...issue().disposition, ignored: true } });
    const root = render(snapshot([dismissed], { healthFilter: { type: "missing-cover", severity: "info", ignored: true } }));
    const primary = root.querySelector<HTMLButtonElement>(".health-primary-action")!;
    expect(primary.textContent).toBe("Restore to review");
    expect(primary.dataset.ignored).toBe("false");
    expect(root.querySelector<HTMLButtonElement>('[data-ui-action="retry-catalog-issue"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-ui-action="lookup-issue-metadata"]')?.disabled).toBe(true);
    expect(root.querySelector<HTMLSelectElement>("#catalog-health-type")?.value).toBe("missing-cover");
    expect(root.querySelector<HTMLSelectElement>("#catalog-health-severity")?.value).toBe("info");
    expect(root.querySelector<HTMLInputElement>("#catalog-health-ignored")?.checked).toBe(true);
    expect(root.querySelector<HTMLDetailsElement>(".health-extra-filters")?.open).toBe(true);
    const busy = render(snapshot([issue()], { healthBusySignature: "issue_one" }));
    expect([...busy.querySelectorAll<HTMLButtonElement>(".health-issue button")].every((button) => button.disabled)).toBe(true);
    expect(busy.querySelector(".health-issue")?.getAttribute("aria-busy")).toBe("true");
  });

  it("shows active online results for explicit review and preserves pause, retry, cancel and candidate hooks", () => {
    const job: MetadataLookupJob = {
      id: "lookup_one", profileId: ROOT.profileId, provider: "open-library", status: "running", revision: 1,
      entriesIncluded: true, total: 2, pending: 1, ready: 1, noResults: 0, failed: 0, cancelled: 0,
      createdAt: "2026-09-01T12:00:00Z", updatedAt: "2026-09-01T12:00:00Z",
      entries: [{ jobId: "lookup_one", bookId: BOOK.id, rank: 0, status: "ready", attempts: 1,
        candidates: [{ provider: "open-library", candidateId: "candidate_one", confidence: "low", metadata: { title: BOOK.title } }],
        errorCode: null, acceptedAt: null, updatedAt: "2026-09-01T12:00:00Z" }],
    };
    const root = render(snapshot([], {
      activeMetadataLookupJob: job, metadataLookupJobs: { items: [job], total: 1, limit: 20, offset: 0 },
    }));
    expect(root.querySelector<HTMLDetailsElement>(".health-searches")?.open).toBe(true);
    const candidate = root.querySelector<HTMLButtonElement>('[data-ui-action="review-metadata-job-candidate"]')!;
    expect(candidate.dataset.bookId).toBe(BOOK.id);
    expect(candidate.dataset.jobId).toBe(job.id);
    expect(candidate.dataset.candidateId).toBe("candidate_one");
    expect(root.querySelector('[data-job-action="pause"]')).not.toBeNull();
    expect(root.querySelector('[data-job-action="cancel"]')).not.toBeNull();
    expect(root.querySelector('[data-ui-action="run-metadata-job"]')).not.toBeNull();
    expect(root.querySelector('[data-ui-action*="import"]')).toBeNull();
    const paused = render(snapshot([], { activeMetadataLookupJob: { ...job, status: "paused" } }));
    expect(paused.querySelector('[data-job-action="resume"]')).not.toBeNull();
    expect(paused.querySelector<HTMLButtonElement>('[data-ui-action="run-metadata-job"]')?.disabled).toBe(true);
    const failed = render(snapshot([], { activeMetadataLookupJob: { ...job, status: "completed", failed: 1 } }));
    expect(failed.querySelector('[data-job-action="retry"]')).not.toBeNull();
  });

  it("does not imply a healthy library when a load failed or filters hide the issues", () => {
    const error = render(snapshot([], { healthState: "error", healthPage: undefined, healthError: "Server unavailable" }));
    expect(error.textContent).not.toContain("Your library looks good");
    expect(error.querySelector('[role="alert"]')?.textContent).toContain("Server unavailable");
    const filtered = render(snapshot([], { healthFilter: { type: "missing-cover", severity: "all", ignored: false } }));
    expect(filtered.textContent).toContain("No items match these filters");
    expect(filtered.textContent).not.toContain("Your library looks good");
  });

  it("escapes book labels, source paths and diagnostic codes rather than interpreting them as markup", () => {
    const dangerous = '<img src=x onerror="alert(1)">';
    const root = render(snapshot([issue({ displayLabels: [dangerous], reasonCode: dangerous })], {
      healthBooks: new Map([[BOOK.id, { ...BOOK, title: dangerous, authors: [dangerous] }]]),
      rootsByProfile: new Map([[ROOT.profileId, [{ ...ROOT, path: dangerous }]]]),
    }));
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector(".health-issue h2")?.textContent).toBe(dangerous);
    expect(root.querySelector(".health-source-details")?.textContent).toContain(dangerous);
  });
});
