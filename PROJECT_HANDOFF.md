# ShelfSend — Project Handoff

Last updated: 2026-09-06

## Status

The platform-agnostic Docker household-library implementation now contains the complete software candidate for Milestones 0–13. Milestone 14 is the integrated release-and-evidence gate, not an additional product feature; its exact final Node 24 and container result belongs in the release-candidate audit after the candidate is frozen. Milestones 1–9 are integrated into the normal API-backed interface. The bounded partial-object probe, KFX sidecar reader, and reading-state foundation are implemented behind development/default-off gates pending their required physical evidence. The measured safe-write decision remains `always`.

The original single-book transfer path remains physically proven on an MTP Kindle with USB vendor/product IDs `0x1949 / 0x9981`. That test confirmed browser-local EPUB-to-AZW3 conversion, MTP connection, exact-byte self-test, transfer, opening the book, chapter navigation, and its cover in the Kindle library.

Before calling this candidate household-ready, repeat the consolidated queue/matching/Update/removal/reconnect journey on the physical Kindle, test the real provider flows and both household library mounts, verify the intended private HTTPS LAN/VPN origin, and measure peak browser memory at the supported source boundary. Automated mocks, localhost checks, and declared allocation limits cannot establish those facts.

[`BACKLOG.md`](BACKLOG.md) is the implementation-and-acceptance ledger; the current [`backlog build plan`](outputs/kindle-bridge-backlog-build-plan.md) and [`release-candidate omission audit`](outputs/kindle-bridge-backlog-feature-audit.md) hold the detailed requirement map and final evidence. Together they distinguish shipped software, deliberately disabled experiments, and evidence that can only be collected on the real deployment or physical Kindle.

## Implemented product

### Recorded Kindle reading data

The existing book-details drawer now includes read-only **Kindle reading data** for one confirmed device copy. Normal post-self-test inventory and post-mutation refreshes collect bounded direct KRDS sidecars via `recordedReadingData: true`. This observation-only path never produces semantic reading evidence, changes matching, or adds Read-books membership. Summaries include recorded time/words, saved positions/timestamps, timer activity fraction (explicitly not completion), available reader metadata, and bounded expandable technical details. Errors, missing data, ambiguous matches and last-seen snapshots are distinguished. No raw observations are sent to the server or persisted as durable history.

Physical capture proved the LONG container version 1, timer version 0 and BYTE last-position version 2 shapes. All 32 captured reading files decode after the parser fixes, but user comparison disproved the timer fraction as actual device percentage/completion. Automatic reading status and its UI gate remain disabled. See [the capture and parser notes](outputs/reading-diagnostic-local.md). Deployment of this drawer still needs the server operator's gate and an integrated physical connection check.

### Docker catalog service

- A vendor-neutral Node.js service owns configuration, additive SQLite schema version 18, persistent profiles/root mappings, bounded delivery/idempotency history, stable catalog identity evidence, durable sparse metadata/replacement-cover overlays, the rebuildable metadata/search index, and source-cover cache. Settings replacement and direct profile creation are operation-scoped and retry-safe; arbitrary delivery-result payloads are rejected rather than persisted.
- EPUB and supported uncompressed/PalmDOC-compressed AZW3 sources are detected structurally and parsed with bounded, isolated metadata workers. HUFF/CDIC AZW3 is rejected rather than accepted on header plausibility alone. Metadata, covers, source fingerprints, hashes, availability, and completeness are indexed.
- Directory watchers provide low-latency per-path hints. Frequent scheduled reconciliation uses persisted bounded source fingerprints before escalating changed candidates to a full immutable snapshot; a separate daily deep reconciliation full-hashes every unchanged source, and manual Rescan requests the same deep verification immediately. Successful full-root completion time is durable per root, so startup remains bounded while a first/overdue deep request is queued after startup and survives further restarts. Each active root scan also has a configurable hard deadline; a stalled host filesystem operation releases the shared scan slot, preserves catalog rows and the durable generation, surfaces `scan_timeout`, and retries with backoff. Confirmed healthy scans retire missing rebuildable catalog/FTS rows, while mount-loss paths keep last-known rows unavailable. Stable current/delivery-linked identities remain protected across rename, delete/re-add, and rebuild; unlinked history has a deterministic 20,000-row/32 MiB per-root ceiling.
- Profile-scoped APIs expose catalog queries, facets, covers, match indexes, authoritative source streams, Settings mutations, manual rescans, delivery recording, health/readiness, and server-sent events.
- Search, filters, stable sorting, and pagination are implemented over the persisted catalog. Normal mode contains no sample catalog or simulated Kindle status.
- Metadata and cover edits never write a mounted book. Source-derived values remain a reset baseline, effective values drive the UI/FTS/facets/match index, and a separate presentation SHA-256 changes managed delivery identity. Replacement covers are checksummed durable assets under `/data/metadata-covers`; extracted source covers remain rebuildable under `/cache`. Revision and current-source-hash preconditions prevent lost updates. Google Books/Open Library search uses fixed server endpoints and same-origin previews; Google credentials are revisioned server-side Settings under `/data`, and Open Library cover downloads follow only the validated ID-bound Archive.org redirect chain. Upload, drag, and clipboard paste send only bounded image bytes.
- Sources are read only. The service accepts only opaque source/book IDs at download time and rechecks the active profile and canonical path containment.

### Browser application

- The library grid and toggleable multi-select list, profile selector, search, author/series/language/subject/publisher/year/source/format/completeness/Kindle filters, sorting, pagination, counts, bulk actions, missing-cover state, and source-health states use the real API. Bounded facet suggestions do not constrain exact filtering: author, series, subject, and publisher accept typed values outside the suggestion list.
- Settings, positioned separately near the bottom of the sidebar, creates and edits persistent profiles and one or more container-visible roots. A root can be shared intentionally across profiles, and Settings can be locked with `CATALOG_SETTINGS_MODE=read-only` after setup.
- **Connect Kindle** remains a direct user gesture because WebUSB requires it. On a clean connection with no pending recovery record, the browser keeps one MTP session open, runs the exact-byte safe-write self-test automatically, inventories the Documents hierarchy, and reconciles the live device with the active profile. The interface now labels safe-write, Documents reading, and library comparison separately. When exact cleanup is pending, it first permits only the read-only inventory needed to present that recovery safely; Send remains disabled.
- An acknowledged exact-handle recovery record now continues on that retained connection by rerunning the exact-byte self-test, read-only inventory, and catalog reconciliation. Recovery inventory holds the same hardware-operation lock as ordinary device work, so acknowledgement and inventory cannot race into concurrent MTP access; any failed revalidation keeps Send disabled.
- Matching has `confirmed`, `possible`, and `absent` outcomes. Only strong evidence receives the green on-Kindle check. The browser loads only the selected profile's bounded match index and mirrors Calibre's active-library title/author comparison: punctuation-insensitive title keys, joined authors, `author_sort`, and individual-author fallback. An exact fully parsed object can confirm even when an unrelated device object was unreadable; incomplete metadata still blocks an authoritative absence result. Indistinguishable selected-profile catalog rows are allocated deterministically to one row, while fuzzy evidence remains yellow and blocks ordinary Send. Device contents are retained and paged up to the 10,000-object inventory ceiling; read-only embedded metadata enrichment is sequential and bounded to 2,000 eligible objects/1 GiB total.
- Repeat inventory prunes `.sdr` sidecar descendants, skips redundant reads of managed ShelfSend derivatives, and reuses current-session collision metadata only after an exact live handle-set relist. It also reads a bounded, checksum-protected A/B metadata cache from the selected Kindle storage root. Portable hits require a currently enumerated object with the exact unadjusted Documents-relative path, object format, size, and valid modification timestamp. Standard MTP timestamps and the physically observed Kindle `YYYYMMDDTHHMMSS.` empty-fraction form are accepted, with the raw live token preserved unchanged for exact comparison; no date parsing or normalization is used. Corrupt, conflicting, stale, or absent entries never supply evidence. A bounded same-origin IndexedDB cache keyed by pseudonymous device/storage and digest evidence remains the fallback. The root cache contains clear relative paths and parsed fields but no serials, browser identity, handles, host paths, credentials, or book bytes; neither cache reaches the backend/cloud. KFX/AZW8 remain visible but conservatively metadata-incomplete because the current PalmDB/MOBI parser cannot read their containers; downloading the entire unsupported book is avoided.
- Every completed inventory writes a browser-local cache diagnostic summary to the debug log. Aggregate evidence eligibility, portable mismatch categories, separate Kindle/browser hits, browser cache operations, and A/B load/write outcomes are included. During development, the bounded page-local modification-date probe additionally logs the exact self-test timestamp sent and returned, every distinct raw candidate timestamp with count and an exact UTF-16LE Base64 representation, plus reconnect stability. Values are emitted in bounded chunks; filenames, paths, titles/authors/identifiers, identities, handles, cache keys, checksums, and raw errors remain omitted. The probe is neither persisted nor sent to the backend, and cache matching/mutation authority is unchanged.
- **Send to Kindle** requires an exact `not-on-kindle` result for the current connection and binds that verdict to both the source content hash and presentation version from the match index. It then refetches the selected source and overlay by opaque ID, rejects source/edit races before MTP, verifies declared size/hash/ETag and actual format, applies EPUB metadata/cover edits to an ephemeral browser copy, converts it locally, prepares the derivative as PDOC, checks space, writes without overwrite, verifies the MTP result, refreshes inventory, and records the delivery idempotently. Existing AZW3 remains supported unchanged, but non-empty AZW3 overrides fail before MTP until a bounded reconstructed-container API is built and validated.
- List-mode multi-book Send keeps one persistent batch position and combines completed-book/current-book progress. Every book retains its own MTP verification and inventory refresh, while delivery-event reconciliation and metadata diagnostics are coalesced; success or the first failure triggers one final catalog reconciliation. The summary names verified, failed, and retry-selected titles, and success explicitly logs `N of N books transferred and verified.`
- Every grid/list item has a three-dot action menu. **Remove from Kindle** is available for exact confirmed associations from the complete current connection; list mode also offers bulk removal. A bounded exact prior KindleBridge presentation token is exposed as yellow removal-only authority after an edit, never as current-presentation presence. The confirmation lists every exact filename and size. Device removal revalidates complete live-inventory authority, full ObjectInfo, current parent membership, file type, protection state, and concrete handle immediately before each sequential delete, verifies absence afterward, and performs one inventory refresh for the batch. A partial failure revokes all pre-operation match authority. Ordinary possible/unknown associations, Kindle-only objects, and host library originals remain untouched.
- A profile-specific **Send later** queue persists independently of pagination and browser layout. It supports bounded visible/all-filtered selection, reorder/remove/clear, eligibility and approximate-capacity review, and one verified batch action after the user connects a Kindle. Stale entries are explained and partial failure retains only unsent work.
- A read-only book-details drawer keeps the user's place and exposes metadata provenance, source health, Kindle/delivery state, filter shortcuts, and the same centrally projected actions as grid/list menus. Versioned per-profile browser context retains layout, density, filters, sort, route overlays, scroll position, and the active shelf.
- Possible Kindle matches have an evidence review with reversible, device/profile/book-version-bound **Same book**, **Not this book**, and undo decisions. Saved choices are browser-local hints revalidated against each live inventory and never become standalone deletion authority.
- Edited EPUBs with exactly one stale ShelfSend-managed presentation can use guarded **Update Kindle copy**. The transaction is strictly upload-first: prepare, upload, verify, durably record, revalidate and delete only the exact old handle, verify absence, then reconcile. It never silently changes to delete-first when temporary capacity is insufficient; edited AZW3 remains unsupported.
- Series browsing, series/volume sorting, gap/duplicate hints, exact series queue actions, durable smart shelves, pinning/reorder, and profile-specific Favorite/Want-to-read annotations are integrated without mutating source files.
- **Needs attention** combines bounded catalog-health issues, duplicate presentation choices, retries/ignore state, field-by-field provider candidate review, and resumable bulk lookup jobs. Candidate imports remain explicit sparse overlays under `/data`; provider work never receives a book file or source path.
- The compact activity/device center projects current phases, inventory/storage/queue state, coalesced verified outcomes, scan/provider status, bounded safe history, recovery actions, and Advanced diagnostics without duplicating mutation authority.
- The downstream boko build fails closed before retaining hostile EPUB archive, spine, XHTML/DOM, IR/style, MathML, normalized-XHTML/CSS, or oversized AZW3 output. The 200 MiB AZW3 ceiling is enforced by a bounded seekable writer rather than a post-allocation length check. `THIRD_PARTY_NOTICES.md` records the exact limits, `ResourceLimit` error class, upstream base, reproducible toolchain, and final JavaScript/WASM checksums.
- Raw Kindle inventory and USB work remain in the browser. The backend never controls USB or receives raw device serials, Kindle cache contents, or book bytes for reconciliation. The portable cache persists only on the Kindle and the fallback cache persists only in browser storage; live hierarchy enumeration is still required on every connection.

### Container boundary

The repository-root `Dockerfile` and `compose.yaml` are the canonical deployment artifacts. The image runs as a non-root UID/GID with a read-only container filesystem and dropped capabilities. Only durable `/data` and rebuildable `/cache` volumes are writable. Host book directories are ordinary read-only bind mounts or Docker volumes, normally exposed below `/libraries`.

The Docker host—not ShelfSend—mounts any local disk, NAS, SMB, or NFS storage and owns its credentials. There is no Synology package, NAS-vendor integration, Calibre dependency, backend converter, or cloud book storage.

Profiles are organizational views, not authentication boundaries. A no-login deployment must remain private to the trusted household LAN/VPN or an appropriate reverse-proxy access layer. A remote WebUSB origin must use a certificate trusted by the client and must be physically tested; localhost is the development secure-context exception.

### Settled automated and container evidence

- The 2026-09-01 baseline passed 59/59 test files and 686/686 tests, but that count predates this backlog candidate and is no longer the release result. Use the final Node 24 `npm run check` recorded in [`outputs/kindle-bridge-backlog-feature-audit.md`](outputs/kindle-bridge-backlog-feature-audit.md); never reuse the historical 18-file/133-test POC count or the superseded 59/686 count as current evidence.
- A real Chromium contract probe confirms that the Kindle-device Web Lock uses the legal `{ mode: "exclusive", ifAvailable: true }` option pair even when connection cancellation is active. Cancellation is handled around acquisition instead of passing the forbidden `signal` + `ifAvailable` combination; regressions cover pre-abort, delayed grants, exact late-grant cleanup, and the pre-WebUSB boundary.
- The hardened boko source passes its Rust library and focused integration tests, and the checked-in browser artifact passes normal Epictetus conversion plus actual-WASM hostile archive, wide-DOM, spine, MathML, normalized-output, and AZW3-output regressions. The vendored WASM SHA-256 is `5cc7e4fcd9116218ad7dcaae54e0dbfdead726069c4e6f40176e63a55605c338`.
- The 2026-08-30 schema-v13 local acceptance image passed a native `linux/arm64` hardened smoke, restart persistence, cold backup, non-destructive restore, derived-catalog/cache rebuild, exact source/cover verification, read-only Settings mode, and cross-runtime `linux/amd64` execution. The restored and rebuilt catalog preserved the same profile, root, book, and delivery identities and returned the exact indexed 459,174-byte source.
- The verified local OCI archive contains `linux/amd64` and `linux/arm64` application manifests plus a per-platform SPDX SBOM and SLSA provenance attestation. The generic operator template remains unchecked in `deploy/docker/RELEASE_CHECKLIST.md` because publishing a concrete household release digest and accepting the real host, origin, and Kindle are still external gates.

## Run locally

Use Node.js 24 or newer:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173/`. This starts Vite on 5173 and the catalog service on 5174 with an `/api` proxy. Development database, cache, and allowed library storage are created under `.kindle-bridge-dev/`; configure Settings with the full absolute path of `.kindle-bridge-dev/libraries` or a directory beneath it.

Run the complete automated gate before handing off any change:

```sh
npm run check
```

This includes tests, client/server TypeScript validation, and production builds. Do not copy the original 18-file/133-test POC count forward as the current result; the expanded suite is larger and its actual count should be taken from the final command output.

## Run with Docker

```sh
docker compose up --build -d
```

The default Compose deployment binds to `127.0.0.1:8080`, maps `./library` to `/libraries:ro`, and uses named data/cache volumes. A different host source is selected with `KINDLE_BRIDGE_LIBRARY_HOST_PATH`; Settings must still use the corresponding container path, not the host path or an SMB URL.

Key service environment variables are:

- paths/state: `CATALOG_DATABASE_PATH`, `CATALOG_CACHE_DIRECTORY`, `CATALOG_ALLOWED_ROOTS`;
- origin policy: `CATALOG_ALLOWED_HOSTS`, `CATALOG_ALLOWED_ORIGINS`, `CATALOG_REQUIRE_ORIGIN`;
- Settings: `CATALOG_SETTINGS_MODE`;
- HTTP/stream bounds: `CATALOG_MAX_BODY_BYTES`, `CATALOG_MAX_CONCURRENT`, `CATALOG_MAX_SOURCE_STREAMS`, `CATALOG_SOURCE_RESPONSE_TIMEOUT_MS`, `CATALOG_COVER_RESPONSE_TIMEOUT_MS`, `CATALOG_SETTINGS_VALIDATION_TIMEOUT_MS`, `CATALOG_ROOT_POLICY_TIMEOUT_MS`, `CATALOG_RATE_PER_MINUTE`;
- scanner controls: `CATALOG_QUIET_WINDOW_MS`, `CATALOG_STABILITY_WINDOW_MS`, `CATALOG_RECONCILE_MS`, `CATALOG_DEEP_RECONCILE_MS`, `CATALOG_MAX_CONCURRENT_SCANS`, `CATALOG_SCAN_TIMEOUT_MS`, `CATALOG_MAX_SCAN_ENTRIES`, `CATALOG_MAX_SCAN_DIRECTORIES`;
- parser controls: `CATALOG_METADATA_WORKERS`, `CATALOG_METADATA_TIMEOUT_MS`.
- derived-cover retention: `CATALOG_COVER_RETENTION_MS`, `CATALOG_COVER_PRUNE_MS`.

Detailed install, HTTPS proxy, backup/restore, rollback, mount-loss, and rebuild procedures are in `deploy/docker/README.md`.

## Preserved Kindle-specific findings

The Kindle exposes a vendor-specific USB interface rather than only a class-code-6 still-image interface. Device discovery therefore derives MTP suitability from the interface name and required bulk IN/OUT endpoints as well as standard class metadata.

Modern MTP Kindles can hide the legacy `system/thumbnails` directory. An ordinary sideloaded `EBOK` AZW3 may consequently show a grey library tile even though its embedded cover is valid. `client/src/api/azw3-sideload.ts` validates PalmDB/MOBI/EXTH bounds and embedded cover records, then changes EXTH record 501 from `EBOK` to `PDOC` without shifting offsets. The physical POC confirmed that this shows the embedded cover; the tradeoff is that Kindle classifies it under Documents rather than Books.

The iOS probe under `ios/KindleProbe` also records a negative physical finding. On an iPhone 16 running iOS 26.6.1, an authorized ImageCaptureCore scan saw no Kindle device callback or listed device. This rules out that discovery path for the tested pairing; it does not establish generic raw-USB, MFi, private-API, or bridge-hardware support.

## Safety invariants

- WebUSB permission starts only from a user action.
- Existing Kindle objects are never overwritten, broadly deleted, renamed, or moved.
- Generated filenames are sanitized, collision resistant, and include a source-version-scoped managed token derived from the opaque book ID and indexed content hash. Replacing a source cannot inherit an old delivery's green-check evidence.
- A bounded metadata-only recovery journal supports exact-handle cleanup; it never authorizes broad deletion.
- Kindle-resident metadata-cache writes require the current connection's successful exact-byte self-test, a complete live hierarchy, and the recovery callback. A/B rotation keeps a verified generation while replacing the other slot; a prior-session slot can be deleted only after fresh root membership, metadata, canonical checksum, and exact-byte revalidation. Books and Calibre's `metadata.calibre` are outside that authority.
- Acknowledging an exact recovery record does not restore write readiness by itself; the retained session must pass a new self-test, inventory, and reconciliation while holding the device-operation lock.
- Descriptor-derived MTP selection and clean USB/session shutdown remain required.
- A BFCache restore or an observed hidden-to-visible gap of at least 60 seconds retires the browser-local USB/MTP session, downgrades inventory to Last seen/unknown, and requires reconnect plus a fresh self-test. This is browser lifecycle handling, not generic OS sleep detection.
- Host-mounted originals are immutable; conversion and PDOC edits affect only derivatives.
- Source downloads are bounded to 200 MiB. The vendored browser converter also
  enforces archive, spine, per-document DOM/IR, all-spine cache, normalized
  XHTML, and 200 MiB AZW3-output allocation limits; the exact downstream boko
  envelope, error class, reproducible build command, and artifact checksums are
  recorded in `THIRD_PARTY_NOTICES.md`.
- DRM-protected sources are rejected; Calibre and cloud conversion/storage remain outside the product.
- A green check requires strong evidence; ambiguous or partial evidence remains visibly uncertain.
- Send authority requires exact current-version `not-on-kindle` evidence; confirmed, possible, unknown, stale, or source-version-mismatched states fail before conversion or MTP.

## Important files

- `README.md` — product, local development, Docker, and safety overview
- `AGENTS.md` — durable constraints and completion expectations
- `server/main.ts` — environment configuration and process lifecycle
- `server/catalog-service.ts` — catalog service composition
- `server/catalog-database.ts` and `server/migrations.ts` — durable/rebuildable SQLite state
- `server/catalog-indexer.ts` and `server/metadata-worker-pool.ts` — watching, reconciliation, and bounded parsing
- `server/http-server.ts` — API, static UI, source streaming, and security boundary
- `client/src/catalog-client.ts` — typed catalog API adapter
- `client/src/catalog-browser.ts` and `client/src/library-prototype-view.ts` — real library and Settings interface (some historical filenames remain)
- `client/src/controller.ts` and `client/src/device-runtime.ts` — catalog, connection, self-test, inventory, and Send orchestration
- `client/src/kindle/inventory.ts`, `client/src/kindle/device-metadata-cache.ts`, `client/src/kindle/device-metadata-cache-codec.ts`, `client/src/kindle/metadata-cache.ts`, and `client/src/kindle/matching.ts` — device enumeration, portable Kindle cache, browser fallback cache, and three-state evidence
- `client/src/catalog-transfer.ts` — source verification and derivative preparation
- `client/src/api/convert.worker.ts` and `client/src/api/azw3-sideload.ts` — browser-local conversion and PDOC validation
- `client/src/mtp/` and `client/src/usb/` — MTP and WebUSB implementation
- `client/vendor/boko/` and `third_party/boko/` — required converter artifacts, source, and license material
- `Dockerfile`, `compose.yaml`, and `deploy/docker/` — platform-neutral deployment and operations
- `outputs/kindle-bridge-backlog-build-plan.md` — complete Milestone 0–14 build, validation, rollout, and omission plan
- `outputs/kindle-bridge-backlog-feature-audit.md` — current requirement-by-requirement release-candidate audit and final evidence record
- `outputs/kindle-bridge-implementation-build-plan.md` and `outputs/kindle-bridge-feature-audit.md` — historical pre-backlog implementation records

## Onboarding and reading integration (2026-09-05)

Schema v18 adds an installation-wide remembered onboarding dismissal and bounded completed-book membership in existing profile annotations. The first-run wizard uses the existing configuration save/validation flow, indexing status and optional user-initiated WebUSB connection. Settings can reopen it. The new Read books shelf is profile-scoped durable history, not device-presence or live-progress authority.

Central browser reading projection, grid/list presentation, status filtering and explicit completion recording are wired, but reading sidecar/presentation rollout remains disabled pending physical acceptance. The current parser has no proven explicit Read/Unread field. Never infer Read from 100%, and never report physical success from tests. See `outputs/onboarding-reading-build-plan.md` for the precise omission/evidence record.

## Remaining release acceptance

The approved ShelfSend Next design is now integrated into the real renderer, not only the separate mockup. `client/src/library-modern.css` provides the responsive light/dark presentation, `library-icons.ts` contains local decorative SVGs, and existing controller/capability flows retain authority. Search facets share a compact disclosure; quick Kindle filters synchronize with partial catalog renders. Settings follows Your shelves. See `outputs/modern-gui-implementation.md` for the scoped omission audit and exact validation result.

Do not infer completion of these checks from automated tests or the local container acceptance:

1. Run the expanded flow on the known physical Kindle: connect, automatic safe-write test, inventory, confirmed/possible display, catalog-driven EPUB Send, exact single and bulk Remove from Kindle (including duplicate-copy confirmation), Kindle indexing/open/navigation/cover, disconnect, reconnect, and durable confirmed match. Confirm removed files are absent while library originals remain byte-identical. Confirm the root-level cache is created, reused from a different browser installation, safely A/B-rotated, ignored by the Kindle library UI, and does not alter books or Calibre's `metadata.calibre`.
2. Configure the real husband/wife directories as read-only Docker mounts, verify profile isolation and multiple roots, add/change/rename a real book, confirm originals remain byte-identical, and repeat backup/restore plus a full cache/catalog rebuild on the intended household host.
3. Verify that the intended LAN/VPN route is private, that the actual HTTPS certificate/origin is trusted, and that WebUSB succeeds from that exact origin.
4. Measure peak browser-process memory with the maximum accepted household EPUB on the intended client. The enforced converter caps and the documented 1.5 GiB planning allowance are safety inputs, not measured acceptance evidence.
