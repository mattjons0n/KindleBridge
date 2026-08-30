/** Canonical text normalization shared by browser matching and server collision checks. */
export function normalizeKindleMetadataWords(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

/** Match ISBN/ASIN/source identifiers independent of prefixes and punctuation. */
export function normalizeKindleMetadataIdentifier(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  const separator = normalized.indexOf(":");
  const identifier = separator >= 0 ? normalized.slice(separator + 1) : normalized;
  return identifier.toLocaleUpperCase("en-US").replace(/[^A-Z0-9]/gu, "");
}

/**
 * Returns the one byte length that every known sendable artifact agrees on.
 * Direct AZW3 preparation is offset preserving; converted formats only gain
 * a usable size after a retained, completed delivery records that artifact.
 */
export function uniqueKindleArtifactSize(
  sourceFormat: string,
  sourceSize: number,
  deliveredArtifactSizes: Iterable<number | null | undefined>,
): number | undefined {
  const sizes = new Set<number>();
  if (
    sourceFormat.toLocaleLowerCase("en-US") === "azw3"
    && Number.isSafeInteger(sourceSize)
    && sourceSize >= 0
  ) {
    sizes.add(sourceSize);
  }
  for (const artifactSize of deliveredArtifactSizes) {
    if (artifactSize !== null && artifactSize !== undefined
      && Number.isSafeInteger(artifactSize) && artifactSize >= 0) {
      sizes.add(artifactSize);
      if (sizes.size > 1) return undefined;
    }
  }
  return sizes.size === 1 ? sizes.values().next().value : undefined;
}
