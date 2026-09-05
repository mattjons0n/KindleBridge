// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../client/src/app-error";
import { DebugLog } from "../../client/src/log";
import { initialAppState, type AppState } from "../../client/src/state";
import { AppView, type AppViewHandlers } from "../../client/src/view";

function handlers(): AppViewHandlers {
  return {
    onTargetProfileSaved: vi.fn(),
    onEpubSelected: vi.fn(),
    onConvert: vi.fn(),
    onDownloadConverted: vi.fn(),
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onSelfTest: vi.fn(),
    onSendIntegrated: vi.fn(),
    onIntegratedOpenConfirmed: vi.fn(),
    onCleanupInspectionConfirmed: vi.fn(),
    onCopyLog: vi.fn(),
  };
}

function readyConversion(): AppState["conversion"] {
  const file = new File(["epub"], "book.epub");
  return {
    kind: "ready",
    file,
    result: {
      filename: "book.azw3",
      blob: new Blob(["azw3"]),
      metadata: { title: "A Local Book", authors: ["Ada Author"], language: "en", chapters: 3, toc_entries: 3 },
      diagnostics: { engine: "boko-wasm", runsLocally: true, inputBytes: 4, outputBytes: 4, kindleDocumentType: "PDOC", embeddedCover: true },
    },
    artifactId: "artifact-1",
    downloaded: false,
    validated: true,
  };
}

describe("AppView", () => {
  it("renders the corrected no-Calibre flow", () => {
    const root = document.createElement("div");
    new AppView(root, { ...initialAppState(), secureContext: true, webUsbAvailable: true }, handlers(), new DebugLog());

    expect(root.querySelectorAll(".gate")).toHaveLength(6);
    expect(root.textContent).toContain("Choose and convert an EPUB");
    expect(root.textContent).toContain("No Calibre installation");
    expect(root.textContent).not.toContain("Choose fixture");
    expect(root.querySelector<HTMLButtonElement>('button[data-action="connect"]')?.disabled).toBe(true);
  });

  it("mounts the default-off partial-object diagnostic only inside Advanced activity controls", () => {
    const root = document.createElement("div");
    const onArm = vi.fn();
    const view = new AppView(
      root,
      { ...initialAppState(), secureContext: true, webUsbAvailable: true },
      { ...handlers(), onAdvancedPartialObjectProbeArm: onArm },
      new DebugLog(),
      { autoStartCatalog: false },
    );

    root.querySelector<HTMLButtonElement>('[data-ui-action="open-activity-center"]')?.click();
    const mount = root.querySelector<HTMLElement>("[data-ui-partial-object-probe]");
    expect(mount?.dataset.phase).toBe("off");
    expect(mount?.textContent).toContain("not part of normal inventory");
    mount?.querySelector<HTMLButtonElement>('[data-ui-action="arm-partial-object-probe"]')?.click();
    expect(onArm).toHaveBeenCalledOnce();

    view.setAdvancedPartialObjectProbe({ phase: "armed" });
    expect(root.querySelector<HTMLElement>("[data-ui-partial-object-probe]")?.textContent)
      .toContain("next clean connection");
  });

  it("enables connection after a locally validated conversion", () => {
    const root = document.createElement("div");
    new AppView(root, {
      ...initialAppState(),
      secureContext: true,
      webUsbAvailable: true,
      conversion: readyConversion(),
    }, handlers(), new DebugLog());

    expect(root.textContent).toContain("A Local Book");
    expect(root.textContent).toContain("BOOKMOBI container verified");
    expect(root.textContent).toContain("Personal document (PDOC)");
    expect(root.textContent).toContain("Embedded cover verified");
    expect(root.querySelector<HTMLButtonElement>('button[data-action="connect"]')?.disabled).toBe(false);
  });

  it("escapes hostile EPUB metadata", () => {
    const root = document.createElement("div");
    const conversion = readyConversion();
    if (conversion.kind !== "ready") throw new Error("test setup");
    const state: AppState = {
      ...initialAppState(),
      conversion: {
        ...conversion,
        result: { ...conversion.result, metadata: { ...conversion.result.metadata, title: '<img src=x onerror="boom">' } },
      },
    };
    new AppView(root, state, handlers(), new DebugLog());
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror="boom">');
  });

  it("enables the self-test only on a fully inspected Kindle", () => {
    const root = document.createElement("div");
    const state: AppState = {
      ...initialAppState(),
      conversion: readyConversion(),
      usbAccessProven: true,
      mtpReadProven: true,
      device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981, model: "Kindle", documentsHandle: 0x37 } },
    };
    new AppView(root, state, handlers(), new DebugLog());
    expect(root.querySelector<HTMLButtonElement>('button[data-action="self-test"]')?.disabled).toBe(false);
    expect(root.textContent).toContain("0x00000037");
  });

  it("shows the connection failure next to the retry control", () => {
    const root = document.createElement("div");
    const error = new AppError(
      "USB_MTP_INTERFACE_NOT_FOUND",
      "No MTP/PTP interface with both bulk endpoints was found.",
    );
    new AppView(root, {
      ...initialAppState(),
      conversion: readyConversion(),
      device: {
        kind: "error",
        details: { vendorId: 0x1949, productId: 0x9981, productName: "Kindle" },
        error,
      },
      activeError: error,
    }, handlers(), new DebugLog());

    const inlineError = root.querySelector(".device-error");
    expect(inlineError?.textContent).toContain("USB_MTP_INTERFACE_NOT_FOUND");
    expect(root.querySelector<HTMLButtonElement>('button[data-action="connect"]')?.textContent).toBe("Retry connection");
  });

  it("redacts serials and converter output in error details", () => {
    const root = document.createElement("div");
    new AppView(root, {
      ...initialAppState(),
      activeError: new AppError("CONVERSION_FAILED", "failed", {
        details: { serialNumber: "SECRET-SERIAL-1234", stderr: "private book content" },
      }),
    }, handlers(), new DebugLog());
    expect(root.textContent).toContain("••••1234");
    expect(root.textContent).not.toContain("SECRET-SERIAL");
    expect(root.textContent).not.toContain("private book content");
  });

  it("keeps interrupted-write recovery and errors at the top of the library layout", () => {
    const root = document.createElement("div");
    const callbacks = handlers();
    const error = new AppError("MTP_INVALID_CONTAINER", "The Kindle returned an invalid response.");
    new AppView(root, {
      ...initialAppState(),
      pendingObjectCleanup: {
        version: 1,
        purpose: "catalog",
        stage: "handle-assigned",
        filename: "managed-book.azw3",
        vendorId: 0x1949,
        productId: 0x9981,
        storageId: 1,
        parentHandle: 2,
        size: 123,
        handle: 3,
        operationId: "operation-alert-order",
        recordedAt: Date.now(),
      },
      activeError: error,
    }, callbacks, new DebugLog(), { autoStartCatalog: false });

    const shell = root.querySelector(".library-app-shell > .library-workspace");
    const topbar = shell?.querySelector(":scope > .library-topbar");
    const alerts = shell?.querySelector(":scope > .library-global-alerts");
    const layout = shell?.querySelector(":scope > .library-layout");
    expect(topbar?.nextElementSibling).toBe(alerts);
    expect(alerts?.nextElementSibling).toBe(layout);
    expect(alerts?.textContent).toContain("Interrupted Kindle write");
    expect(alerts?.textContent).toContain("MTP_INVALID_CONTAINER");

    alerts?.querySelector<HTMLButtonElement>('button[data-action="confirm-cleanup-inspection"]')?.click();
    expect(callbacks.onCleanupInspectionConfirmed).toHaveBeenCalledOnce();
  });

  it("directs interrupted metadata-cache recovery to the Kindle storage root", () => {
    const root = document.createElement("div");
    new AppView(root, {
      ...initialAppState(),
      pendingObjectCleanup: {
        version: 1,
        purpose: "metadata-cache",
        stage: "handle-assigned",
        filename: ".kindle-bridge-device-metadata-cache-v1-a.json",
        vendorId: 0x1949,
        productId: 0x9981,
        storageId: 1,
        parentHandle: 0xffff_ffff,
        size: 1_024,
        handle: 4,
        operationId: "operation-cache-recovery",
        recordedAt: Date.now(),
      },
    }, handlers(), new DebugLog(), { autoStartCatalog: false });

    expect(root.querySelector(".recovery-notice")?.textContent).toContain(
      "Inspect the Kindle storage root",
    );
  });

  it("surfaces every replacement cleanup and wires only durably recorded cleanup", () => {
    const root = document.createElement("div");
    const callbacks = { ...handlers(), onReplacementCleanupRequested: vi.fn() };
    const cleanupObject = (handle: number, token: string, filename: string) => ({
      handle,
      storageId: 1,
      parentHandle: 2,
      filename,
      byteLength: 123,
      managedToken: token,
      exactIdentity: `exact-${handle}`,
    });
    new AppView(root, {
      ...initialAppState(),
      device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
      selfTest: { kind: "passed", byteLength: 1012 },
      catalogInventoryState: "ready",
      pendingReplacementCleanups: [{
        version: 1,
        operationId: "cleanup-one",
        recordedAt: 1,
        vendorId: 0x1949,
        productId: 0x9981,
        reason: "old-copy-cleanup",
        oldCopy: cleanupObject(10, "kb-0123456789abcdefabcd", "Old-kb-0123456789abcdefabcd.azw3"),
        newCopy: cleanupObject(20, "kb-fedcba9876543210abcd", "New-kb-fedcba9876543210abcd.azw3"),
      }, {
        version: 1,
        operationId: "delivery-one",
        recordedAt: 2,
        vendorId: 0x1949,
        productId: 0x9981,
        reason: "delivery-recording",
        oldCopy: cleanupObject(30, "kb-11111111111111111111", "Old-kb-11111111111111111111.azw3"),
        newCopy: cleanupObject(40, "kb-22222222222222222222", "New-kb-22222222222222222222.azw3"),
      }],
    }, callbacks, new DebugLog(), { autoStartCatalog: false });

    const notices = root.querySelectorAll('[data-action="cleanup-managed-replacement"]');
    expect(notices).toHaveLength(2);
    const cleanup = root.querySelector<HTMLButtonElement>('[data-cleanup-operation-id="cleanup-one"]');
    const delivery = root.querySelector<HTMLButtonElement>('[data-cleanup-operation-id="delivery-one"]');
    expect(cleanup?.disabled).toBe(false);
    expect(delivery?.disabled).toBe(false);
    expect(delivery?.textContent).toContain("Remove unrecorded replacement");
    cleanup?.click();
    expect(callbacks.onReplacementCleanupRequested).toHaveBeenCalledWith("cleanup-one");
  });

  it("forwards the conversion action", () => {
    const root = document.createElement("div");
    const callbacks = handlers();
    new AppView(root, {
      ...initialAppState(),
      conversion: { kind: "selected", file: new File(["epub"], "book.epub") },
    }, callbacks, new DebugLog());
    root.querySelector<HTMLButtonElement>('button[data-action="convert"]')?.click();
    expect(callbacks.onConvert).toHaveBeenCalledOnce();
  });
});
