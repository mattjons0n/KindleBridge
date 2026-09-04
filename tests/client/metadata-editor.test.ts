// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BookMetadataOverrides,
  CatalogApi,
  CatalogBook,
  CatalogBookMetadataState,
  CatalogFilters,
  CatalogProfile,
  CatalogRoot,
  CatalogServiceStatus,
  CoverProvider,
  CoverProviderCredentialState,
} from "../../client/src/catalog-client";
import { DebugLog } from "../../client/src/log";
import { initialAppState } from "../../client/src/state";
import { AppView, type AppViewHandlers } from "../../client/src/view";

const HASH = "a".repeat(64);
const STATUS: CatalogServiceStatus = {
  available: true,
  state: "ready",
  settingsMode: "read-write",
  database: "ready",
  cache: "ready",
};
const PROFILE: CatalogProfile = {
  id: "profile-one",
  name: "Library",
  description: "Read-only books",
  initial: "L",
  sourceLabel: "books",
  enabled: true,
  rootCount: 1,
  availableRootCount: 1,
  bookCount: 1,
};
const ROOT: CatalogRoot = {
  id: "root-one",
  profileId: PROFILE.id,
  label: "books",
  path: "/libraries/books",
  recursive: true,
  watch: true,
  enabled: true,
  status: "available",
};
const EMPTY_FILTERS: CatalogFilters = {
  authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [],
};
const BOOK: CatalogBook = {
  id: "book-one",
  profileId: PROFILE.id,
  rootId: ROOT.id,
  sourceFilename: "immutable.epub",
  title: "Source Title",
  authors: ["Source Author"],
  authorSort: "Author, Source",
  language: "en",
  publisher: "Saved Publisher",
  publishedAt: "2025",
  series: "Source Series",
  seriesIndex: 1,
  description: "Source description",
  subjects: ["Source subject"],
  identifiers: ["isbn:123"],
  format: "epub",
  size: 1234,
  contentHash: HASH,
  presentationVersion: "b".repeat(64),
  addedAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-09-01T10:00:00Z",
  metadataComplete: true,
  available: true,
  coverUrl: `/api/profiles/${PROFILE.id}/books/book-one/cover`,
  metadataEdited: true,
  coverEdited: false,
  metadataRevision: 4,
};

function handlers(): AppViewHandlers {
  return {
    onTargetProfileSaved: vi.fn(),
    onEpubSelected: vi.fn(),
    onConvert: vi.fn(),
    onDownloadConverted: vi.fn(),
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onSelfTest: vi.fn(),
    onSendIntegrated: vi.fn(),
    onIntegratedOpenConfirmed: vi.fn(),
    onCleanupInspectionConfirmed: vi.fn(),
    onCopyLog: vi.fn(),
  };
}

function sourceMetadata(book: CatalogBook): CatalogBookMetadataState["sourceMetadata"] {
  return {
    title: "Source Title",
    authors: ["Source Author"],
    authorSort: "Author, Source",
    language: "en",
    publisher: "Source Publisher",
    publishedAt: "2025",
    series: "Source Series",
    seriesIndex: 1,
    description: "Source description",
    subjects: ["Source subject"],
    identifiers: ["isbn:123"],
  };
}

function testApi(book: CatalogBook = BOOK): CatalogApi & {
  getBookDetails: ReturnType<typeof vi.fn>;
  getMatchIndex: ReturnType<typeof vi.fn>;
  updateBookMetadata: ReturnType<typeof vi.fn>;
  resetBookMetadata: ReturnType<typeof vi.fn>;
  uploadBookCover: ReturnType<typeof vi.fn>;
  importBookCover: ReturnType<typeof vi.fn>;
  listCoverProviderCredentials: ReturnType<typeof vi.fn>;
  searchBookMetadata: ReturnType<typeof vi.fn>;
} {
  let state: CatalogBookMetadataState = {
    book,
    sourceMetadata: sourceMetadata(book),
    sourceCoverUrl: `/api/profiles/${PROFILE.id}/books/${book.id}/cover?source=true`,
    overrides: { publisher: "Saved Publisher" },
    revision: 4,
    basedOnContentHash: HASH,
    sourceChanged: false,
    coverOverride: null,
  };
  const applyOverrides = (overrides: BookMetadataOverrides): CatalogBook => ({
    ...state.book,
    ...(Object.hasOwn(overrides, "title") ? { title: overrides.title! } : { title: state.sourceMetadata.title }),
    ...(Object.hasOwn(overrides, "authors") ? { authors: overrides.authors! } : { authors: state.sourceMetadata.authors }),
    ...(Object.hasOwn(overrides, "publisher") ? { publisher: overrides.publisher ?? undefined } : { publisher: state.sourceMetadata.publisher ?? undefined }),
    metadataEdited: Object.keys(overrides).length > 0,
  });
  const updateBookMetadata = vi.fn(async (_profileId: string, _bookId: string, input: { changes: BookMetadataOverrides }) => {
    const overrides = { ...state.overrides, ...input.changes };
    state = { ...state, book: applyOverrides(overrides), overrides, revision: state.revision + 1, sourceChanged: false };
    return state;
  });
  const resetBookMetadata = vi.fn(async (_profileId: string, _bookId: string, input: { fields?: readonly (keyof BookMetadataOverrides)[] }) => {
    const overrides = { ...state.overrides };
    for (const field of input.fields ?? Object.keys(overrides) as Array<keyof BookMetadataOverrides>) delete overrides[field];
    state = { ...state, book: applyOverrides(overrides), overrides, revision: state.revision + 1, sourceChanged: false };
    return state;
  });
  const importBookCover = vi.fn(async () => {
    state = {
      ...state,
      book: { ...state.book, coverEdited: true, metadataRevision: state.revision + 1 },
      revision: state.revision + 1,
      coverOverride: { assetKey: "provider-cover", mediaType: "image/jpeg", byteLength: 100, width: 600, height: 900, sourceKind: "provider", provider: "open-library", providerReference: "OL1M", sourceUrl: null },
    };
    return state;
  });
  const uploadBookCover = vi.fn(async () => {
    state = {
      ...state,
      book: { ...state.book, coverEdited: true, metadataRevision: state.revision + 1 },
      revision: state.revision + 1,
      coverOverride: { assetKey: "pasted-cover", mediaType: "image/png", byteLength: 4, width: 2, height: 3, sourceKind: "upload", provider: null, providerReference: null, sourceUrl: null },
    };
    return state;
  });
  let googleBooksCredential: CoverProviderCredentialState = {
    provider: "google-books" as const,
    configured: false,
    maskedKey: null,
    revision: 0,
    status: "not-configured" as const,
    lastTestedAt: null,
    errorCode: null,
  };
  const searchBookMetadata = vi.fn(async (_profileId: string, _bookId: string, provider: CoverProvider) => ({
    provider,
    items: [{
      provider,
      candidateId: "provider-book-one",
      confidence: "high" as const,
      metadata: { title: "Provider title", authors: ["Provider Author"] },
    }],
  }));
  return {
    getStatus: vi.fn(async () => STATUS),
    listProfiles: vi.fn(async () => [PROFILE]),
    createProfile: vi.fn(async () => PROFILE),
    updateProfile: vi.fn(async () => PROFILE),
    deleteProfile: vi.fn(async () => undefined),
    listRoots: vi.fn(async () => [ROOT]),
    createRoot: vi.fn(async () => ROOT),
    updateRoot: vi.fn(async () => ROOT),
    deleteRoot: vi.fn(async () => undefined),
    rescanRoot: vi.fn(async () => undefined),
    listBooks: vi.fn(async (_profileId, query = {}) => ({ items: [state.book], total: 1, offset: query.offset ?? 0, limit: query.limit ?? 24 })),
    queryBooks: vi.fn(async (_profileId, query = {}) => ({ items: [state.book], total: 1, offset: query.offset ?? 0, limit: query.limit ?? 24 })),
    getFilters: vi.fn(async () => EMPTY_FILTERS),
    getBook: vi.fn(async () => state.book),
    getBookDetails: vi.fn(async () => ({
      ...state,
      source: {
        rootId: ROOT.id,
        rootLabel: ROOT.label,
        rootPath: ROOT.path,
        rootStatus: ROOT.status,
        rootLastScanAt: "2026-09-01T09:55:00Z",
        relativePath: `nested/${state.book.sourceFilename}`,
        available: true,
      },
      latestVerifiedDelivery: {
        filename: "Source Title.azw3",
        size: 2_048,
        deliveredAt: "2026-09-01T11:00:00Z",
        currentPresentation: true,
      },
    })),
    getBookMetadata: vi.fn(async () => state),
    updateBookMetadata,
    resetBookMetadata,
    uploadBookCover,
    deleteBookCover: vi.fn(async () => state),
    searchBookCovers: vi.fn(async (_profileId, _bookId, provider) => ({
      provider,
      items: [{ candidateId: "OL1M", title: "Candidate title", authors: ["Candidate Author"], publishedAt: "2024", identifiers: ["isbn:123"], thumbnailUrl: `/api/profiles/${PROFILE.id}/books/${book.id}/cover-search/preview?candidate=OL1M` }],
    })),
    searchBookMetadata,
    importBookCover,
    getBookCover: vi.fn(async () => new Blob(["cover"], { type: "image/jpeg" })),
    listCoverProviderCredentials: vi.fn(async () => [googleBooksCredential]),
    saveCoverProviderCredential: vi.fn(async (_provider, input) => {
      googleBooksCredential = {
        ...googleBooksCredential,
        configured: true,
        maskedKey: "••••••••",
        revision: input.expectedRevision + 1,
        status: "untested" as const,
      };
      return googleBooksCredential;
    }),
    testCoverProviderCredential: vi.fn(async () => {
      googleBooksCredential = { ...googleBooksCredential, status: "working" as const };
      return googleBooksCredential;
    }),
    removeCoverProviderCredential: vi.fn(async () => {
      googleBooksCredential = { ...googleBooksCredential, configured: false, maskedKey: null, revision: googleBooksCredential.revision + 1, status: "not-configured" as const };
      return googleBooksCredential;
    }),
    getMatchIndex: vi.fn(async () => ({ profileId: PROFILE.id, generatedAt: "2026-09-01T10:00:00Z", entries: [{ bookId: BOOK.id, sourceFilename: BOOK.sourceFilename, sourceFormat: BOOK.format, sourceSize: BOOK.size, contentHash: HASH, identifiers: BOOK.identifiers, title: BOOK.title, authors: BOOK.authors, deliveries: [{ deviceKey: "private-device", filename: "Source Title.azw3", artifactSize: 2_048, status: "verified", deliveredAt: "2026-09-01T11:00:00Z" }] }] })),
    getBookSource: vi.fn(async () => ({ blob: new Blob(["source"]) })),
    createDelivery: vi.fn(async () => ({})),
    saveConfiguration: vi.fn(async () => ({ profile: PROFILE, roots: [ROOT] })),
    subscribeEvents: vi.fn((_onEvent, _onError, onOpen) => { onOpen?.(); return () => undefined; }),
  } as CatalogApi & {
    getBookDetails: ReturnType<typeof vi.fn>;
    getMatchIndex: ReturnType<typeof vi.fn>;
    updateBookMetadata: ReturnType<typeof vi.fn>;
    resetBookMetadata: ReturnType<typeof vi.fn>;
    uploadBookCover: ReturnType<typeof vi.fn>;
    importBookCover: ReturnType<typeof vi.fn>;
    listCoverProviderCredentials: ReturnType<typeof vi.fn>;
    searchBookMetadata: ReturnType<typeof vi.fn>;
  };
}

async function openEditor(api = testApi()): Promise<{ root: HTMLElement; api: ReturnType<typeof testApi> }> {
  const root = document.createElement("div");
  document.body.append(root);
  new AppView(root, initialAppState(), handlers(), new DebugLog(), { catalogApi: api });
  await vi.waitFor(() => expect(root.querySelector('[data-book-id="book-one"]')).not.toBeNull());
  root.querySelector<HTMLButtonElement>('[data-ui-action="edit-book-metadata"]')!.click();
  await vi.waitFor(() => expect(root.querySelector<HTMLFormElement>("form.metadata-editor-form")).not.toBeNull());
  return { root, api };
}

afterEach(() => {
  document.body.innerHTML = "";
  window.localStorage.clear();
  window.history.replaceState({}, "", "#library");
});

describe("non-destructive metadata and cover editor", () => {
  it("keeps provider credentials out of UI state and clears the password field immediately", async () => {
    const api = testApi();
    const root = document.createElement("div");
    document.body.append(root);
    new AppView(root, initialAppState(), handlers(), new DebugLog(), { catalogApi: api });
    await vi.waitFor(() => expect(root.querySelector('[data-book-id="book-one"]')).not.toBeNull());
    root.querySelector<HTMLButtonElement>('[data-ui-view="settings"]')!.click();
    await vi.waitFor(() => expect(root.querySelector(".settings-provider-card")?.textContent).toContain("Not configured"));
    root.querySelector<HTMLButtonElement>('[data-ui-action="edit-google-books-key"]')!.click();
    const input = root.querySelector<HTMLInputElement>("#settings-google-books-key")!;
    expect(input.value).toBe("");
    const secret = "development-key-must-not-render";
    input.value = secret;
    root.querySelector<HTMLButtonElement>('[data-ui-action="save-test-google-books-key"]')!.click();
    expect(input.value).toBe("");
    expect(root.textContent).not.toContain(secret);
    expect(Object.values(window.localStorage)).not.toContain(secret);
    await vi.waitFor(() => expect(root.querySelector(".settings-provider-card")?.textContent).toContain("Working"));
    expect(api.saveCoverProviderCredential).toHaveBeenCalledWith("google-books", {
      apiKey: secret,
      expectedRevision: 0,
    }, expect.any(AbortSignal));
  });

  it("defaults cover search to Open Library", async () => {
    const { root } = await openEditor();
    expect(root.querySelector<HTMLSelectElement>("#metadata-cover-provider")?.value).toBe("open-library");
  });

  it("uses a configured Google Books key after reload without opening Settings", async () => {
    const api = testApi();
    api.listCoverProviderCredentials.mockResolvedValue([{
      provider: "google-books",
      configured: true,
      maskedKey: "••••••••",
      revision: 3,
      status: "working",
      lastTestedAt: "2026-09-04T10:00:00Z",
      errorCode: null,
    }]);
    const { root } = await openEditor(api);
    expect(api.listCoverProviderCredentials).not.toHaveBeenCalled();

    root.querySelector<HTMLSelectElement>("#metadata-candidate-provider")!.value = "google-books";
    root.querySelector<HTMLButtonElement>('[data-ui-action="search-metadata-candidates"]')!.click();

    await vi.waitFor(() => expect(api.searchBookMetadata).toHaveBeenCalledOnce());
    expect(api.listCoverProviderCredentials).toHaveBeenCalledOnce();
    expect(api.searchBookMetadata).toHaveBeenCalledWith(
      PROFILE.id,
      BOOK.id,
      "google-books",
      expect.objectContaining({ title: BOOK.title }),
      expect.any(AbortSignal),
    );
    expect(root.querySelector(".metadata-candidate-list")?.textContent).toContain("Provider title");
  });

  it("shows exact possible-match evidence and routes explicit choices without treating Kindle-only files as hidden", async () => {
    const api = testApi();
    const appHandlers: AppViewHandlers = {
      ...handlers(),
      onCatalogManualMatchDecision: vi.fn(async () => undefined),
    };
    const root = document.createElement("div");
    document.body.append(root);
    const view = new AppView(root, initialAppState(), appHandlers, new DebugLog(), { catalogApi: api });
    await vi.waitFor(() => expect(root.querySelector('[data-book-id="book-one"]')).not.toBeNull());
    view.setCatalogKindleStatuses(new Map([[BOOK.id, "possible"]]));
    view.setCatalogKindleInventory({
      deviceLabel: "My Kindle",
      scannedAt: "2026-09-03T20:00:00Z",
      completeness: "complete",
      total: 2,
      truncated: false,
      metadata: { status: "complete", eligible: 2, enriched: 1, failed: 0, skipped: 0, truncated: false },
      matching: { status: "complete", matchedProfiles: 1, failedProfiles: 0 },
      items: [{
        id: "mtp-00000010",
        filename: "Source Title.azw3",
        title: "Source Title",
        author: "Source Author",
        format: "AZW3",
        objectFormat: 0xb00a,
        modificationDate: "20260903T200000",
        size: 2_048,
        path: "Books/Source Title.azw3",
        managed: false,
        bookId: BOOK.id,
        match: "possible",
        candidates: [{
          profileId: PROFILE.id,
          bookId: BOOK.id,
          reason: "The filename resembles this book.",
          evidence: {
            tier: "filename-similarity",
            inventoryCompleteness: "complete",
            ambiguous: true,
            candidateCount: 1,
            comparisons: {
              title: "unavailable",
              authors: "unavailable",
              identifiers: "unavailable",
              filename: "match",
              size: "unavailable",
            },
            strongerProofUnavailable: "No exact prior delivery identity was available.",
          },
        }],
      }, {
        id: "mtp-00000011",
        filename: "Only on Kindle.azw3",
        format: "AZW3",
        objectFormat: 0xb00a,
        size: 1_024,
        path: "Only on Kindle.azw3",
        managed: false,
        match: "unmatched",
      }],
    });
    await vi.waitFor(() => expect(root.querySelector('[data-ui-action="open-match-review"]')).not.toBeNull());
    root.querySelector<HTMLButtonElement>('[data-ui-action="open-match-review"]')!.click();
    await vi.waitFor(() => expect(root.querySelector(".library-match-review-sheet")?.textContent).toContain("The filename resembles this book."));
    expect(root.querySelector(".library-match-review-sheet")?.textContent).toContain("Books/Source Title.azw3");
    root.querySelector<HTMLButtonElement>('button[data-decision="same-book"]')!.click();
    await vi.waitFor(() => expect(appHandlers.onCatalogManualMatchDecision).toHaveBeenCalledWith({
      profileId: PROFILE.id,
      bookId: BOOK.id,
      itemId: "mtp-00000010",
      decision: "same-book",
    }));
  });

  it("explains a possible match even when an incomplete inventory has no device candidate", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const view = new AppView(root, initialAppState(), handlers(), new DebugLog(), { catalogApi: testApi() });
    await vi.waitFor(() => expect(root.querySelector('[data-book-id="book-one"]')).not.toBeNull());
    view.setCatalogKindleStatuses(new Map([[BOOK.id, "possible"]]));
    view.setCatalogKindleInventory({
      deviceLabel: "My Kindle",
      scannedAt: "2026-09-03T20:00:00Z",
      completeness: "partial",
      total: 0,
      truncated: false,
      matching: { status: "partial", matchedProfiles: 1, failedProfiles: 0 },
      items: [],
      possibleMatches: [{
        profileId: PROFILE.id,
        bookId: BOOK.id,
        reason: "The Kindle scan was incomplete, so this possible match cannot be confirmed.",
        evidence: {
          tier: "inventory-partial",
          inventoryCompleteness: "partial",
          ambiguous: true,
          candidateCount: 0,
          comparisons: {
            title: "not-compared",
            authors: "not-compared",
            identifiers: "not-compared",
            filename: "not-compared",
            size: "not-compared",
          },
          strongerProofUnavailable: "A complete current Kindle inventory is required before any match can be authoritative.",
        },
      }],
    });

    const badge = root.querySelector<HTMLButtonElement>('[data-book-id="book-one"] [data-ui-action="open-match-review"]');
    expect(badge?.disabled).toBe(false);
    badge?.click();
    await vi.waitFor(() => expect(root.querySelector(".library-match-review-sheet")?.textContent).toContain("Incomplete inventory"));
    const review = root.querySelector(".library-match-review-sheet");
    expect(review?.textContent).toContain("Why is this a possible match?");
    expect(review?.textContent).toContain("No exact Kindle file identified");
    expect(review?.textContent).toContain("Incomplete inventory");
    expect(review?.textContent).toContain("No exact device candidate");
    expect(review?.querySelector('[data-decision="same-book"]')).toBeNull();
  });

  it("opens a keyboard-contained details drawer and browser back restores the catalog", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const scrollTo = vi.fn();
    Object.defineProperty(window, "scrollTo", { configurable: true, value: scrollTo });
    const api = testApi();
    new AppView(root, initialAppState(), handlers(), new DebugLog(), { catalogApi: api });
    await vi.waitFor(() => expect(root.querySelector('[data-book-id="book-one"]')).not.toBeNull());
    const initialMatchIndexCalls = api.getMatchIndex.mock.calls.length;

    root.querySelector<HTMLButtonElement>('[data-ui-action="open-book-details"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('.library-book-details-sheet[role="dialog"]')?.textContent).toContain("Source Publisher"));
    expect(root.querySelector('.library-book-details-sheet')?.textContent).toContain("Saved Publisher");
    expect(root.querySelector('.library-book-details-sheet')?.textContent).toContain("Source Title.azw3");
    expect(root.querySelector('.library-book-details-sheet')?.textContent).toContain("nested/immutable.epub");
    expect(api.getBookDetails).toHaveBeenCalledWith(PROFILE.id, BOOK.id, expect.any(AbortSignal));
    expect(api.getMatchIndex).toHaveBeenCalledTimes(initialMatchIndexCalls);
    expect(document.activeElement?.getAttribute("data-ui-action")).toBe("close-book-details");

    window.history.replaceState({}, "", "#library");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await vi.waitFor(() => expect(root.querySelector(".library-book-details-sheet")).toBeNull());
    expect(document.activeElement?.getAttribute("data-ui-action")).toBe("open-book-details");
    expect(scrollTo).toHaveBeenCalled();
  });

  it("shows source/effective fields and saves override/inherit changes with current-version fencing", async () => {
    const { root, api } = await openEditor();
    expect(root.querySelector('.library-metadata-sheet[role="dialog"]')?.textContent).toContain("torrent/source files stay untouched");
    expect(root.querySelector('[data-metadata-field-row="publisher"] small')?.textContent).toContain("Source Publisher");
    expect(root.querySelector(".metadata-format-note")?.textContent).toContain("temporary browser-created derivative");
    expect(root.querySelector(".metadata-existing-copy-note")?.textContent).toContain("Kindle update unavailable");
    expect(root.querySelector(".metadata-existing-copy-note")?.textContent).toContain("Kindle Bridge-managed presentation");

    const publisher = root.querySelector<HTMLInputElement>('input[data-metadata-override="publisher"]')!;
    publisher.checked = false;
    publisher.dispatchEvent(new Event("change", { bubbles: true }));
    const titleToggle = root.querySelector<HTMLInputElement>('input[data-metadata-override="title"]')!;
    titleToggle.checked = true;
    titleToggle.dispatchEvent(new Event("change", { bubbles: true }));
    const title = root.querySelector<HTMLInputElement>('[data-metadata-field="title"]')!;
    title.value = "Edited Title";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-ui-action="save-book-metadata"]')!.click();

    await vi.waitFor(() => expect(api.updateBookMetadata).toHaveBeenCalledOnce());
    expect(api.resetBookMetadata).toHaveBeenCalledWith(PROFILE.id, BOOK.id, {
      expectedRevision: 4,
      expectedContentHash: HASH,
      fields: ["publisher"],
    }, expect.any(AbortSignal));
    expect(api.updateBookMetadata).toHaveBeenCalledWith(PROFILE.id, BOOK.id, {
      expectedRevision: 5,
      expectedContentHash: HASH,
      changes: { title: "Edited Title" },
    }, expect.any(AbortSignal));
    await vi.waitFor(() => expect(root.querySelector("#metadata-editor-description")?.textContent).toContain("Edited Title"));
  });

  it("searches proxied providers, imports a candidate, and uploads an actual pasted image Blob", async () => {
    const { root, api } = await openEditor();
    const provider = root.querySelector<HTMLSelectElement>("#metadata-cover-provider")!;
    provider.value = "open-library";
    const query = root.querySelector<HTMLInputElement>("#metadata-cover-query")!;
    query.value = "isbn:123";
    root.querySelector<HTMLButtonElement>('[data-ui-action="search-metadata-covers"]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-ui-action="import-metadata-cover"]')).not.toBeNull());
    expect(root.querySelector<HTMLImageElement>(".metadata-cover-results img")?.getAttribute("src")).toContain("/api/profiles/");
    root.querySelector<HTMLButtonElement>('[data-ui-action="import-metadata-cover"]')!.click();
    await vi.waitFor(() => {
      expect(api.importBookCover).toHaveBeenCalledOnce();
      expect(root.querySelector(".metadata-revision-chip")?.textContent).toContain("5");
    });
    expect(api.importBookCover.mock.calls[0]?.[2]).toMatchObject({
      expectedRevision: 4,
      expectedContentHash: HASH,
      provider: "open-library",
      candidateId: "OL1M",
    });

    const image = new File([new Uint8Array([1, 2, 3, 4])], "pasted.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => image }],
        files: [],
      },
    });
    root.querySelector<HTMLElement>("[data-metadata-cover-dropzone]")!.dispatchEvent(paste);
    await vi.waitFor(() => expect(api.uploadBookCover).toHaveBeenCalledOnce());
    expect(api.uploadBookCover.mock.calls[0]?.[2]).toBe(image);
    expect(api.uploadBookCover.mock.calls[0]?.slice(3, 5)).toEqual([5, HASH]);
  });

  it("warns that edited AZW3 presentation cannot yet be embedded on Send", async () => {
    const azw3 = { ...BOOK, format: "azw3", sourceFilename: "immutable.azw3" };
    const { root } = await openEditor(testApi(azw3));
    expect(root.querySelector(".metadata-format-note.warning")?.textContent).toContain("cannot yet be embedded into an AZW3 Send");
    expect(root.querySelector(".metadata-format-note.warning")?.textContent).toContain("source remains unchanged");
  });

  it("explicitly rebases a retained cover-only overlay when the source changed", async () => {
    const api = testApi({ ...BOOK, metadataEdited: false, coverEdited: false });
    const staleState = await api.getBookMetadata!(PROFILE.id, BOOK.id);
    vi.mocked(api.getBookMetadata!).mockResolvedValue({
      ...staleState,
      overrides: {},
      sourceChanged: true,
      coverOverride: {
        assetKey: "prior-source-cover",
        mediaType: "image/jpeg",
        byteLength: 100,
        width: 600,
        height: 900,
        sourceKind: "upload",
        provider: null,
        providerReference: null,
        sourceUrl: null,
      },
    });
    const { root } = await openEditor(api);

    expect(root.querySelector(".metadata-editor-rebase")?.textContent).toContain("saved cover");
    expect(root.querySelector(".metadata-cover-panel")?.textContent).toContain("Saved for prior source");
    root.querySelector<HTMLButtonElement>('[data-ui-action="save-book-metadata"]')!.click();

    await vi.waitFor(() => expect(api.updateBookMetadata).toHaveBeenCalledOnce());
    expect(api.updateBookMetadata).toHaveBeenCalledWith(PROFILE.id, BOOK.id, {
      expectedRevision: 4,
      expectedContentHash: HASH,
      changes: {},
    }, expect.any(AbortSignal));
  });
});
