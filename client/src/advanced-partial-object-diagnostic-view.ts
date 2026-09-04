import {
  advancedPartialObjectProbeMetrics,
  type AdvancedPartialObjectProbeTarget,
  type AdvancedPartialObjectProbeRunRequest,
  type AdvancedPartialObjectProbeViewState,
} from "./advanced-partial-object-diagnostic";

export interface AdvancedPartialObjectProbeViewHandlers {
  readonly onArm?: () => void | Promise<void>;
  readonly onRun?: (request: AdvancedPartialObjectProbeRunRequest) => void | Promise<void>;
  readonly onExport?: () => void | Promise<void>;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resultMarkup(state: AdvancedPartialObjectProbeViewState): string {
  const result = state.phase === "complete"
    ? state.result
    : state.phase === "error" ? state.result : undefined;
  if (!result) return "";
  return `<dl class="activity-probe-metrics" aria-label="Byte-free partial-object probe result">${advancedPartialObjectProbeMetrics(result)
    .map(({ label, value }) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("")}</dl><button type="button" data-ui-action="export-partial-object-probe">Copy byte-free metrics</button>`;
}

function selectionMarkup(
  state: Extract<AdvancedPartialObjectProbeViewState, {
    readonly targets: readonly AdvancedPartialObjectProbeTarget[];
  }>,
  handlers: AdvancedPartialObjectProbeViewHandlers,
): string {
  const running = state.phase === "running";
  if (state.targets.length === 0) {
    return '<p role="status">No eligible unprotected readable book is directly inside Kindle Documents.</p>';
  }
  const hasRun = state.phase === "complete" || state.hasRun;
  const countNote = state.targetsTruncated
    ? `Showing ${state.targets.length} of ${state.eligibleCount} eligible files.`
    : `${state.eligibleCount} eligible ${state.eligibleCount === 1 ? "file" : "files"}.`;
  const confirmation = hasRun
    ? "I explicitly confirm repeating this read-only probe in the current connection."
    : "I confirm this read-only probe may inspect bounded ranges from the selected file.";
  return `<fieldset class="activity-probe-controls"${running ? " disabled" : ""}>
    <legend class="sr-only">Select and confirm one exact Kindle file</legend>
    <label><span>Exact current file</span><select data-ui-partial-object-target>
      <option value="">Choose one file…</option>
      ${state.targets.map((target) => `<option value="${target.handle}">${escapeHtml(target.filename)} · ${target.size} bytes · object 0x${target.handle.toString(16).padStart(8, "0")}</option>`).join("")}
    </select></label>
    <small>${escapeHtml(countNote)} Paths and file contents are not exported.</small>
    <label class="activity-probe-confirm"><input type="checkbox" data-ui-partial-object-confirm /> <span>${escapeHtml(confirmation)}</span></label>
    <button type="button" class="primary" data-ui-action="run-partial-object-probe" disabled>${running ? "Running bounded probe…" : hasRun ? "Repeat bounded probe" : "Run bounded probe"}</button>
  </fieldset>${handlers.onRun ? "" : '<p role="status">This build has no diagnostic controller hook.</p>'}`;
}

function markup(
  state: AdvancedPartialObjectProbeViewState,
  handlers: AdvancedPartialObjectProbeViewHandlers,
): string {
  const heading = '<header><strong>GetPartialObject physical probe</strong><span>Development-only · session-only · default off</span></header>';
  if (state.phase === "off") {
    return `${heading}<p>This diagnostic is not part of normal inventory. Enable it only for the next clean Kindle connection.</p><button type="button" data-ui-action="arm-partial-object-probe"${handlers.onArm ? "" : " disabled"}>Enable for next connection</button>`;
  }
  if (state.phase === "armed") {
    return `${heading}<p role="status">Enabled in page memory for the next clean connection. Connect the Kindle normally; the opt-in is consumed once.</p>`;
  }
  if (state.phase === "opening") {
    return `${heading}<p role="status">Opening the explicitly enabled diagnostic connection. The normal byte test and complete inventory run first.</p>`;
  }

  const status = state.phase === "running"
    ? '<p role="status">Reading only the fixed, bounded compatibility samples…</p>'
    : state.phase === "complete"
      ? '<p role="status">The advertised operation returned consistent bounded samples.</p>'
      : state.phase === "error"
        ? `<p role="alert">${escapeHtml(state.message)}</p>`
        : "";
  const canSelect = state.targets.length > 0;
  return `${heading}${status}${resultMarkup(state)}${selectionMarkup(state, handlers)}${state.phase === "error" && !canSelect ? `<button type="button" data-ui-action="arm-partial-object-probe"${handlers.onArm ? "" : " disabled"}>Enable again for next connection</button>` : ""}`;
}

/** Replaces only the dedicated Advanced-panel mount and binds its local controls. */
export function mountAdvancedPartialObjectProbe(
  mount: HTMLElement,
  state: AdvancedPartialObjectProbeViewState,
  handlers: AdvancedPartialObjectProbeViewHandlers,
): void {
  mount.className = "activity-partial-object-probe";
  mount.dataset.phase = state.phase;
  mount.innerHTML = markup(state, handlers);

  mount.querySelector<HTMLButtonElement>('[data-ui-action="arm-partial-object-probe"]')
    ?.addEventListener("click", () => { void handlers.onArm?.(); });
  mount.querySelector<HTMLButtonElement>('[data-ui-action="export-partial-object-probe"]')
    ?.addEventListener("click", () => { void handlers.onExport?.(); });

  const select = mount.querySelector<HTMLSelectElement>("[data-ui-partial-object-target]");
  const confirm = mount.querySelector<HTMLInputElement>("[data-ui-partial-object-confirm]");
  const run = mount.querySelector<HTMLButtonElement>('[data-ui-action="run-partial-object-probe"]');
  if (!select || !confirm || !run || !handlers.onRun || state.phase === "running") return;
  const update = (): void => {
    run.disabled = select.value === "" || !confirm.checked;
  };
  select.addEventListener("change", update);
  confirm.addEventListener("change", update);
  run.addEventListener("click", () => {
    const handle = Number(select.value);
    if (!Number.isSafeInteger(handle) || handle < 0 || handle > 0xffff_ffff || !confirm.checked) return;
    const hasRun = state.phase === "complete"
      || ((state.phase === "available" || state.phase === "error") && state.hasRun);
    void handlers.onRun?.({
      handle,
      confirmed: true,
      repeatConfirmed: hasRun,
    });
  });
}
