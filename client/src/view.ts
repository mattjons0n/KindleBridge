import type { DebugLog } from "./log";
import type {
  AdvancedPartialObjectProbeRunRequest,
  AdvancedPartialObjectProbeViewState,
} from "./advanced-partial-object-diagnostic";
import { mountAdvancedPartialObjectProbe } from "./advanced-partial-object-diagnostic-view";
import {
  CatalogBrowser,
  type CatalogSendBatchResult,
  type CatalogHardwareHooks,
  type CatalogKindleInventory,
  type CatalogRemoveRequest,
  type CatalogSendRequest,
  type CatalogTransferUpdate,
} from "./catalog-browser";
import {
  createCatalogClient,
  type BookMetadataOverrides,
  type CatalogApi,
  type CatalogEvent,
  type CatalogKindleStatus,
  type CatalogKindleStatusCounts,
  type CoverProvider,
} from "./catalog-client";
import { renderKindleDeviceContents, renderLibraryPrototype, renderLibraryResults } from "./library-prototype-view";
import type { KindleFilter, LibraryFilters, LibrarySort, LibraryView, MetadataFilter } from "./library-prototype";
import type { LibraryFolderDraft, LibrarySettingsDraft } from "./library-settings-prototype";
import {
  decodeLibraryRoute,
  encodeLibraryRoute,
  type LibraryRouteOverlays,
  type LibraryRouteState,
} from "./library-route";
import {
  deriveGateStatuses,
  pendingObjectWriteActive,
  targetProfileComplete,
  type AppState,
  type DeviceDetails,
  type GateStatus,
  type TargetProfile,
  type TransferState,
} from "./state";

export interface AppViewHandlers {
  readonly onTargetProfileSaved: (profile: TargetProfile) => void;
  readonly onEpubSelected: (file: File) => void;
  readonly onConvert: () => void;
  readonly onDownloadConverted: () => void;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onSelfTest: () => void;
  readonly onSendIntegrated: () => void;
  readonly onIntegratedOpenConfirmed: () => void;
  readonly onCleanupInspectionConfirmed: () => void;
  readonly onReplacementCleanupRequested?: (operationId: string) => void | Promise<void>;
  readonly onCopyLog: () => void;
  /** Hardware integration for the Docker catalog. Kept separate from Gate 0 so a
   * Kindle can be connected before a catalog book has been converted. */
  readonly onCatalogConnectRequested?: () => void | Promise<void>;
  readonly onCatalogDisconnectRequested?: () => void | Promise<void>;
  readonly onCatalogSendRequested?: (request: CatalogSendRequest) => void | Promise<void>;
  readonly onCatalogSendBatchFinished?: (result: CatalogSendBatchResult) => void | Promise<void>;
  readonly onCatalogRemoveRequested?: (request: CatalogRemoveRequest) => void | Promise<void>;
  readonly onCatalogUpdateRequested?: CatalogHardwareHooks["onUpdateRequested"];
  readonly onCatalogChanged?: (event: CatalogEvent) => void | Promise<void>;
  readonly onCatalogProfileChanged?: (profileId: string) => void | Promise<void>;
  readonly onCatalogManualMatchDecision?: CatalogHardwareHooks["onManualMatchDecision"];
  readonly onAdvancedPartialObjectProbeArm?: () => void | Promise<void>;
  readonly onAdvancedPartialObjectProbeRun?: (
    request: AdvancedPartialObjectProbeRunRequest,
  ) => void | Promise<void>;
  readonly onAdvancedPartialObjectProbeExport?: () => void | Promise<void>;
}

export interface AppViewOptions {
  readonly catalogApi?: CatalogApi;
  readonly catalogStorage?: Pick<Storage, "getItem" | "setItem">;
  readonly autoStartCatalog?: boolean;
}

const GATE_LABELS = ["Convert", "WebUSB", "MTP read", "Byte test", "Send", "Open"] as const;

type CatalogRouteOverlayPatch = Partial<{
  bookId: string | null;
  matchItemId: string | null;
  matchBookId: string | null;
  seriesKey: string | null;
  sendQueueOpen: boolean;
  shelfManagerOpen: boolean;
  activityOpen: boolean;
}>;

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function hex(value: number | undefined, width = 4): string {
  return value === undefined ? "—" : `0x${value.toString(16).toUpperCase().padStart(width, "0")}`;
}

function statusChip(label: string, tone: "ok" | "neutral" | "warning" | "error" = "neutral"): string {
  const suffix = tone === "ok" ? "" : ` ${tone}`;
  return `<span class="status-chip${suffix}"><span class="status-dot"></span>${escapeHtml(label)}</span>`;
}

function gateMark(status: GateStatus, index: number): string {
  if (status === "passed") return "✓";
  if (status === "failed") return "!";
  return String(index);
}

function renderGateRail(state: AppState): string {
  return deriveGateStatuses(state).map((status, index) => `
    <li class="gate" data-status="${status}" aria-label="Gate ${index}, ${GATE_LABELS[index]}: ${status}"${status === "active" ? ' aria-current="step"' : ""}>
      <span class="gate-number">${gateMark(status, index)}</span>${GATE_LABELS[index]}
      <span class="sr-only">${status}</span>
    </li>
  `).join("");
}

function selectedEpub(state: AppState): File | undefined {
  return state.conversion.kind === "empty" ? undefined : state.conversion.file;
}

function renderConversion(state: AppState, catalogSendBusy = false): string {
  const file = selectedEpub(state);
  const converting = state.conversion.kind === "converting";
  const ready = state.conversion.kind === "ready";
  const locked = converting || state.integratedTransfer.kind === "sending" || catalogSendBusy;
  return `
    <section class="panel panel-wide" aria-labelledby="conversion-title">
      <div class="panel-head">
        <div>
          <div class="panel-title" id="conversion-title">Gate 0 · Choose and convert an EPUB</div>
          <div class="panel-kicker">Runs inside this browser in a private worker; the book is never uploaded</div>
        </div>
        ${ready ? statusChip("AZW3 ready", "ok") : converting ? statusChip("Converting", "warning") : statusChip("Local WASM")}
      </div>
      <div class="notice success local-conversion-notice">
        <div><strong>No Calibre installation</strong>boko WASM performs EPUB → AZW3 conversion locally. DRM-protected EPUB files are not supported.</div>
      </div>
      <div class="file-slot${file ? " has-file" : ""}">
        <div class="file-icon" aria-hidden="true">EPUB</div>
        <div class="grow">
          <div class="file-name">${file ? escapeHtml(file.name) : "No EPUB selected"}</div>
          <div class="meta">${file ? `${formatBytes(file.size)} · stays in this browser` : "Choose a DRM-free .epub file up to 200 MB"}</div>
        </div>
        <input class="file-picker" aria-label="Choose EPUB" id="epub-input" type="file" accept=".epub,application/epub+zip"${locked ? " disabled" : ""} />
      </div>
      ${ready ? `
        <div class="kv-list">
          <div class="kv-row"><span>Title</span><span>${escapeHtml(state.conversion.result.metadata.title || "Untitled")}</span></div>
          <div class="kv-row"><span>Author</span><span>${escapeHtml(state.conversion.result.metadata.authors.join(", ") || "Unknown")}</span></div>
          <div class="kv-row"><span>Converted file</span><span>${escapeHtml(state.conversion.result.filename)}</span></div>
          <div class="kv-row"><span>Output size</span><span>${formatBytes(state.conversion.result.blob.size)}</span></div>
          <div class="kv-row"><span>Validation</span><span>BOOKMOBI container verified</span></div>
          <div class="kv-row"><span>Kindle library mode</span><span>Personal document (PDOC)</span></div>
          <div class="kv-row"><span>Library cover</span><span>${state.conversion.result.diagnostics.embeddedCover ? "Embedded cover verified" : "No embedded cover detected in the EPUB"}</span></div>
        </div>
      ` : ""}
      <div class="actions">
        <button type="button" class="primary" data-action="convert"${!file || locked ? " disabled" : ""}>${converting ? "Converting locally…" : ready ? "Convert again" : "Convert to AZW3"}</button>
        <button type="button" data-action="download-converted"${!ready || locked ? " disabled" : ""}>Download a backup</button>
      </div>
    </section>
  `;
}

function deviceDetails(state: AppState): DeviceDetails | undefined {
  return state.device.kind === "disconnected" || state.device.kind === "requesting-permission"
    ? undefined
    : state.device.details;
}

function renderDevice(state: AppState): string {
  const details = deviceDetails(state);
  const ready = state.device.kind === "ready";
  const connecting = state.device.kind === "requesting-permission" || state.device.kind === "opening" || state.device.kind === "mtp-reading";
  const busy = state.device.kind === "transferring" || state.device.kind === "recovering" || state.selfTest.kind === "running";
  const conversionReady = state.conversion.kind === "ready" && state.conversion.validated;
  const canConnect = conversionReady && !connecting && !busy && (state.device.kind === "disconnected" || state.device.kind === "error");
  const canSelfTest = ready && state.mtpReadProven && !state.pendingObjectCleanup;
  return `
    <section class="panel" aria-labelledby="device-title">
      <div class="panel-head">
        <div><div class="panel-title" id="device-title">Gates 1–3 · Connect and prove writes</div><div class="panel-kicker">WebUSB permission, read-only MTP inspection, then an exact-byte round trip</div></div>
        ${ready ? statusChip("Kindle ready", "ok") : connecting ? statusChip("Connecting", "warning") : statusChip("Disconnected")}
      </div>
      <div class="kv-list">
        <div class="kv-row"><span>Device</span><span>${escapeHtml(details?.model ?? details?.productName ?? "Not connected")}</span></div>
        <div class="kv-row"><span>USB IDs</span><span>${hex(details?.vendorId)} / ${hex(details?.productId)}</span></div>
        <div class="kv-row"><span>Documents handle</span><span>${hex(details?.documentsHandle, 8)}</span></div>
        <div class="kv-row"><span>Self-test</span><span>${state.selfTest.kind === "passed" ? `Passed · ${state.selfTest.byteLength} bytes` : state.selfTest.kind.replaceAll("-", " ")}</span></div>
      </div>
      ${state.device.kind === "error" ? `
        <div class="notice error device-error" role="alert">
          <div><strong>${escapeHtml(state.device.error.code)}</strong>${escapeHtml(state.device.error.message)}</div>
        </div>
      ` : ""}
      <div class="actions">
        <button type="button" class="primary" data-action="connect"${!state.secureContext || !state.webUsbAvailable || !canConnect ? " disabled" : ""}>${state.device.kind === "error" ? "Retry connection" : "Connect Kindle"}</button>
        <button type="button" data-action="disconnect"${state.device.kind === "disconnected" || state.device.kind === "error" || busy ? " disabled" : ""}>Disconnect</button>
        <button type="button" data-action="self-test"${!canSelfTest ? " disabled" : ""}>Run byte self-test</button>
      </div>
    </section>
  `;
}

function transferProgress(transfer: TransferState): string {
  if (transfer.kind !== "sending") return "";
  const percent = transfer.totalBytes === 0 ? 0 : Math.round(100 * transfer.sentBytes / transfer.totalBytes);
  return `<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div><div class="meta">${percent}% · ${formatBytes(transfer.sentBytes)} of ${formatBytes(transfer.totalBytes)}</div>`;
}

function renderTransfer(state: AppState): string {
  const transfer = state.integratedTransfer;
  const readyArtifact = state.conversion.kind === "ready" && state.conversion.validated;
  const canSend = state.device.kind === "ready" && state.selfTest.kind === "passed" && readyArtifact && !state.pendingObjectCleanup && transfer.kind !== "sending";
  const verified = transfer.kind === "verified";
  const artifactMatches = verified && state.conversion.kind === "ready" && transfer.artifactId === state.conversion.artifactId;
  return `
    <section class="panel" aria-labelledby="transfer-title">
      <div class="panel-head">
        <div><div class="panel-title" id="transfer-title">Gates 4–5 · Send and open</div><div class="panel-kicker">Writes only the newly converted filename; never overwrites an existing book</div></div>
        ${verified ? statusChip(transfer.physicalOpenConfirmed ? "Complete" : "Verify Kindle", transfer.physicalOpenConfirmed ? "ok" : "warning") : statusChip("Waiting")}
      </div>
      ${transferProgress(transfer)}
      ${verified ? `<div class="notice success"><div><strong>Transfer verified and USB closed</strong>Eject or unplug the Kindle, wait for indexing, then open <code>${escapeHtml(transfer.filename)}</code> and test chapter navigation.</div></div>` : ""}
      <div class="actions">
        <button type="button" class="primary" data-action="send-integrated"${!canSend ? " disabled" : ""}>Send converted book</button>
        <button type="button" data-action="confirm-integrated-open"${!verified || !artifactMatches || transfer.physicalOpenConfirmed ? " disabled" : ""}>It opens correctly</button>
      </div>
      ${transfer.kind === "failed" && transfer.cleanupRequired ? `<div class="error-box"><div class="error-code">CLEANUP REQUIRED</div>${escapeHtml(transfer.cleanupRequired)}</div>` : ""}
    </section>
  `;
}

function safeDetails(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (key, item: unknown) => {
    if (/^(?:stdout|stderr|raw|output|bookContent)$/iu.test(key)) return "[redacted]";
    if (/serial/iu.test(key) && typeof item === "string") return item.length <= 4 ? "••••" : `••••${item.slice(-4)}`;
    if (typeof item === "bigint") return item.toString();
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[Circular]";
      seen.add(item);
    }
    return item;
  }).slice(0, 2_000);
}

function renderError(state: AppState): string {
  if (!state.activeError) return "";
  return `<div class="notice error" role="alert"><div><strong>${escapeHtml(state.activeError.code)}</strong>${escapeHtml(state.activeError.message)}${state.activeError.details ? `<div>${escapeHtml(safeDetails(state.activeError.details))}</div>` : ""}</div></div>`;
}

function renderRecovery(state: AppState): string {
  const pending = state.pendingObjectCleanup;
  const interrupted = !pending || pendingObjectWriteActive(state)
    ? ""
    : (() => {
        const location = pending.purpose === "metadata-cache" ? "the Kindle storage root" : "Documents";
        return `<section class="notice error recovery-notice" role="alert"><div class="grow"><strong>Interrupted Kindle write</strong>Inspect ${location} for exactly <code>${escapeHtml(pending.filename)}</code>. Remove only that exact managed filename if it is partial, then acknowledge the inspection.<div class="actions"><button type="button" data-action="confirm-cleanup-inspection">I inspected this filename</button></div></div></section>`;
      })();
  const replacements = state.pendingReplacementCleanups ?? [];
  if (replacements.length === 0) return interrupted;
  const canClean = state.device.kind === "ready"
    && state.selfTest.kind === "passed"
    && state.catalogInventoryState === "ready";
  const replacementNotice = `<section class="notice error recovery-notice" role="alert"><div class="grow"><strong>Verified replacement needs exact cleanup</strong>${replacements.length === 1 ? "One replacement recovery task remains." : `${replacements.length} replacement recovery tasks remain.`} Connect the matching Kindle and use the explicit action below. ShelfSend will first rebuild a complete inventory and revalidate both exact objects; it will never delete from this reminder alone.<ul>${replacements.map((record) => {
    const deliveryMissing = record.reason === "delivery-recording";
    return `<li><span><code>${escapeHtml(record.oldCopy.filename)}</code><br><small>${deliveryMissing ? `Unrecorded replacement: ${escapeHtml(record.newCopy.filename)}. The safe recovery removes only that new copy and retains this prior copy.` : `Replacement kept: ${escapeHtml(record.newCopy.filename)}`}</small></span><button type="button" data-action="cleanup-managed-replacement" data-cleanup-operation-id="${escapeHtml(record.operationId)}"${canClean ? "" : " disabled"}>${canClean ? deliveryMissing ? "Remove unrecorded replacement" : "Remove exact older copy" : "Connect and finish checks"}</button></li>`;
  }).join("")}</ul></div></section>`;
  return `${interrupted}${replacementNotice}`;
}

function renderProfile(state: AppState, draft: TargetProfile): string {
  const fields: ReadonlyArray<readonly [keyof TargetProfile, string]> = [
    ["macModel", "Computer model / CPU"], ["macosVersion", "Operating system"], ["chromeVersion", "Chromium browser"],
    ["kindleModel", "Kindle model"], ["kindleFirmware", "Kindle firmware"], ["usbCable", "USB cable / adapter"],
    ["kindleUsbMode", "Kindle USB mode"],
  ];
  return `<section class="panel panel-wide"><details class="diagnostics"><summary>Optional test-environment notes</summary><div class="profile-grid">${fields.map(([key, label]) => `<label class="field-label"><span>${escapeHtml(label)}</span><input data-profile-field="${key}" value="${escapeHtml(draft[key])}" autocomplete="off" /></label>`).join("")}</div><div class="actions right"><span class="profile-status">${targetProfileComplete(state.targetProfile) ? "Saved" : "Optional"}</span><button type="button" data-action="save-profile">Save notes</button></div></details></section>`;
}

export class AppView {
  readonly #root: HTMLElement;
  readonly #handlers: AppViewHandlers;
  readonly #debugLog: DebugLog;
  readonly #catalog: CatalogBrowser;
  #state: AppState;
  #profileDraft: TargetProfile;
  #diagnosticsDeviceQuery = "";
  #catalogDialogReturnBookId?: string;
  #catalogRemovalReturnBookId?: string;
  #catalogUpdateReturnBookId?: string;
  #catalogMetadataReturnBookId?: string;
  #catalogDetailsReturnBookId?: string;
  #catalogDetailsScrollY = 0;
  #catalogContextRestoreToken = -1;
  #catalogScrollFrame?: number;
  #settingsDeleteReturnLibraryId?: string;
  #advancedPartialObjectProbe: AdvancedPartialObjectProbeViewState = { phase: "off" };

  constructor(
    root: HTMLElement,
    state: AppState,
    handlers: AppViewHandlers,
    debugLog: DebugLog,
    options: AppViewOptions = {},
  ) {
    this.#root = root;
    this.#state = state;
    this.#handlers = handlers;
    this.#debugLog = debugLog;
    this.#profileDraft = { ...state.targetProfile };
    const catalogHooks: CatalogHardwareHooks = {
      onConnectRequested: handlers.onCatalogConnectRequested,
      onDisconnectRequested: handlers.onCatalogDisconnectRequested,
      onSendRequested: handlers.onCatalogSendRequested,
      onSendBatchFinished: handlers.onCatalogSendBatchFinished,
      onRemoveRequested: handlers.onCatalogRemoveRequested,
      onUpdateRequested: handlers.onCatalogUpdateRequested,
      onCatalogChanged: handlers.onCatalogChanged,
      onActiveProfileChanged: handlers.onCatalogProfileChanged,
      onManualMatchDecision: handlers.onCatalogManualMatchDecision,
    };
    this.#catalog = new CatalogBrowser(
      options.catalogApi ?? createCatalogClient(),
      catalogHooks,
      (scope) => {
        if (scope === "results") this.#refreshCatalogResults();
        else if (scope === "device") this.#refreshCatalogDeviceContents();
        else if (scope === "results-and-device") {
          this.#refreshCatalogResults();
          this.#refreshCatalogDeviceContents();
        } else this.render(this.#state);
      },
      options.catalogStorage,
    );
    this.render(state);
    debugLog.subscribe(() => this.#renderLog());
    window.addEventListener("scroll", () => {
      if (!this.#root.isConnected || this.#catalog.snapshot.bookDetails || this.#catalogScrollFrame !== undefined) return;
      this.#catalogScrollFrame = window.requestAnimationFrame(() => {
        this.#catalogScrollFrame = undefined;
        this.#catalog.setScrollPosition(window.scrollY);
      });
    }, { passive: true });
    window.addEventListener("popstate", () => {
      if (this.#root.isConnected) void this.#restoreCatalogRoute(true);
    });
    if (options.autoStartCatalog !== false) {
      void this.#catalog.start().then(() => this.#restoreCatalogRoute());
    }
  }

  #currentCatalogRoute(overrides: CatalogRouteOverlayPatch = {}): LibraryRouteState {
    const snapshot = this.#catalog.snapshot;
    const bookId = overrides.bookId === undefined ? snapshot.bookDetails?.bookId : overrides.bookId ?? undefined;
    const matchItemId = overrides.matchItemId === undefined ? snapshot.matchReview?.itemId : overrides.matchItemId ?? undefined;
    const matchBookId = matchItemId
      ? overrides.matchBookId === undefined ? snapshot.matchReview?.requestedBookId : overrides.matchBookId ?? undefined
      : undefined;
    const seriesKey = overrides.seriesKey === undefined ? snapshot.seriesDetail?.key : overrides.seriesKey ?? undefined;
    const overlays: LibraryRouteOverlays = {
      ...(bookId ? { bookId } : {}),
      ...(matchItemId ? { matchItemId } : {}),
      ...(matchBookId ? { matchBookId } : {}),
      ...(seriesKey ? { seriesKey } : {}),
      sendQueueOpen: overrides.sendQueueOpen ?? snapshot.sendQueueOpen,
      shelfManagerOpen: overrides.shelfManagerOpen ?? snapshot.shelfManagerOpen,
      activityOpen: overrides.activityOpen ?? snapshot.activityOpen,
    };
    return {
      version: 1,
      ...(snapshot.filters.profileId ? { profileId: snapshot.filters.profileId } : {}),
      ...(snapshot.activeShelf ? { activeShelfId: snapshot.activeShelf.id } : {}),
      filters: snapshot.filters,
      layout: snapshot.layout,
      density: snapshot.density ?? "comfortable",
      overlays,
    };
  }

  #writeCatalogRoute(
    overrides: CatalogRouteOverlayPatch,
    mode: "push" | "replace",
    state: Record<string, unknown> = {},
  ): void {
    const url = encodeLibraryRoute(this.#currentCatalogRoute(overrides));
    if (mode === "push") window.history.pushState(state, "", url);
    else window.history.replaceState(state, "", url);
  }

  async #restoreCatalogRoute(fromHistory = false): Promise<void> {
    const route = decodeLibraryRoute(window.location.hash);
    if (!route) {
      if (fromHistory && this.#catalog.snapshot.bookDetails) this.#closeBookDetails(false);
      else if (fromHistory && this.#catalog.snapshot.matchReview) this.#closeMatchReview(false);
      return;
    }
    const closingBookDetails = this.#catalog.snapshot.bookDetails !== undefined
      && route.overlays.bookId !== this.#catalog.snapshot.bookDetails.bookId;
    const closingMatchReview = this.#catalog.snapshot.matchReview !== undefined
      && route.overlays.matchItemId !== this.#catalog.snapshot.matchReview.itemId;
    const returnBookId = this.#catalogDetailsReturnBookId ?? this.#catalog.snapshot.bookDetails?.bookId;
    const returnMatchItemId = this.#catalog.snapshot.matchReview?.itemId;
    const returnScrollY = this.#catalogDetailsScrollY;
    if (!await this.#catalog.applyLibraryRoute(route)) {
      // A device mutation intentionally blocks navigation. Keep the address
      // bar truthful instead of leaving a popped URL that the busy UI did not
      // apply; the user can navigate again once the operation settles.
      if (fromHistory) this.#writeCatalogRoute({}, "replace");
      return;
    }
    if (route.overlays.bookId) await this.#catalog.openBookDetails(route.overlays.bookId);
    else if (route.overlays.matchItemId) await this.#catalog.openMatchReview(route.overlays.matchItemId, route.overlays.matchBookId);
    else if (route.overlays.seriesKey) await this.#catalog.openSeries(route.overlays.seriesKey);
    if (closingBookDetails) this.#restoreBookDetailsOrigin(returnBookId, returnScrollY);
    if (closingMatchReview && returnMatchItemId) this.#restoreMatchReviewOrigin(returnMatchItemId);
  }

  render(state: AppState): void {
    this.#state = state;
    const active = document.activeElement;
    const transferFocusBookId = active instanceof HTMLButtonElement && this.#root.contains(active)
      && active.matches('[data-ui-action="send-book"], [data-ui-action="cancel-book-send"], [data-ui-action="retry-book-send"]')
      ? active.dataset.bookId : undefined;
    const preservedInputFocus = active instanceof HTMLInputElement
      && active.id
      && this.#root.contains(active)
      && active.closest(".settings-page, .library-toolbar, .settings-diagnostics")
      ? {
          id: active.id,
          value: active.value,
          start: active.selectionStart,
          end: active.selectionEnd,
          direction: active.selectionDirection,
        }
      : undefined;
    const moreFiltersOpen = this.#root.querySelector<HTMLDetailsElement>(".library-more-filters")?.open ?? false;
    const openDiagnostics = new Set([...this.#root.querySelectorAll<HTMLDetailsElement>("details[data-diagnostic-panel][open]")]
      .map((details) => details.dataset.diagnosticPanel));
    const globalAlerts = `${renderRecovery(state)}${renderError(state)}`;
    const connected = state.device.kind === "ready" || state.device.kind === "transferring" || state.device.kind === "recovering";
    const diagnostics = this.#catalog.snapshot.filters.view === "settings" ? `
      <section class="poc-lab settings-diagnostics" aria-labelledby="poc-lab-title">
        <details data-diagnostic-panel="main">
          <summary><span><strong id="poc-lab-title">Diagnostics</strong><small>Device files, connection tools, and debug reports</small></span></summary>
          <div class="poc-lab-content">
            <details data-diagnostic-panel="device-files" class="settings-diagnostic-group">
              <summary>Kindle files <small>Inspect the most recent device scan</small></summary>
              <label class="diagnostics-search"><span>Search Kindle files</span><input type="search" id="diagnostics-device-search" value="${escapeHtml(this.#diagnosticsDeviceQuery)}" placeholder="Title, author, or filename" /></label>
              ${renderKindleDeviceContents(this.#catalog.snapshot, connected, state.catalogInventoryState, this.#diagnosticsDeviceQuery)}
            </details>
            <details data-diagnostic-panel="transfer-tools" class="settings-diagnostic-group">
              <summary>Connection &amp; transfer tools <small>Manual checks for troubleshooting</small></summary>
              <ol class="gate-rail" aria-label="Diagnostic checks">${renderGateRail(state)}</ol>
              <div class="main-content">
                ${!state.secureContext ? '<div class="notice error"><div><strong>Secure context required</strong>Open ShelfSend through trusted HTTPS or localhost.</div></div>' : ""}
                ${!state.webUsbAvailable ? '<div class="notice error"><div><strong>WebUSB unavailable</strong>Use Chrome or another compatible Chromium browser.</div></div>' : ""}
                <div class="grid">${renderConversion(state, this.#catalog.snapshot.sendBusy)}${renderDevice(state)}${renderTransfer(state)}${renderProfile(state, this.#profileDraft)}</div>
              </div>
            </details>
            <details data-diagnostic-panel="reports" class="settings-diagnostic-group">
              <summary>Debug reports <small>Detailed activity and device diagnostics</small></summary>
              <div class="log-toolbar"><button type="button" data-action="copy-log">Copy debug log</button><button type="button" data-ui-action="export-activity-report">Download activity report</button></div>
              <pre class="debug-log" id="debug-log"></pre>
              <div data-ui-partial-object-probe></div>
            </details>
          </div>
        </details>
      </section>` : "";
    this.#root.innerHTML = `<div class="app-shell library-app-shell">
      ${renderLibraryPrototype(state, this.#catalog.snapshot, globalAlerts, diagnostics)}
    </div>`;
    this.#root.querySelectorAll<HTMLDetailsElement>("details[data-diagnostic-panel]").forEach((details) => {
      details.open = openDiagnostics.has(details.dataset.diagnosticPanel);
    });
    this.#renderAdvancedPartialObjectProbe();
    this.#bindEvents();
    this.#renderLog();
    if (transferFocusBookId) {
      [...this.#root.querySelectorAll<HTMLButtonElement>('.library-card-actions button[data-book-id], .library-off-card-send button[data-book-id]')]
        .find((button) => button.dataset.bookId === transferFocusBookId && !button.disabled)?.focus({ preventScroll: true });
    }
    const moreFilters = this.#root.querySelector<HTMLDetailsElement>(".library-more-filters");
    if (moreFilters) moreFilters.open = moreFiltersOpen;
    if (preservedInputFocus) {
      const replacement = document.getElementById(preservedInputFocus.id);
      if (replacement instanceof HTMLInputElement && this.#root.contains(replacement) && !replacement.disabled) {
        // Typed facet values are committed on change rather than every input
        // event. Preserve the live DOM value as well as the caret when an SSE
        // status update refreshes the surrounding application shell.
        replacement.value = preservedInputFocus.value;
        replacement.focus({ preventScroll: true });
        if (preservedInputFocus.start !== null && preservedInputFocus.end !== null) {
          replacement.setSelectionRange(
            preservedInputFocus.start,
            preservedInputFocus.end,
            preservedInputFocus.direction ?? undefined,
          );
        }
      }
    }
    const restoreToken = this.#catalog.snapshot.contextRestoreToken ?? 0;
    if (this.#catalog.snapshot.booksState === "ready" && restoreToken !== this.#catalogContextRestoreToken) {
      this.#catalogContextRestoreToken = restoreToken;
      const scrollY = this.#catalog.snapshot.contextScrollY ?? 0;
      window.queueMicrotask(() => {
        try { window.scrollTo({ top: scrollY, behavior: "auto" }); } catch { /* jsdom and older browsers */ }
      });
    }
  }

  #renderLog(): void {
    const element = this.#root.querySelector<HTMLPreElement>("#debug-log");
    if (element) element.textContent = this.#debugLog.format() || "Application ready";
  }

  #renderAdvancedPartialObjectProbe(): void {
    const mount = this.#root.querySelector<HTMLElement>("[data-ui-partial-object-probe]");
    if (!mount) return;
    mountAdvancedPartialObjectProbe(mount, this.#advancedPartialObjectProbe, {
      onArm: this.#handlers.onAdvancedPartialObjectProbeArm,
      onRun: this.#handlers.onAdvancedPartialObjectProbeRun,
      onExport: this.#handlers.onAdvancedPartialObjectProbeExport,
    });
  }

  #bindEvents(): void {
    this.#root.querySelectorAll<HTMLInputElement>("input[data-profile-field]").forEach((input) => input.addEventListener("input", () => {
      const key = input.dataset.profileField as keyof TargetProfile | undefined;
      if (key) this.#profileDraft = { ...this.#profileDraft, [key]: input.value };
    }));
    this.#root.querySelector<HTMLInputElement>("#epub-input")?.addEventListener("change", (event) => {
      const file = (event.currentTarget as HTMLInputElement).files?.[0];
      if (file) this.#handlers.onEpubSelected(file);
    });
    const actions: Record<string, () => void> = {
      "save-profile": () => this.#handlers.onTargetProfileSaved(this.#profileDraft),
      convert: this.#handlers.onConvert,
      "download-converted": this.#handlers.onDownloadConverted,
      connect: this.#handlers.onConnect,
      disconnect: this.#handlers.onDisconnect,
      "self-test": this.#handlers.onSelfTest,
      "send-integrated": this.#handlers.onSendIntegrated,
      "confirm-integrated-open": this.#handlers.onIntegratedOpenConfirmed,
      "confirm-cleanup-inspection": this.#handlers.onCleanupInspectionConfirmed,
      "copy-log": this.#handlers.onCopyLog,
    };
    this.#root.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((button) => button.addEventListener("click", () => actions[button.dataset.action ?? ""]?.()));
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-action="cleanup-managed-replacement"]').forEach((button) => button.addEventListener("click", () => {
      const operationId = button.dataset.cleanupOperationId;
      if (operationId) void this.#handlers.onReplacementCleanupRequested?.(operationId);
    }));
    this.#bindCatalogEvents();
  }

  #bindCatalogEvents(): void {
    this.#root.querySelector<HTMLInputElement>("#diagnostics-device-search")?.addEventListener("input", (event) => {
      this.#diagnosticsDeviceQuery = (event.currentTarget as HTMLInputElement).value;
      this.#catalog.goToKindleInventoryPage(0);
    });
    this.#root.querySelectorAll<HTMLButtonElement>("[data-ui-summary-filter]").forEach((button) => button.addEventListener("click", () => {
      this.#catalog.applyKindleSummaryFilter(button.dataset.uiSummaryFilter as KindleFilter);
      this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace");
    }));
    this.#root.querySelector<HTMLButtonElement>('[data-ui-action="open-settings-diagnostics"]')?.addEventListener("click", () => {
      this.#closeActivityCenter(false);
      void this.#catalog.setView("settings").then(() => {
        this.#writeCatalogRoute({}, "replace");
        const details = this.#root.querySelector<HTMLDetailsElement>('[data-diagnostic-panel="main"]');
        if (details) {
          details.open = true;
          details.querySelector<HTMLElement>("summary")?.focus();
        }
      });
    });
    this.#root.querySelector<HTMLInputElement>("#library-search")?.addEventListener("input", (event) => {
      this.#catalog.updateFilter("query", (event.currentTarget as HTMLInputElement).value);
      this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace");
    });
    const selects: ReadonlyArray<readonly [string, "language" | "format" | "rootId" | "year"]> = [
      ["#library-language", "language"], ["#library-format", "format"],
      ["#library-root-filter", "rootId"], ["#library-year", "year"],
    ];
    selects.forEach(([selector, key]) => this.#root.querySelector<HTMLSelectElement>(selector)?.addEventListener("change", (event) => {
      this.#catalog.updateFilter(key, (event.currentTarget as HTMLSelectElement).value);
      this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace");
    }));
    const typedFacets: ReadonlyArray<readonly [string, "author" | "subject" | "publisher" | "series"]> = [
      ["#library-author", "author"], ["#library-subject", "subject"],
      ["#library-publisher", "publisher"], ["#library-series", "series"],
    ];
    typedFacets.forEach(([selector, key]) => this.#root.querySelector<HTMLInputElement>(selector)?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLInputElement).value.trim();
      this.#catalog.updateFilter(key, value || "all");
      this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace");
    }));
    this.#root.querySelector<HTMLSelectElement>("#library-metadata")?.addEventListener("change", (event) => {
      this.#catalog.updateFilter("metadata", (event.currentTarget as HTMLSelectElement).value as MetadataFilter);
      this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace");
    });
    this.#root.querySelector<HTMLSelectElement>("#library-kindle-filter")?.addEventListener("change", (event) => {
      this.#catalog.updateFilter("kindle", (event.currentTarget as HTMLSelectElement).value as KindleFilter);
      this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace");
    });
    this.#root.querySelectorAll<HTMLButtonElement>("button[data-ui-kindle-filter]").forEach((button) => button.addEventListener("click", () => {
      this.#catalog.updateFilter("kindle", button.dataset.uiKindleFilter as KindleFilter);
      this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace");
    }));
    this.#root.querySelector<HTMLSelectElement>("#library-sort")?.addEventListener("change", (event) => {
      this.#catalog.updateFilter("sort", (event.currentTarget as HTMLSelectElement).value as LibrarySort);
      this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace");
    });
    this.#root.querySelectorAll<HTMLButtonElement>("button[data-ui-profile]").forEach((button) => button.addEventListener("click", () => {
      this.#captureSettingsForm();
      const profileId = button.dataset.uiProfile;
      if (profileId) void this.#catalog.selectProfile(profileId).then(() => this.#writeCatalogRoute({}, "replace"));
    }));
    this.#root.querySelectorAll<HTMLButtonElement>("button[data-ui-view]").forEach((button) => button.addEventListener("click", () => {
      this.#captureSettingsForm();
      if (this.#catalog.snapshot.activityOpen) this.#closeActivityCenter(false);
      void this.#catalog.setView(button.dataset.uiView as LibraryView).then(() => this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace"));
    }));
    const focusSetup = () => window.queueMicrotask(() => {
      this.#root.querySelector<HTMLElement>('.onboarding-wizard button, #settings-library-name')?.focus();
    });
    this.#root.querySelector<HTMLSelectElement>('#library-reading-filter')?.addEventListener("change", (event) => {
      void this.#catalog.setReadingFilter((event.currentTarget as HTMLSelectElement).value);
    });
    this.#root.querySelector<HTMLButtonElement>('[data-ui-action="onboarding-open"]')?.addEventListener("click", () => { void this.#catalog.openOnboarding().then(focusSetup); });
    this.#root.querySelector<HTMLButtonElement>('[data-ui-action="onboarding-next"]')?.addEventListener("click", () => { void this.#catalog.advanceOnboarding().then(focusSetup); });
    this.#root.querySelector<HTMLButtonElement>('[data-ui-action="onboarding-skip"]')?.addEventListener("click", () => { void this.#catalog.dismissOnboarding().then(() => this.#root.querySelector<HTMLElement>('#settings-library-name, #library-search')?.focus()); });
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="connect-catalog-device"]').forEach((button) => button.addEventListener("click", () => {
      void this.#catalog.requestConnect();
    }));
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="disconnect-catalog-device"]').forEach((button) => button.addEventListener("click", () => {
      void this.#catalog.requestDisconnect();
    }));
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="show-kindle"]')?.addEventListener("click", () => {
      void this.#catalog.setView("on-kindle").then(() => this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace"));
    });
    this.#root.querySelector<HTMLInputElement>("#series-search")?.addEventListener("change", (event) => {
      void this.#catalog.loadSeries((event.currentTarget as HTMLInputElement).value);
    });
    this.#root.querySelector<HTMLSelectElement>("#series-sort")?.addEventListener("change", (event) => {
      const sort = (event.currentTarget as HTMLSelectElement).value;
      if (sort === "name" || sort === "count") this.#catalog.setSeriesSort(sort);
    });
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="open-series"]').forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.seriesKey;
      if (!key) return;
      if (button.closest(".library-book-details-sheet")) this.#closeBookDetails(true, false);
      void this.#catalog.setView("series").then(async () => {
        this.#writeCatalogRoute({ bookId: null, seriesKey: key }, "push", { kindleBridgeSeries: key });
        await this.#catalog.openSeries(key);
      });
    }));
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="close-series"]')?.addEventListener("click", () => {
      this.#catalog.closeSeries();
      this.#writeCatalogRoute({ seriesKey: null }, "replace");
    });
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="queue-series"]').forEach((button) => button.addEventListener("click", () => {
      const mode = button.dataset.mode;
      if (mode === "next" || mode === "all") void this.#catalog.queueSeriesBooks(mode);
    }));
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="open-send-queue"]').forEach((button) => button.addEventListener("click", () => {
      if (button.closest(".library-activity-sheet")) {
        this.#catalog.toggleActivityCenter(false);
        this.#catalog.toggleSendQueue(true);
        this.#writeCatalogRoute({ activityOpen: false, sendQueueOpen: true }, "replace");
      } else {
        this.#writeCatalogRoute({ sendQueueOpen: true }, "push", { kindleBridgeQueue: true });
        this.#catalog.toggleSendQueue(true);
      }
    }));
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="open-activity-center"]').forEach((button) => button.addEventListener("click", () => {
      this.#writeCatalogRoute({ activityOpen: true }, "push", { kindleBridgeActivity: true });
      this.#catalog.toggleActivityCenter(true);
    }));
    this.#root.querySelectorAll<HTMLElement>('[data-ui-action="close-activity-center"]').forEach((element) => element.addEventListener("click", () => this.#closeActivityCenter()));
    this.#root.querySelector<HTMLButtonElement>('[data-ui-action="clear-activity-history"]')?.addEventListener("click", () => this.#catalog.clearActivityHistory());
    this.#root.querySelectorAll<HTMLButtonElement>('[data-ui-action="acknowledge-activity"]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.eventId) this.#catalog.acknowledgeActivity(button.dataset.eventId);
    }));
    this.#root.querySelector<HTMLButtonElement>('[data-ui-action="open-activity-metadata-job"]')?.addEventListener("click", () => {
      const jobId = this.#root.querySelector<HTMLButtonElement>('[data-ui-action="open-activity-metadata-job"]')?.dataset.jobId;
      if (!jobId) return;
      this.#closeActivityCenter(false);
      void this.#catalog.setView("attention").then(async () => {
        this.#writeCatalogRoute({ activityOpen: false, sendQueueOpen: false, shelfManagerOpen: false }, "replace");
        await this.#catalog.openMetadataLookupJob(jobId);
      });
    });
    this.#root.querySelectorAll<HTMLButtonElement>('[data-ui-action="activity-event-action"]').forEach((button) => button.addEventListener("click", () => {
      const action = button.dataset.eventAction;
      if (button.dataset.eventId) this.#catalog.acknowledgeActivity(button.dataset.eventId);
      this.#closeActivityCenter(false);
      if (action === "open-queue") {
        this.#catalog.toggleSendQueue(true);
        this.#writeCatalogRoute({ activityOpen: false, sendQueueOpen: true }, "replace");
      } else if (action === "reconnect") {
        this.#writeCatalogRoute({ activityOpen: false }, "replace");
        void this.#catalog.requestConnect();
      } else if (action === "rescan" || action === "open-attention" || action === "open-settings") {
        void this.#catalog.setView(action === "open-settings" ? "settings" : "attention").then(() => {
          this.#writeCatalogRoute({ activityOpen: false, sendQueueOpen: false, shelfManagerOpen: false }, "replace");
        });
      } else if (action === "retry") {
        this.#writeCatalogRoute({ activityOpen: false }, "replace");
        void this.#catalog.retry();
      } else if (action === "retry-transfer") {
        this.#writeCatalogRoute({ activityOpen: false }, "replace");
        void this.#catalog.sendSelectedBooks();
      }
    }));
    this.#root.querySelector<HTMLButtonElement>('[data-ui-action="export-activity-report"]')?.addEventListener("click", () => this.#downloadActivityReport());
    this.#root.querySelector<HTMLSelectElement>("#catalog-health-type")?.addEventListener("change", (event) => {
      this.#catalog.setCatalogHealthFilter("type", (event.currentTarget as HTMLSelectElement).value as never);
    });
    this.#root.querySelector<HTMLSelectElement>("#catalog-health-severity")?.addEventListener("change", (event) => {
      this.#catalog.setCatalogHealthFilter("severity", (event.currentTarget as HTMLSelectElement).value as never);
    });
    this.#root.querySelector<HTMLInputElement>("#catalog-health-ignored")?.addEventListener("change", (event) => {
      this.#catalog.setCatalogHealthFilter("ignored", (event.currentTarget as HTMLInputElement).checked);
    });
    this.#root.querySelectorAll<HTMLButtonElement>('[data-ui-action="reload-catalog-health"]').forEach((button) => button.addEventListener("click", () => { void this.#catalog.loadCatalogHealth(); }));
    this.#root.querySelectorAll<HTMLButtonElement>('[data-ui-action="catalog-health-page"]').forEach((button) => button.addEventListener("click", () => {
      const offset = Number(button.dataset.pageOffset);
      if (Number.isSafeInteger(offset) && offset >= 0) this.#catalog.goToCatalogHealthPage(offset);
    }));
    this.#root.querySelectorAll<HTMLButtonElement>('[data-ui-action="set-catalog-issue-ignored"]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.issueSignature) void this.#catalog.setCatalogIssueIgnored(button.dataset.issueSignature, button.dataset.ignored === "true");
    }));
    this.#root.querySelectorAll<HTMLButtonElement>('[data-ui-action="retry-catalog-issue"]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.issueSignature) void this.#catalog.retryCatalogIssue(button.dataset.issueSignature);
    }));
    this.#root.querySelectorAll<HTMLButtonElement>('[data-ui-action="set-duplicate-preference"]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.issueSignature) void this.#catalog.setDuplicatePreference(button.dataset.issueSignature, button.dataset.bookId || null);
    }));
    this.#root.querySelectorAll<HTMLButtonElement>('[data-ui-action="review-issue-metadata"]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.bookId) void this.#catalog.openMetadataEditor(button.dataset.bookId);
    }));
    this.#root.querySelectorAll<HTMLButtonElement>('[data-ui-action="lookup-issue-metadata"]').forEach((button) => button.addEventListener("click", () => {
      const provider = button.dataset.provider;
      if (button.dataset.issueSignature && (provider === "open-library" || provider === "google-books")) {
        void this.#catalog.createMetadataLookupForIssue(button.dataset.issueSignature, provider);
      }
    }));
    this.#root.querySelector<HTMLButtonElement>('[data-ui-action="reload-metadata-jobs"]')?.addEventListener("click", () => { void this.#catalog.loadMetadataLookupJobs(); });
    this.#root.querySelectorAll<HTMLButtonElement>('[data-ui-action="open-metadata-job"]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.jobId) void this.#catalog.openMetadataLookupJob(button.dataset.jobId);
    }));
    this.#root.querySelector<HTMLButtonElement>('[data-ui-action="close-metadata-job"]')?.addEventListener("click", () => this.#catalog.closeMetadataLookupJob());
    this.#root.querySelectorAll<HTMLButtonElement>('[data-ui-action="control-metadata-job"]').forEach((button) => button.addEventListener("click", () => {
      const action = button.dataset.jobAction;
      if (action === "resume" || action === "pause" || action === "cancel" || action === "retry") void this.#catalog.controlMetadataLookupJob(action);
    }));
    this.#root.querySelector<HTMLButtonElement>('[data-ui-action="run-metadata-job"]')?.addEventListener("click", () => { void this.#catalog.runMetadataLookupJobStep(); });
    this.#root.querySelectorAll<HTMLButtonElement>('[data-ui-action="review-metadata-job-candidate"]').forEach((button) => button.addEventListener("click", () => {
      const { jobId, bookId, candidateId } = button.dataset;
      if (jobId && bookId && candidateId) void this.#catalog.reviewMetadataLookupCandidate(jobId, bookId, candidateId);
    }));
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="apply-smart-shelf"]').forEach((button) => button.addEventListener("click", () => {
      const shelfId = button.dataset.shelfId;
      if (!shelfId) return;
      void this.#catalog.applySmartShelf(shelfId).then(() => this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace"));
    }));
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="clear-smart-shelf"]')?.addEventListener("click", () => {
      this.#catalog.clearSmartShelf();
      this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace");
    });
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="manage-smart-shelves"]')?.addEventListener("click", () => {
      this.#writeCatalogRoute({ shelfManagerOpen: true }, "push", { kindleBridgeShelves: true });
      this.#catalog.toggleShelfManager(true);
    });
    this.#root.querySelectorAll<HTMLElement>('[data-ui-action="close-smart-shelves"]').forEach((element) => element.addEventListener("click", () => this.#closeSmartShelfDialog()));
    this.#root.querySelector<HTMLFormElement>("form.smart-shelf-save-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = this.#root.querySelector<HTMLInputElement>("#smart-shelf-name");
      if (input?.value.trim()) void this.#catalog.saveCurrentQueryAsShelf(input.value).then(() => { input.value = ""; });
    });
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="toggle-smart-shelf-pin"]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.shelfId) void this.#catalog.toggleSmartShelfPinned(button.dataset.shelfId);
    }));
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="move-smart-shelf"]').forEach((button) => button.addEventListener("click", () => {
      const direction = Number(button.dataset.direction);
      if (button.dataset.shelfId && (direction === -1 || direction === 1)) {
        void this.#catalog.movePinnedSmartShelf(button.dataset.shelfId, direction);
      }
    }));
    this.#root.querySelectorAll<HTMLFormElement>("form[data-smart-shelf-rename]").forEach((form) => form.addEventListener("submit", (event) => {
      event.preventDefault();
      const shelfId = form.dataset.smartShelfRename;
      const name = form.querySelector<HTMLInputElement>("input")?.value;
      if (shelfId && name?.trim()) void this.#catalog.renameSmartShelf(shelfId, name);
    }));
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="update-smart-shelf-query"]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.shelfId) void this.#catalog.updateSmartShelfToCurrentView(button.dataset.shelfId);
    }));
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="delete-smart-shelf"]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.shelfId) void this.#catalog.deleteSmartShelf(button.dataset.shelfId);
    }));
    this.#bindSettingsEvents();
    this.#bindCatalogResultActions();
  }

  #bindSettingsEvents(): void {
    this.#root.querySelector<HTMLFormElement>("form.settings-editor")?.addEventListener("submit", (event) => event.preventDefault());
    this.#root.querySelectorAll<HTMLButtonElement>("button[data-settings-library-id]").forEach((button) => button.addEventListener("click", () => {
      this.#captureSettingsForm();
      const libraryId = button.dataset.settingsLibraryId;
      if (libraryId) void this.#catalog.selectSettingsLibrary(libraryId).then(() => window.queueMicrotask(() => {
        (this.#root.querySelector<HTMLElement>('button[data-settings-library-id][aria-current="page"]')
          ?? this.#root.querySelector<HTMLElement>("#settings-library-name"))?.focus();
      }));
    }));
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="new-library"]')?.addEventListener("click", () => {
      this.#captureSettingsForm();
      this.#catalog.newLibrary();
      window.queueMicrotask(() => this.#root.querySelector<HTMLInputElement>("#settings-library-name")?.focus());
    });
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="add-settings-folder"]')?.addEventListener("click", () => {
      this.#captureSettingsForm();
      this.#catalog.addSettingsFolder();
      window.queueMicrotask(() => {
        const paths = this.#root.querySelectorAll<HTMLInputElement>("input[data-settings-folder-path]");
        paths.item(Math.max(0, paths.length - 1))?.focus();
      });
    });
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="remove-settings-folder"]').forEach((button) => button.addEventListener("click", () => {
      this.#captureSettingsForm();
      const folderId = button.dataset.folderId;
      if (!folderId) return;
      const folders = [...this.#root.querySelectorAll<HTMLElement>("[data-settings-folder-id]")];
      const removedIndex = Math.max(0, folders.findIndex((folder) => folder.dataset.settingsFolderId === folderId));
      this.#catalog.removeSettingsFolder(folderId);
      window.queueMicrotask(() => {
        const paths = [...this.#root.querySelectorAll<HTMLInputElement>("input[data-settings-folder-path]")];
        (paths[Math.min(removedIndex, Math.max(0, paths.length - 1))]
          ?? this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="add-settings-folder"]'))?.focus();
      });
    }));
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="rescan-settings-folder"]').forEach((button) => button.addEventListener("click", () => {
      const folderId = button.dataset.folderId;
      if (folderId) void this.#catalog.rescanRoot(folderId).then(() => window.queueMicrotask(() => {
        const rescan = [...this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="rescan-settings-folder"]')]
          .find((candidate) => candidate.dataset.folderId === folderId);
        (rescan ?? this.#root.querySelector<HTMLElement>("#settings-heading"))?.focus();
      }));
    }));
    this.#root.querySelectorAll<HTMLInputElement>("input[data-settings-folder-enabled]").forEach((checkbox) => checkbox.addEventListener("change", () => {
      const row = checkbox.closest<HTMLElement>(".settings-folder-card");
      row?.querySelectorAll<HTMLInputElement>("input[data-settings-folder-recursive], input[data-settings-folder-watch]")
        .forEach((input) => { input.disabled = !checkbox.checked; });
      this.#captureSettingsForm();
    }));
    this.#root.querySelectorAll<HTMLInputElement>("form.settings-editor input").forEach((input) => {
      input.addEventListener("input", () => this.#captureSettingsForm());
      input.addEventListener("change", () => this.#captureSettingsForm());
    });
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="save-library-settings"]')?.addEventListener("click", () => {
      this.#captureSettingsForm();
      void this.#catalog.saveSettings().then(() => window.queueMicrotask(() => {
        (this.#root.querySelector<HTMLElement>(".settings-error-summary")
          ?? this.#root.querySelector<HTMLElement>("#settings-library-name")
          ?? this.#root.querySelector<HTMLElement>("#settings-heading"))?.focus();
      }));
    });
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="cancel-library-settings"]')?.addEventListener("click", () => {
      void this.#catalog.cancelSettingsChanges().then(() => window.queueMicrotask(() => {
        (this.#root.querySelector<HTMLElement>(".settings-error-summary")
          ?? this.#root.querySelector<HTMLElement>("#settings-library-name")
          ?? this.#root.querySelector<HTMLElement>("#settings-heading"))?.focus();
      }));
    });
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="delete-library"]')?.addEventListener("click", () => {
      this.#settingsDeleteReturnLibraryId = this.#catalog.snapshot.settingsDraft?.id;
      this.#catalog.requestDeleteSettings();
    });
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="cancel-delete-library"]')?.addEventListener("click", () => this.#closeDeleteDialog());
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="confirm-delete-library"]')?.addEventListener("click", () => {
      void this.#catalog.confirmDeleteSettings().then(() => window.queueMicrotask(() => {
        if (this.#root.querySelector('.settings-delete-confirmation[role="alertdialog"]')) return;
        (this.#root.querySelector<HTMLElement>('button[data-settings-library-id][aria-current="page"]')
          ?? this.#root.querySelector<HTMLElement>("#settings-heading"))?.focus();
      }));
    });
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="retry-settings-library"]')?.addEventListener("click", () => {
      const libraryId = this.#catalog.snapshot.settingsLibraryId;
      if (libraryId) void this.#catalog.selectSettingsLibrary(libraryId, true).then(() => window.queueMicrotask(() => {
        (this.#root.querySelector<HTMLElement>(".settings-error-summary")
          ?? this.#root.querySelector<HTMLElement>("#settings-library-name")
          ?? this.#root.querySelector<HTMLElement>("#settings-heading"))?.focus();
      }));
    });
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="retry-cover-provider-settings"]')?.addEventListener("click", () => {
      void this.#catalog.loadCoverProviderSettings(true);
    });
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="edit-google-books-key"]')?.addEventListener("click", () => {
      this.#catalog.editGoogleBooksCredential();
      window.queueMicrotask(() => this.#root.querySelector<HTMLInputElement>("#settings-google-books-key")?.focus());
    });
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="cancel-google-books-key"]')?.addEventListener("click", () => {
      const input = this.#root.querySelector<HTMLInputElement>("#settings-google-books-key");
      if (input) input.value = "";
      this.#catalog.cancelGoogleBooksCredentialEdit();
    });
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="save-test-google-books-key"]')?.addEventListener("click", () => {
      const input = this.#root.querySelector<HTMLInputElement>("#settings-google-books-key");
      const key = input?.value ?? "";
      if (input) input.value = "";
      void this.#catalog.saveAndTestGoogleBooksCredential(key);
    });
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="remove-google-books-key"]')?.addEventListener("click", () => {
      const input = this.#root.querySelector<HTMLInputElement>("#settings-google-books-key");
      if (input) input.value = "";
      if (typeof window.confirm === "function" && !window.confirm("Remove the saved Google Books API key?")) return;
      void this.#catalog.removeGoogleBooksCredential();
    });
    this.#activateDeleteDialog();
  }

  #closeDeleteDialog(): void {
    if (this.#catalog.snapshot.settingsSaving) return;
    const libraryId = this.#settingsDeleteReturnLibraryId;
    this.#catalog.cancelDeleteSettings();
    this.#settingsDeleteReturnLibraryId = undefined;
    window.queueMicrotask(() => {
      const button = this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="delete-library"]');
      const selected = [...this.#root.querySelectorAll<HTMLButtonElement>("button[data-settings-library-id]")]
        .find((candidate) => candidate.dataset.settingsLibraryId === libraryId);
      (button ?? selected)?.focus();
    });
  }

  #activateDeleteDialog(): void {
    const dialog = this.#root.querySelector<HTMLElement>('.settings-delete-confirmation[role="alertdialog"]');
    if (!dialog) return;
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("tabindex", "-1");
    const editor = dialog.closest<HTMLElement>(".settings-editor");
    editor?.querySelectorAll<HTMLElement>(":scope > :not(.settings-delete-confirmation)")
      .forEach((element) => element.setAttribute("inert", ""));
    this.#root.querySelectorAll<HTMLElement>(".settings-page-head, .settings-prototype-notice, .settings-library-picker, .settings-guidance")
      .forEach((element) => element.setAttribute("inert", ""));
    this.#root.querySelectorAll<HTMLElement>(".library-topbar, .library-sidebar, .library-global-alerts, .poc-lab, .footer")
      .forEach((element) => element.setAttribute("inert", ""));
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.#closeDeleteDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
      if (buttons.length === 0) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && document.activeElement === buttons[0]) {
        event.preventDefault();
        buttons.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === buttons.at(-1)) {
        event.preventDefault();
        buttons[0]?.focus();
      }
    });
    (dialog.querySelector<HTMLElement>('button[data-ui-action="cancel-delete-library"]:not([disabled])') ?? dialog).focus();
  }

  #bindCatalogResultActions(scope: ParentNode = this.#root): void {
    if (scope !== this.#root) {
      scope.querySelectorAll<HTMLButtonElement>("button[data-ui-view]").forEach((button) => button.addEventListener("click", () => {
        void this.#catalog.setView(button.dataset.uiView as LibraryView).then(() => this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace"));
      }));
      scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="open-series"]').forEach((button) => button.addEventListener("click", () => {
        const key = button.dataset.seriesKey;
        if (!key) return;
        if (button.closest(".library-book-details-sheet")) this.#closeBookDetails(true, false);
        void this.#catalog.setView("series").then(async () => {
          this.#writeCatalogRoute({ bookId: null, seriesKey: key }, "push", { kindleBridgeSeries: key });
          await this.#catalog.openSeries(key);
        });
      }));
    }
    scope.querySelectorAll<HTMLImageElement>("img[data-library-cover-image]").forEach((image) => image.addEventListener("error", () => {
      const cover = image.closest<HTMLElement>(".library-cover");
      if (!cover || image.hidden) return;
      image.hidden = true;
      cover.classList.remove("library-cover-image");
      cover.querySelectorAll<HTMLElement>("[data-library-cover-fallback]").forEach((element) => {
        element.hidden = false;
      });
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="send-book"]').forEach((button) => button.addEventListener("click", () => {
      const bookId = button.dataset.bookId;
      if (bookId) {
        if (button.closest(".library-book-details-sheet")) this.#closeBookDetails(true, false);
        this.#catalogDialogReturnBookId = bookId;
        this.#catalog.openSend(bookId);
      }
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="cancel-book-send"]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.bookId) this.#catalog.cancelSend(button.dataset.bookId);
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="retry-book-send"]').forEach((button) => button.addEventListener("click", () => {
      // Reuse the retained immutable request; the controller revalidates source,
      // current device comparison and recovery state before any retry writes.
      if (button.dataset.bookId === this.#catalog.snapshot.pendingBookId) void this.#catalog.confirmSend();
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="update-book-on-kindle"]').forEach((button) => button.addEventListener("click", () => {
      const bookId = button.dataset.bookId;
      if (!bookId) return;
      if (button.closest(".library-book-details-sheet")) this.#closeBookDetails(true, false);
      if (button.closest(".library-metadata-sheet")) {
        this.#closeMetadataEditorDialog();
        if (this.#catalog.snapshot.metadataEditor) return;
      }
      this.#catalogUpdateReturnBookId = bookId;
      this.#catalog.requestBookUpdate(bookId);
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="edit-book-metadata"]').forEach((button) => button.addEventListener("click", () => {
      const bookId = button.dataset.bookId;
      if (!bookId) return;
      if (button.closest(".library-book-details-sheet")) this.#closeBookDetails(true, false);
      this.#catalogMetadataReturnBookId = bookId;
      void this.#catalog.openMetadataEditor(bookId);
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="open-book-details"]').forEach((button) => button.addEventListener("click", () => {
      const bookId = button.dataset.bookId;
      if (!bookId) return;
      this.#catalogDetailsReturnBookId = bookId;
      this.#catalogDetailsScrollY = window.scrollY;
      this.#catalog.setScrollPosition(window.scrollY);
      this.#writeCatalogRoute({ bookId, seriesKey: null }, "push", { kindleBridgeBook: bookId });
      void this.#catalog.openBookDetails(bookId);
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="set-library-layout"]').forEach((button) => button.addEventListener("click", () => {
      const layout = button.dataset.layout;
      if (layout === "grid" || layout === "list") {
        this.#catalog.setLayout(layout);
        this.#writeCatalogRoute({}, "replace");
      }
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="set-library-density"]').forEach((button) => button.addEventListener("click", () => {
      const density = button.dataset.density;
      if (density === "comfortable" || density === "compact") {
        this.#catalog.setDensity(density);
        this.#writeCatalogRoute({}, "replace");
      }
    }));
    scope.querySelectorAll<HTMLInputElement>('input[data-ui-action="toggle-book-selection"]').forEach((input) => input.addEventListener("change", () => {
      const bookId = input.dataset.bookId;
      if (bookId) this.#catalog.toggleBookSelection(bookId, input.checked);
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="select-visible-books"]').forEach((button) => button.addEventListener("click", () => this.#catalog.toggleVisibleBookSelection()));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="select-all-filtered"]').forEach((button) => button.addEventListener("click", () => { void this.#catalog.selectAllFiltered(false); }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="select-all-filtered-missing"]').forEach((button) => button.addEventListener("click", () => { void this.#catalog.selectAllFiltered(true); }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="clear-book-selection"]').forEach((button) => button.addEventListener("click", () => this.#catalog.clearBookSelection()));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="add-book-to-queue"]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.bookId) void this.#catalog.addBookToSendQueue(button.dataset.bookId);
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="bulk-add-to-queue"]').forEach((button) => button.addEventListener("click", () => { void this.#catalog.addSelectedBooksToSendQueue(); }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="bulk-find-metadata"]').forEach((button) => button.addEventListener("click", () => {
      const provider = scope.querySelector<HTMLSelectElement>("#bulk-metadata-provider")?.value;
      if (provider !== "open-library" && provider !== "google-books") return;
      void this.#catalog.createMetadataLookupJob(provider).then(() => this.#catalog.setView("attention"))
        .then(() => this.#writeCatalogRoute({ bookId: null, matchItemId: null, matchBookId: null, seriesKey: null }, "replace"));
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="toggle-book-favorite"]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.bookId) void this.#catalog.toggleBookAnnotation(button.dataset.bookId, "favorite");
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="toggle-book-want-to-read"]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.bookId) void this.#catalog.toggleBookAnnotation(button.dataset.bookId, "wantToRead");
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="bulk-send-to-kindle"]').forEach((button) => button.addEventListener("click", () => { void this.#catalog.sendSelectedBooks(); }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="remove-book-from-kindle"]').forEach((button) => button.addEventListener("click", () => {
      const bookId = button.dataset.bookId;
      if (!bookId) return;
      if (button.closest(".library-book-details-sheet")) this.#closeBookDetails(true, false);
      if (button.closest(".library-match-review-sheet")) this.#closeMatchReview();
      this.#catalogRemovalReturnBookId = bookId;
      this.#catalog.requestBookRemoval(bookId);
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="bulk-remove-from-kindle"]').forEach((button) => button.addEventListener("click", () => {
      this.#catalogRemovalReturnBookId = undefined;
      this.#catalog.requestSelectedBookRemoval();
    }));
    scope.querySelectorAll<HTMLElement>('[data-ui-action="cancel-remove-from-kindle"]').forEach((element) => element.addEventListener("click", () => this.#closeCatalogRemovalDialog()));
    scope.querySelector<HTMLButtonElement>('button[data-ui-action="confirm-remove-from-kindle"]')?.addEventListener("click", () => {
      void this.#catalog.confirmBookRemoval().then(() => {
        if (this.#catalog.snapshot.pendingRemoval) return;
        this.#restoreCatalogRemovalFocus();
      });
    });
    scope.querySelectorAll<HTMLElement>('[data-ui-action="cancel-kindle-update"]').forEach((element) => element.addEventListener("click", () => this.#closeCatalogUpdateDialog()));
    scope.querySelector<HTMLButtonElement>('button[data-ui-action="confirm-kindle-update"]')?.addEventListener("click", () => {
      void this.#catalog.confirmBookUpdate();
    });
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="clear-filters"]').forEach((button) => button.addEventListener("click", () => {
      this.#catalog.clearFilters();
      this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace");
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="retry-catalog"]').forEach((button) => button.addEventListener("click", () => { void this.#catalog.retry(); }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="catalog-page"]').forEach((button) => button.addEventListener("click", () => {
      const offset = Number(button.dataset.pageOffset);
      if (Number.isFinite(offset)) {
        this.#catalog.goToPage(offset);
        this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace");
      }
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="kindle-page"]').forEach((button) => button.addEventListener("click", () => {
      const offset = Number(button.dataset.pageOffset);
      if (Number.isFinite(offset)) this.#catalog.goToKindleInventoryPage(offset);
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="open-match-review"]').forEach((button) => button.addEventListener("click", () => {
      const itemId = button.dataset.itemId;
      if (!itemId) return;
      const bookId = button.dataset.bookId;
      if (button.closest(".library-book-details-sheet")) this.#closeBookDetails(true, false);
      this.#writeCatalogRoute({
        bookId: null,
        matchItemId: itemId,
        matchBookId: bookId ?? null,
        seriesKey: null,
      }, "push", { kindleBridgeMatch: itemId });
      void this.#catalog.openMatchReview(itemId, bookId);
    }));
    scope.querySelectorAll<HTMLElement>('[data-ui-action="close-match-review"]').forEach((element) => element.addEventListener("click", () => this.#closeMatchReview()));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="manual-match-decision"]').forEach((button) => button.addEventListener("click", () => {
      const { profileId, bookId, decision } = button.dataset;
      if (!profileId || !bookId || (decision !== "same-book" && decision !== "not-this-book" && decision !== "undo")) return;
      void this.#catalog.decideManualMatch(profileId, bookId, decision);
    }));
    scope.querySelectorAll<HTMLElement>('[data-ui-action="close-send-queue"]').forEach((element) => element.addEventListener("click", () => this.#closeSendQueueDialog()));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="remove-queue-book"]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.bookId) void this.#catalog.removeBookFromSendQueue(button.dataset.bookId);
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="move-queue-book"]').forEach((button) => button.addEventListener("click", () => {
      const direction = Number(button.dataset.direction);
      if (button.dataset.bookId && (direction === -1 || direction === 1)) void this.#catalog.moveSendQueueBook(button.dataset.bookId, direction);
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="clear-send-queue"]').forEach((button) => button.addEventListener("click", () => { void this.#catalog.clearSendQueue(); }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="send-queued-books"]').forEach((button) => button.addEventListener("click", () => {
      this.#writeCatalogRoute({ sendQueueOpen: false }, "replace");
      void this.#catalog.sendQueuedBooks();
    }));
    scope.querySelectorAll<HTMLElement>('[data-ui-action="close-send"]').forEach((element) => element.addEventListener("click", () => this.#closeCatalogDialog()));
    scope.querySelector<HTMLButtonElement>('button[data-ui-action="confirm-catalog-send"]')?.addEventListener("click", () => { void this.#catalog.confirmSend(); });
    scope.querySelector<HTMLButtonElement>('button[data-ui-action="dismiss-announcement"]')?.addEventListener("click", () => this.#catalog.dismissAnnouncement());
    scope.querySelectorAll<HTMLElement>('[data-ui-action="close-book-details"]').forEach((element) => element.addEventListener("click", () => this.#closeBookDetails()));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="book-details-filter"]').forEach((button) => button.addEventListener("click", () => {
      const key = button.dataset.filterKey as keyof LibraryFilters | undefined;
      const value = button.dataset.filterValue;
      if (!key || !value || !["author", "series", "publisher", "language", "subject"].includes(key)) return;
      this.#closeBookDetails(true, false);
      this.#catalog.updateFilter(key, value);
      this.#writeCatalogRoute({ bookId: null, seriesKey: null }, "replace");
      window.queueMicrotask(() => this.#root.querySelector<HTMLElement>("#library-search")?.focus({ preventScroll: true }));
    }));
    this.#bindMetadataEditorEvents(scope);
    if (scope === this.#root) {
      this.#activateCatalogDialog();
      this.#activateCatalogRemovalDialog();
      this.#activateCatalogUpdateDialog();
      this.#activateMetadataEditorDialog();
      this.#activateMatchReviewDialog();
      this.#activateSendQueueDialog();
      this.#activateSmartShelfDialog();
      this.#activateBookDetailsDialog();
      this.#activateActivityCenterDialog();
    }
  }

  #readMetadataEditorForm(): BookMetadataOverrides | undefined {
    const form = this.#root.querySelector<HTMLFormElement>("form.metadata-editor-form");
    if (!form) return undefined;
    const values: Record<string, unknown> = {};
    const fields = [
      "title", "authors", "authorSort", "language", "publisher", "publishedAt",
      "series", "seriesIndex", "description", "subjects", "identifiers",
    ] as const;
    for (const field of fields) {
      const enabled = form.querySelector<HTMLInputElement>(`input[data-metadata-override="${field}"]`);
      if (!enabled?.checked) continue;
      const control = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-metadata-field="${field}"]`);
      if (!control) continue;
      control.setCustomValidity("");
      const raw = control.value.trim();
      if (field === "title") {
        if (!raw) {
          control.setCustomValidity("An overridden title cannot be empty.");
          control.reportValidity();
          control.focus();
          return undefined;
        }
        values[field] = raw;
      } else if (field === "authors" || field === "subjects" || field === "identifiers") {
        values[field] = control.value.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
      } else if (field === "seriesIndex") {
        if (!raw) values[field] = null;
        else {
          const numeric = Number(raw);
          if (!Number.isFinite(numeric) || numeric < 0) {
            control.setCustomValidity("Enter a non-negative series number or leave it blank.");
            control.reportValidity();
            control.focus();
            return undefined;
          }
          values[field] = numeric;
        }
      } else {
        values[field] = raw || null;
      }
    }
    return values as BookMetadataOverrides;
  }

  #captureMetadataEditorForm(): boolean {
    const changes = this.#readMetadataEditorForm();
    if (!changes) return false;
    this.#catalog.setMetadataEditorDraft(changes);
    return true;
  }

  #bindMetadataEditorEvents(scope: ParentNode): void {
    const form = scope.querySelector<HTMLFormElement>("form.metadata-editor-form");
    form?.addEventListener("submit", (event) => event.preventDefault());
    form?.querySelectorAll<HTMLInputElement>("input[data-metadata-override]").forEach((checkbox) => checkbox.addEventListener("change", () => {
      const field = checkbox.dataset.metadataOverride;
      const row = field ? form.querySelector<HTMLElement>(`[data-metadata-field-row="${field}"]`) : undefined;
      const control = field ? row?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-metadata-field="${field}"]`) : undefined;
      if (control) control.disabled = !checkbox.checked;
      const label = checkbox.closest("label")?.querySelector("span");
      if (label) label.textContent = checkbox.checked ? "Override active" : "Use source";
      if (this.#captureMetadataEditorForm() && checkbox.checked) control?.focus();
    }));
    form?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-metadata-field]").forEach((control) => {
      control.addEventListener("input", () => this.#captureMetadataEditorForm());
      control.addEventListener("change", () => this.#captureMetadataEditorForm());
    });
    scope.querySelectorAll<HTMLElement>('[data-ui-action="close-metadata-editor"]').forEach((element) => element.addEventListener("click", () => this.#closeMetadataEditorDialog()));
    scope.querySelector<HTMLButtonElement>('[data-ui-action="save-book-metadata"]')?.addEventListener("click", () => {
      if (this.#captureMetadataEditorForm()) void this.#catalog.saveBookMetadata();
    });
    scope.querySelector<HTMLButtonElement>('[data-ui-action="reset-book-metadata"]')?.addEventListener("click", () => {
      void this.#catalog.resetBookMetadata();
    });
    scope.querySelector<HTMLButtonElement>('[data-ui-action="reset-book-cover"]')?.addEventListener("click", () => {
      if (this.#captureMetadataEditorForm()) void this.#catalog.resetBookCover();
    });
    const searchMetadata = (): void => {
      if (!this.#captureMetadataEditorForm()) return;
      const provider = scope.querySelector<HTMLSelectElement>("#metadata-candidate-provider")?.value;
      if (provider !== "google-books" && provider !== "open-library") return;
      void this.#catalog.searchBookMetadata(provider, {
        title: scope.querySelector<HTMLInputElement>("#metadata-candidate-title")?.value.trim() || undefined,
        author: scope.querySelector<HTMLInputElement>("#metadata-candidate-author")?.value.trim() || undefined,
        identifier: scope.querySelector<HTMLInputElement>("#metadata-candidate-identifier")?.value.trim() || undefined,
      });
    };
    scope.querySelector<HTMLButtonElement>('[data-ui-action="search-metadata-candidates"]')?.addEventListener("click", searchMetadata);
    scope.querySelectorAll<HTMLInputElement>("#metadata-candidate-title, #metadata-candidate-author, #metadata-candidate-identifier")
      .forEach((input) => input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          searchMetadata();
        }
      }));
    scope.querySelectorAll<HTMLButtonElement>('[data-ui-action="select-metadata-candidate"]').forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.candidateId && this.#captureMetadataEditorForm()) this.#catalog.selectMetadataCandidate(button.dataset.candidateId);
    }));
    scope.querySelectorAll<HTMLInputElement>('[data-ui-action="toggle-metadata-candidate-field"]').forEach((input) => input.addEventListener("change", () => {
      const field = input.dataset.field;
      if (field) this.#catalog.setMetadataCandidateField(field as never, input.checked);
    }));
    scope.querySelector<HTMLInputElement>('[data-ui-action="toggle-metadata-candidate-cover"]')?.addEventListener("change", (event) => {
      this.#catalog.setMetadataCandidateCover((event.currentTarget as HTMLInputElement).checked);
    });
    scope.querySelector<HTMLButtonElement>('[data-ui-action="import-metadata-candidate"]')?.addEventListener("click", () => {
      if (this.#captureMetadataEditorForm()) void this.#catalog.importSelectedMetadataCandidate();
    });
    const search = (): void => {
      if (!this.#captureMetadataEditorForm()) return;
      const provider = scope.querySelector<HTMLSelectElement>("#metadata-cover-provider")?.value as CoverProvider | undefined;
      const query = scope.querySelector<HTMLInputElement>("#metadata-cover-query")?.value ?? "";
      if (provider === "google-books" || provider === "open-library") void this.#catalog.searchBookCovers(provider, query);
    };
    scope.querySelector<HTMLButtonElement>('[data-ui-action="search-metadata-covers"]')?.addEventListener("click", search);
    scope.querySelector<HTMLButtonElement>('[data-ui-action="open-cover-provider-settings"]')?.addEventListener("click", () => {
      this.#closeMetadataEditorDialog();
      if (!this.#catalog.snapshot.metadataEditor) {
        void this.#catalog.setView("settings")
          .then(() => this.#writeCatalogRoute({ bookId: null, matchItemId: null, matchBookId: null, seriesKey: null }, "replace"));
      }
    });
    scope.querySelector<HTMLInputElement>("#metadata-cover-query")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        search();
      }
    });
    scope.querySelectorAll<HTMLButtonElement>('[data-ui-action="import-metadata-cover"]').forEach((button) => button.addEventListener("click", () => {
      const candidateId = button.dataset.candidateId;
      if (candidateId && this.#captureMetadataEditorForm()) void this.#catalog.importBookCover(candidateId);
    }));
    const fileInput = scope.querySelector<HTMLInputElement>('input[data-ui-action="upload-metadata-cover"]');
    const upload = (image: Blob | undefined): void => {
      if (image && this.#captureMetadataEditorForm()) void this.#catalog.uploadBookCover(image);
    };
    fileInput?.addEventListener("change", () => upload(fileInput.files?.[0]));
    const dropzone = scope.querySelector<HTMLElement>("[data-metadata-cover-dropzone]");
    dropzone?.addEventListener("click", () => {
      if (dropzone.getAttribute("aria-disabled") !== "true") fileInput?.click();
    });
    dropzone?.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && dropzone.getAttribute("aria-disabled") !== "true") {
        event.preventDefault();
        fileInput?.click();
      }
    });
    ["dragenter", "dragover"].forEach((type) => dropzone?.addEventListener(type, (event) => {
      event.preventDefault();
      if (dropzone.getAttribute("aria-disabled") !== "true") dropzone.classList.add("dragging");
    }));
    ["dragleave", "drop"].forEach((type) => dropzone?.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove("dragging");
      if (type === "drop" && dropzone.getAttribute("aria-disabled") !== "true") {
        const transfer = (event as DragEvent).dataTransfer;
        upload([...transfer?.files ?? []].find((file) => file.type.startsWith("image/")));
      }
    }));
    dropzone?.addEventListener("paste", (event) => {
      if (dropzone.getAttribute("aria-disabled") === "true") return;
      const clipboard = (event as ClipboardEvent).clipboardData;
      const item = [...clipboard?.items ?? []].find((candidate) => candidate.kind === "file" && candidate.type.startsWith("image/"));
      const image = item?.getAsFile() ?? [...clipboard?.files ?? []].find((file) => file.type.startsWith("image/"));
      if (!image) return;
      event.preventDefault();
      upload(image);
    });
    scope.querySelectorAll<HTMLImageElement>("img[data-metadata-cover-image]").forEach((image) => image.addEventListener("error", () => {
      image.hidden = true;
    }));
  }

  #closeMetadataEditorDialog(): void {
    const editor = this.#catalog.snapshot.metadataEditor;
    if (!editor || editor.busy) return;
    const dirty = editor.data !== undefined
      && JSON.stringify(editor.draftOverrides) !== JSON.stringify(editor.data.overrides);
    if (dirty && typeof window.confirm === "function" && !window.confirm("Discard unsaved metadata changes?")) return;
    const returnBookId = this.#catalogMetadataReturnBookId;
    this.#catalogMetadataReturnBookId = undefined;
    this.#catalog.closeMetadataEditor();
    window.queueMicrotask(() => {
      const trigger = returnBookId
        ? [...this.#root.querySelectorAll<HTMLElement>(".library-book-menu > summary")]
            .find((summary) => summary.closest<HTMLElement>("[data-book-id]")?.dataset.bookId === returnBookId)
        : undefined;
      (trigger
        ?? this.#root.querySelector<HTMLElement>('.library-nav-item[aria-current="page"]')
        ?? this.#root.querySelector<HTMLElement>(".library-brand"))?.focus();
    });
  }

  #closeBookDetails(updateHistory = true, restoreFocus = true): void {
    if (!this.#catalog.snapshot.bookDetails) return;
    const returnBookId = this.#catalogDetailsReturnBookId ?? this.#catalog.snapshot.bookDetails.bookId;
    const scrollY = this.#catalogDetailsScrollY;
    this.#catalogDetailsReturnBookId = undefined;
    this.#catalog.closeBookDetails();
    if (updateHistory && decodeLibraryRoute(window.location.hash)?.overlays.bookId) {
      this.#writeCatalogRoute({ bookId: null }, "replace");
    }
    if (restoreFocus) this.#restoreBookDetailsOrigin(returnBookId, scrollY);
  }

  #restoreBookDetailsOrigin(returnBookId: string | undefined, scrollY: number): void {
    window.queueMicrotask(() => {
      try { window.scrollTo({ top: scrollY, behavior: "auto" }); } catch { /* jsdom and older browsers */ }
      const trigger = returnBookId
        ? [...this.#root.querySelectorAll<HTMLElement>('[data-ui-action="open-book-details"]')]
            .find((candidate) => candidate.dataset.bookId === returnBookId)
        : undefined;
      (trigger
        ?? this.#root.querySelector<HTMLElement>('.library-nav-item[aria-current="page"]')
        ?? this.#root.querySelector<HTMLElement>(".library-brand"))?.focus({ preventScroll: true });
    });
  }

  #closeMatchReview(updateHistory = true): void {
    const itemId = this.#catalog.snapshot.matchReview?.itemId;
    if (!itemId) return;
    this.#catalog.closeMatchReview();
    if (updateHistory) this.#writeCatalogRoute({ matchItemId: null, matchBookId: null }, "replace");
    this.#restoreMatchReviewOrigin(itemId);
  }

  #restoreMatchReviewOrigin(itemId: string): void {
    window.queueMicrotask(() => {
      ([...this.#root.querySelectorAll<HTMLElement>('[data-ui-action="open-match-review"]')]
        .find((candidate) => candidate.dataset.itemId === itemId)
        ?? this.#root.querySelector<HTMLElement>('.library-nav-item[aria-current="page"]')
        ?? this.#root.querySelector<HTMLElement>(".library-brand"))?.focus({ preventScroll: true });
    });
  }

  #activateBookDetailsDialog(): void {
    const dialog = this.#root.querySelector<HTMLElement>('.library-book-details-sheet[role="dialog"]');
    if (!dialog) return;
    [
      this.#root.querySelector<HTMLElement>(".library-topbar"),
      this.#root.querySelector<HTMLElement>(".library-sidebar"),
      ...this.#root.querySelectorAll<HTMLElement>(".library-main > :not(.library-book-details-sheet):not(.library-modal-backdrop)"),
      this.#root.querySelector<HTMLElement>(".library-global-alerts"),
      this.#root.querySelector<HTMLElement>(".poc-lab"),
      this.#root.querySelector<HTMLElement>(".footer"),
    ].filter((element): element is HTMLElement => element !== null)
      .forEach((element) => element.setAttribute("inert", ""));
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.#closeBookDetails();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    (dialog.querySelector<HTMLElement>('button[data-ui-action="close-book-details"]') ?? dialog).focus({ preventScroll: true });
  }

  #activateMetadataEditorDialog(): void {
    const dialog = this.#root.querySelector<HTMLElement>('.library-metadata-sheet[role="dialog"]');
    if (!dialog) return;
    [
      this.#root.querySelector<HTMLElement>(".library-topbar"),
      this.#root.querySelector<HTMLElement>(".library-sidebar"),
      ...this.#root.querySelectorAll<HTMLElement>(".library-main > :not(.library-metadata-sheet):not(.library-modal-backdrop)"),
      this.#root.querySelector<HTMLElement>(".library-global-alerts"),
      this.#root.querySelector<HTMLElement>(".poc-lab"),
      this.#root.querySelector<HTMLElement>(".footer"),
    ].filter((element): element is HTMLElement => element !== null)
      .forEach((element) => element.setAttribute("inert", ""));
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.#closeMetadataEditorDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    (dialog.querySelector<HTMLElement>('button[data-ui-action="close-metadata-editor"]:not([disabled])')
      ?? dialog).focus();
  }

  #activateMatchReviewDialog(): void {
    const dialog = this.#root.querySelector<HTMLElement>('.library-match-review-sheet[role="dialog"]');
    if (!dialog) return;
    [
      this.#root.querySelector<HTMLElement>(".library-topbar"),
      this.#root.querySelector<HTMLElement>(".library-sidebar"),
      ...this.#root.querySelectorAll<HTMLElement>(".library-main > :not(.library-match-review-sheet):not(.library-modal-backdrop)"),
      this.#root.querySelector<HTMLElement>(".library-global-alerts"),
      this.#root.querySelector<HTMLElement>(".poc-lab"),
      this.#root.querySelector<HTMLElement>(".footer"),
    ].filter((element): element is HTMLElement => element !== null)
      .forEach((element) => element.setAttribute("inert", ""));
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.#closeMatchReview();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    (dialog.querySelector<HTMLElement>('button[data-ui-action="close-match-review"]:not([disabled])') ?? dialog).focus();
  }

  #activateSendQueueDialog(): void {
    const dialog = this.#root.querySelector<HTMLElement>('.library-queue-sheet[role="dialog"]');
    if (!dialog) return;
    [
      this.#root.querySelector<HTMLElement>(".library-topbar"),
      this.#root.querySelector<HTMLElement>(".library-sidebar"),
      ...this.#root.querySelectorAll<HTMLElement>(".library-main > :not(.library-queue-sheet):not(.library-modal-backdrop)"),
      this.#root.querySelector<HTMLElement>(".poc-lab"),
      this.#root.querySelector<HTMLElement>(".footer"),
    ].filter((element): element is HTMLElement => element !== null)
      .forEach((element) => element.setAttribute("inert", ""));
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.#catalog.snapshot.sendQueueBusy) {
        event.preventDefault();
        this.#closeSendQueueDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    (dialog.querySelector<HTMLElement>('button[data-ui-action="close-send-queue"]:not([disabled])') ?? dialog).focus();
  }

  #activateSmartShelfDialog(): void {
    const dialog = this.#root.querySelector<HTMLElement>('.library-shelf-sheet[role="dialog"]');
    if (!dialog) return;
    [
      this.#root.querySelector<HTMLElement>(".library-topbar"),
      this.#root.querySelector<HTMLElement>(".library-sidebar"),
      ...this.#root.querySelectorAll<HTMLElement>(".library-main > :not(.library-shelf-sheet):not(.library-modal-backdrop)"),
      this.#root.querySelector<HTMLElement>(".poc-lab"),
      this.#root.querySelector<HTMLElement>(".footer"),
    ].filter((element): element is HTMLElement => element !== null)
      .forEach((element) => element.setAttribute("inert", ""));
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.#closeSmartShelfDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    (dialog.querySelector<HTMLElement>("#smart-shelf-name") ?? dialog).focus();
  }

  #closeSendQueueDialog(): void {
    if (this.#catalog.snapshot.sendQueueBusy) return;
    if (decodeLibraryRoute(window.location.hash)?.overlays.sendQueueOpen && window.history.length > 1) window.history.back();
    else {
      this.#catalog.toggleSendQueue(false);
      this.#writeCatalogRoute({ sendQueueOpen: false }, "replace");
    }
  }

  #closeSmartShelfDialog(): void {
    if (decodeLibraryRoute(window.location.hash)?.overlays.shelfManagerOpen && window.history.length > 1) window.history.back();
    else {
      this.#catalog.toggleShelfManager(false);
      this.#writeCatalogRoute({ shelfManagerOpen: false }, "replace");
    }
  }

  #closeActivityCenter(updateHistory = true): void {
    if (!this.#catalog.snapshot.activityOpen) return;
    if (updateHistory && decodeLibraryRoute(window.location.hash)?.overlays.activityOpen && window.history.length > 1) {
      window.history.back();
      return;
    }
    if (updateHistory) this.#writeCatalogRoute({ activityOpen: false }, "replace");
    this.#catalog.toggleActivityCenter(false);
    window.queueMicrotask(() => this.#root.querySelector<HTMLElement>('[data-ui-action="open-activity-center"]')?.focus());
  }

  #downloadActivityReport(): void {
    const report = JSON.stringify({
      exportedAt: new Date().toISOString(),
      profileId: this.#catalog.snapshot.filters.profileId ?? null,
      service: this.#catalog.snapshot.serviceStatus ?? null,
      issues: this.#catalog.snapshot.healthPage?.counts ?? null,
      events: this.#catalog.snapshot.activityEvents,
    }, null, 2);
    if (typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(new Blob([report], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `kindle-bridge-activity-${new Date().toISOString().replaceAll(":", "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  #activateActivityCenterDialog(): void {
    const dialog = this.#root.querySelector<HTMLElement>('.library-activity-sheet[role="dialog"]');
    if (!dialog) return;
    [
      this.#root.querySelector<HTMLElement>(".library-topbar"),
      this.#root.querySelector<HTMLElement>(".library-sidebar"),
      ...this.#root.querySelectorAll<HTMLElement>(".library-main > :not(.library-activity-sheet):not(.library-modal-backdrop)"),
      this.#root.querySelector<HTMLElement>(".library-global-alerts"),
      this.#root.querySelector<HTMLElement>(".poc-lab"),
      this.#root.querySelector<HTMLElement>(".footer"),
    ].filter((element): element is HTMLElement => element !== null)
      .forEach((element) => element.setAttribute("inert", ""));
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.#closeActivityCenter();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), details > summary, [tabindex]:not([tabindex="-1"])')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    (dialog.querySelector<HTMLElement>('[data-ui-action="close-activity-center"]') ?? dialog).focus();
  }

  #closeCatalogDialog(): void {
    if (this.#catalog.snapshot.sendBusy) return;
    const returnBookId = this.#catalogDialogReturnBookId;
    this.#catalog.closeSend();
    this.#catalogDialogReturnBookId = undefined;
    window.queueMicrotask(() => {
      const trigger = [...this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="send-book"]')]
        .find((button) => button.dataset.bookId === returnBookId);
      (trigger
        ?? this.#root.querySelector<HTMLElement>('.library-nav-item[aria-current="page"]')
        ?? this.#root.querySelector<HTMLElement>(".library-brand"))?.focus();
    });
  }

  #closeCatalogRemovalDialog(): void {
    if (this.#catalog.snapshot.bulkActionBusy) return;
    this.#catalog.cancelBookRemoval();
    this.#restoreCatalogRemovalFocus();
  }

  #closeCatalogUpdateDialog(): void {
    if (this.#catalog.snapshot.sendBusy) return;
    const returnBookId = this.#catalogUpdateReturnBookId;
    this.#catalogUpdateReturnBookId = undefined;
    this.#catalog.cancelBookUpdate();
    window.queueMicrotask(() => {
      const trigger = returnBookId
        ? [...this.#root.querySelectorAll<HTMLElement>('[data-ui-action="update-book-on-kindle"]')]
            .find((candidate) => candidate.dataset.bookId === returnBookId)
        : undefined;
      (trigger
        ?? this.#root.querySelector<HTMLElement>('.library-nav-item[aria-current="page"]')
        ?? this.#root.querySelector<HTMLElement>(".library-brand"))?.focus();
    });
  }

  #activateCatalogUpdateDialog(): void {
    const dialog = this.#root.querySelector<HTMLElement>('.library-update-sheet[role="alertdialog"]');
    if (!dialog) return;
    [
      this.#root.querySelector<HTMLElement>(".library-topbar"),
      this.#root.querySelector<HTMLElement>(".library-sidebar"),
      ...this.#root.querySelectorAll<HTMLElement>(".library-main > :not(.library-update-sheet):not(.library-modal-backdrop)"),
      this.#root.querySelector<HTMLElement>(".library-global-alerts"),
      this.#root.querySelector<HTMLElement>(".poc-lab"),
      this.#root.querySelector<HTMLElement>(".footer"),
    ].filter((element): element is HTMLElement => element !== null)
      .forEach((element) => element.setAttribute("inert", ""));
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.#closeCatalogUpdateDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    (dialog.querySelector<HTMLElement>('button[data-ui-action="cancel-kindle-update"]:not([disabled])')
      ?? dialog).focus();
  }

  #restoreCatalogRemovalFocus(): void {
    const returnBookId = this.#catalogRemovalReturnBookId;
    this.#catalogRemovalReturnBookId = undefined;
    window.queueMicrotask(() => {
      const trigger = returnBookId
        ? [...this.#root.querySelectorAll<HTMLElement>(".library-book-menu > summary")]
            .find((summary) => summary.closest<HTMLElement>("[data-book-id]")?.dataset.bookId === returnBookId)
        : this.#root.querySelector<HTMLElement>('button[data-ui-action="bulk-remove-from-kindle"]');
      (trigger
        ?? this.#root.querySelector<HTMLElement>('.library-nav-item[aria-current="page"]')
        ?? this.#root.querySelector<HTMLElement>(".library-brand"))?.focus();
    });
  }

  #activateCatalogRemovalDialog(): void {
    const dialog = this.#root.querySelector<HTMLElement>('.library-remove-sheet[role="alertdialog"]');
    if (!dialog) return;
    [
      this.#root.querySelector<HTMLElement>(".library-topbar"),
      this.#root.querySelector<HTMLElement>(".library-sidebar"),
      ...this.#root.querySelectorAll<HTMLElement>(".library-main > :not(.library-remove-sheet):not(.library-modal-backdrop)"),
      this.#root.querySelector<HTMLElement>(".library-global-alerts"),
      this.#root.querySelector<HTMLElement>(".poc-lab"),
      this.#root.querySelector<HTMLElement>(".footer"),
    ].filter((element): element is HTMLElement => element !== null)
      .forEach((element) => element.setAttribute("inert", ""));
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.#closeCatalogRemovalDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    (dialog.querySelector<HTMLElement>('button[data-ui-action="cancel-remove-from-kindle"]:not([disabled])')
      ?? dialog).focus();
  }

  #activateCatalogDialog(): void {
    const dialog = this.#root.querySelector<HTMLElement>('.library-send-sheet[role="dialog"]');
    if (!dialog) return;
    [
      this.#root.querySelector<HTMLElement>(".library-topbar"),
      this.#root.querySelector<HTMLElement>(".library-sidebar"),
      ...this.#root.querySelectorAll<HTMLElement>(".library-main > :not(.library-send-sheet):not(.library-modal-backdrop)"),
      this.#root.querySelector<HTMLElement>(".library-global-alerts"),
      this.#root.querySelector<HTMLElement>(".poc-lab"),
      this.#root.querySelector<HTMLElement>(".footer"),
    ].filter((element): element is HTMLElement => element !== null).forEach((element) => element.setAttribute("inert", ""));

    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.#closeCatalogDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    const initialFocus = dialog.querySelector<HTMLElement>('button:not([disabled])');
    (initialFocus ?? dialog).focus();
  }

  #refreshCatalogResults(): void {
    const kindleFilter = this.#catalog.snapshot.filters.kindle;
    const kindleSelect = this.#root.querySelector<HTMLSelectElement>("#library-kindle-filter");
    if (kindleSelect) kindleSelect.value = kindleFilter;
    this.#root.querySelectorAll<HTMLButtonElement>("[data-ui-kindle-filter]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.uiKindleFilter === kindleFilter));
    });
    this.#root.querySelectorAll<HTMLButtonElement>("[data-ui-summary-filter]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.uiSummaryFilter === kindleFilter && this.#catalog.snapshot.filters.view === "all"));
    });
    const results = this.#root.querySelector<HTMLElement>(".library-results");
    if (!results) return;
    results.innerHTML = renderLibraryResults(this.#state, this.#catalog.snapshot);
    this.#bindCatalogResultActions(results);
  }

  #refreshCatalogDeviceContents(): void {
    const current = this.#root.querySelector<HTMLElement>(".library-device-contents");
    if (!current) return;
    const connected = this.#state.device.kind === "ready"
      || this.#state.device.kind === "transferring"
      || this.#state.device.kind === "recovering";
    current.outerHTML = renderKindleDeviceContents(
      this.#catalog.snapshot,
      connected,
      this.#state.catalogInventoryState,
      this.#diagnosticsDeviceQuery,
    );
    const replacement = this.#root.querySelector<HTMLElement>(".library-device-contents");
    if (replacement) this.#bindCatalogResultActions(replacement);
  }

  #readSettingsForm(): LibrarySettingsDraft | undefined {
    const form = this.#root.querySelector<HTMLFormElement>("form.settings-editor");
    const current = this.#catalog.snapshot.settingsDraft;
    if (!form || !current || form.dataset.settingsLibraryId !== current.id) return undefined;
    const name = form.querySelector<HTMLInputElement>("#settings-library-name")?.value ?? current.name;
    const enabled = form.querySelector<HTMLInputElement>("#settings-library-enabled")?.checked ?? current.enabled;
    const folders = [...form.querySelectorAll<HTMLElement>(".settings-folder-card")].map((row, index): LibraryFolderDraft => {
      const previous = current.folders.find((folder) => folder.id === row.dataset.settingsFolderId) ?? current.folders[index];
      if (!previous) throw new Error("Settings folder draft is missing");
      return {
        ...previous,
        label: row.querySelector<HTMLInputElement>("input[data-settings-folder-label]")?.value ?? previous.label,
        path: row.querySelector<HTMLInputElement>("input[data-settings-folder-path]")?.value ?? previous.path,
        enabled: row.querySelector<HTMLInputElement>("input[data-settings-folder-enabled]")?.checked ?? false,
        includeSubfolders: row.querySelector<HTMLInputElement>("input[data-settings-folder-recursive]")?.checked ?? false,
        watchForChanges: row.querySelector<HTMLInputElement>("input[data-settings-folder-watch]")?.checked ?? false,
        sentinel: row.querySelector<HTMLInputElement>("input[data-settings-folder-sentinel]")?.value ?? previous.sentinel,
      };
    });
    return { ...current, name, enabled, folders };
  }

  #captureSettingsForm(): void {
    const draft = this.#readSettingsForm();
    if (!draft) return;
    this.#catalog.setSettingsDraft(draft);
    const chip = this.#root.querySelector<HTMLElement>(".settings-unsaved-chip");
    if (chip) {
      chip.textContent = this.#catalog.snapshot.settingsDirty ? "Unsaved changes" : "Server configuration";
      chip.classList.toggle("dirty", this.#catalog.snapshot.settingsDirty);
    }
  }

  setCatalogKindleStatuses(
    statuses: ReadonlyMap<string, CatalogKindleStatus>,
    countsByProfile: ReadonlyMap<string, CatalogKindleStatusCounts> = new Map(),
  ): void {
    this.#catalog.setKindleStatuses(statuses, countsByProfile);
  }

  setCatalogKindleBookStatus(profileId: string, bookId: string, status: CatalogKindleStatus): void {
    this.#catalog.setKindleBookStatus(profileId, bookId, status);
  }

  setCatalogKindleInventory(inventory: CatalogKindleInventory | undefined): void {
    this.#catalog.setKindleInventory(inventory);
  }

  setCatalogTransferUpdate(update: CatalogTransferUpdate): void {
    this.#catalog.setTransferUpdate(update);
  }

  setAdvancedPartialObjectProbe(state: AdvancedPartialObjectProbeViewState): void {
    this.#advancedPartialObjectProbe = state;
    this.#renderAdvancedPartialObjectProbe();
  }

  get activeCatalogProfileId(): string | undefined {
    return this.#catalog.snapshot.filters.profileId;
  }

  catalogKindleStatus(bookId: string): CatalogKindleStatus | undefined {
    return this.#catalog.snapshot.kindleStatus.get(bookId);
  }
}
