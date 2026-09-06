import type { KindleObjectStore, KindleOperationOptions, KindleStoredObjectInfo } from "./contracts";
import { isFatalTransportFailure } from "../error-diagnostics";
import { parseKindleKrdsReadingEvidence } from "./krds-reading-state";
import type { KindleReadingSidecarFormat } from "./reading-state";

const LIMITS = { objects: 10_000, depth: 32, fileBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 };
const FORMATS = new Set(["azw3f", "azw3r", "yjf", "yjr", "mbs", "mbp1"]);
type ReadStore = Pick<KindleObjectStore, "listObjectHandles" | "getObjectInfo" | "readObject">;
export interface ReadingDiagnosticObject {
  info: KindleStoredObjectInfo;
  path: string;
  sidecar: boolean;
  outcome?: string;
  sha256?: string;
  base64?: string;
  parsed?: unknown;
  error?: string;
}
export interface ReadingDiagnosticReport {
  schemaVersion: 1;
  capturedAt: string;
  limits: typeof LIMITS;
  objects: ReadingDiagnosticObject[];
  issues: string[];
  bytesRead: number;
}
function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Development evidence only. Never writes, deletes, or treats parsed progress as confirmed state. */
export async function collectReadingDiagnostic(
  store: ReadStore,
  storageId: number,
  documentsHandle: number,
  options: KindleOperationOptions = {},
  progress: (message: string) => void = () => {},
): Promise<ReadingDiagnosticReport> {
  const report: ReadingDiagnosticReport = {
    schemaVersion: 1, capturedAt: new Date().toISOString(), limits: { ...LIMITS },
    objects: [], issues: [], bytesRead: 0,
  };
  const visited = new Set<number>([documentsHandle]);
  const queue = [{ handle: documentsHandle, path: "documents", sidecar: false, depth: 0 }];
  const recover = (error: unknown, context: string): void => {
    if (options.signal?.aborted || isFatalTransportFailure(error)) throw error;
    report.issues.push(`${context}: ${message(error)}`);
  };
  while (queue.length > 0 && visited.size < LIMITS.objects) {
    options.signal?.throwIfAborted();
    const folder = queue.shift()!;
    progress(`Listing ${folder.path} (${report.objects.length} objects)`);
    try {
      const handles = await store.listObjectHandles({ storageId, associationHandle: folder.handle,
        maxHandles: LIMITS.objects - visited.size }, options);
      for (const handle of handles) {
        if (visited.has(handle)) { report.issues.push(`Repeated handle ${handle} in ${folder.path}`); continue; }
        if (visited.size >= LIMITS.objects) { report.issues.push("Object limit reached"); break; }
        visited.add(handle);
        try {
          const info = await store.getObjectInfo(handle, options);
          if (info.storageId !== storageId || info.parentHandle !== folder.handle) {
            report.issues.push(`Object ${handle} moved or has inconsistent parent/storage`); continue;
          }
          const path = `${folder.path}/${info.filename}`;
          const sidecar = folder.sidecar || (info.objectFormat === 0x3001 && /\.sdr$/i.test(info.filename));
          report.objects.push({ info, path, sidecar });
          if (info.objectFormat === 0x3001) {
            if (folder.depth >= LIMITS.depth) report.issues.push(`Depth limit: ${path}`);
            else queue.push({ handle, path, sidecar, depth: folder.depth + 1 });
          }
        } catch (error) { recover(error, `${folder.path}, handle ${handle}`); }
      }
    } catch (error) { recover(error, folder.path); }
  }
  if (queue.length) report.issues.push("Object limit left folders unvisited");
  // Known reading formats first; retain unknown sidecars too for offline discovery.
  const extension = (entry: ReadingDiagnosticObject): string => entry.info.filename.split(".").pop()!.toLowerCase();
  const files = report.objects.filter((entry) => entry.sidecar && entry.info.objectFormat !== 0x3001)
    .sort((a, b) => Number(FORMATS.has(extension(b))) - Number(FORMATS.has(extension(a))));
  let reservedBytes = 0;
  for (const [index, entry] of files.entries()) {
    options.signal?.throwIfAborted();
    const size = entry.info.compressedSize;
    if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.fileBytes || size > LIMITS.totalBytes - reservedBytes) {
      entry.outcome = "skipped-size-limit"; continue;
    }
    reservedBytes += size;
    progress(`Reading sidecar ${index + 1} of ${files.length}: ${entry.path}`);
    try {
      const current = await store.getObjectInfo(entry.info.handle, options);
      if (JSON.stringify(current) !== JSON.stringify(entry.info)) throw new Error("Object changed before read");
      const bytes = await store.readObject(entry.info.handle, { ...options, maxBytes: size });
      report.bytesRead += bytes.byteLength;
      if (bytes.byteLength !== size) throw new Error("Object size changed while reading");
      const after = await store.getObjectInfo(entry.info.handle, options);
      if (JSON.stringify(after) !== JSON.stringify(entry.info)) throw new Error("Object changed during read");
      entry.sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))))
        .map((value) => value.toString(16).padStart(2, "0")).join("");
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      entry.base64 = btoa(binary);
      entry.outcome = "captured";
      if (FORMATS.has(extension(entry))) {
        try { entry.parsed = parseKindleKrdsReadingEvidence(bytes, extension(entry) as KindleReadingSidecarFormat, { maxInputBytes: LIMITS.fileBytes }); }
        catch (error) { entry.error = message(error); }
      }
    } catch (error) { entry.outcome = "failed"; entry.error = message(error); recover(error, entry.path); }
  }
  return report;
}
