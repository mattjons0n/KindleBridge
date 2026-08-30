import type {
  MtpBulkTransport,
  MtpIncomingTransportChunk,
  MtpOutgoingTransportPhase,
  MtpTransportIoOptions,
} from "../../client/src/mtp/session";

export type FakeMtpRead = Uint8Array | MtpIncomingTransportChunk;

export class FakeMtpBulkTransport implements MtpBulkTransport {
  readonly writes: Uint8Array[] = [];
  readonly readTimeouts: Array<number | undefined> = [];
  readonly writeTimeouts: Array<number | undefined> = [];
  readonly phases: Uint8Array[] = [];
  readonly reads: MtpIncomingTransportChunk[] = [];
  shortWriteAt: number | undefined;
  writeErrorAt: number | undefined;
  writeError: unknown = new Error("injected bulk-OUT failure");
  writeDelayMs = 0;
  readErrorAt: number | undefined;
  private readCount = 0;

  constructor(reads: readonly FakeMtpRead[] = []) {
    this.reads.push(...reads.map(normalizeRead));
  }

  enqueueRead(...chunks: readonly FakeMtpRead[]): void {
    this.reads.push(...chunks.map(normalizeRead));
  }

  async writePhase(
    phase: MtpOutgoingTransportPhase,
    options: MtpTransportIoOptions = {},
  ): Promise<{ readonly bytesWritten: number }> {
    const phaseChunks: Uint8Array[] = [];
    let totalWritten = 0;
    try {
      for await (const data of phase.chunks) {
        if (this.writeDelayMs > 0) {
          await abortableDelay(this.writeDelayMs, options.signal);
        }
        const writeIndex = this.writes.length;
        this.writeTimeouts.push(options.timeoutMs);
        if (this.writeErrorAt === writeIndex) {
          throw this.writeError;
        }
        const copy = data.slice();
        this.writes.push(copy);
        phaseChunks.push(copy);
        const bytesWritten = this.shortWriteAt === writeIndex
          ? Math.max(0, data.byteLength - 1)
          : data.byteLength;
        totalWritten += bytesWritten;
        phase.onProgress?.(totalWritten, phase.length);
        if (bytesWritten !== data.byteLength) break;
      }
    } finally {
      this.phases.push(concatenate(...phaseChunks));
    }
    return { bytesWritten: totalWritten };
  }

  async read(
    options: MtpTransportIoOptions = {},
  ): Promise<MtpIncomingTransportChunk> {
    const readIndex = this.readCount;
    this.readCount += 1;
    this.readTimeouts.push(options.timeoutMs);
    if (this.readErrorAt === readIndex) {
      throw new Error("injected bulk-IN failure");
    }
    const next = this.reads.shift();
    if (next) {
      return { data: next.data.slice(), phaseEnded: next.phaseEnded };
    }
    return new Promise<MtpIncomingTransportChunk>((_resolve, reject) => {
      const abort = (): void => reject(options.signal?.reason ?? new Error("aborted"));
      if (options.signal?.aborted) {
        abort();
      } else {
        options.signal?.addEventListener("abort", abort, { once: true });
      }
    });
  }

  allWrittenBytes(): Uint8Array {
    const length = this.writes.reduce((total, chunk) => total + chunk.byteLength, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.writes) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finishResolve, milliseconds);
    function cleanup(): void {
      signal?.removeEventListener("abort", finishReject);
    }
    function finishResolve(): void {
      cleanup();
      resolve();
    }
    function finishReject(): void {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("aborted"));
    }
    signal?.addEventListener("abort", finishReject, { once: true });
    if (signal?.aborted) finishReject();
  });
}

function normalizeRead(read: FakeMtpRead): MtpIncomingTransportChunk {
  return read instanceof Uint8Array
    ? { data: read.slice(), phaseEnded: true }
    : { data: read.data.slice(), phaseEnded: read.phaseEnded };
}

export function splitReadPhase(
  bytes: Uint8Array,
  ...offsets: readonly number[]
): MtpIncomingTransportChunk[] {
  const chunks = splitAt(bytes, ...offsets);
  return chunks.map((data, index) => ({
    data,
    phaseEnded: index === chunks.length - 1,
  }));
}

export function concatenate(...chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export function splitAt(bytes: Uint8Array, ...offsets: readonly number[]): Uint8Array[] {
  const result: Uint8Array[] = [];
  let previous = 0;
  for (const offset of offsets) {
    result.push(bytes.slice(previous, offset));
    previous = offset;
  }
  result.push(bytes.slice(previous));
  return result.filter((part) => part.byteLength > 0);
}

export function splitContainerStream(bytes: Uint8Array): Uint8Array[] {
  const result: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) {
      throw new Error("truncated container stream");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    const length = view.getUint32(0, true);
    if (length < 12 || offset + length > bytes.byteLength) {
      throw new Error(`invalid container length ${length}`);
    }
    result.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  return result;
}
