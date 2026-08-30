// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { convertEpub } from "../../client/src/api/convert";

afterEach(() => vi.unstubAllGlobals());

describe("browser-local EPUB conversion lifecycle", () => {
  it("does not create a boko worker when cancellation happens during the source read", async () => {
    let releaseRead!: (value: ArrayBuffer) => void;
    const delayedRead = new Promise<ArrayBuffer>((resolve) => { releaseRead = resolve; });
    const file = new File(["epub"], "cancelled.epub", { type: "application/epub+zip" });
    Object.defineProperty(file, "arrayBuffer", { value: vi.fn(() => delayedRead) });
    const WorkerConstructor = vi.fn();
    vi.stubGlobal("Worker", WorkerConstructor);
    const abort = new AbortController();

    const converting = convertEpub(file, abort.signal);
    abort.abort();
    releaseRead(new ArrayBuffer(4));

    await expect(converting).rejects.toMatchObject({ code: "CONVERSION_ABORTED" });
    expect(WorkerConstructor).not.toHaveBeenCalled();
  });
});
