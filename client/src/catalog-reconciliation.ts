import type {
  CatalogKindleInventory,
  CatalogKindleInventoryItem,
  CatalogMatchEvidenceBreakdown,
  CatalogPossibleMatchReview,
} from "./catalog-browser";
import type {
  CatalogKindleStatus,
  CatalogKindleStatusCounts,
  CatalogMatchDelivery,
  CatalogMatchIndex,
  CatalogMatchIndexEntry,
} from "./catalog-client";
import {
  createManagedFilenameToken,
  extractManagedFilenameToken,
  hasSufficientKindleObjectDistinguishability,
  isKindleReadableBookFilename,
  kindleInventoryObjectToMatchInput,
  matchCatalogBookToKindle,
  normalizeManagedFilenameToken,
  type KindleManualMatchDecisionStore,
  type KindleManualMatchEvidence,
  type KindleMatchEvidence,
  type PseudonymousKindleIdentity,
  type KindleInventorySnapshot,
  type KindleObjectMatchInput,
} from "./kindle";
import {
  normalizeKindleMetadataIdentifier,
  normalizeKindleMetadataWords,
  uniqueKindleArtifactSize,
} from "../../shared/kindle-metadata-normalization.js";

export interface CatalogReconciliationResult {
  readonly statuses: ReadonlyMap<string, CatalogKindleStatus>;
  readonly statusCountsByProfile: ReadonlyMap<string, CatalogKindleStatusCounts>;
  readonly inventory: CatalogKindleInventory;
  readonly manualMatchEvidence: ReadonlyMap<string, KindleManualMatchEvidence>;
}

export interface ReconcileCatalogOptions {
  readonly deviceLabel: string;
  readonly scannedAt?: Date;
  /** Opaque installation-HMAC device identity. It is never rendered or logged. */
  readonly deviceKey?: string;
  readonly deviceIdentity?: PseudonymousKindleIdentity;
  readonly manualMatchDecisions?: KindleManualMatchDecisionStore;
  /**
   * Retained for compatibility with older callers. Matching is scoped to the
   * selected profile, just as Calibre matches against its active library.
   */
  readonly metadataClaimScopeComplete?: boolean;
}

export function manualMatchEvidenceKey(profileId: string, bookId: string, itemId: string): string {
  return `${profileId}\u0000${bookId}\u0000${itemId}`;
}

function manualMatchReason(evidence: KindleMatchEvidence): string {
  switch (evidence) {
    case "delivery-persistent-id": return "A prior verified delivery identity matches, but the current scan is not complete enough to confirm it.";
    case "delivery-managed-token-size": return "The prior Kindle Bridge token and exact delivered size match, but the current scan is incomplete.";
    case "managed-token-size": return "The embedded Kindle Bridge token and exact expected size match, but the current scan is incomplete.";
    case "identifier-title-author": return "The identifier, normalized title, and normalized author all match, but the current scan is incomplete.";
    case "title-author-size": return "The normalized title, normalized author, and exact expected size match, but the current scan is incomplete.";
    case "managed-token": return "The embedded Kindle Bridge token matches, but an exact size or complete current scan is unavailable.";
    case "identifier": return "An ISBN or other identifier matches, but the title and author do not provide enough confirmation.";
    case "title-author": return "The title and author match, but this file has no Kindle Bridge delivery identity.";
    case "filename-similarity": return "The filename resembles this book, but the file has no confirming embedded identity.";
    case "inventory-partial": return "The Kindle scan was incomplete, so this possible match cannot be confirmed.";
    case "none": return "No exact device candidate was found, but the available scan cannot prove that the book is absent.";
  }
}

function comparisonKey(value: string | undefined): string {
  return value?.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]/gu)?.join("") ?? "";
}

function comparisonResult(expected: string, actual: string): "match" | "different" | "unavailable" {
  if (!expected || !actual) return "unavailable";
  return expected === actual ? "match" : "different";
}

function setComparison(
  expected: readonly string[] | undefined,
  actual: readonly string[] | undefined,
  normalize: (value: string) => string,
): "match" | "different" | "unavailable" {
  const expectedValues = new Set((expected ?? []).map(normalize).filter(Boolean));
  const actualValues = new Set((actual ?? []).map(normalize).filter(Boolean));
  if (expectedValues.size === 0 || actualValues.size === 0) return "unavailable";
  return [...actualValues].some((value) => expectedValues.has(value)) ? "match" : "different";
}

function filenameComparison(sourceFilename: string, title: string, deviceFilename: string): "match" | "different" | "unavailable" {
  const stem = (value: string): string => {
    const leaf = value.replace(/\\/gu, "/").split("/").at(-1) ?? value;
    const dot = leaf.lastIndexOf(".");
    return normalizeKindleMetadataWords(dot > 0 ? leaf.slice(0, dot) : leaf);
  };
  const actual = stem(deviceFilename)
    .replace(/(?:^|[^a-z0-9])kb-[0-9a-f]{20}(?=$|[^a-z0-9])/giu, " ")
    .replace(/\d{8}t\d{6}z-[0-9a-f]{6}/giu, " ")
    .trim();
  const expected = [stem(sourceFilename), normalizeKindleMetadataWords(title)].filter((value) => value.length >= 5);
  if (!actual || expected.length === 0) return "unavailable";
  return expected.some((value) => actual === value || actual.includes(value) || value.includes(actual))
    ? "match"
    : "different";
}

function strongerProofUnavailable(evidence: KindleMatchEvidence, inventoryStatus: KindleInventorySnapshot["status"]): string {
  if (inventoryStatus !== "complete") {
    return "A complete current Kindle inventory is required before any match can be authoritative.";
  }
  if (evidence === "identifier" || evidence === "title-author" || evidence === "filename-similarity") {
    return "No exact prior delivery identity or current Kindle Bridge token was available to corroborate this metadata.";
  }
  if (evidence === "inventory-partial" || evidence === "none") {
    return "The current evidence cannot identify one exact Kindle file for this catalog book.";
  }
  return "The strongest available evidence is shown, but the current result is still ambiguous.";
}

function matchEvidenceBreakdown(
  entry: CatalogMatchIndexEntry,
  candidate: KindleObjectMatchInput | undefined,
  evidence: KindleMatchEvidence,
  inventoryStatus: KindleInventorySnapshot["status"],
  candidateCount: number,
  ambiguous: boolean,
  expectedSize: number | undefined,
): CatalogMatchEvidenceBreakdown {
  const noCandidate = candidate === undefined;
  const expectedAuthors = [...entry.authors, ...(entry.authorSort ? [entry.authorSort] : [])];
  const size = expectedSize === undefined || !candidate
    ? "unavailable" as const
    : candidate.size === expectedSize ? "match" as const : "different" as const;
  return {
    tier: evidence,
    inventoryCompleteness: inventoryStatus,
    ambiguous,
    candidateCount,
    comparisons: noCandidate ? {
      title: "not-compared",
      authors: "not-compared",
      identifiers: "not-compared",
      filename: "not-compared",
      size: "not-compared",
    } : {
      title: comparisonResult(comparisonKey(entry.title), comparisonKey(candidate.title)),
      authors: setComparison(expectedAuthors, candidate.authors, normalizeKindleMetadataWords),
      identifiers: setComparison(entry.identifiers, candidate.identifiers, normalizeKindleMetadataIdentifier),
      filename: filenameComparison(entry.sourceFilename, entry.title, candidate.filename),
      size,
    },
    strongerProofUnavailable: strongerProofUnavailable(evidence, inventoryStatus),
  };
}

interface ObjectAssociation {
  readonly bookId: string;
  readonly status: "confirmed" | "possible";
  readonly stalePresentation?: boolean;
}

function managedTokenFromIndex(entry: CatalogMatchIndexEntry): string | undefined {
  const candidate = Reflect.get(entry, "managedToken");
  return typeof candidate === "string" ? candidate : undefined;
}

function normalizedManagedToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    return normalizeManagedFilenameToken(token);
  } catch {
    return undefined;
  }
}

function managedTokenFromDelivery(delivery: CatalogMatchDelivery): string | undefined {
  return normalizedManagedToken(delivery.managedToken)
    ?? extractManagedFilenameToken(delivery.filename);
}

function managedTokenFromObject(object: KindleObjectMatchInput): string | undefined {
  if (object.metadataAdjusted) return undefined;
  return normalizedManagedToken(object.managedToken)
    ?? extractManagedFilenameToken(object.filename);
}

function deviceFormat(filename: string): string | undefined {
  const leaf = filename.replace(/\\/gu, "/").split("/").at(-1) ?? filename;
  const dot = leaf.lastIndexOf(".");
  if (dot < 1 || dot === leaf.length - 1) return undefined;
  const extension = leaf.slice(dot + 1).toLocaleUpperCase("en-US");
  return /^[A-Z0-9]{1,10}$/u.test(extension) ? extension : undefined;
}

function preferAssociation(
  current: ObjectAssociation | undefined,
  candidate: ObjectAssociation,
): ObjectAssociation {
  if (!current || (current.status === "possible" && candidate.status === "confirmed")) {
    return candidate;
  }
  return current;
}

function safeIsoDate(value: Date): string {
  return Number.isNaN(value.getTime()) ? new Date(0).toISOString() : value.toISOString();
}

function expectedArtifactSize(
  entry: CatalogMatchIndexEntry,
  deliveries: readonly { readonly artifactSize?: number }[],
): number | undefined {
  return uniqueKindleArtifactSize(
    entry.sourceFormat,
    entry.sourceSize,
    deliveries.map(({ artifactSize }) => artifactSize),
  );
}

/**
 * Reconciles compact, profile-scoped catalog indexes entirely in the browser.
 * Raw Kindle identifiers and inventory never leave the browser. Strong
 * evidence in a complete inventory becomes `confirmed` within the selected
 * profile; indistinguishable catalog rows are allocated deterministically.
 */
export async function reconcileCatalogIndexes(
  indexes: readonly CatalogMatchIndex[],
  snapshot: KindleInventorySnapshot,
  options: ReconcileCatalogOptions,
): Promise<CatalogReconciliationResult> {
  const files = snapshot.objects.filter((object) => object.kind === "file");
  const objects: readonly KindleObjectMatchInput[] = files
    .filter((object) => isKindleReadableBookFilename(object.filename))
    .map(kindleInventoryObjectToMatchInput);
  // Treat the summary as a useful signal, not sole proof. This object-level
  // check also protects reconciliation of snapshots produced by older clients
  // that could label successfully parsed empty/title-only objects complete.
  const metadataCanProveAbsence = snapshot.bookMetadata?.status === "complete"
    && objects.every(hasSufficientKindleObjectDistinguishability);
  const statuses = new Map<string, CatalogKindleStatus>();
  const statusCountsByProfile = new Map<string, CatalogKindleStatusCounts>();
  const associations = new Map<number, ObjectAssociation>();
  const confirmedClaims = new Map<number, Set<string>>();
  const possibleClaims = new Map<string, Set<number>>();
  const stalePresentationClaims = new Map<number, Set<string>>();
  const candidateReviews = new Map<number, Array<{
    readonly profileId: string;
    readonly bookId: string;
    readonly reason: string;
    readonly evidence: CatalogMatchEvidenceBreakdown;
    readonly decision?: "same-book" | "not-this-book";
  }>>();
  const possibleMatchReviews = new Map<string, CatalogPossibleMatchReview>();
  const profileByBookId = new Map<string, string>();
  const preferredPresentationBooks = new Set<string>();
  const manualMatchEvidence = new Map<string, KindleManualMatchEvidence>();
  const fileByHandle = new Map(files.map((object) => [object.handle, object] as const));

  for (const index of indexes) {
    for (const entry of index.entries) {
      profileByBookId.set(entry.bookId, index.profileId);
      if (entry.preferredPresentation === true) preferredPresentationBooks.add(entry.bookId);
      const managedToken = normalizedManagedToken(managedTokenFromIndex(entry))
        ?? await createManagedFilenameToken(
          entry.bookId,
          entry.presentationVersion ?? entry.contentHash,
        );
      const scopedDeliveries = entry.deliveries
        // Only a completed delivery may contribute delivery-record authority.
        // A queued/sending/failed row can exist before verified upload and must
        // never turn an unrelated on-device object into a green confirmation.
        .filter((delivery) => delivery.status === "delivered")
        .filter((delivery) => !options.deviceKey || delivery.deviceKey === options.deviceKey);
      const deliveries = scopedDeliveries
        .filter((delivery) => managedTokenFromDelivery(delivery) === managedToken)
        .map((delivery) => ({
          persistentObjectId: delivery.objectIdentity,
          managedToken: delivery.managedToken,
          destinationFilename: delivery.filename,
          artifactSize: delivery.artifactSize,
        }));
      const staleManagedTokens = new Set((entry.staleManagedTokens ?? [])
        .map(normalizedManagedToken)
        .filter((token): token is string => token !== undefined && token !== managedToken));
      if (staleManagedTokens.size > 0) {
        for (const object of objects) {
          const token = managedTokenFromObject(object);
          if (!token || !staleManagedTokens.has(token)) continue;
          const claims = stalePresentationClaims.get(object.handle) ?? new Set<string>();
          claims.add(entry.bookId);
          stalePresentationClaims.set(object.handle, claims);
        }
      }
      const expectedSize = expectedArtifactSize(entry, deliveries);
      const match = matchCatalogBookToKindle({
        title: entry.title,
        authors: entry.authors,
        authorSort: entry.authorSort,
        identifiers: entry.identifiers,
        expectedArtifactSize: expectedSize,
        sourceFilename: entry.sourceFilename,
        managedToken,
        deliveries,
      }, objects, snapshot.status, snapshot.bookMetadata?.status ?? "disabled");
      let effectiveCandidates = match.candidates;
      let effectiveMatchStatus = match.status;
      if (match.status === "possible" && match.candidates.length > 0) {
        const reviewed: Array<{
          readonly candidate: KindleObjectMatchInput;
          readonly decision?: "same-book" | "not-this-book";
        }> = [];
        for (const candidate of match.candidates) {
          const object = fileByHandle.get(candidate.handle);
          let decision: "same-book" | "not-this-book" | undefined;
          if (snapshot.status === "complete"
            && object?.metadataAdjusted === false
            && options.deviceIdentity
            && options.manualMatchDecisions) {
            const evidence: KindleManualMatchEvidence = {
              identity: options.deviceIdentity,
              storageId: object.storageId,
              profileId: index.profileId,
              bookId: entry.bookId,
              catalogPresentationVersion: (entry.presentationVersion ?? entry.contentHash).toLocaleLowerCase("en-US"),
              relativePath: object.relativePath,
              metadataAdjusted: false,
              objectFormat: object.objectFormat,
              size: object.size,
              ...(object.modificationDate ? { modificationDate: object.modificationDate } : {}),
              ...(object.title ? { title: object.title } : {}),
              ...(object.authors ? { authors: object.authors } : {}),
              ...(object.identifiers ? { identifiers: object.identifiers } : {}),
            };
            manualMatchEvidence.set(
              manualMatchEvidenceKey(index.profileId, entry.bookId, `mtp-${object.handle.toString(16).padStart(8, "0")}`),
              evidence,
            );
            decision = (await options.manualMatchDecisions.lookup(evidence))?.decision;
          }
          const reviews = candidateReviews.get(candidate.handle) ?? [];
          reviews.push({
            profileId: index.profileId,
            bookId: entry.bookId,
            reason: manualMatchReason(match.evidence),
            evidence: matchEvidenceBreakdown(
              entry,
              candidate,
              match.evidence,
              snapshot.status,
              match.candidates.length,
              match.ambiguous,
              expectedSize,
            ),
            ...(decision ? { decision } : {}),
          });
          candidateReviews.set(candidate.handle, reviews);
          reviewed.push({ candidate, ...(decision ? { decision } : {}) });
        }
        effectiveCandidates = reviewed
          .filter(({ decision }) => decision !== "not-this-book")
          .map(({ candidate }) => candidate);
        const confirmedByUser = reviewed.filter(({ candidate, decision }) => decision === "same-book"
          && effectiveCandidates.some(({ handle }) => handle === candidate.handle));
        if (effectiveCandidates.length === 0) effectiveMatchStatus = "absent";
        else if (snapshot.status === "complete"
          && effectiveCandidates.length === 1
          && confirmedByUser.length === 1
          && confirmedByUser[0]?.candidate.handle === effectiveCandidates[0]?.handle) {
          effectiveMatchStatus = "confirmed";
        }
      }
      const status: CatalogKindleStatus = effectiveMatchStatus === "absent"
        ? metadataCanProveAbsence ? "not-on-kindle" : "unknown"
        : effectiveMatchStatus;
      statuses.set(entry.bookId, status);
      if (status === "possible") {
        possibleMatchReviews.set(`${index.profileId}\u0000${entry.bookId}`, {
          profileId: index.profileId,
          bookId: entry.bookId,
          reason: manualMatchReason(match.evidence),
          evidence: matchEvidenceBreakdown(
            entry,
            effectiveCandidates[0],
            match.evidence,
            snapshot.status,
            effectiveCandidates.length,
            match.ambiguous || effectiveCandidates.length !== 1,
            expectedSize,
          ),
        });
      }
      if (effectiveMatchStatus === "absent") continue;
      if (effectiveMatchStatus === "possible" && effectiveCandidates.length > 0) {
        possibleClaims.set(entry.bookId, new Set(effectiveCandidates.map((candidate) => candidate.handle)));
      }
      for (const candidate of effectiveCandidates) {
        if (effectiveMatchStatus === "confirmed") {
          const claims = confirmedClaims.get(candidate.handle) ?? new Set<string>();
          claims.add(entry.bookId);
          confirmedClaims.set(candidate.handle, claims);
        }
        associations.set(candidate.handle, preferAssociation(
          associations.get(candidate.handle),
          { bookId: entry.bookId, status: effectiveMatchStatus },
        ));
      }
    }
  }

  // Calibre resolves indistinguishable active-library records to one stable
  // database row. Mirror that behavior using the backend's stable book IDs,
  // while associating every same-book device copy consistently. A book that
  // loses one contested object remains confirmed if it wins another.
  const assignedConfirmedBooks = new Set<string>();
  const confirmedBookIds = new Set<string>();
  for (const [handle, claims] of confirmedClaims) {
    const orderedClaims = [...claims].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    // A saved catalog presentation preference can break a current confirmed
    // tie, but only while that exact book is one of the live claimants. The
    // signal is deliberately not carried into any removal-authority path.
    const selectedBookId = orderedClaims.find((bookId) => preferredPresentationBooks.has(bookId))
      ?? orderedClaims[0];
    if (!selectedBookId) continue;
    assignedConfirmedBooks.add(selectedBookId);
    for (const bookId of orderedClaims) confirmedBookIds.add(bookId);
    associations.set(handle, { bookId: selectedBookId, status: "confirmed" });
  }
  for (const bookId of confirmedBookIds) {
    if (assignedConfirmedBooks.has(bookId)) continue;
    statuses.set(bookId, metadataCanProveAbsence ? "not-on-kindle" : "unknown");
  }

  // A weak candidate is no longer ambiguous when every object it could mean
  // has been authoritatively allocated to another active-library record. This
  // mirrors Calibre's one-record device mapping and prevents a deterministic
  // winner from leaving unrelated catalog rows yellow forever.
  for (const [bookId, handles] of possibleClaims) {
    if (statuses.get(bookId) !== "possible" || handles.size === 0) continue;
    const allAllocatedElsewhere = [...handles].every((handle) => {
      const association = associations.get(handle);
      return association?.status === "confirmed" && association.bookId !== bookId;
    });
    if (allAllocatedElsewhere) {
      statuses.set(bookId, metadataCanProveAbsence ? "not-on-kindle" : "unknown");
    }
  }

  // A prior presentation token proves which managed object can be removed,
  // but it must not claim that the current metadata/cover presentation is on
  // the Kindle. Associate only an unambiguous live token, keep the book yellow
  // (therefore Send-blocked), and expose deletion authority separately.
  for (const [handle, claims] of stalePresentationClaims) {
    if (claims.size !== 1) continue;
    const bookId = claims.values().next().value as string | undefined;
    if (!bookId) continue;
    const current = associations.get(handle);
    if (current?.status === "confirmed") continue;
    associations.set(handle, { bookId, status: "possible", stalePresentation: true });
    if (statuses.get(bookId) !== "confirmed") {
      statuses.set(bookId, "possible");
      const profileId = profileByBookId.get(bookId);
      if (profileId) {
        possibleMatchReviews.set(`${profileId}\u0000${bookId}`, {
          profileId,
          bookId,
          reason: "This exact Kindle Bridge file is an older presentation of the book, not the current metadata and cover version.",
          evidence: {
            tier: "prior-presentation",
            inventoryCompleteness: snapshot.status,
            ambiguous: false,
            candidateCount: 1,
            comparisons: {
              title: "not-compared",
              authors: "not-compared",
              identifiers: "not-compared",
              filename: "match",
              size: "unavailable",
            },
            strongerProofUnavailable: "The embedded token proves the prior presentation only; it cannot prove that the current edited presentation is installed.",
          },
        });
      }
    }
  }

  for (const index of indexes) {
    const counts = {
      confirmed: 0,
      possible: 0,
      notOnKindle: 0,
      unknown: 0,
    };
    for (const entry of index.entries) {
      const status = statuses.get(entry.bookId) ?? "unknown";
      if (status === "not-on-kindle") counts.notOnKindle += 1;
      else counts[status] += 1;
    }
    statusCountsByProfile.set(index.profileId, counts);
  }

  const items: readonly CatalogKindleInventoryItem[] = files.map((object) => {
    const association = associations.get(object.handle);
    return {
      // Handles are used only as connection-scoped presentation keys.
      id: `mtp-${object.handle.toString(16).padStart(8, "0")}`,
      filename: object.filename,
      format: deviceFormat(object.filename),
      size: object.size,
      path: object.relativePath,
      title: object.title,
      author: object.authors?.join(", "),
      managed: object.managedToken !== undefined,
      objectFormat: object.objectFormat,
      ...(object.readingEvidence ? { readingEvidence: object.readingEvidence } : {}),
      ...(object.recordedReadingData ? { recordedReadingData: object.recordedReadingData } : {}),
      ...(object.modificationDate ? { modificationDate: object.modificationDate } : {}),
      ...(candidateReviews.has(object.handle) ? { candidates: candidateReviews.get(object.handle) } : {}),
      ...(association === undefined ? {} : { bookId: association.bookId }),
      match: association?.status ?? "unmatched",
      ...(association?.stalePresentation === true ? { stalePresentation: true } : {}),
    };
  });

  return {
    statuses,
    statusCountsByProfile,
    inventory: {
      deviceLabel: options.deviceLabel || "Connected Kindle",
      scannedAt: safeIsoDate(options.scannedAt ?? new Date()),
      completeness: snapshot.status,
      items,
      possibleMatches: [...possibleMatchReviews.values()]
        .filter(({ bookId }) => statuses.get(bookId) === "possible")
        .sort((left, right) => left.profileId.localeCompare(right.profileId) || left.bookId.localeCompare(right.bookId)),
      total: items.length,
      ...(snapshot.bookMetadata === undefined ? {} : {
        metadata: {
          status: snapshot.bookMetadata.status,
          eligible: snapshot.bookMetadata.eligibleObjectCount,
          enriched: snapshot.bookMetadata.enrichedObjectCount,
          failed: snapshot.bookMetadata.failedObjectCount,
          skipped: snapshot.bookMetadata.skippedObjectCount,
          truncated: snapshot.bookMetadata.truncated,
        },
      }),
      truncated: snapshot.issues.some((issue) => issue.code === "handle-limit"),
    },
    manualMatchEvidence,
  };
}

export function asLastSeenInventory(
  inventory: CatalogKindleInventory | undefined,
): CatalogKindleInventory | undefined {
  return inventory ? { ...inventory, completeness: "last-seen" } : undefined;
}
