import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { CatalogHttpServer } from "../../server/http-server.js";

const database = {
  initializeCoverProviderCredentials: () => undefined,
  getCoverProviderCredential: () => undefined,
};

describe("buffered response lifecycle lease", () => {
  it("queues beyond the active cap and releases waiters in response-lifecycle order", async () => {
    const server = new CatalogHttpServer(database as never, {} as never, {} as never, {} as never, {} as never, {
      maxConcurrentBufferedResponses: 2,
    });
    const acquire = (
      server as unknown as { acquireBufferedResponse(response: ServerResponse): Promise<() => void> }
    ).acquireBufferedResponse.bind(server);
    const first = new EventEmitter() as ServerResponse;
    const second = new EventEmitter() as ServerResponse;
    const third = new EventEmitter() as ServerResponse;

    await acquire(first);
    await acquire(second);
    let thirdAcquired = false;
    const waiting = acquire(third).then((release) => {
      thirdAcquired = true;
      return release;
    });
    await Promise.resolve();
    expect(thirdAcquired).toBe(false);

    first.emit("finish");
    const releaseThird = await waiting;
    expect(thirdAcquired).toBe(true);
    releaseThird();
    second.emit("close");
  });

  it("times out a non-draining bounded queue without reserving another buffer", async () => {
    const server = new CatalogHttpServer(database as never, {} as never, {} as never, {} as never, {} as never, {
      maxConcurrentBufferedResponses: 1,
      bufferedResponseWaitTimeoutMs: 5,
    });
    const acquire = (
      server as unknown as { acquireBufferedResponse(response: ServerResponse): Promise<() => void> }
    ).acquireBufferedResponse.bind(server);
    const first = new EventEmitter() as ServerResponse;
    const releaseFirst = await acquire(first);

    await expect(acquire(new EventEmitter() as ServerResponse)).rejects.toMatchObject({
      code: "buffered_response_busy",
    });
    releaseFirst();
  });

  it("rejects an already-closed fast-path response without leaking capacity", async () => {
    const server = new CatalogHttpServer(database as never, {} as never, {} as never, {} as never, {} as never, {
      maxConcurrentBufferedResponses: 1,
    });
    const acquire = (
      server as unknown as { acquireBufferedResponse(response: ServerResponse): Promise<() => void> }
    ).acquireBufferedResponse.bind(server);
    const closed = Object.assign(new EventEmitter(), { destroyed: true, writableFinished: false }) as unknown as ServerResponse;

    await expect(acquire(closed)).rejects.toMatchObject({ code: "buffered_response_aborted" });
    expect((server as unknown as { activeBufferedResponses: number }).activeBufferedResponses).toBe(0);
    const live = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false }) as unknown as ServerResponse;
    const release = await acquire(live);
    release();
    expect((server as unknown as { activeBufferedResponses: number }).activeBufferedResponses).toBe(0);
  });

  it("removes a response that closes while queued and lets a later request acquire", async () => {
    const server = new CatalogHttpServer(database as never, {} as never, {} as never, {} as never, {} as never, {
      maxConcurrentBufferedResponses: 1,
    });
    const acquire = (
      server as unknown as { acquireBufferedResponse(response: ServerResponse): Promise<() => void> }
    ).acquireBufferedResponse.bind(server);
    const first = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false }) as unknown as ServerResponse;
    const releaseFirst = await acquire(first);
    const closing = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false }) as EventEmitter & {
      destroyed: boolean;
      writableFinished: boolean;
    };
    const waiting = acquire(closing as unknown as ServerResponse);
    closing.destroyed = true;
    closing.emit("close");
    await expect(waiting).rejects.toMatchObject({ code: "buffered_response_aborted" });

    releaseFirst();
    const later = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false }) as unknown as ServerResponse;
    const releaseLater = await acquire(later);
    releaseLater();
    expect((server as unknown as { activeBufferedResponses: number }).activeBufferedResponses).toBe(0);
  });
});
