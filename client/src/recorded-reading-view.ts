import type { CatalogKindleInventory } from "./catalog-browser";

const escape = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function renderRecordedReadingData(bookId: string, inventory: CatalogKindleInventory | undefined): string {
  const candidates = inventory?.items.filter((item) => item.bookId === bookId || item.candidates?.some((candidate) => candidate.bookId === bookId)) ?? [];
  const item = candidates.length === 1 && candidates[0]?.match === "confirmed" && candidates[0].bookId === bookId
    ? candidates[0] : undefined;
  const files = item?.recordedReadingData;
  const explanation = !inventory ? "Connect a Kindle to read its available sidecar data."
    : !item ? "No data available: a single confirmed Kindle copy is needed for this book."
    : "No data available: no supported readable sidecars were found, or collection limits were reached. This does not mean the book is unread.";
  return `<section class="book-details-section kindle-recorded-data" aria-labelledby="kindle-recorded-data-title"><h3 id="kindle-recorded-data-title">Kindle reading data</h3>
    <p>Recorded activity and saved positions — not the Kindle’s current percentage or Read/Unread status.</p>
    ${files?.length ? `<p class="book-details-provenance">${inventory?.completeness === "last-seen" ? "Last seen" : "Collected"}: ${escape(inventory!.scannedAt)} · Browser session only</p>
    ${files.map((file) => `<article><h4>${escape(file.filename)}</h4>${file.error ? `<p>Could not read this file: ${escape(file.error)}</p>` : `<dl class="book-details-metadata">${file.fields.map(({ label, value }) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("") || "<div><dt>Summary</dt><dd>No recognized summary fields; see technical details.</dd></div>"}</dl>`}
    <details><summary>Technical details · ${file.size.toLocaleString()} bytes</summary><pre>${escape(file.technical ?? file.error ?? "No decoded data available")}</pre>${file.technicalTruncated ? "<p>Technical preview truncated at 16 KiB.</p>" : ""}</details></article>`).join("")}` : `<p class="book-details-provenance">${explanation}</p>`}
    </section>`;
}
