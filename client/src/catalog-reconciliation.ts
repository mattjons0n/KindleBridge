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
import { decodeMetadataClaimBitmap } from "./catalog-client";
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
   * True only when every enabled catalog claimant participated. If another
   * profile is deferred, metadata alone cannot prove that its single Kindle
   * candidate is globally unique; source-scoped managed/delivery evidence can.
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
 * Raw Kindle identifiers and inventory never leave the browser. Only a unique
 * strong match in a complete inventory can become `confirmed`.
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

  for (const index of indexes) {
    const decodedClaimCollisions = index.metadataClaims
      ? decodeMetadataClaimBitmap(index.metadataClaims.collisionBitmap)
      : undefined;
    const metadataSummaryIncomplete = index.metadataClaims?.complete !== true
      || decodedClaimCollisions === undefined;
    for (const [entryPosition, entry] of index.entries.entries()) {
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
        identifiers: entry.identifiers,
        expectedArtifactSize: expectedArtifactSize(entry, deliveries),
        sourceFilename: entry.sourceFilename,
        managedToken,
        deliveries,
      }, objects, snapshot.status, snapshot.bookMetadata?.status ?? "disabled");
      const metadataDerivedConfirmation = match.status === "confirmed"
        && (match.evidence === "identifier-title-author" || match.evidence === "title-author-size");
      const globalClaimCollision = decodedClaimCollisions !== undefined
        && ((decodedClaimCollisions[entryPosition >>> 3] ?? 0) & (1 << (entryPosition & 7))) !== 0;
      const effectiveMatchStatus = metadataDerivedConfirmation
        && (options.metadataClaimScopeComplete === false || metadataSummaryIncomplete || globalClaimCollision)
        ? "possible" as const
        : match.status;
      const status: CatalogKindleStatus = effectiveMatchStatus === "absent"
        ? metadataCanProveAbsence ? "not-on-kindle" : "unknown"
        : effectiveMatchStatus;
      statuses.set(entry.bookId, status);
      if (effectiveMatchStatus === "absent") continue;
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

  // A one-to-one result inside each book is not enough: two distinct catalog
  // books can independently claim the same unmanaged Kindle object. Neither
  // claim is unique across the whole comparison, so both must remain visibly
  // uncertain instead of receiving green checks.
  for (const [handle, claims] of confirmedClaims) {
    if (claims.size <= 1) continue;
    for (const bookId of claims) statuses.set(bookId, "possible");
    const firstBookId = claims.values().next().value as string;
    associations.set(handle, { bookId: firstBookId, status: "possible" });
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
