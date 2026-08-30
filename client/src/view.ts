import type { DebugLog } from "./log";
import {
  CatalogBrowser,
  type CatalogHardwareHooks,
  type CatalogKindleInventory,
  type CatalogSendRequest,
  type CatalogTransferUpdate,
} from "./catalog-browser";
import {
  createCatalogClient,
  type CatalogApi,
  type CatalogEvent,
  type CatalogKindleStatus,
  type CatalogKindleStatusCounts,
} from "./catalog-client";
import { renderKindleDeviceContents, renderLibraryPrototype, renderLibraryResults } from "./library-prototype-view";
import type { KindleFilter, LibrarySort, LibraryView, MetadataFilter } from "./library-prototype";
import type { LibraryFolderDraft, LibrarySettingsDraft } from "./library-settings-prototype";
import {
  deriveGateStatuses,
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
  readonly onCopyLog: () => void;
  /** Hardware integration for the Docker catalog. Kept separate from Gate 0 so a
   * Kindle can be connected before a catalog book has been converted. */
  readonly onCatalogConnectRequested?: () => void | Promise<void>;
  readonly onCatalogDisconnectRequested?: () => void | Promise<void>;
  readonly onCatalogSendRequested?: (request: CatalogSendRequest) => void | Promise<void>;
  readonly onCatalogChanged?: (event: CatalogEvent) => void | Promise<void>;
  readonly onCatalogProfileChanged?: (profileId: string) => void | Promise<void>;
}

export interface AppViewOptions {
  readonly catalogApi?: CatalogApi;
  readonly catalogStorage?: Pick<Storage, "getItem" | "setItem">;
  readonly autoStartCatalog?: boolean;
}

const GATE_LABELS = ["Convert", "WebUSB", "MTP read", "Byte test", "Send", "Open"] as const;

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
  if (!pending || state.device.kind === "transferring" || state.selfTest.kind === "running") return "";
  return `<section class="notice error recovery-notice" role="alert"><div class="grow"><strong>Interrupted Kindle write</strong>Inspect Documents for exactly <code>${escapeHtml(pending.filename)}</code>. Remove only that exact managed filename if it is partial, then acknowledge the inspection.<div class="actions"><button type="button" data-action="confirm-cleanup-inspection">I inspected this filename</button></div></div></section>`;
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
  #catalogDialogReturnBookId?: string;
  #settingsDeleteReturnLibraryId?: string;

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
      onCatalogChanged: handlers.onCatalogChanged,
      onActiveProfileChanged: handlers.onCatalogProfileChanged,
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
    if (options.autoStartCatalog !== false) void this.#catalog.start();
  }

  render(state: AppState): void {
    this.#state = state;
    const active = document.activeElement;
    const preservedInputFocus = active instanceof HTMLInputElement
      && active.id
      && this.#root.contains(active)
      && active.closest(".settings-page, .library-toolbar")
      ? {
          id: active.id,
          value: active.value,
          start: active.selectionStart,
          end: active.selectionEnd,
          direction: active.selectionDirection,
        }
      : undefined;
    const moreFiltersOpen = this.#root.querySelector<HTMLDetailsElement>(".library-more-filters")?.open ?? false;
    const globalAlerts = `${renderRecovery(state)}${renderError(state)}`;
    this.#root.innerHTML = `<div class="app-shell library-app-shell">
      ${renderLibraryPrototype(state, this.#catalog.snapshot, globalAlerts)}
      <section class="poc-lab" aria-labelledby="poc-lab-title">
        <details>
          <summary><span><strong id="poc-lab-title">Proven transfer engine</strong><small>Open the original conversion, WebUSB, MTP, self-test, and transfer controls</small></span><span class="poc-lab-summary-badge">Transfer checks preserved</span></summary>
          <div class="poc-lab-content">
            <div class="poc-lab-intro"><span class="local-badge">No Calibre · no cloud</span><p>The catalog above uses the private Docker catalog service. These controls preserve the physically proven single-book transfer path.</p></div>
            <ol class="gate-rail" aria-label="POC gates">${renderGateRail(state)}</ol>
            <div class="main-content">
        ${!state.secureContext ? '<div class="notice error"><div><strong>Secure context required</strong>Open Kindle Bridge through trusted HTTPS or its localhost development URL.</div></div>' : ""}
        ${!state.webUsbAvailable ? '<div class="notice error"><div><strong>WebUSB unavailable</strong>Use Chrome or another compatible Chromium browser.</div></div>' : ""}
        <div class="grid">${renderConversion(state, this.#catalog.snapshot.sendBusy)}${renderDevice(state)}${renderTransfer(state)}${renderProfile(state, this.#profileDraft)}
          <section class="panel panel-wide"><details class="diagnostics"><summary>Developer diagnostics</summary><div class="log-toolbar"><button type="button" data-action="copy-log">Copy debug log</button></div><pre class="debug-log" id="debug-log"></pre></details></section>
        </div>
            </div>
          </div>
        </details>
      </section>
      <footer class="footer"><span>Private self-hosted catalog · browser-local conversion</span><span>boko WASM (GPL-3.0-or-later) · no overwrite support</span></footer>
    </div>`;
    this.#bindEvents();
    this.#renderLog();
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
  }

  #renderLog(): void {
    const element = this.#root.querySelector<HTMLPreElement>("#debug-log");
    if (element) element.textContent = this.#debugLog.format() || "Application ready";
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
    this.#bindCatalogEvents();
  }

  #bindCatalogEvents(): void {
    this.#root.querySelector<HTMLInputElement>("#library-search")?.addEventListener("input", (event) => {
      this.#catalog.updateFilter("query", (event.currentTarget as HTMLInputElement).value);
    });
    const selects: ReadonlyArray<readonly [string, "language" | "format" | "rootId" | "year"]> = [
      ["#library-language", "language"], ["#library-format", "format"],
      ["#library-root-filter", "rootId"], ["#library-year", "year"],
    ];
    selects.forEach(([selector, key]) => this.#root.querySelector<HTMLSelectElement>(selector)?.addEventListener("change", (event) => {
      this.#catalog.updateFilter(key, (event.currentTarget as HTMLSelectElement).value);
    }));
    const typedFacets: ReadonlyArray<readonly [string, "author" | "subject" | "publisher" | "series"]> = [
      ["#library-author", "author"], ["#library-subject", "subject"],
      ["#library-publisher", "publisher"], ["#library-series", "series"],
    ];
    typedFacets.forEach(([selector, key]) => this.#root.querySelector<HTMLInputElement>(selector)?.addEventListener("change", (event) => {
      const value = (event.currentTarget as HTMLInputElement).value.trim();
      this.#catalog.updateFilter(key, value || "all");
    }));
    this.#root.querySelector<HTMLSelectElement>("#library-metadata")?.addEventListener("change", (event) => {
      this.#catalog.updateFilter("metadata", (event.currentTarget as HTMLSelectElement).value as MetadataFilter);
    });
    this.#root.querySelector<HTMLSelectElement>("#library-kindle-filter")?.addEventListener("change", (event) => {
      this.#catalog.updateFilter("kindle", (event.currentTarget as HTMLSelectElement).value as KindleFilter);
    });
    this.#root.querySelector<HTMLSelectElement>("#library-sort")?.addEventListener("change", (event) => {
      this.#catalog.updateFilter("sort", (event.currentTarget as HTMLSelectElement).value as LibrarySort);
    });
    this.#root.querySelectorAll<HTMLButtonElement>("button[data-ui-profile]").forEach((button) => button.addEventListener("click", () => {
      this.#captureSettingsForm();
      const profileId = button.dataset.uiProfile;
      if (profileId) void this.#catalog.selectProfile(profileId);
    }));
    this.#root.querySelectorAll<HTMLButtonElement>("button[data-ui-view]").forEach((button) => button.addEventListener("click", () => {
      this.#captureSettingsForm();
      void this.#catalog.setView(button.dataset.uiView as LibraryView);
    }));
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="connect-catalog-device"]').forEach((button) => button.addEventListener("click", () => {
      void this.#catalog.requestConnect();
    }));
    this.#root.querySelectorAll<HTMLButtonElement>('button[data-ui-action="disconnect-catalog-device"]').forEach((button) => button.addEventListener("click", () => {
      void this.#catalog.requestDisconnect();
    }));
    this.#root.querySelector<HTMLButtonElement>('button[data-ui-action="show-kindle"]')?.addEventListener("click", () => {
      void this.#catalog.setView("on-kindle");
    });
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
        void this.#catalog.setView(button.dataset.uiView as LibraryView);
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
        this.#catalogDialogReturnBookId = bookId;
        this.#catalog.openSend(bookId);
      }
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="clear-filters"]').forEach((button) => button.addEventListener("click", () => this.#catalog.clearFilters()));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="retry-catalog"]').forEach((button) => button.addEventListener("click", () => { void this.#catalog.retry(); }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="catalog-page"]').forEach((button) => button.addEventListener("click", () => {
      const offset = Number(button.dataset.pageOffset);
      if (Number.isFinite(offset)) this.#catalog.goToPage(offset);
    }));
    scope.querySelectorAll<HTMLButtonElement>('button[data-ui-action="kindle-page"]').forEach((button) => button.addEventListener("click", () => {
      const offset = Number(button.dataset.pageOffset);
      if (Number.isFinite(offset)) this.#catalog.goToKindleInventoryPage(offset);
    }));
    scope.querySelectorAll<HTMLElement>('[data-ui-action="close-send"]').forEach((element) => element.addEventListener("click", () => this.#closeCatalogDialog()));
    scope.querySelector<HTMLButtonElement>('button[data-ui-action="confirm-catalog-send"]')?.addEventListener("click", () => { void this.#catalog.confirmSend(); });
    scope.querySelector<HTMLButtonElement>('button[data-ui-action="dismiss-announcement"]')?.addEventListener("click", () => this.#catalog.dismissAnnouncement());
    if (scope === this.#root) this.#activateCatalogDialog();
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

  get activeCatalogProfileId(): string | undefined {
    return this.#catalog.snapshot.filters.profileId;
  }

  catalogKindleStatus(bookId: string): CatalogKindleStatus | undefined {
    return this.#catalog.snapshot.kindleStatus.get(bookId);
  }
}
