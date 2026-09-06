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

async function openTransferDiagnostics(root: HTMLElement): Promise<void> {
  root.querySelector<HTMLButtonElement>('[data-ui-view="settings"]')?.click();
  await vi.waitFor(() => expect(root.querySelector('[data-diagnostic-panel="main"]')).not.toBeNull());
  const main = root.querySelector<HTMLDetailsElement>('[data-diagnostic-panel="main"]')!;
  expect(main.open).toBe(false);
  main.querySelector<HTMLElement>(":scope > summary")?.click();
  root.querySelector<HTMLElement>('[data-diagnostic-panel="transfer-tools"] > summary')?.click();
}

describe("AppView", () => {
  it("keeps manual transfer tools inside collapsed Settings Diagnostics", async () => {
    const root = document.createElement("div");
    new AppView(root, { ...initialAppState(), secureContext: true, webUsbAvailable: true }, handlers(), new DebugLog(), { autoStartCatalog: false });

    expect(root.querySelector(".gate-rail")).toBeNull();
    expect(root.querySelector(".settings-diagnostics")).toBeNull();
    expect(root.querySelector('[data-action="connect"]')).toBeNull();
    expect(root.textContent).not.toContain("Choose and convert an EPUB");
    await openTransferDiagnostics(root);

    expect(root.querySelectorAll(".gate")).toHaveLength(6);
    expect(root.textContent).toContain("Choose and convert an EPUB");
    expect(root.querySelector(".settings-diagnostics")?.textContent).toContain("Manual checks for troubleshooting");
    expect(root.textContent).not.toContain("Choose fixture");
    expect(root.querySelector<HTMLButtonElement>('button[data-action="connect"]')?.disabled).toBe(true);
  });

  it("mounts the default-off partial-object probe only in Settings Diagnostics reports", async () => {
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
    expect(root.querySelector("[data-ui-partial-object-probe]")).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-ui-action="open-settings-diagnostics"]')?.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLDetailsElement>('[data-diagnostic-panel="main"]')?.open).toBe(true));
    root.querySelector<HTMLElement>('[data-diagnostic-panel="reports"] > summary')?.click();
    const mount = root.querySelector<HTMLElement>("[data-ui-partial-object-probe]");
    expect(mount?.closest('[data-diagnostic-panel="reports"]')).not.toBeNull();
    expect(mount?.dataset.phase).toBe("off");
    expect(mount?.textContent).toContain("not part of normal inventory");
    mount?.querySelector<HTMLButtonElement>('[data-ui-action="arm-partial-object-probe"]')?.click();
    expect(onArm).toHaveBeenCalledOnce();

    view.setAdvancedPartialObjectProbe({ phase: "armed" });
    expect(root.querySelector<HTMLElement>("[data-ui-partial-object-probe]")?.textContent)
      .toContain("next clean connection");
  });

  it("enables diagnostic connection after a locally validated conversion", async () => {
    const root = document.createElement("div");
    new AppView(root, {
      ...initialAppState(),
      secureContext: true,
      webUsbAvailable: true,
      conversion: readyConversion(),
    }, handlers(), new DebugLog(), { autoStartCatalog: false });
    await openTransferDiagnostics(root);

    expect(root.textContent).toContain("A Local Book");
    expect(root.textContent).toContain("BOOKMOBI container verified");
    expect(root.textContent).toContain("Personal document (PDOC)");
    expect(root.textContent).toContain("Embedded cover verified");
    expect(root.querySelector<HTMLButtonElement>('button[data-action="connect"]')?.disabled).toBe(false);
  });

  it("escapes hostile EPUB metadata", async () => {
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
    new AppView(root, state, handlers(), new DebugLog(), { autoStartCatalog: false });
    await openTransferDiagnostics(root);
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror="boom">');
  });

  it("enables the diagnostic self-test only on a fully inspected Kindle", async () => {
    const root = document.createElement("div");
    const state: AppState = {
      ...initialAppState(),
      conversion: readyConversion(),
      usbAccessProven: true,
      mtpReadProven: true,
      device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981, model: "Kindle", documentsHandle: 0x37 } },
    };
    new AppView(root, state, handlers(), new DebugLog(), { autoStartCatalog: false });
    await openTransferDiagnostics(root);
    expect(root.querySelector<HTMLButtonElement>('button[data-action="self-test"]')?.disabled).toBe(false);
    expect(root.textContent).toContain("0x00000037");
  });

  it("shows the diagnostic connection failure next to the retry control", async () => {
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
    }, handlers(), new DebugLog(), { autoStartCatalog: false });
    await openTransferDiagnostics(root);

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

  it.each(["catalog", "metadata-cache", "self-test", "integrated"] as const)(
    "presents only the live owned %s journal as work in progress, not interrupted recovery",
    (purpose) => {
      const root = document.createElement("div");
      const state: AppState = {
        ...initialAppState(),
        device: { kind: "ready", details: { vendorId: 0x1949, productId: 0x9981 } },
        activeObjectWriteId: "live-write",
        pendingObjectCleanup: {
          version: 1, purpose, stage: "handle-assigned", filename: "current-object",
          vendorId: 0x1949, productId: 0x9981, storageId: 1, parentHandle: 2,
          size: 123, handle: 3, operationId: "live-write", recordedAt: Date.now(),
        },
      };
      const view = new AppView(root, state, handlers(), new DebugLog(), { autoStartCatalog: false });
      expect(root.querySelector(".recovery-notice")).toBeNull();
      expect(root.textContent).not.toContain("Recovery inspection required");
      expect(root.textContent).not.toContain("Inspect and acknowledge the recorded object");
      expect(root.textContent).toContain(purpose === "metadata-cache" ? "Updating Kindle metadata" : "Writing to Kindle");

      // Once the owner settles or a reload drops ephemeral state, a remaining
      // durable record still requires recovery. Merely being busy cannot hide it.
      for (const activeObjectWriteId of [undefined, "different-live-write"]) {
        view.render({ ...state, activeObjectWriteId, selfTest: { kind: "running" } });
        expect(root.querySelector(".recovery-notice")?.textContent).toContain("Interrupted Kindle write");
        expect(root.textContent).toContain("Recovery inspection required");
      }

      // Even a matching marker cannot hide real connection loss while an
      // asynchronous send is still unwinding.
      view.render({ ...state, device: { kind: "disconnected" } });
      expect(root.querySelector(".recovery-notice")?.textContent).toContain("Interrupted Kindle write");
      view.render({ ...state, pendingObjectCleanup: undefined, activeObjectWriteId: undefined });
      expect(root.querySelector(".recovery-notice")).toBeNull();
    },
  );

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

  it("forwards the diagnostic conversion action", async () => {
    const root = document.createElement("div");
    const callbacks = handlers();
    new AppView(root, {
      ...initialAppState(),
      conversion: { kind: "selected", file: new File(["epub"], "book.epub") },
    }, callbacks, new DebugLog(), { autoStartCatalog: false });
    await openTransferDiagnostics(root);
    root.querySelector<HTMLButtonElement>('button[data-action="convert"]')?.click();
    expect(callbacks.onConvert).toHaveBeenCalledOnce();
  });

  it("preserves opened Diagnostics sections across device state renders", async () => {
    const root = document.createElement("div");
    const state = { ...initialAppState(), secureContext: true, webUsbAvailable: true };
    const view = new AppView(root, state, handlers(), new DebugLog(), { autoStartCatalog: false });
    await openTransferDiagnostics(root);

    view.render({ ...state, conversion: readyConversion() });

    expect(root.querySelector<HTMLDetailsElement>('[data-diagnostic-panel="main"]')?.open).toBe(true);
    expect(root.querySelector<HTMLDetailsElement>('[data-diagnostic-panel="transfer-tools"]')?.open).toBe(true);
    expect(root.querySelector<HTMLDetailsElement>('[data-diagnostic-panel="device-files"]')?.open).toBe(false);
    expect(root.querySelector<HTMLDetailsElement>('[data-diagnostic-panel="reports"]')?.open).toBe(false);
    expect(root.textContent).toContain("A Local Book");
  });
});
