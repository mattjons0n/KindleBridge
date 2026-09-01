# Kindle Bridge implementation objects

These two implementation objects extend the completed household-library baseline. They share one invariant: a transfer may change only a browser-created derivative; a host-mounted source remains byte-identical.

## Object 1 — Non-destructive metadata and cover editing

### Outcome

Allow a household member to correct catalog metadata and select a preferred cover without changing an EPUB or AZW3 in a read-only/torrent source directory.

### Software acceptance

- Durable sparse overrides are stored beneath `/data`, separately from the rebuildable catalog and `/cache` cover extraction.
- The editor shows file-derived values, effective values, and which fields are overridden. Individual fields, all metadata, and a custom cover can be reset to the source values.
- Writes use the current metadata revision and source SHA-256. Concurrent edits or changed source bytes fail with a reload-required conflict.
- Effective title, author, series, subjects, identifiers, cover, search text, facets, matching data, and catalog display all come from the merged presentation.
- A custom cover can come from an uploaded, dragged, or clipboard-pasted image, or from bounded Google Books/Open Library search through the same-origin service.
- Selected images are copied into durable, content-addressed storage; third-party URLs are never retained as the only copy.
- Source downloads continue to return the original indexed bytes and source hash. Metadata/cover changes alter a separate `presentationVersion` used for current delivery identity.
- For an edited EPUB, the browser applies sparse metadata and the selected cover to an ephemeral EPUB copy, converts that copy with boko WASM, and transfers the verified PDOC derivative.
- Existing AZW3 sources remain sendable when unedited. An edited AZW3 fails before MTP because the checked-in converter has no bounded, verified reconstruction API for that path yet.
- An edit does not mutate a copy already on a Kindle. Up to 16 distinct retained prior KindleBridge presentation tokens per active book are exposed as exact removal-only evidence: the prior copy stays yellow, can be removed safely, and never proves that the edited presentation is already present.

### External acceptance still required

- Verify edited title/author/cover on the physical Kindle after indexing.
- Verify restart, backup/restore, and full catalog/cache rebuild against the real durable `/data` volume and read-only household mounts.

## Object 2 — Clear multi-book transfer feedback

### Outcome

Make a successful multi-book transfer look like one coherent batch while retaining exact verification for every individual MTP object.

### Software acceptance

- The transfer dialog persistently shows `Book X of Y` and the current title.
- One overall bar combines completed books with the current book's percentage; per-book controller updates cannot erase the batch position.
- Each completed book is listed as transferred and verified before the batch advances.
- A partial failure lists every succeeded title and the failed title, and leaves only the failed and not-yet-attempted books selected for retry.
- A successful batch displays and logs the explicit summary `N of N books transferred and verified.`
- Per-book byte transfer, returned-object verification, and inventory refresh remain intact.
- Delivery-event catalog refreshes are coalesced while a batch is active. One final catalog reconciliation runs when the batch succeeds or stops.
- The latest useful Kindle metadata-cache diagnostic is logged once for the batch instead of once per book.

### External acceptance still required

- Transfer a real multi-book batch on the physical Kindle and confirm that every displayed verified result corresponds to a present/openable device file.
