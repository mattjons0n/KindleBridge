// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../../client/src/app-error";
import {
  clearPendingObjectCleanup,
  deriveGateStatuses,
  initialAppState,
  persistPendingObjectCleanup,
  readPendingObjectCleanup,
  type AppState,
  type PendingObjectCleanup,
} from "../../client/src/state";

function convertedState(): AppState {
  const file = new File(["epub"], "book.epub");
  return {
    ...initialAppState(),
    conversion: {
      kind: "ready",
      file,
      result: {
        filename: "book.azw3",
        blob: new Blob(["azw3"]),
        metadata: { title: "Book", authors: ["Author"], language: "en", chapters: 2, toc_entries: 2 },
        diagnostics: { engine: "boko-wasm", runsLocally: true, inputBytes: 4, outputBytes: 4, kindleDocumentType: "PDOC", embeddedCover: true },
      },
      artifactId: "artifact-current",
      downloaded: false,
      validated: true,
    },
  };
}

afterEach(() => window.localStorage.clear());

describe("gate derivation", () => {
  it("starts at local conversion and locks hardware gates", () => {
    expect(deriveGateStatuses(initialAppState())).toEqual([
      "active", "pending", "pending", "pending", "pending", "pending",
    ]);
  });

  it("advances through conversion, USB, MTP and byte test in order", () => {
    const state: AppState = {
      ...convertedState(),
      usbAccessProven: true,
      mtpReadProven: true,
      device: { kind: "ready", details: { vendorId: 0x1949, productId: 1 } },
      selfTest: { kind: "passed", byteLength: 1037 },
    };
    expect(deriveGateStatuses(state)).toEqual([
      "passed", "passed", "passed", "passed", "active", "pending",
    ]);
  });

  it("does not pass physical-open gate until the exact converted artifact is confirmed", () => {
    const base: AppState = {
      ...convertedState(),
      usbAccessProven: true,
      mtpReadProven: true,
      selfTest: { kind: "passed", byteLength: 1037 },
      integratedTransfer: {
        kind: "verified",
        purpose: "integrated",
        filename: "book.azw3",
        artifactId: "artifact-current",
        totalBytes: 4,
        physicalOpenConfirmed: false,
      },
    };
    expect(deriveGateStatuses(base).slice(4)).toEqual(["passed", "active"]);
    expect(deriveGateStatuses({
      ...base,
      integratedTransfer: {
        kind: "verified",
        purpose: "integrated",
        filename: "book.azw3",
        artifactId: "artifact-current",
        totalBytes: 4,
        physicalOpenConfirmed: true,
      },
    }).slice(4)).toEqual(["passed", "passed"]);
  });

  it("shows a self-test failure at its own gate", () => {
    const state: AppState = {
      ...convertedState(),
      usbAccessProven: true,
      mtpReadProven: true,
      selfTest: { kind: "failed", error: new AppError("MTP_READBACK_MISMATCH", "bytes differ") },
    };
    expect(deriveGateStatuses(state)[3]).toBe("failed");
  });
});

describe("pending object cleanup journal", () => {
  it("round-trips only bounded recovery metadata", () => {
    const entry: PendingObjectCleanup = {
      version: 1,
      purpose: "integrated",
      stage: "handle-assigned",
      filename: "Generated-Book.azw3",
      vendorId: 0x1949,
      productId: 0x9981,
      deviceLabel: "Kindle",
      storageId: 0x10001,
      parentHandle: 0x37,
      size: 1234,
      handle: 0x101,
      artifactId: "artifact-1",
      recordedAt: 123456,
    };
    expect(persistPendingObjectCleanup(entry)).toBe(true);
    expect(readPendingObjectCleanup()).toEqual(entry);
    expect(clearPendingObjectCleanup()).toBe(true);
  });

  it("round-trips a root-level metadata-cache recovery intent", () => {
    const entry: PendingObjectCleanup = {
      version: 1,
      purpose: "metadata-cache",
      stage: "handle-assigned",
      filename: ".kindle-bridge-device-metadata-cache-v1-a.json",
      vendorId: 0x1949,
      productId: 0x9981,
      storageId: 0x10001,
      parentHandle: 0xffff_ffff,
      size: 1_024,
      handle: 0x505,
      operationId: "mtp-device-cache-a",
      recordedAt: 1_000,
    };

    expect(persistPendingObjectCleanup(entry)).toBe(true);
    expect(readPendingObjectCleanup()).toEqual(entry);
  });

  it("rejects unsafe filenames", () => {
    expect(persistPendingObjectCleanup({
      version: 1,
      purpose: "self-test",
      stage: "send-object-info-intent",
      filename: "../not-a-leaf.txt",
      vendorId: 0x1949,
      productId: 1,
      storageId: 1,
      parentHandle: 2,
      size: 3,
      recordedAt: 4,
    })).toBe(false);
  });

  it("compare-and-delete never clears a newer tab's recovery operation", () => {
    const older: PendingObjectCleanup = {
      version: 1,
      purpose: "catalog",
      stage: "send-object-info-intent",
      filename: "Book-kb-old.azw3",
      vendorId: 0x1949,
      productId: 0x9981,
      storageId: 0x10001,
      parentHandle: 0x37,
      size: 100,
      operationId: "mtp-operation-old",
      recordedAt: 1,
    };
    const newer: PendingObjectCleanup = {
      ...older,
      stage: "handle-assigned",
      handle: 0x202,
      operationId: "mtp-operation-new",
      recordedAt: 2,
    };
    expect(persistPendingObjectCleanup(older)).toBe(true);
    expect(persistPendingObjectCleanup(newer)).toBe(true);

    expect(clearPendingObjectCleanup(older)).toBe(false);
    expect(readPendingObjectCleanup()).toEqual(newer);
    expect(clearPendingObjectCleanup(newer)).toBe(true);
  });
});
