export const MAX_USABLE_SERIES_INDEX = 1_000_000;

/** Canonical identity shared by server routes and shelf validation. Display
 * text is always retained separately. */
export function canonicalSeriesKey(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu)?.join(" ")
    .trim() ?? "";
}

export function usableSeriesIndex(value: number | null | undefined): number | null {
  return value !== null
    && value !== undefined
    && Number.isFinite(value)
    && value > 0
    && value <= MAX_USABLE_SERIES_INDEX
    ? value
    : null;
}
