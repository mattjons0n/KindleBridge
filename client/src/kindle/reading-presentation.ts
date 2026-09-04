import { isKindleReadingPresentationEnabled } from "./reading-reconciliation";
import {
  validateKindleReadingEvidence,
  type KindleReadingEvidence,
} from "./reading-state";

export type KindleReadingPresentationLayout = "grid" | "list";

export interface HiddenKindleReadingPresentation {
  readonly visibility: "hidden";
  readonly layout: KindleReadingPresentationLayout;
}

export interface KnownKindleReadingProgressDescriptor {
  readonly kind: "known";
  readonly role: "progressbar";
  readonly valueMin: 0;
  readonly valueMax: 100;
  readonly valueNow: number;
  readonly text: string;
  readonly accessibleLabel: string;
  readonly placement: "under-cover" | "inline-reading-cell";
}

export interface UnknownKindleReadingProgressDescriptor {
  readonly kind: "unknown";
  readonly role: "status";
  readonly text: "Unknown";
  readonly accessibleLabel: string;
  readonly placement: "under-cover" | "inline-reading-cell";
}

export type KindleReadingProgressDescriptor =
  | KnownKindleReadingProgressDescriptor
  | UnknownKindleReadingProgressDescriptor;

export interface KindleReadingStateIndicatorDescriptor {
  readonly state: "read" | "unread";
  readonly shape: "closed-book" | "open-book";
  readonly text: "Read" | "Unread";
  readonly accessibleLabel: string;
  readonly placement: "below-cover-progress" | "reading-state-cell";
}

export interface VisibleKindleReadingPresentation {
  readonly visibility: "visible";
  readonly layout: KindleReadingPresentationLayout;
  readonly progress: KindleReadingProgressDescriptor;
  /** Present only for a physically proven explicit Read/Unread field. */
  readonly stateIndicator?: KindleReadingStateIndicatorDescriptor;
}

export type KindleReadingPresentationDescriptor =
  | HiddenKindleReadingPresentation
  | VisibleKindleReadingPresentation;

function roundedPercentage(value: number): number {
  return Math.round(value * 10) / 10;
}

function progressPlacement(layout: KindleReadingPresentationLayout): KindleReadingProgressDescriptor["placement"] {
  return layout === "grid" ? "under-cover" : "inline-reading-cell";
}

function freshnessPrefix(evidence: KindleReadingEvidence | undefined): string {
  return evidence?.freshness === "last-seen" ? "Last seen: " : "";
}

/**
 * Pure render data for the future grid/list UI. Unknown uses no progressbar
 * semantics or numeric fill, so it cannot be confused with a known 0% value.
 */
export function describeKindleReadingPresentation(input: {
  readonly gate?: unknown;
  readonly layout: KindleReadingPresentationLayout;
  readonly evidence?: unknown;
}): KindleReadingPresentationDescriptor {
  if (input.layout !== "grid" && input.layout !== "list") {
    throw new TypeError("Unknown Kindle reading presentation layout.");
  }
  if (!isKindleReadingPresentationEnabled(input.gate)) {
    return Object.freeze({ visibility: "hidden", layout: input.layout });
  }

  const evidence = validateKindleReadingEvidence(input.evidence);
  const placement = progressPlacement(input.layout);
  const prefix = freshnessPrefix(evidence);
  const progress: KindleReadingProgressDescriptor = evidence?.progressPercent === undefined
    ? Object.freeze({
      kind: "unknown" as const,
      role: "status" as const,
      text: "Unknown" as const,
      accessibleLabel: `${prefix}reading progress unknown`,
      placement,
    })
    : (() => {
      const valueNow = roundedPercentage(evidence.progressPercent);
      const text = `${valueNow}%`;
      return Object.freeze({
        kind: "known" as const,
        role: "progressbar" as const,
        valueMin: 0 as const,
        valueMax: 100 as const,
        valueNow,
        text,
        accessibleLabel: `${prefix}${text} read`,
        placement,
      });
    })();

  let stateIndicator: KindleReadingStateIndicatorDescriptor | undefined;
  if (evidence?.explicitState === true && (evidence.status === "read" || evidence.status === "unread")) {
    const read = evidence.status === "read";
    const text = read ? "Read" as const : "Unread" as const;
    stateIndicator = Object.freeze({
      state: evidence.status,
      shape: read ? "closed-book" as const : "open-book" as const,
      text,
      accessibleLabel: `${prefix}reading state: ${text}`,
      placement: input.layout === "grid" ? "below-cover-progress" as const : "reading-state-cell" as const,
    });
  }

  return Object.freeze({
    visibility: "visible" as const,
    layout: input.layout,
    progress,
    ...(stateIndicator === undefined ? {} : { stateIndicator }),
  });
}
