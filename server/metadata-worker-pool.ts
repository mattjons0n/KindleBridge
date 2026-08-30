import { Worker } from "node:worker_threads";

import type { BookFormat } from "../shared/catalog-contracts.js";
import {
  MetadataError,
  type ExtractedBookMetadata,
  type MetadataErrorCode,
} from "./book-metadata.js";

export interface MetadataWorkerPoolOptions {
  size?: number;
  timeoutMs?: number;
  /** Test seam; production always uses the adjacent compiled parser module. */
  moduleUrl?: string;
}

interface MetadataTask {
  id: number;
  filename: string;
  format: BookFormat;
  resolve: (metadata: ExtractedBookMetadata) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout | null;
}

interface WorkerSlot {
  worker: Worker;
  task: MetadataTask | null;
}

interface WorkerSuccess {
  id: number;
  ok: true;
  metadata: ExtractedBookMetadata;
}

interface WorkerFailure {
  id: number;
  ok: false;
  error: { code?: string; message?: string };
}

type WorkerReply = WorkerSuccess | WorkerFailure;

const WORKER_SOURCE = String.raw`
  import { parentPort, workerData } from "node:worker_threads";
  const extractor = import(workerData.moduleUrl).then((module) => module.extractBookMetadata);

  parentPort.on("message", async (task) => {
    try {
      const extractBookMetadata = await extractor;
      const metadata = await extractBookMetadata(task.filename, task.format);
      parentPort.postMessage({ id: task.id, ok: true, metadata });
    } catch (error) {
      parentPort.postMessage({
        id: task.id,
        ok: false,
        error: {
          code: error && typeof error.code === "string" ? error.code : undefined,
          message: error && typeof error.message === "string" ? error.message : undefined,
        },
      });
    }
  });
`;

const METADATA_ERROR_CODES = new Set<MetadataErrorCode>([
  "book_too_large",
  "invalid_epub",
  "invalid_azw3",
  "archive_limit",
  "metadata_limit",
  "metadata_timeout",
  "drm_unsupported",
  "unsupported_compression",
]);

/**
 * A small, persistent worker pool isolates all untrusted container parsing from
 * the HTTP/scanner event loop. Workers are reused across books, so a large
 * initial library pays startup cost per pool slot rather than per source. A
 * timed-out worker is terminated and replaced before another source is parsed.
 */
export class MetadataWorkerPool {
  private readonly size: number;
  private readonly timeoutMs: number;
  private readonly moduleUrl: string;
  private readonly queue: MetadataTask[] = [];
  private readonly slots: WorkerSlot[] = [];
  private nextTaskId = 1;
  private closed = false;

  constructor(options: MetadataWorkerPoolOptions = {}) {
    this.size = options.size ?? 2;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.size) || this.size < 1 || this.size > 16) {
      throw new RangeError("Metadata worker count must be between 1 and 16.");
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 5 * 60_000) {
      throw new RangeError("Metadata timeout must be between 1 ms and 5 minutes.");
    }
    const sourceExtension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    this.moduleUrl = options.moduleUrl ?? new URL(`./book-metadata.${sourceExtension}`, import.meta.url).href;
  }

  extract(filename: string, format: BookFormat): Promise<ExtractedBookMetadata> {
    if (this.closed) return Promise.reject(new Error("Metadata worker pool is closed."));
    return new Promise<ExtractedBookMetadata>((resolve, reject) => {
      this.queue.push({
        id: this.nextTaskId,
        filename,
        format,
        resolve,
        reject,
        timer: null,
      });
      this.nextTaskId += 1;
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closedError = new Error("Metadata worker pool closed before extraction completed.");
    for (const task of this.queue.splice(0)) task.reject(closedError);
    const terminations = this.slots.splice(0).map((slot) => {
      if (slot.task) {
        if (slot.task.timer) clearTimeout(slot.task.timer);
        slot.task.reject(closedError);
        slot.task = null;
      }
      return slot.worker.terminate();
    });
    await Promise.allSettled(terminations);
  }

  private dispatch(): void {
    if (this.closed) return;
    while (this.queue.length > 0) {
      let slot = this.slots.find((candidate) => candidate.task === null);
      if (!slot) {
        if (this.slots.length >= this.size) return;
        slot = this.createSlot();
      }
      const task = this.queue.shift() as MetadataTask;
      slot.task = task;
      task.timer = setTimeout(() => this.timeout(slot as WorkerSlot, task), this.timeoutMs);
      slot.worker.postMessage({ id: task.id, filename: task.filename, format: task.format });
    }
  }

  private createSlot(): WorkerSlot {
    const slot: WorkerSlot = {
      worker: new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { moduleUrl: this.moduleUrl },
        name: "kindle-bridge-metadata",
      }),
      task: null,
    };
    slot.worker.on("message", (reply: WorkerReply) => this.complete(slot, reply));
    slot.worker.on("error", () => this.failSlot(slot));
    slot.worker.on("exit", () => this.failSlot(slot));
    this.slots.push(slot);
    return slot;
  }

  private complete(slot: WorkerSlot, reply: WorkerReply): void {
    const task = slot.task;
    if (!task || reply.id !== task.id) return;
    if (task.timer) clearTimeout(task.timer);
    task.timer = null;
    slot.task = null;
    if (reply.ok) {
      const cover = reply.metadata.cover;
      task.resolve({
        ...reply.metadata,
        cover: cover === null ? null : Buffer.from(cover),
      });
    } else if (reply.error.code && METADATA_ERROR_CODES.has(reply.error.code as MetadataErrorCode)) {
      task.reject(
        new MetadataError(
          reply.error.code as MetadataErrorCode,
          reply.error.message || "Metadata extraction was rejected.",
        ),
      );
    } else {
      task.reject(new Error("Metadata worker could not parse the source."));
    }
    this.dispatch();
  }

  private timeout(slot: WorkerSlot, task: MetadataTask): void {
    if (slot.task !== task) return;
    task.timer = null;
    slot.task = null;
    task.reject(new MetadataError("metadata_timeout", "Metadata extraction exceeded its time limit."));
    this.removeSlot(slot);
    void slot.worker.terminate();
    this.dispatch();
  }

  private failSlot(slot: WorkerSlot): void {
    if (!this.slots.includes(slot)) return;
    const task = slot.task;
    if (task) {
      if (task.timer) clearTimeout(task.timer);
      task.timer = null;
      slot.task = null;
      task.reject(new Error("Metadata worker stopped before extraction completed."));
    }
    this.removeSlot(slot);
    if (!this.closed) this.dispatch();
  }

  private removeSlot(slot: WorkerSlot): void {
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
  }
}
