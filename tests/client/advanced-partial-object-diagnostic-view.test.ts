// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { mountAdvancedPartialObjectProbe } from "../../client/src/advanced-partial-object-diagnostic-view";

const target = Object.freeze({
  handle: 23,
  filename: "Book <One>.azw3",
  size: 1_024,
});

const result = Object.freeze({
  verdict: "advertised-and-consistent" as const,
  operation: "GetPartialObject (0x101b)" as const,
  objectSize: 1_024,
  rangeCount: 7,
  requestedRangeBytes: 640,
  returnedRangeBytes: 512,
  overlapBytesVerified: 64,
  repeatBytesVerified: 64,
  wholeObjectComparison: "not-run-object-too-large" as const,
  referenceBytesRead: 0,
  eofBehavior: "zero-byte-success" as const,
  elapsedMs: 18,
});

describe("Advanced partial-object diagnostic view", () => {
  it("keeps the diagnostic off until the user arms the next connection", () => {
    const mount = document.createElement("div");
    const onArm = vi.fn();
    mountAdvancedPartialObjectProbe(mount, { phase: "off" }, { onArm });

    expect(mount.textContent).toContain("default off");
    expect(mount.textContent).toContain("not part of normal inventory");
    mount.querySelector<HTMLButtonElement>('[data-ui-action="arm-partial-object-probe"]')?.click();
    expect(onArm).toHaveBeenCalledOnce();
  });

  it("requires an explicit file selection and confirmation before the first run", () => {
    const mount = document.createElement("div");
    const onRun = vi.fn();
    mountAdvancedPartialObjectProbe(mount, {
      phase: "available",
      targets: [target],
      eligibleCount: 1,
      targetsTruncated: false,
      hasRun: false,
    }, { onRun });

    expect(mount.querySelector("img")).toBeNull();
    expect(mount.textContent).toContain("Book <One>.azw3");
    const select = mount.querySelector<HTMLSelectElement>("[data-ui-partial-object-target]")!;
    const confirmation = mount.querySelector<HTMLInputElement>("[data-ui-partial-object-confirm]")!;
    const run = mount.querySelector<HTMLButtonElement>('[data-ui-action="run-partial-object-probe"]')!;
    expect(run.disabled).toBe(true);
    select.value = "23";
    select.dispatchEvent(new Event("change"));
    expect(run.disabled).toBe(true);
    confirmation.checked = true;
    confirmation.dispatchEvent(new Event("change"));
    expect(run.disabled).toBe(false);
    run.click();
    expect(onRun).toHaveBeenCalledWith({
      handle: 23,
      confirmed: true,
      repeatConfirmed: false,
    });
  });

  it("shows and exports only byte-free metrics and requires repeat confirmation", () => {
    const mount = document.createElement("div");
    const onRun = vi.fn();
    const onExport = vi.fn();
    mountAdvancedPartialObjectProbe(mount, {
      phase: "complete",
      targets: [target],
      eligibleCount: 1,
      targetsTruncated: false,
      result,
    }, { onRun, onExport });

    expect(mount.textContent).toContain("512 returned of 640 requested");
    expect(mount.textContent).toContain("explicitly confirm repeating");
    mount.querySelector<HTMLButtonElement>('[data-ui-action="export-partial-object-probe"]')?.click();
    expect(onExport).toHaveBeenCalledOnce();

    const select = mount.querySelector<HTMLSelectElement>("[data-ui-partial-object-target]")!;
    const confirmation = mount.querySelector<HTMLInputElement>("[data-ui-partial-object-confirm]")!;
    const run = mount.querySelector<HTMLButtonElement>('[data-ui-action="run-partial-object-probe"]')!;
    select.value = "23";
    select.dispatchEvent(new Event("change"));
    confirmation.checked = true;
    confirmation.dispatchEvent(new Event("change"));
    run.click();
    expect(onRun).toHaveBeenCalledWith({
      handle: 23,
      confirmed: true,
      repeatConfirmed: true,
    });
    expect(mount.innerHTML).not.toContain("Uint8Array");
    expect(mount.innerHTML).not.toContain("rawBytes");
  });
});
