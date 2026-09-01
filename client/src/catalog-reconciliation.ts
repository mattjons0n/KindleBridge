import type {
  CatalogKindleInventory,
  CatalogKindleInventoryItem,
} from "./catalog-browser";
import type {
  CatalogKindleStatus,
  CatalogKindleStatusCounts,
  CatalogMatchIndex,
  CatalogMatchIndexEntry,
} from "./catalog-client";
import {
  createManagedFilenameToken,
  hasSufficientKindleObjectDistinguishability,
  isKindleReadableBookFilename,
  kindleInventoryObjectToMatchInput,
  matchCatalogBookToKindle,
  type KindleInventorySnapshot,
  type KindleObjectMatchInput,
} from "./kindle";
import { uniqueKindleArtifactSize } from "../../shared/kindle-metadata-normalization.js";

export interface CatalogReconciliationResult {
  readonly statuses: ReadonlyMap<string, CatalogKindleStatus>;
  readonly statusCountsByProfile: ReadonlyMap<string, CatalogKindleStatusCounts>;
  readonly inventory: CatalogKindleInventory;
}

export interface ReconcileCatalogOptions {
  readonly deviceLabel: string;
  readonly scannedAt?: Date;
  /** Opaque installation-HMAC device identity. It is never rendered or logged. */
  readonly deviceKey?: string;
  /**
   * Retained for compatibility with older callers. Matching is scoped to the
   * selected profile, just as Calibre matches against its active library.
   */
  readonly metadataClaimScopeComplete?: boolean;
}

interface ObjectAssociation {
  readonly bookId: string;
  readonly status: "confirmed" | "possible";
}

function managedTokenFromIndex(entry: CatalogMatchIndexEntry): string | undefined {
  const candidate = Reflect.get(entry, "managedToken");
  return typeof candidate === "string" ? candidate : undefined;
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

  for (const index of indexes) {
    for (const entry of index.entries) {
      const managedToken = managedTokenFromIndex(entry)
        ?? await createManagedFilenameToken(entry.bookId, entry.contentHash);
      const deliveries = entry.deliveries
        // Only a completed delivery may contribute delivery-record authority.
        // A queued/sending/failed row can exist before verified upload and must
        // never turn an unrelated on-device object into a green confirmation.
        .filter((delivery) => delivery.status === "delivered")
        .filter((delivery) => delivery.managedToken === managedToken)
        .filter((delivery) => !options.deviceKey || delivery.deviceKey === options.deviceKey)
        .map((delivery) => ({
          persistentObjectId: delivery.objectIdentity,
          managedToken: delivery.managedToken,
          destinationFilename: delivery.filename,
          artifactSize: delivery.artifactSize,
        }));
      const match = matchCatalogBookToKindle({
        title: entry.title,
        authors: entry.authors,
        authorSort: entry.authorSort,
        identifiers: entry.identifiers,
        expectedArtifactSize: expectedArtifactSize(entry, deliveries),
        sourceFilename: entry.sourceFilename,
        managedToken,
        deliveries,
      }, objects, snapshot.status, snapshot.bookMetadata?.status ?? "disabled");
      const effectiveMatchStatus = match.status;
      const status: CatalogKindleStatus = effectiveMatchStatus === "absent"
        ? metadataCanProveAbsence ? "not-on-kindle" : "unknown"
        : effectiveMatchStatus;
      statuses.set(entry.bookId, status);
      if (effectiveMatchStatus === "absent") continue;
      if (effectiveMatchStatus === "possible" && match.candidates.length > 0) {
        possibleClaims.set(entry.bookId, new Set(match.candidates.map((candidate) => candidate.handle)));
      }
      for (const candidate of match.candidates) {
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
    const selectedBookId = orderedClaims[0];
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
      ...(association === undefined ? {} : { bookId: association.bookId }),
      match: association?.status ?? "unmatched",
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
  };
}

export function asLastSeenInventory(
  inventory: CatalogKindleInventory | undefined,
): CatalogKindleInventory | undefined {
  return inventory ? { ...inventory, completeness: "last-seen" } : undefined;
}
