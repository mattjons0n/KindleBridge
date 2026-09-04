import { describe, expect, it } from "vitest";
import {
  MAX_ACTIVITY_EVENTS,
  KINDLE_BRIDGE_ACTIVITY_STORAGE_KEY,
  acknowledgeKindleBridgeActivity,
  appendKindleBridgeActivity,
  buildKindleBridgeActivityHistory,
  clearKindleBridgeActivity,
  parseKindleBridgeActivityEvent,
  persistKindleBridgeActivity,
  projectKindleBridgeActivityCenter,
  readKindleBridgeActivity,
  type KindleBridgeActivityEvent,
} from "../../client/src/activity-center";
import { EMPTY_TARGET_PROFILE, type AppState } from "../../client/src/state";
import { initialLibraryFilters } from "../../client/src/library-prototype";

function event(
  id: string,
  overrides: Partial<KindleBridgeActivityEvent> = {},
): KindleBridgeActivityEvent {
  return {
    version: 1,
    id,
    kind: "transfer-result",
    at: "2026-09-03T12:00:00.000Z",
    tone: "success",
    title: "Book transferred and verified",
    acknowledged: false,
    ...overrides,
  };
}

describe("activity center domain", () => {
  it("persists only a bounded validated browser-local history", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const valid = event("persisted");
    const invalid = { ...event("secret"), detail: "API key: should-not-persist" };
    expect(persistKindleBridgeActivity(storage, [invalid, valid])).toBe(true);
    expect(readKindleBridgeActivity(storage).map(({ id }) => id)).toEqual(["persisted"]);

    values.set(KINDLE_BRIDGE_ACTIVITY_STORAGE_KEY, "x".repeat(96 * 1024 + 1));
    expect(readKindleBridgeActivity(storage)).toEqual([]);
    expect(clearKindleBridgeActivity(storage)).toBe(true);
  });

  it("rejects unbounded, malformed, or secret-bearing event payloads", () => {
    expect(parseKindleBridgeActivityEvent(event("ok"))).toMatchObject({ id: "ok" });
    expect(parseKindleBridgeActivityEvent(event("ordinary-title", { title: "Alchemy of Secrets" })))
      .toMatchObject({ title: "Alchemy of Secrets" });
    expect(parseKindleBridgeActivityEvent(event("attention", { action: "open-attention" })))
      .toMatchObject({ action: "open-attention" });
    expect(parseKindleBridgeActivityEvent(event("retry-transfer", { action: "retry-transfer" })))
      .toMatchObject({ action: "retry-transfer" });
    expect(parseKindleBridgeActivityEvent({ ...event("bad"), version: 2 })).toBeUndefined();
    expect(parseKindleBridgeActivityEvent({ ...event("bad"), detail: "Bearer abc123" })).toBeUndefined();
    expect(parseKindleBridgeActivityEvent({ ...event("bad"), detail: "x".repeat(1_001) })).toBeUndefined();
    expect(parseKindleBridgeActivityEvent({ ...event("bad"), extra: { raw: "bytes" } })).toBeUndefined();
  });

  it("coalesces transient phase and scan summaries but retains outcomes", () => {
    let events: readonly KindleBridgeActivityEvent[] = [];
    events = appendKindleBridgeActivity(events, event("phase-1", {
      kind: "device-phase", phase: "connecting", tone: "neutral", title: "Connecting",
    }));
    events = appendKindleBridgeActivity(events, event("phase-2", {
      kind: "device-phase", phase: "ready", tone: "success", title: "Kindle ready",
    }));
    events = appendKindleBridgeActivity(events, event("result"));
    expect(events.map(({ id }) => id)).toEqual(["result", "phase-2"]);

    events = appendKindleBridgeActivity(events, event("scan-start", {
      kind: "catalog-scan", profileId: "prf-one", newlyIndexed: 0,
    }));
    events = appendKindleBridgeActivity(events, event("book-one", {
      kind: "catalog-scan", profileId: "prf-one", newlyIndexed: 1,
    }));
    events = appendKindleBridgeActivity(events, event("book-two", {
      kind: "catalog-scan", profileId: "prf-one", newlyIndexed: 1,
    }));
    events = appendKindleBridgeActivity(events, event("scan-complete", {
      kind: "catalog-scan", profileId: "prf-one",
    }));
    expect(events.find(({ kind }) => kind === "catalog-scan")).toMatchObject({
      id: "scan-complete",
      newlyIndexed: 2,
    });
  });

  it("bounds history, orders it, and promotes unresolved actionable failures", () => {
    const values = Array.from({ length: MAX_ACTIVITY_EVENTS + 20 }, (_, index) => event(`event-${index}`, {
      at: new Date(Date.UTC(2026, 8, 3, 12, 0, index)).toISOString(),
    }));
    values.push(event("phase", { kind: "device-phase", phase: "ready", title: "Ready" }));
    values.push(event("failure", {
      kind: "failure", tone: "error", title: "Transfer failed", action: "retry",
      at: "2026-09-03T13:00:00.000Z",
    }));
    const history = buildKindleBridgeActivityHistory(values);
    expect(history.events).toHaveLength(MAX_ACTIVITY_EVENTS);
    expect(history.phase).toBe("needs-attention");
    expect(history.needsAttention).toBeGreaterThan(0);

    const acknowledged = acknowledgeKindleBridgeActivity(history.events, "failure");
    expect(acknowledged.find(({ id }) => id === "failure")?.acknowledged).toBe(true);

    const quietNavigation = buildKindleBridgeActivityHistory([
      event("queue", { kind: "queue-change", tone: "neutral", action: "open-queue" }),
      event("ready", { kind: "device-phase", tone: "success", phase: "ready" }),
    ]);
    expect(quietNavigation).toMatchObject({ phase: "ready", needsAttention: 0 });
  });

  it("retains an unresolved warning through routine-event churn until it is acknowledged", () => {
    const unresolved = event("unresolved-warning", {
      at: "2026-09-03T10:00:00.000Z",
      tone: "warning",
      title: "Source folder unavailable",
      action: "open-settings",
    });
    const routine = Array.from({ length: MAX_ACTIVITY_EVENTS }, (_, index) => event(`routine-${index}`, {
      at: new Date(Date.UTC(2026, 8, 3, 12, 0, index)).toISOString(),
    }));

    const retained = buildKindleBridgeActivityHistory([unresolved, ...routine]);
    expect(retained.events).toHaveLength(MAX_ACTIVITY_EVENTS);
    expect(retained.events.some(({ id }) => id === unresolved.id)).toBe(true);
    expect(retained.events.some(({ id }) => id === "routine-0")).toBe(false);
    expect(retained.needsAttention).toBe(1);

    const acknowledged = acknowledgeKindleBridgeActivity(retained.events, unresolved.id);
    const afterAcknowledgement = buildKindleBridgeActivityHistory([
      ...acknowledged,
      event("routine-next", { at: "2026-09-03T14:00:00.000Z" }),
    ]);
    expect(afterAcknowledgement.events).toHaveLength(MAX_ACTIVITY_EVENTS);
    expect(afterAcknowledgement.events.some(({ id }) => id === unresolved.id)).toBe(false);
    expect(afterAcknowledgement.needsAttention).toBe(0);
  });

  it("projects plain device phases and source health from current app state", () => {
    const state: AppState = {
      secureContext: true,
      webUsbAvailable: true,
      targetProfile: EMPTY_TARGET_PROFILE,
      usbAccessProven: true,
      mtpReadProven: true,
      conversion: { kind: "empty" },
      device: {
        kind: "ready" as const,
        details: { vendorId: 0x1949, productId: 0x9981, model: "Kindle", freeBytes: 5_000n, capacityBytes: 10_000n },
      },
      selfTest: { kind: "passed" as const, byteLength: 1012 },
      postConnectStage: "idle",
      catalogInventoryState: "ready" as const,
      integratedTransfer: { kind: "idle" },
    };
    const projected = projectKindleBridgeActivityCenter(state, {
      loadState: "ready",
      profiles: [{ id: "prf-one", name: "Household", description: "", initial: "H", sourceLabel: "Library", enabled: true, rootCount: 1, availableRootCount: 0, bookCount: 42 }],
      rootsByProfile: new Map([["prf-one", [{ id: "root-one", profileId: "prf-one", label: "Library", path: "/libraries", recursive: true, watch: true, enabled: true, status: "unavailable" as const }]]]),
      filters: initialLibraryFilters("prf-one"),
      facets: { authors: [], languages: [], subjects: [], publishers: [], series: [], formats: [], roots: [], years: [], metadata: [] },
      booksState: "ready",
      stale: false,
      liveUpdatesConnected: true,
      settingsSaving: false,
      settingsRefreshing: false,
      settingsConflict: false,
      settingsDirty: false,
      rescanningRootIds: new Set(),
      sendBusy: false,
      kindleStatus: new Map(),
      kindleStatusCountsByProfile: new Map(),
      kindleInventoryOffset: 0,
      layout: "grid",
      selectedBookIds: new Set(),
      bulkActionBusy: false,
      sendQueueState: "idle",
      sendQueueOpen: false,
      sendQueueBusy: false,
      seriesState: "idle",
      seriesQuery: "",
      seriesSort: "name",
      smartShelves: [],
      smartShelvesState: "idle",
      shelfManagerOpen: false,
      annotations: new Map(),
      healthState: "idle",
      healthBooks: new Map(),
      healthFilter: { type: "all", severity: "all", ignored: false },
      metadataLookupState: "idle",
      metadataLookupJobs: {
        items: [{
          id: "lookup-restart-safe",
          profileId: "prf-one",
          provider: "open-library",
          status: "paused",
          revision: 7,
          entriesIncluded: false,
          entries: [],
          total: 12,
          pending: 5,
          ready: 4,
          noResults: 2,
          failed: 1,
          cancelled: 0,
          createdAt: "2026-09-03T12:00:00.000Z",
          updatedAt: "2026-09-03T12:05:00.000Z",
        }],
        total: 1,
        limit: 100,
        offset: 0,
      },
      metadataLookupBusy: false,
      activityOpen: false,
      activityEvents: [],
    });
    expect(projected).toMatchObject({
      phase: "ready", deviceLabel: "Kindle", freeBytes: 5_000n, capacityBytes: 10_000n,
      queueCount: 0, queuedSourceBytes: 0, approximateQueueCapacity: "unknown",
      sourceWarnings: 1, scanningRoots: 0, indexedBooks: 42, newlyIndexed: 0,
      metadataLookupJob: {
        id: "lookup-restart-safe", provider: "open-library", status: "paused",
        total: 12, pending: 5, ready: 4, failed: 1, noResults: 2,
      },
    });
  });
});
