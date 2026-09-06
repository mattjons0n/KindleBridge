import { openKindle, type ConnectedKindle } from "./device-runtime";
import { requestKindleDevice } from "./usb";

const collect = document.querySelector<HTMLButtonElement>("#collect")!;
const cancel = document.querySelector<HTMLButtonElement>("#cancel")!;
const status = document.querySelector<HTMLElement>("#status")!;
const download = document.querySelector<HTMLAnchorElement>("#download")!;
const notes = document.querySelector<HTMLTextAreaElement>("#notes")!;
let abort: AbortController | undefined;
let url: string | undefined;
const update = (message: string): void => { status.textContent = message; };
cancel.onclick = () => abort?.abort();
if (!import.meta.env.DEV) { collect.disabled = true; update("This diagnostic is development-only."); }
else collect.onclick = async () => {
  collect.disabled = true;
  cancel.disabled = false;
  download.hidden = true;
  abort = new AbortController();
  let connection: ConnectedKindle | undefined;
  let descriptor: unknown;
  try {
    // Keep the chooser directly in the click handler's user gesture.
    const device = await requestKindleDevice();
    abort.signal.throwIfAborted();
    connection = await openKindle(device, {
      onDescriptor: (_details, value) => { descriptor = value; },
      onUsbOpen: () => update("USB connected. Opening read-only diagnostic session…"),
      onMtpReading: () => update("Reading device information…"),
    }, undefined, { signal: abort.signal });
    const report = await connection.collectDevelopmentReadingDiagnostic(update, { signal: abort.signal });
    const payload = { ...report, notes: notes.value, device: connection.details, descriptor };
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([JSON.stringify(payload, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2)], { type: "application/json" }));
    download.href = url;
    download.download = `kindle-reading-diagnostic-${Date.now()}.json`;
    download.hidden = false;
    const captured = report.objects.filter((entry) => entry.outcome === "captured");
    const skipped = report.objects.filter((entry) => entry.outcome && entry.outcome !== "captured");
    update(`Collected ${captured.length} sidecar files (${report.bytesRead} bytes). ${skipped.length} skipped/failed; ${report.issues.length} issues.\nDownload the report and attach it in the conversation.\n\n${captured.map((entry) => `${entry.path}\n  ${entry.error ?? JSON.stringify(entry.parsed) ?? "Raw bytes captured for offline analysis"}`).join("\n")}`);
  } catch (error) { update(`Collection did not complete: ${error instanceof Error ? error.message : String(error)}. Disconnect the Kindle in other apps/tabs before retrying.`); }
  finally {
    try { await connection?.disconnect(); }
    catch (error) { status.textContent += `\nUSB cleanup failed: ${String(error)}. Unplug and reconnect before retrying.`; }
    collect.disabled = false;
    cancel.disabled = true;
  }
};
