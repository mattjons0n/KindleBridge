# Kindle Bridge

Kindle Bridge is a private, self-hosted household ebook library. A platform-agnostic Docker service watches configured read-only directories, indexes EPUB and supported AZW3 metadata and covers into SQLite, and serves a searchable web catalog. In the browser, a household member can connect a Kindle, compare its live inventory with the selected library, and send a missing book in one action.

EPUB conversion remains entirely browser-local through the vendored boko WebAssembly converter. Kindle access remains browser-local through user-initiated WebUSB/MTP. Kindle Bridge does not require Calibre, does not upload books to a cloud converter, and does not mount or manage SMB/NFS shares.

## Current state

The repository now contains the implemented household-library flow:

- a Node.js catalog service with SQLite migrations, persistent profiles and roots, health/readiness endpoints, and a rebuildable cover/search index;
- bounded metadata extraction, incremental directory watching, scheduled reconciliation, source-health reporting, and server-sent scan events;
- a real API-backed cover grid and toggleable multi-select list with profile selection, search, filters, sorting, pagination, source status, bulk actions, and Settings CRUD;
- a durable per-profile **Send later** queue, read-only book-details drawer, Comfortable/Compact density, versioned browser context, series-first browsing, smart shelves, and Favorite/Want-to-read annotations;
- an actionable **Needs attention** inbox with issue lifecycle, duplicate presentation choices, reviewed field-by-field provider metadata imports, and bounded resumable lookup jobs;
- a compact activity/device center with truthful connection phases, capacity/queue summaries, coalesced transfer/removal/update outcomes, scan health, and progressively disclosed diagnostics;
- non-destructive metadata and cover editing: sparse user overrides and replacement-cover bytes persist under `/data`, while mounted originals and the rebuildable `/cache` remain separate;
- live Kindle inventory, automatic exact-byte self-test after connection, Calibre-compatible active-library matching, and green checks reserved for strong matches;
- catalog-driven **Send to Kindle**, including authoritative source validation, browser-local EPUB conversion or AZW3 validation, PDOC preparation, collision-resistant transfer, verification, and delivery recording;
- coherent multi-book Send feedback with `Book X of Y`, combined batch/current-book progress, per-title verification, exact partial-failure retry selection, and one final catalog reconciliation;
- explicitly confirmed single/bulk **Remove from Kindle** for exact current-device matches, including removal-only prior KindleBridge presentations after an edit, with exact-handle revalidation and one post-removal inventory refresh;
- guarded one-click **Update Kindle copy** for edited EPUBs with one exact stale KindleBridge-managed presentation, using upload → verify → durable record → exact old-copy deletion rather than overwrite or delete-first replacement;
- default-off, bounded engineering foundations for a physical `GetPartialObject` capability probe, exact KFX/AZW8 metadata sidecars, and browser-only reading evidence; none alters normal inventory until its physical gate passes;
- a hardened, non-root Docker/OCI image and Compose deployment using ordinary read-only library mounts plus persistent `/data` and rebuildable `/cache` volumes.

The original transfer engine was physically validated on an MTP Kindle with USB IDs `0x1949 / 0x9981`: conversion, MTP connection, exact-byte self-test, transfer, opening, chapter navigation, and library-cover display all succeeded. The expanded integrated catalog/inventory/Send/removal journey still requires a fresh physical Kindle run and acceptance against the real household mounts and intended HTTPS LAN/VPN origin. Automated tests do not replace those checks.

See the current [`backlog build plan`](outputs/kindle-bridge-backlog-build-plan.md) and [`release-candidate omission audit`](outputs/kindle-bridge-backlog-feature-audit.md) for milestone/evidence status, and [`outputs/kindle-bridge-service-design-plan.md`](outputs/kindle-bridge-service-design-plan.md) for the architecture rationale.

## Architecture

```text
Host directories exposed to Docker as read-only mounts
  -> Docker catalog service: scanner + SQLite/FTS + durable presentation overlays + source API
  -> same-origin web interface
  -> browser-local boko conversion or AZW3 validation
  -> browser-local WebUSB/MTP
  -> Kindle
```

The host is responsible for making local, NAS-, SMB-, or NFS-backed directories available to Docker. Kindle Bridge sees only their container paths, normally below `/libraries`. It never receives storage credentials and never changes an original book. Metadata corrections and selected cover images are stored separately under `/data`; conversion and PDOC preparation apply them only to an in-browser derivative.

Profiles are organizational views over one or more roots. They are deliberately not access-control boundaries: anyone who can reach a no-login deployment can switch profiles. Keep the service on a trusted LAN/VPN or behind an appropriate private HTTPS access layer; do not publish it unauthenticated to the internet.

## Run the complete stack locally

Requirements are Node.js 24 or newer, npm, and a WebUSB-capable Chromium desktop browser for Kindle access. Calibre and Rust are not required.

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:5173/>. The development command starts Vite on port 5173 and the catalog API on port 5174, with `/api` proxied by Vite. Development data, cache, and allowed library paths are created under `.kindle-bridge-dev/`.

In **Settings**:

1. Create a household library/profile.
2. Add the full absolute path of `.kindle-bridge-dev/libraries`, or a directory beneath it; that directory is the development server's allowed root.
3. Save the root and use **Rescan** if an immediate manual scan is wanted. Watching and scheduled reconciliation continue automatically.
4. In **Online cover search**, add and test a Google Books API key only if that provider is wanted. Open Library and local upload/paste need no key.

For implementation diagnostics outside Docker (not a supported production deployment):

```sh
npm run build
npm start
```

Set the catalog environment variables described in [`server/README.md`](server/README.md). Production deployment is Docker/OCI only.

## Run with Docker Compose

The canonical deployment artifacts are the repository-root `Dockerfile` and `compose.yaml`.

```sh
docker compose up --build -d
```

By default Compose binds the app to <http://127.0.0.1:8080/>, mounts `./library` at `/libraries:ro`, stores durable state in `kindle-bridge-data`, and stores rebuildable covers in `kindle-bridge-cache`. Override the host book path without changing the application:

```sh
KINDLE_BRIDGE_LIBRARY_HOST_PATH=/path/on/the/docker/host docker compose up --build -d
```

Settings paths are container paths, such as `/libraries`, `/libraries/husband`, or `/libraries/wife`; they are not host paths or SMB URLs. Add more read-only bind mounts in Compose when the directories cannot share one mounted parent. The application will accept configured roots only beneath `CATALOG_ALLOWED_ROOTS`.

Important service controls include:

- `CATALOG_ALLOWED_HOSTS`, `CATALOG_ALLOWED_ORIGINS`, and `CATALOG_REQUIRE_ORIGIN` for the trusted web origin;
- `CATALOG_SETTINGS_MODE=read-write|read-only` to enable initial configuration or lock later mutations;
- `CATALOG_MAX_SOURCE_STREAMS` and `CATALOG_MAX_CONCURRENT_SCANS` for source-download and scan concurrency, plus `CATALOG_SOURCE_RESPONSE_TIMEOUT_MS` and `CATALOG_SCAN_TIMEOUT_MS` for their aggregate deadlines;
- `CATALOG_COVER_RESPONSE_TIMEOUT_MS`, `CATALOG_SETTINGS_VALIDATION_TIMEOUT_MS`, and `CATALOG_ROOT_POLICY_TIMEOUT_MS` so cache reads, Settings path checks, and startup allowed-root checks cannot retain capacity or resume late database work indefinitely;
- `CATALOG_METADATA_WORKERS` and `CATALOG_METADATA_TIMEOUT_MS` for the isolated metadata-parser pool;
- `CATALOG_METADATA_DIRECTORY` for durable replacement covers (normally `/data`) plus `CATALOG_COVER_PROVIDER_TIMEOUT_MS` for fixed-endpoint cover search. Google Books keys are normally managed in Settings and stored under `/data`;
- `CATALOG_QUIET_WINDOW_MS`, `CATALOG_STABILITY_WINDOW_MS`, `CATALOG_RECONCILE_MS`, and `CATALOG_DEEP_RECONCILE_MS` for watcher debounce, changed-file stability, frequent bounded-fingerprint reconciliation, and automatic full deep sweeps. Each root's successful deep completion is stored in SQLite, so restarting the container does not reset or postpone its deadline;
- `CATALOG_MAX_SCAN_ENTRIES` and `CATALOG_MAX_SCAN_DIRECTORIES` for bounded per-root traversal. A timed-out scan preserves prior catalog rows and its durable scan request, reports `scan_timeout`, and retries with bounded backoff without holding a shared scan slot or startup readiness indefinitely;
- `CATALOG_COVER_RETENTION_MS` and `CATALOG_COVER_PRUNE_MS` for safe cleanup of rebuildable, unreferenced covers;
- `CATALOG_MAX_BODY_BYTES`, `CATALOG_MAX_CONCURRENT`, and `CATALOG_RATE_PER_MINUTE` for HTTP bounds.

Remote WebUSB use requires a trustworthy HTTPS origin in a supported Chromium desktop browser. Full deployment, reverse-proxy, backup, restore, rollback, mount-loss, and rebuild procedures are in [`deploy/docker/README.md`](deploy/docker/README.md).

## Kindle workflow and safety

1. Click **Connect Kindle** to open the browser's required user-initiated device chooser.
2. On a clean connection, Kindle Bridge opens one browser-local MTP session, runs the exact-byte create/read/compare/delete self-test, inventories Documents, and compares the result with the selected library. The interface labels those three phases separately. If exact cleanup is pending, it permits only read-only recovery inventory first; acknowledgement must be followed by a new self-test, inventory, and reconciliation.
3. Confirmed matches receive a green check. For unmanaged books, Kindle Bridge follows Calibre's active-library comparison: punctuation-insensitive exact title plus Calibre-style joined author or `author_sort`, including Calibre's individual-author fallback. A fully parsed exact device row can confirm even if an unrelated file could not be parsed; incomplete metadata still prevents proving that a missing book is absent. Fuzzy evidence remains visibly possible and blocks ordinary Send.
4. Use a book's three-dot menu to open **Edit metadata & cover**. Field overrides, uploaded/dragged/pasted images, and reviewed Google Books/Open Library candidates are saved separately from the source. The catalog uses the effective presentation immediately. If one exact prior KindleBridge presentation remains on the connected device, the edited book stays yellow until the guarded **Update Kindle copy** flow succeeds.
5. **Update Kindle copy** prepares and uploads the edited EPUB derivative beside the old copy, verifies and durably records the replacement, then revalidates and removes only the exact old object. The Kindle must temporarily hold both files. Any preparation/upload failure leaves the old copy untouched, and insufficient capacity never triggers delete-first behavior. Edited AZW3 embedding remains unavailable until a bounded reconstruction path exists.
6. Use **Send later** while disconnected or click **Send to Kindle** for an eligible connected book. Immediately before each transfer, the browser revalidates the indexed source size, hash, presentation version, ETag, actual format, current device evidence, and capacity; applies EPUB overlays to a temporary copy; converts or validates the derivative; transfers without overwrite; verifies the result; and records delivery. The original remains untouched.
7. Toggle **List view** to select multiple books for queueing, bulk Send, or bulk removal. Batch Send retains `Book X of Y`, combines current-book and overall progress, lists verified titles, leaves only unsent titles selected after a failure, and performs one final catalog reconciliation. The three-dot menu on every grid/list item also offers **Remove from Kindle** when that catalog book has an exact confirmed association. A bounded exact prior KindleBridge presentation token can also authorize removal only, without claiming that the current edited presentation is on the device. Removal shows the exact Kindle filenames and sizes, requires confirmation, revalidates every live MTP object before deleting its concrete handle, and refreshes inventory once. Ordinary possible/unknown matches, Kindle-only items, protected files, folders, caches, or changed objects cannot authorize removal. Library originals are never changed.

Browser lifecycle safety is deliberately conservative. A page restored from the browser back/forward cache, or a visible return after the page was observed hidden for at least 60 seconds, invalidates the retained WebUSB/MTP session. In-flight device work is aborted, the session is closed after that work drains, inventory becomes **Last seen**, green-check evidence becomes unknown, and reconnect plus the automatic byte self-test is required before Send. This handles observable browser lifecycle and hidden/visible timing; it does not claim to detect every operating-system sleep or hardware suspend event.

Safety invariants include immutable source mounts, optimistic edit revision/source-hash checks, a 200 MiB source limit, bounded parsing, no overwrite, presentation-version-scoped collision-resistant managed filenames, a bounded metadata-only recovery journal, exact-handle cleanup, one active browser-wide device lease, and clean USB/session shutdown. DRM-protected ebooks are unsupported.

Direct AZW3 sources are supported when their KF8 text is uncompressed or PalmDOC-compressed. HUFF/CDIC-compressed AZW3 is rejected explicitly because this release does not contain a trustworthy bounded HUFF/CDIC decoder; EPUB remains the preferred source path for browser-local conversion.

Large-library behavior is bounded rather than silently discarded. Catalog facet suggestions are capped for responsiveness, while author, subject, publisher, and series filters also accept an exact typed value that is not in the suggestion list. A connected Kindle inventory retains and pages up to 10,000 readable objects at 100 rows per page. Read-only embedded-metadata enrichment is sequential and separately bounded to 2,000 eligible objects, 200 MiB per object, and 1 GiB total; hitting a bound makes the affected match evidence incomplete instead of turning uncertainty into a green check.

Reconnect inventory uses conservative Calibre-style acceleration without modifying any book. Kindle `.sdr` sidecar trees are pruned, Kindle Bridge derivatives with a valid managed token are not downloaded merely to recover weaker embedded fields, and object information already read by the current self-test collision scan is reused only after an exact live handle-set relist. After the current connection passes the exact-byte self-test and completes live hierarchy enumeration, Kindle Bridge can update two bounded, checksum-protected A/B metadata-cache files at the selected Kindle storage root. Those portable files contain clear Documents-relative paths plus parsed title/author/identifier/language fields for at most 2,000 unmanaged books; they contain no book bytes, MTP handles, device serial, browser identity, host path, or credentials. This makes the acceleration available to another laptop or browser profile that connects the same Kindle.

The Kindle-resident cache is never authoritative by itself. A hit is accepted only for a book enumerated in the current live Documents hierarchy with the exact unadjusted path, object format, size, and valid modification timestamp. Kindle Bridge accepts both standard MTP timestamps and the physically observed Kindle empty-fraction form `YYYYMMDDTHHMMSS.`, preserving the live token byte-for-byte for exact comparison rather than parsing or normalizing it. A changed, ambiguous, corrupt, missing, or removed object falls back safely to a bounded live read. Rotation retains a previously verified slot until its replacement has been written and read back exactly, and deletion authority is limited to a freshly revalidated Kindle Bridge cache slot. The cache files do not replace, rename, or delete books and do not touch Calibre's separate `metadata.calibre` file. A bounded same-origin IndexedDB cache remains a fallback, stores digest evidence rather than raw paths/serials, and can be cleared with browser site data. Neither cache is sent to the backend or cloud. A first-ever connection and genuine cache misses can therefore remain slower than later connections.

Each completed inventory adds a **Kindle metadata cache diagnostics** entry to the browser debug log. It reports bounded counts and fixed outcomes for evidence eligibility, portable-cache mismatches, Kindle/browser hits, browser operations, and A/B slot state. The development timestamp diagnostic also records the exact app-owned self-test value sent and returned, every distinct raw candidate modification-date value with its object count and an exact UTF-16LE Base64 representation, and aggregate stability against the previous connection in the same page. Distinct values are emitted in bounded chunks so the debug-log sanitizer cannot silently omit the evidence. The probe samples at most 2,000 candidate books and keeps at most eight page-local device/storage snapshots. It still excludes filenames, paths, titles, authors, identifiers, device identity, cache keys, handles, checksums, and raw errors; no probe data is sent to the backend or persisted. Disconnect and reconnect without reloading the page to obtain the comparison. Cache acceptance and transfer safety remain unchanged.

KFX and AZW8 books remain visible Kindle presence evidence, but normal inventory does not download their entire payload for metadata. A strict reader for the exact sibling `.sdr/assets/metadata.kfx` sidecar now exists behind a default-off gate, as do bounded reading-sidecar evidence contracts and a development-only `GetPartialObject` diagnostic under Advanced. Until each physical format/capability matrix passes, normal KFX/AZW8 metadata remains incomplete, reading progress stays hidden, and full-object PalmDB/MOBI reads remain authoritative. See [`outputs/kindle-device-experimental-gates.md`](outputs/kindle-device-experimental-gates.md).
The complete active-profile match index is likewise fail-closed and never truncated: its non-paginated endpoint accepts up to 20,000 available books, 40,000 delivered-history rows, and 32 MiB of JSON. Matching is deliberately scoped to the selected household library, as Calibre scopes device matching to its active library; another profile does not downgrade an otherwise exact active-library match. If duplicate active-library rows are indistinguishable, one stable row owns the device association instead of marking every duplicate green. The browser independently enforces the response-size ceiling before parsing.

Durable histories are bounded rather than append-only. Settings/direct-profile retry evidence retains 1,000 operation-scoped keys per profile; delivery history retains 40,000 delivered and 10,000 non-delivered records per profile and rejects arbitrary nested result payloads. Healthy scans retire missing rebuildable rows while NAS/mount loss retains last-known unavailable cards. Stable current or delivery-linked identities remain protected; recent unlinked delete/re-add identities use a 20,000-row/32 MiB window per root and survive explicit catalog rebuilds until the replacement scan commits.

## Verification

```sh
npm run check
```

This runs the client and server tests, TypeScript validation, and production builds. The suite covers the catalog database/API/scanner/parser, filesystem and large-catalog integration behavior, real API-backed UI/controller flows, conversion, matching, WebUSB/MTP behavior, exact selected-object removal, transfer and Kindle-resident cache safety, and deployment contracts. Final release acceptance additionally requires the physical Kindle and real household deployment checks described above, including matching, Send, removal, cache creation, reconnect reuse, A/B rotation, and cleanup of the root-level cache files.

## Third-party converter

The project vendors boko 0.5.0 browser artifacts and corresponding source under `third_party/boko`. boko is GPL-3.0-or-later. See `THIRD_PARTY_NOTICES.md` and `LICENSE` before redistributing the project.
