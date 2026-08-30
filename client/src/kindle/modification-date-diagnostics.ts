const CANONICAL_MTP_PATTERN = /^\d{8}T\d{6}(?:\.\d{1,9})?(?:Z|[+-]\d{4})?$/u;
const BASIC_COLON_OFFSET_PATTERN = /^\d{8}T\d{6}(?:\.\d{1,9})?[+-]\d{2}:\d{2}$/u;
const EXTENDED_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?$/u;
const EXTENDED_ISO_SPACE_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?$/u;
const MAX_SAMPLED_OBJECTS = 2_000;
const MAX_DEVICE_SNAPSHOTS = 8;

export type KindleModificationDateShape =
  | "canonical-mtp"
  | "basic-colon-offset"
  | "extended-iso"
  | "extended-iso-space"
  | "lowercase-marker"
  | "surrounding-whitespace"
  | "trailing-null"
  | "digits-only"
  | "control-or-non-ascii"
  | "overlong"
  | "other";

export interface KindleModificationDateShapeCounts {
  readonly canonicalMtp: number;
  readonly basicColonOffset: number;
  readonly extendedIso: number;
  readonly extendedIsoSpace: number;
  readonly lowercaseMarker: number;
  readonly surroundingWhitespace: number;
  readonly trailingNull: number;
  readonly digitsOnly: number;
  readonly controlOrNonAscii: number;
  readonly overlong: number;
  readonly other: number;
}

export interface KindleModificationDateFeatureCounts {
  readonly hyphen: number;
  readonly colon: number;
  readonly period: number;
  readonly plus: number;
  readonly whitespace: number;
  readonly lowercaseMarker: number;
  readonly controlOrNonAscii: number;
  readonly trailingNull: number;
}

export interface KindleModificationDateProbeSummary {
  readonly candidateObjectCount: number;
  readonly sampledObjectCount: number;
  readonly nonemptyValueObjectCount: number;
  readonly truncated: boolean;
  readonly distinctValueCount: number;
  readonly mostCommonValueObjectCount: number;
  readonly minimumCodeUnitLength: number;
  readonly maximumCodeUnitLength: number;
  readonly shapes: KindleModificationDateShapeCounts;
  readonly features: KindleModificationDateFeatureCounts;
  readonly reconnect: {
    readonly outcome: "no-previous-snapshot" | "compared";
    readonly comparableObjectCount: number;
    readonly unchangedValueObjectCount: number;
    readonly changedValueObjectCount: number;
    readonly currentOnlyObjectCount: number;
    readonly previousOnlyObjectCount: number;
  };
  readonly selfTest?: {
    readonly returnedShape: KindleModificationDateShape;
    readonly returnedCodeUnitLength: number;
    readonly exactRequestedValueMatch: boolean;
    readonly requestedValue: string;
    readonly returnedValue: string;
    readonly returnedUtf16LeBase64: string;
  };
  /** Exact development evidence, emitted to the browser debug log in bounded chunks. */
  readonly exactValues: readonly {
    readonly value: string;
    readonly utf16LeBase64: string;
    readonly objectCount: number;
  }[];
}

export interface KindleModificationDateProbeCandidate {
  readonly relativePath: string;
  readonly objectFormat: number;
  readonly size: number;
  readonly metadataAdjusted: boolean;
  readonly uniquePath: boolean;
  readonly rawModificationDate: string;
}

interface KindleModificationDateProbeObservation {
  readonly deviceKey: string;
  readonly storageId: number;
  readonly candidates: readonly KindleModificationDateProbeCandidate[];
}

interface KindleModificationDateSelfTestObservation {
  readonly deviceKey: string;
  readonly storageId: number;
  readonly requestedModificationDate: Date;
  readonly returnedModificationDate: string;
}

export interface KindleModificationDateProbe {
  recordSelfTest(observation: KindleModificationDateSelfTestObservation): void;
  observe(observation: KindleModificationDateProbeObservation): KindleModificationDateProbeSummary;
}

interface ProbeState {
  snapshot?: ReadonlyMap<string, string>;
  selfTest?: NonNullable<KindleModificationDateProbeSummary["selfTest"]>;
}

function zeroShapeCounts(): Record<keyof KindleModificationDateShapeCounts, number> {
  return {
    canonicalMtp: 0,
    basicColonOffset: 0,
    extendedIso: 0,
    extendedIsoSpace: 0,
    lowercaseMarker: 0,
    surroundingWhitespace: 0,
    trailingNull: 0,
    digitsOnly: 0,
    controlOrNonAscii: 0,
    overlong: 0,
    other: 0,
  };
}

function zeroFeatureCounts(): Record<keyof KindleModificationDateFeatureCounts, number> {
  return {
    hyphen: 0,
    colon: 0,
    period: 0,
    plus: 0,
    whitespace: 0,
    lowercaseMarker: 0,
    controlOrNonAscii: 0,
    trailingNull: 0,
  };
}

export function isCanonicalMtpModificationDate(value: string): boolean {
  return CANONICAL_MTP_PATTERN.test(value);
}

export function classifyKindleModificationDate(value: string): KindleModificationDateShape {
  if (CANONICAL_MTP_PATTERN.test(value)) return "canonical-mtp";
  if (BASIC_COLON_OFFSET_PATTERN.test(value)) return "basic-colon-offset";
  if (EXTENDED_ISO_PATTERN.test(value)) return "extended-iso";
  if (EXTENDED_ISO_SPACE_PATTERN.test(value)) return "extended-iso-space";

  const trimmed = value.trim();
  if (trimmed !== value && CANONICAL_MTP_PATTERN.test(trimmed)) {
    return "surrounding-whitespace";
  }
  const withoutTrailingNull = value.replace(/\u0000+$/u, "");
  if (withoutTrailingNull !== value && CANONICAL_MTP_PATTERN.test(withoutTrailingNull)) {
    return "trailing-null";
  }
  if (
    /[tz]/u.test(value)
    && CANONICAL_MTP_PATTERN.test(value.replace("t", "T").replace("z", "Z"))
  ) {
    return "lowercase-marker";
  }
  if (/^\d+$/u.test(value)) return "digits-only";
  if (/[^\u0020-\u007e]/u.test(value)) return "control-or-non-ascii";
  if (value.length > 96) return "overlong";
  return "other";
}

function shapeCountKey(
  shape: KindleModificationDateShape,
): keyof KindleModificationDateShapeCounts {
  switch (shape) {
    case "canonical-mtp": return "canonicalMtp";
    case "basic-colon-offset": return "basicColonOffset";
    case "extended-iso": return "extendedIso";
    case "extended-iso-space": return "extendedIsoSpace";
    case "lowercase-marker": return "lowercaseMarker";
    case "surrounding-whitespace": return "surroundingWhitespace";
    case "trailing-null": return "trailingNull";
    case "digits-only": return "digitsOnly";
    case "control-or-non-ascii": return "controlOrNonAscii";
    case "overlong": return "overlong";
    case "other": return "other";
  }
}

function requestedMtpTimestamp(value: Date): string {
  const iso = value.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

function utf16LeBase64(value: string): string {
  let binary = "";
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    binary += String.fromCharCode(codeUnit & 0xff, codeUnit >>> 8);
  }
  return btoa(binary);
}

function observationKey(deviceKey: string, storageId: number): string {
  return `${deviceKey}\u0000${storageId.toString(10)}`;
}

function candidateKey(candidate: KindleModificationDateProbeCandidate): string {
  return `${candidate.relativePath.length.toString(10)}:${candidate.relativePath}${candidate.objectFormat.toString(10)}:${candidate.size.toString(10)}`;
}

export function createKindleModificationDateProbe(): KindleModificationDateProbe {
  const states = new Map<string, ProbeState>();

  const stateFor = (key: string): ProbeState => {
    const existing = states.get(key);
    if (existing !== undefined) return existing;
    if (states.size >= MAX_DEVICE_SNAPSHOTS) {
      const oldest = states.keys().next().value as string | undefined;
      if (oldest !== undefined) states.delete(oldest);
    }
    const created: ProbeState = {};
    states.set(key, created);
    return created;
  };

  return Object.freeze({
    recordSelfTest(observation: KindleModificationDateSelfTestObservation): void {
      const state = stateFor(observationKey(observation.deviceKey, observation.storageId));
      const requestedValue = requestedMtpTimestamp(observation.requestedModificationDate);
      state.selfTest = Object.freeze({
        returnedShape: classifyKindleModificationDate(observation.returnedModificationDate),
        returnedCodeUnitLength: observation.returnedModificationDate.length,
        exactRequestedValueMatch: observation.returnedModificationDate === requestedValue,
        requestedValue,
        returnedValue: observation.returnedModificationDate,
        returnedUtf16LeBase64: utf16LeBase64(observation.returnedModificationDate),
      });
    },

    observe(observation: KindleModificationDateProbeObservation): KindleModificationDateProbeSummary {
      const state = stateFor(observationKey(observation.deviceKey, observation.storageId));
      const sampled = observation.candidates.slice(0, MAX_SAMPLED_OBJECTS);
      const shapes = zeroShapeCounts();
      const features = zeroFeatureCounts();
      const valueCounts = new Map<string, number>();
      const currentSnapshot = new Map<string, string>();
      let nonemptyValueObjectCount = 0;
      let minimumCodeUnitLength = Number.POSITIVE_INFINITY;
      let maximumCodeUnitLength = 0;

      for (const candidate of sampled) {
        const value = candidate.rawModificationDate;
        if (value.length === 0) continue;
        nonemptyValueObjectCount += 1;
        minimumCodeUnitLength = Math.min(minimumCodeUnitLength, value.length);
        maximumCodeUnitLength = Math.max(maximumCodeUnitLength, value.length);
        const shape = classifyKindleModificationDate(value);
        shapes[shapeCountKey(shape)] += 1;
        if (value.includes("-")) features.hyphen += 1;
        if (value.includes(":")) features.colon += 1;
        if (value.includes(".")) features.period += 1;
        if (value.includes("+")) features.plus += 1;
        if (/\s/u.test(value)) features.whitespace += 1;
        if (/[tz]/u.test(value)) features.lowercaseMarker += 1;
        if (/[^\u0020-\u007e]/u.test(value)) features.controlOrNonAscii += 1;
        if (/\u0000$/u.test(value)) features.trailingNull += 1;
        valueCounts.set(value, (valueCounts.get(value) ?? 0) + 1);
        if (!candidate.metadataAdjusted && candidate.uniquePath) {
          currentSnapshot.set(candidateKey(candidate), value);
        }
      }

      let mostCommonValueObjectCount = 0;
      for (const count of valueCounts.values()) {
        mostCommonValueObjectCount = Math.max(mostCommonValueObjectCount, count);
      }

      const previous = state.snapshot;
      let comparableObjectCount = 0;
      let unchangedValueObjectCount = 0;
      let changedValueObjectCount = 0;
      let currentOnlyObjectCount = 0;
      let previousOnlyObjectCount = 0;
      if (previous !== undefined) {
        for (const [key, value] of currentSnapshot) {
          const previousValue = previous.get(key);
          if (previousValue === undefined) {
            currentOnlyObjectCount += 1;
            continue;
          }
          comparableObjectCount += 1;
          if (previousValue === value) unchangedValueObjectCount += 1;
          else changedValueObjectCount += 1;
        }
        for (const key of previous.keys()) {
          if (!currentSnapshot.has(key)) previousOnlyObjectCount += 1;
        }
      }
      state.snapshot = currentSnapshot;
      const exactValues = Object.freeze([...valueCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([value, objectCount]) => Object.freeze({
          value,
          utf16LeBase64: utf16LeBase64(value),
          objectCount,
        })));

      return Object.freeze({
        candidateObjectCount: observation.candidates.length,
        sampledObjectCount: sampled.length,
        nonemptyValueObjectCount,
        truncated: observation.candidates.length > sampled.length,
        distinctValueCount: valueCounts.size,
        mostCommonValueObjectCount,
        minimumCodeUnitLength:
          minimumCodeUnitLength === Number.POSITIVE_INFINITY ? 0 : minimumCodeUnitLength,
        maximumCodeUnitLength,
        shapes: Object.freeze(shapes),
        features: Object.freeze(features),
        reconnect: Object.freeze({
          outcome: previous === undefined ? "no-previous-snapshot" : "compared",
          comparableObjectCount,
          unchangedValueObjectCount,
          changedValueObjectCount,
          currentOnlyObjectCount,
          previousOnlyObjectCount,
        }),
        ...(state.selfTest === undefined ? {} : { selfTest: state.selfTest }),
        exactValues,
      });
    },
  });
}
