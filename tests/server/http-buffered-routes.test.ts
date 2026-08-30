import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CatalogHttpServer } from "../../server/http-server.js";

class HeldResponse extends EventEmitter {
  headersSent = false;
  destroyed = false;
  writableFinished = false;
  status = 0;
  data: Buffer | null = null;

  setHeader(): void {}

  writeHead(status: number): this {
    this.status = status;
    this.headersSent = true;
    return this;
  }

  end(data?: Buffer | string): this {
    if (data !== undefined) this.data = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return this;
  }

  finish(): void {
    this.writableFinished = true;
    this.emit("finish");
  }
}

interface PrivateRoutes {
  routeBooks(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    profileId: string,
    segments: string[],
  ): Promise<void>;
  serveCover(
    request: IncomingMessage,
    response: ServerResponse,
    profileId: string,
    bookId: string,
  ): Promise<void>;
  serveStatic(pathname: string, response: ServerResponse): Promise<void>;
}

function heldRequest(): IncomingMessage {
  const request = new EventEmitter() as EventEmitter & { aborted: boolean; socket: EventEmitter & { destroyed: boolean } };
  request.aborted = false;
  request.socket = Object.assign(new EventEmitter(), { destroyed: false });
  return request as unknown as IncomingMessage;
}

function privateRoutes(server: CatalogHttpServer): PrivateRoutes {
  return server as unknown as PrivateRoutes;
}

describe("buffered route lifecycle", () => {
  it("queues third book, cover, and static responses before allocating their bodies", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "kindle-bridge-buffered-routes-"));
    const staticBytes = Buffer.from("bounded-static-body");
    await writeFile(path.join(directory, "asset.js"), staticBytes);
    const pageBytes = Buffer.from('{"items":[],"total":0,"limit":24,"offset":0}');
    const coverBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    let pageBuilds = 0;
    let sourceLookups = 0;
    let coverReads = 0;
    const database = {
      getProfile: () => ({ id: "prf_test1234" }),
      serializeBookPage: () => {
        pageBuilds += 1;
        return pageBytes;
      },
      getBookSource: () => {
        sourceLookups += 1;
        return {
          coverKey: "a".repeat(64),
          coverMediaType: "image/jpeg",
          book: { rootId: "root_test1234" },
        };
      },
    };
    const coverCache = {
      read: async () => {
        coverReads += 1;
        return coverBytes;
      },
    };
    const server = new CatalogHttpServer(
      database as never,
      { requestRescan: () => true } as never,
      {} as never,
      coverCache as never,
      {} as never,
      { maxConcurrentBufferedResponses: 2, staticDirectory: directory },
    );
    const routes = privateRoutes(server);

    const bookResponses = [new HeldResponse(), new HeldResponse(), new HeldResponse()];
    const bookRequest = { method: "GET" } as IncomingMessage;
    const bookCalls = bookResponses.slice(0, 2).map((response) =>
      routes.routeBooks(bookRequest, response as unknown as ServerResponse, new URL("http://local/books"), "prf_test1234", []),
    );
    await Promise.all(bookCalls);
    const thirdBookCall = routes.routeBooks(
      bookRequest,
      bookResponses[2] as unknown as ServerResponse,
      new URL("http://local/books"),
      "prf_test1234",
      [],
    );
    await Promise.resolve();
    expect(pageBuilds).toBe(2);
    expect(bookResponses[2]!.data).toBeNull();
    bookResponses[0]!.finish();
    await thirdBookCall;
    expect(pageBuilds).toBe(3);
    expect(bookResponses[2]!.data).toEqual(pageBytes);
    bookResponses[1]!.finish();
    bookResponses[2]!.finish();
    expect((server as unknown as { activeBufferedResponses: number }).activeBufferedResponses).toBe(0);

    const coverResponses = [new HeldResponse(), new HeldResponse(), new HeldResponse()];
    const coverCalls = coverResponses.slice(0, 2).map((response) =>
      routes.serveCover(
        heldRequest(),
        response as unknown as ServerResponse,
        "prf_test1234",
        "book_test1234",
      ),
    );
    await Promise.all(coverCalls);
    const thirdCoverCall = routes.serveCover(
      heldRequest(),
      coverResponses[2] as unknown as ServerResponse,
      "prf_test1234",
      "book_test1234",
    );
    await Promise.resolve();
    expect(sourceLookups).toBe(2);
    expect(coverReads).toBe(2);
    expect(coverResponses[2]!.data).toBeNull();
    coverResponses[0]!.finish();
    await thirdCoverCall;
    expect(sourceLookups).toBe(3);
    expect(coverReads).toBe(3);
    expect(coverResponses[2]!.data).toEqual(coverBytes);
    coverResponses[1]!.finish();
    coverResponses[2]!.finish();
    expect((server as unknown as { activeBufferedResponses: number }).activeBufferedResponses).toBe(0);

    const staticResponses = [new HeldResponse(), new HeldResponse(), new HeldResponse()];
    // serveStatic performs an asynchronous stat before it reaches the gate.
    // Establish both active leases before starting the third call so the test
    // cannot accidentally enqueue response 0 or 1 behind response 2.
    const staticCalls = staticResponses.slice(0, 2).map((response) =>
      routes.serveStatic("/asset.js", response as unknown as ServerResponse),
    );
    await Promise.all(staticCalls);
    const thirdStaticCall = routes.serveStatic(
      "/asset.js",
      staticResponses[2] as unknown as ServerResponse,
    );
    await Promise.resolve();
    expect(staticResponses[2]!.data).toBeNull();
    staticResponses[0]!.finish();
    await thirdStaticCall;
    expect(staticResponses[2]!.data).toEqual(staticBytes);
    staticResponses[1]!.finish();
    staticResponses[2]!.finish();
  }, 20_000);
});
