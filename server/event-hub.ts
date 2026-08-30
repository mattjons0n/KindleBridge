import type { ServerResponse } from "node:http";

import type { CatalogEvent } from "../shared/catalog-contracts.js";
import type { ScannerEvent } from "./catalog-indexer.js";

export class CatalogEventHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly recent: CatalogEvent[] = [];
  private counter = 0;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly historyLimit = 256,
    private readonly maxClients = 64,
  ) {
    this.heartbeat = setInterval(() => {
      for (const response of this.clients) this.writeOrDrop(response, ": keep-alive\n\n");
    }, 20_000);
    this.heartbeat.unref();
  }

  publish(event: ScannerEvent): CatalogEvent {
    this.counter += 1;
    const catalogEvent: CatalogEvent = {
      ...event,
      id: `evt_${Date.now().toString(36)}_${this.counter.toString(36)}`,
      at: new Date().toISOString(),
    };
    this.recent.push(catalogEvent);
    if (this.recent.length > this.historyLimit) this.recent.splice(0, this.recent.length - this.historyLimit);
    const encoded = encodeEvent(catalogEvent);
    for (const response of this.clients) this.writeOrDrop(response, encoded);
    return catalogEvent;
  }

  attach(response: ServerResponse, lastEventId?: string): boolean {
    if (this.clients.size >= this.maxClients) return false;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.clients.add(response);
    response.once("close", () => this.clients.delete(response));
    if (!this.writeOrDrop(response, "retry: 3000\n\n")) return true;
    if (lastEventId) {
      const index = this.recent.findIndex((event) => event.id === lastEventId);
      // If the browser's cursor fell outside the bounded history, replay the
      // retained window instead of silently sending nothing. The browser
      // coalesces these hints into one authoritative API refresh and finishes
      // on a cursor that exists in this process's history.
      const replay = index >= 0 ? this.recent.slice(index + 1) : this.recent;
      for (const event of replay) {
        if (!this.writeOrDrop(response, encodeEvent(event))) return true;
      }
    }
    // Every transport connection receives an authoritative refresh hint,
    // including a first connection with no cursor and a reconnect to a fresh
    // server process whose bounded history cannot contain the old cursor.
    this.counter += 1;
    const snapshot: CatalogEvent = {
      id: `snapshot_${Date.now().toString(36)}_${this.counter.toString(36)}`,
      type: "catalog.snapshot",
      at: new Date().toISOString(),
    };
    this.writeOrDrop(response, encodeEvent(snapshot));
    return true;
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const response of this.clients) response.end();
    this.clients.clear();
  }

  private writeOrDrop(response: ServerResponse, frame: string): boolean {
    try {
      if (response.destroyed || response.writableEnded || !response.write(frame)) {
        this.clients.delete(response);
        response.destroy();
        return false;
      }
      return true;
    } catch {
      this.clients.delete(response);
      response.destroy();
      return false;
    }
  }
}

function encodeEvent(event: CatalogEvent): string {
  const serialized = JSON.stringify(event);
  // Scanner events are intentionally small hints. Keep an internal mistake
  // from turning one event into an unbounded socket write.
  const data = Buffer.byteLength(serialized, "utf8") <= 32 * 1024
    ? serialized
    : JSON.stringify({
        id: event.id,
        type: event.type,
        at: event.at,
        ...(event.profileId ? { profileId: event.profileId } : {}),
        ...(event.rootId ? { rootId: event.rootId } : {}),
        data: { truncated: true },
      });
  return `id: ${event.id}\ndata: ${data}\n\n`;
}
