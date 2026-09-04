import { describe, expect, it } from "vitest";
import { describeKindleReadingPresentation } from "../../client/src/kindle/reading-presentation";

const ENABLED = Object.freeze({ version: 1 as const, enabled: true });

describe("Kindle reading presentation descriptors", () => {
  it("is hidden while the internal presentation gate is off", () => {
    expect(describeKindleReadingPresentation({ layout: "grid" })).toEqual({
      visibility: "hidden",
      layout: "grid",
    });
  });

  it("makes Unknown structurally different from a known zero percent", () => {
    const unknown = describeKindleReadingPresentation({ gate: ENABLED, layout: "grid" });
    const zero = describeKindleReadingPresentation({
      gate: ENABLED,
      layout: "grid",
      evidence: {
        status: "unknown",
        progressPercent: 0,
        provenance: "azw3f",
        freshness: "live",
        explicitState: false,
      },
    });
    expect(unknown).toMatchObject({
      visibility: "visible",
      progress: { kind: "unknown", role: "status", text: "Unknown", accessibleLabel: "reading progress unknown" },
    });
    expect(unknown).not.toHaveProperty("progress.valueNow");
    expect(zero).toMatchObject({
      visibility: "visible",
      progress: { kind: "known", role: "progressbar", valueNow: 0, text: "0%", accessibleLabel: "0% read" },
    });
  });

  it("provides layout-specific accessible grid and list progress contracts", () => {
    const evidence = {
      status: "in-progress",
      progressPercent: 42.36,
      provenance: "yjf",
      freshness: "live",
      explicitState: false,
    } as const;
    expect(describeKindleReadingPresentation({ gate: ENABLED, layout: "grid", evidence })).toMatchObject({
      progress: {
        kind: "known",
        valueMin: 0,
        valueMax: 100,
        valueNow: 42.4,
        accessibleLabel: "42.4% read",
        placement: "under-cover",
      },
    });
    expect(describeKindleReadingPresentation({ gate: ENABLED, layout: "list", evidence })).toMatchObject({
      progress: { placement: "inline-reading-cell" },
    });
  });

  it("shows shaped Read/Unread indicators only for explicit state evidence", () => {
    const read = describeKindleReadingPresentation({
      gate: ENABLED,
      layout: "grid",
      evidence: {
        status: "read",
        progressPercent: 100,
        provenance: "yjf",
        freshness: "live",
        explicitState: true,
      },
    });
    const unread = describeKindleReadingPresentation({
      gate: ENABLED,
      layout: "list",
      evidence: {
        status: "unread",
        progressPercent: 0,
        provenance: "mbp1",
        freshness: "last-seen",
        explicitState: true,
      },
    });
    const percentageOnly = describeKindleReadingPresentation({
      gate: ENABLED,
      layout: "grid",
      evidence: {
        status: "in-progress",
        progressPercent: 100,
        provenance: "azw3r",
        freshness: "live",
        explicitState: false,
      },
    });
    expect(read).toMatchObject({
      stateIndicator: {
        state: "read",
        shape: "closed-book",
        text: "Read",
        accessibleLabel: "reading state: Read",
        placement: "below-cover-progress",
      },
    });
    expect(unread).toMatchObject({
      progress: { kind: "known", valueNow: 0, accessibleLabel: "Last seen: 0% read" },
      stateIndicator: {
        state: "unread",
        shape: "open-book",
        text: "Unread",
        accessibleLabel: "Last seen: reading state: Unread",
        placement: "reading-state-cell",
      },
    });
    expect(percentageOnly).not.toHaveProperty("stateIndicator");
  });
});
