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
  updateBookMetadata: ReturnType<typeof vi.fn>;
  resetBookMetadata: ReturnType<typeof vi.fn>;
  uploadBookCover: ReturnType<typeof vi.fn>;
  importBookCover: ReturnType<typeof vi.fn>;
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
    getBookMetadata: vi.fn(async () => state),
    updateBookMetadata,
    resetBookMetadata,
    uploadBookCover,
    deleteBookCover: vi.fn(async () => state),
    searchBookCovers: vi.fn(async (_profileId, _bookId, provider) => ({
      provider,
      items: [{ candidateId: "OL1M", title: "Candidate title", authors: ["Candidate Author"], publishedAt: "2024", identifiers: ["isbn:123"], thumbnailUrl: `/api/profiles/${PROFILE.id}/books/${book.id}/cover-search/preview?candidate=OL1M` }],
    })),
    importBookCover,
    getBookCover: vi.fn(async () => new Blob(["cover"], { type: "image/jpeg" })),
    getMatchIndex: vi.fn(async () => ({ profileId: PROFILE.id, generatedAt: "2026-09-01T10:00:00Z", entries: [] })),
    getBookSource: vi.fn(async () => ({ blob: new Blob(["source"]) })),
    createDelivery: vi.fn(async () => ({})),
    saveConfiguration: vi.fn(async () => ({ profile: PROFILE, roots: [ROOT] })),
    subscribeEvents: vi.fn((_onEvent, _onError, onOpen) => { onOpen?.(); return () => undefined; }),
  } as CatalogApi & {
    updateBookMetadata: ReturnType<typeof vi.fn>;
    resetBookMetadata: ReturnType<typeof vi.fn>;
    uploadBookCover: ReturnType<typeof vi.fn>;
    importBookCover: ReturnType<typeof vi.fn>;
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
});

describe("non-destructive metadata and cover editor", () => {
  it("shows source/effective fields and saves override/inherit changes with current-version fencing", async () => {
    const { root, api } = await openEditor();
    expect(root.querySelector('.library-metadata-sheet[role="dialog"]')?.textContent).toContain("torrent/source files stay untouched");
    expect(root.querySelector('[data-metadata-field-row="publisher"] small')?.textContent).toContain("Source Publisher");
    expect(root.querySelector(".metadata-format-note")?.textContent).toContain("temporary browser-created derivative");
    expect(root.querySelector(".metadata-existing-copy-note")?.textContent).toContain("remove that Kindle copy");

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
