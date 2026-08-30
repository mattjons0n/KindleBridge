import type {
  KindleInventoryObject,
  KindleInventoryStatus,
} from "./inventory";
import {
  extractManagedFilenameToken,
  normalizeManagedFilenameToken,
} from "./filenames";
import {
  normalizeKindleMetadataIdentifier,
  normalizeKindleMetadataWords,
} from "../../../shared/kindle-metadata-normalization.js";

export interface KindleDeliveryMatchEvidence {
  readonly persistentObjectId?: string;
  readonly managedToken?: string;
  readonly destinationFilename?: string;
  readonly artifactSize?: number;
}

export interface KindleCatalogMatchInput {
  readonly title?: string;
  readonly authors?: readonly string[];
  readonly identifiers?: readonly string[];
  readonly expectedArtifactSize?: number;
  readonly sourceFilename?: string;
  readonly managedToken?: string;
  readonly deliveries?: readonly KindleDeliveryMatchEvidence[];
}

export interface KindleObjectMatchInput {
  readonly handle: number;
  readonly filename: string;
  readonly size: number;
  readonly persistentObjectId?: string;
  readonly managedToken?: string;
  readonly title?: string;
  readonly authors?: readonly string[];
  readonly identifiers?: readonly string[];
  /** Sanitized/truncated filenames cannot carry confirming token evidence. */
  readonly metadataAdjusted?: boolean;
}

export type KindleMatchStatus = "confirmed" | "possible" | "absent";
export type KindleMatchMetadataStatus = "disabled" | "complete" | "partial";

export type KindleMatchEvidence =
  | "delivery-persistent-id"
  | "delivery-managed-token-size"
  | "managed-token-size"
  | "identifier-title-author"
  | "title-author-size"
  | "managed-token"
  | "identifier"
  | "title-author"
  | "filename-similarity"
  | "inventory-partial"
  | "none";

export interface KindleBookMatchResult {
  readonly status: KindleMatchStatus;
  readonly evidence: KindleMatchEvidence;
  readonly candidates: readonly KindleObjectMatchInput[];
  readonly matchedObject?: KindleObjectMatchInput;
  /** True when duplicate or incomplete evidence prevents a green confirmation. */
  readonly ambiguous: boolean;
}

/** Carries bounded inventory metadata into the pure matcher without adding authority. */
export function kindleInventoryObjectToMatchInput(
  object: KindleInventoryObject,
): KindleObjectMatchInput {
  return {
    handle: object.handle,
    filename: object.filename,
    size: object.size,
    managedToken: object.managedToken,
    metadataAdjusted: object.metadataAdjusted,
    title: object.title,
    authors: object.authors,
    identifiers: object.identifiers,
  };
}

function normalizedToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    return normalizeManagedFilenameToken(token);
  } catch {
    return undefined;
  }
}

function objectToken(object: KindleObjectMatchInput): string | undefined {
  if (object.metadataAdjusted) return undefined;
  return normalizedToken(object.managedToken) ?? extractManagedFilenameToken(object.filename);
}

/**
 * Returns whether an eligible Kindle object carries enough independent,
 * normalized evidence to keep it from hiding an arbitrary catalog book.
 * This is deliberately weaker than positive-match confirmation: a trustworthy
 * identifier or title-plus-author makes the object distinguishable, while only
 * the strong tiers below can produce a green confirmation.
 */
export function hasSufficientKindleObjectDistinguishability(
  object: KindleObjectMatchInput,
): boolean {
  if (objectToken(object) !== undefined) return true;
  if ((object.identifiers ?? []).some((value) => normalizeKindleMetadataIdentifier(value).length >= 4)) {
    return true;
  }
  return normalizeKindleMetadataWords(object.title).length > 0
    && (object.authors ?? []).some((author) => normalizeKindleMetadataWords(author).length > 0);
}

function deliveryToken(delivery: KindleDeliveryMatchEvidence): string | undefined {
  return normalizedToken(delivery.managedToken)
    ?? (delivery.destinationFilename
      ? extractManagedFilenameToken(delivery.destinationFilename)
      : undefined);
}

function validSize(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function exactTitle(book: KindleCatalogMatchInput, object: KindleObjectMatchInput): boolean {
  const left = normalizeKindleMetadataWords(book.title);
  return left.length > 0 && left === normalizeKindleMetadataWords(object.title);
}

function authorOverlap(book: KindleCatalogMatchInput, object: KindleObjectMatchInput): boolean {
  const expected = new Set((book.authors ?? []).map(normalizeKindleMetadataWords).filter(Boolean));
  if (expected.size === 0) return false;
  return (object.authors ?? []).map(normalizeKindleMetadataWords).some((author) => expected.has(author));
}

function identifierOverlap(book: KindleCatalogMatchInput, object: KindleObjectMatchInput): boolean {
  const expected = new Set(
    (book.identifiers ?? [])
      .map(normalizeKindleMetadataIdentifier)
      .filter((identifier) => identifier.length >= 4),
  );
  if (expected.size === 0) return false;
  return (object.identifiers ?? [])
    .map(normalizeKindleMetadataIdentifier)
    .some((identifier) => expected.has(identifier));
}

function objectsWithoutConflictingManagedToken(
  book: KindleCatalogMatchInput,
  objects: readonly KindleObjectMatchInput[],
): readonly KindleObjectMatchInput[] {
  const expected = normalizedToken(book.managedToken);
  if (!expected) return objects;
  return objects.filter((object) => {
    const candidate = objectToken(object);
    return candidate === undefined || candidate === expected;
  });
}

function filenameStem(filename: string): string {
  const leaf = filename.replace(/\\/gu, "/").split("/").at(-1) ?? "";
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

function filenameLooksLikeBook(book: KindleCatalogMatchInput, object: KindleObjectMatchInput): boolean {
  const title = normalizeKindleMetadataWords(book.title);
  const source = normalizeKindleMetadataWords(filenameStem(book.sourceFilename ?? ""));
  let candidate = filenameStem(object.filename)
    .replace(/(?:^|[^a-z0-9])kb-[0-9a-f]{20}(?=$|[^a-z0-9])/giu, " ")
    .replace(/\d{8}t\d{6}z-[0-9a-f]{6}/giu, " ");
  candidate = normalizeKindleMetadataWords(candidate);
  const expected = [title, source].filter((value) => value.length >= 5);
  return expected.some((value) => candidate === value
    || (candidate.length >= 5 && (candidate.includes(value) || value.includes(candidate))));
}

function uniqueObjects(objects: readonly KindleObjectMatchInput[]): KindleObjectMatchInput[] {
  const byHandle = new Map<number, KindleObjectMatchInput>();
  for (const object of objects) {
    if (!byHandle.has(object.handle)) byHandle.set(object.handle, object);
  }
  return [...byHandle.values()];
}

function candidatesForStrongTier(
  book: KindleCatalogMatchInput,
  objects: readonly KindleObjectMatchInput[],
  evidence: Exclude<
    KindleMatchEvidence,
    "identifier" | "title-author" | "filename-similarity" | "inventory-partial" | "none"
  >,
): KindleObjectMatchInput[] {
  switch (evidence) {
    case "delivery-persistent-id": {
      const ids = new Set(
        (book.deliveries ?? [])
          .map(({ persistentObjectId }) => persistentObjectId?.trim())
          .filter((value): value is string => Boolean(value)),
      );
      return objects.filter(({ persistentObjectId }) => Boolean(persistentObjectId && ids.has(persistentObjectId)));
    }
    case "delivery-managed-token-size": {
      return objects.filter((object) => {
        const token = objectToken(object);
        if (!token) return false;
        return (book.deliveries ?? []).some((delivery) => {
          const expectedToken = deliveryToken(delivery);
          return expectedToken === token
            && validSize(delivery.artifactSize)
            && object.size === delivery.artifactSize;
        });
      });
    }
    case "managed-token-size": {
      const expectedToken = normalizedToken(book.managedToken);
      if (!expectedToken || !validSize(book.expectedArtifactSize)) return [];
      return objects.filter((object) => objectToken(object) === expectedToken
        && object.size === book.expectedArtifactSize);
    }
    case "managed-token": {
      const expectedToken = normalizedToken(book.managedToken);
      return expectedToken
        ? objects.filter((object) => objectToken(object) === expectedToken)
        : [];
    }
    case "identifier-title-author":
      return objectsWithoutConflictingManagedToken(book, objects).filter((object) => identifierOverlap(book, object)
        && exactTitle(book, object)
        && authorOverlap(book, object));
    case "title-author-size":
      return validSize(book.expectedArtifactSize)
        ? objectsWithoutConflictingManagedToken(book, objects).filter((object) => exactTitle(book, object)
          && authorOverlap(book, object)
          && object.size === book.expectedArtifactSize)
        : [];
  }
}

/**
 * Pure evidence matcher. Only one candidate at the strongest present tier in a
 * complete inventory can be confirmed. Duplicate evidence and partial scans
 * are deliberately downgraded to possible.
 */
export function matchCatalogBookToKindle(
  book: KindleCatalogMatchInput,
  objectsInput: readonly KindleObjectMatchInput[],
  inventoryStatus: KindleInventoryStatus,
  metadataStatus: KindleMatchMetadataStatus = "complete",
): KindleBookMatchResult {
  const objects = uniqueObjects(objectsInput);
  const strongTiers = [
    "delivery-persistent-id",
    "delivery-managed-token-size",
    "managed-token-size",
    "managed-token",
    "identifier-title-author",
    "title-author-size",
  ] as const;

  for (const evidence of strongTiers) {
    const candidates = candidatesForStrongTier(book, objects, evidence);
    if (candidates.length === 0) continue;
    const metadataDerived = evidence === "identifier-title-author" || evidence === "title-author-size";
    if (
      candidates.length === 1
      && inventoryStatus === "complete"
      && (!metadataDerived || metadataStatus === "complete")
    ) {
      return Object.freeze({
        status: "confirmed",
        evidence,
        candidates: Object.freeze(candidates),
        matchedObject: candidates[0],
        ambiguous: false,
      });
    }
    return Object.freeze({
      status: "possible",
      evidence,
      candidates: Object.freeze(candidates),
      ambiguous: true,
    });
  }

  // A valid, unadjusted token from another book/content version is negative
  // authority for generic metadata and filename tiers. Invalid or sanitized
  // token text remains non-authoritative and is not excluded.
  const genericObjects = objectsWithoutConflictingManagedToken(book, objects);
  const titleAuthor = genericObjects.filter((object) => exactTitle(book, object) && authorOverlap(book, object));
  if (titleAuthor.length > 0) {
    return Object.freeze({
      status: "possible",
      evidence: "title-author",
      candidates: Object.freeze(titleAuthor),
      ambiguous: titleAuthor.length !== 1 || inventoryStatus === "partial",
    });
  }

  // A normalized ISBN/ASIN/source identifier can independently distinguish an
  // object for absence accounting, but without corroborating title and author
  // it must remain yellow rather than becoming a green confirmation.
  const identifierCandidates = genericObjects.filter((object) => identifierOverlap(book, object));
  if (identifierCandidates.length > 0) {
    return Object.freeze({
      status: "possible",
      evidence: "identifier",
      candidates: Object.freeze(identifierCandidates),
      ambiguous: true,
    });
  }

  const filenameCandidates = genericObjects.filter((object) => filenameLooksLikeBook(book, object));
  if (filenameCandidates.length > 0) {
    return Object.freeze({
      status: "possible",
      evidence: "filename-similarity",
      candidates: Object.freeze(filenameCandidates),
      ambiguous: filenameCandidates.length !== 1 || inventoryStatus === "partial",
    });
  }

  if (inventoryStatus === "partial") {
    return Object.freeze({
      status: "possible",
      evidence: "inventory-partial",
      candidates: Object.freeze([]),
      ambiguous: true,
    });
  }
  return Object.freeze({
    status: "absent",
    evidence: "none",
    candidates: Object.freeze([]),
    ambiguous: false,
  });
}
