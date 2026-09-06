import type { BookMetadataOverrides, EditableBookMetadata, MetadataProvider } from "./catalog-client";

export const MAX_METADATA_CANDIDATES = 12;
export const MAX_METADATA_IMPORT_FIELDS = 12;

export type MetadataCandidateField = keyof EditableBookMetadata;
type CurrentMetadataValues = Readonly<Partial<Record<MetadataCandidateField, unknown>>>;

export interface CatalogMetadataCandidate {
  readonly provider: MetadataProvider;
  readonly candidateId: string;
  readonly confidence: "high" | "medium" | "low";
  readonly metadata: Partial<EditableBookMetadata>;
  readonly coverCandidateId?: string;
}

export interface MetadataCandidateDiffRow {
  readonly field: MetadataCandidateField;
  readonly sourceValue?: EditableBookMetadata[MetadataCandidateField];
  readonly currentValue?: EditableBookMetadata[MetadataCandidateField];
  readonly candidateValue: EditableBookMetadata[MetadataCandidateField];
  readonly changed: boolean;
}

const FIELDS = Object.freeze([
  "title", "authors", "authorSort", "language", "publisher", "publishedAt", "series", "seriesIndex",
  "description", "subjects", "identifiers",
] satisfies readonly MetadataCandidateField[]);

function stable(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function metadataProviderLabel(provider: MetadataProvider): string {
  return provider === "hardcover" ? "Hardcover" : provider === "google-books" ? "Google Books" : "Open Library";
}

/** A reviewed Hardcover suggestion starts with gaps only, never existing choices. */
export function missingMetadataCandidateFields(
  current: CurrentMetadataValues,
  overrides: BookMetadataOverrides,
  candidate: CatalogMetadataCandidate,
): ReadonlySet<MetadataCandidateField> {
  const empty = (value: unknown): boolean => value == null || value === "" || (Array.isArray(value) && value.length === 0);
  const selected = new Set<MetadataCandidateField>();
  for (const field of FIELDS) {
    if (!Object.hasOwn(overrides, field) && empty(current[field]) && !empty(candidate.metadata[field])) selected.add(field);
  }
  // A volume number only makes sense within its own series. Preserve an
  // explicitly cleared name/number, and do not pair a new name with an old number.
  if (stable(current.series) !== stable(candidate.metadata.series)) {
    if (selected.has("series") && !Object.hasOwn(overrides, "seriesIndex") && empty(current.seriesIndex)
        && Object.hasOwn(candidate.metadata, "seriesIndex")) {
      selected.add("seriesIndex");
    } else {
      selected.delete("series");
      selected.delete("seriesIndex");
    }
  }
  return selected;
}

export function reviewedMetadataCandidateFields(
  current: CurrentMetadataValues,
  candidate: CatalogMetadataCandidate,
  fields: ReadonlySet<MetadataCandidateField>,
  field: MetadataCandidateField,
  selected: boolean,
): ReadonlySet<MetadataCandidateField> {
  const next = new Set(fields);
  const pair = candidate.provider === "hardcover" && (field === "series" || field === "seriesIndex")
    && stable(current.series) !== stable(candidate.metadata.series);
  for (const key of pair ? ["series", "seriesIndex"] as const : [field]) {
    if (selected && Object.hasOwn(candidate.metadata, key)) next.add(key);
    else next.delete(key);
  }
  return next;
}

function boundedCandidateValue(
  field: MetadataCandidateField,
  value: unknown,
): EditableBookMetadata[MetadataCandidateField] | undefined {
  if (field === "seriesIndex") {
    return (value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000))
      ? value as EditableBookMetadata[MetadataCandidateField]
      : undefined;
  }
  if (field === "authors" || field === "subjects" || field === "identifiers") {
    if (!Array.isArray(value) || value.length > 200 || value.some((item) => typeof item !== "string" || item.length > 500)) {
      return undefined;
    }
    return Object.freeze([...value]) as EditableBookMetadata[MetadataCandidateField];
  }
  if (typeof value !== "string") return undefined;
  const maximum = field === "description" ? 20_000 : field === "title" ? 4_096 : 500;
  return value.length <= maximum && !/\p{Cc}/u.test(value)
    ? value as EditableBookMetadata[MetadataCandidateField]
    : undefined;
}

export function buildMetadataCandidateDiff(
  source: EditableBookMetadata,
  current: EditableBookMetadata,
  candidate: CatalogMetadataCandidate,
): readonly MetadataCandidateDiffRow[] {
  const rows: MetadataCandidateDiffRow[] = [];
  for (const field of FIELDS) {
    if (!Object.hasOwn(candidate.metadata, field)) continue;
    const candidateValue = boundedCandidateValue(field, candidate.metadata[field]);
    if (candidateValue === undefined) continue;
    rows.push(Object.freeze({
      field,
      sourceValue: source[field],
      currentValue: current[field],
      candidateValue,
      changed: stable(current[field]) !== stable(candidateValue),
    }));
  }
  return Object.freeze(rows);
}

/** Nothing is selected simply because a provider returned it. */
export function selectedMetadataCandidateOverrides(
  candidate: CatalogMetadataCandidate,
  selectedFields: ReadonlySet<MetadataCandidateField>,
): BookMetadataOverrides {
  if (selectedFields.size > MAX_METADATA_IMPORT_FIELDS) {
    throw new RangeError(`A metadata import cannot select more than ${MAX_METADATA_IMPORT_FIELDS} fields`);
  }
  const output: Record<string, unknown> = {};
  for (const field of FIELDS) {
    if (!selectedFields.has(field) || !Object.hasOwn(candidate.metadata, field)) continue;
    const value = boundedCandidateValue(field, candidate.metadata[field]);
    if (value !== undefined) output[field] = value;
  }
  return Object.freeze(output) as BookMetadataOverrides;
}

export function validateCatalogMetadataCandidate(value: unknown): CatalogMetadataCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<CatalogMetadataCandidate>;
  if ((item.provider !== "google-books" && item.provider !== "open-library" && item.provider !== "hardcover")
      || typeof item.candidateId !== "string" || item.candidateId.length < 1 || item.candidateId.length > 512
      || (item.confidence !== "high" && item.confidence !== "medium" && item.confidence !== "low")
      || !item.metadata || typeof item.metadata !== "object" || Array.isArray(item.metadata)
      || (item.coverCandidateId !== undefined
        && (typeof item.coverCandidateId !== "string" || item.coverCandidateId.length > 512))) {
    return undefined;
  }
  const metadata: Record<string, unknown> = {};
  for (const field of FIELDS) {
    if (!Object.hasOwn(item.metadata, field)) continue;
    const parsed = boundedCandidateValue(field, item.metadata[field]);
    if (parsed === undefined) return undefined;
    metadata[field] = parsed;
  }
  if (Object.keys(metadata).length === 0) return undefined;
  return Object.freeze({
    provider: item.provider,
    candidateId: item.candidateId,
    confidence: item.confidence,
    metadata: Object.freeze(metadata),
    ...(item.coverCandidateId === undefined ? {} : { coverCandidateId: item.coverCandidateId }),
  });
}
