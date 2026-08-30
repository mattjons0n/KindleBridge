# Kindle Bridge — Feature Omission Audit

Last audited: 2026-08-30

This checklist is the final independent comparison against the product request,
service design plan, implementation build plan, and settled implementation.
`[x]` means the software exists and proportionate automated, source, or native
container evidence passed. `[ ]` deliberately identifies release-host,
household-data, browser-memory, secure-origin, or physical-device evidence that
cannot be inferred from mocks or localhost.

The authoritative root gate passed 49/49 test files and 536/536 tests, followed
by successful client typechecking, server build, and production Vite build. The
generic operator template in `deploy/docker/RELEASE_CHECKLIST.md` remains
unchecked until a concrete release image, host, origin, and Kindle are accepted.

## Product and deployment boundary

- [x] Standard platform-agnostic Docker/OCI image and Compose configuration.
- [x] Library paths are container paths supplied by read-only bind mounts or Docker volumes.
- [x] No NAS-brand integration, host storage mounting, Calibre, backend conversion, or cloud book upload.
- [x] Browser-local boko EPUB conversion and browser-local WebUSB/MTP are preserved.
- [x] Profiles are explicitly organizational rather than authentication boundaries.

## Service foundation and persistent state

- [x] Same-origin production HTTP service serves the API and built browser application.
- [x] Liveness, readiness, and status are separate: health reports the process, readiness reports scanner readiness, and status reports database/scanner/root health.
- [x] Versioned, transactional SQLite migrations and migration locking.
- [x] Durable configuration/delivery state is separated from rebuildable catalog/cache state.
- [x] Settings replacement and direct profile creation require operation-scoped idempotency keys; replay history is transactionally bounded to 1,000 keys per profile.
- [x] Delivery history is bounded to 40,000 delivered and 10,000 non-delivered rows per profile; arbitrary nested result payloads are rejected and legacy payloads are removed.
- [x] Graceful shutdown closes watchers, jobs, HTTP, parser workers, and SQLite cleanly within the bounded shutdown policy.
- [x] Startup allowed-root checks, request-time Settings validation, source responses, and cover reads have finite server-side deadlines; disconnect/shutdown retirement observes late filesystem promises and bars late database, event, or rescan work.
- [x] Structured logs redact source paths where appropriate, credentials, book bytes, conversion output, and device serials.

## Libraries and mounted roots

- [x] Create, rename, enable/disable, and delete household libraries.
- [x] Add, edit, enable/disable, and remove multiple roots per library.
- [x] Intentionally shared roots are scanned once and mapped safely to multiple profiles.
- [x] Settings persist across browser, service, and container restarts.
- [x] Absolute container paths are constrained to configured allowed parents.
- [x] Realpath/symlink/traversal containment and overlapping-root policy are enforced server-side.
- [x] Unavailable roots can remain configured with accurate health states.
- [x] Removing configuration never removes a source file.
- [x] Optional read-only Settings mode after initial setup.

## Indexing and catalog

- [x] Initial recursive scan indexes supported EPUB and AZW3 sources.
- [x] Format is detected structurally rather than trusted from its extension.
- [x] Bounded EPUB and supported uncompressed/PalmDOC AZW3 metadata and cover extraction; HUFF/CDIC is rejected explicitly.
- [x] Title, all authors, language, publisher, date, subjects, series, identifiers, format, size, and source are indexed.
- [x] New or changed files use size/mtime as a hint and content SHA-256 as identity evidence.
- [x] A new file indexes independently without reparsing the unchanged library.
- [x] Settings state and required scan intent commit atomically; replays preserve one pending generation, and profile/description/root-label-only saves do not scan the whole library.
- [x] Quiet-window handling ignores partial downloads and temporary files.
- [x] Watch events accelerate updates while scheduled bounded-fingerprint and deep reconciliation remain authoritative.
- [x] Rename, atomic replace, same-size rewrite, dropped watcher event, and restart-mid-scan are handled.
- [x] Mount loss marks sources unavailable without mass deletion; restoration reconciles safely.
- [x] A confirmed healthy scan retires missing rebuildable source/book/FTS rows so churn and stale cover references do not grow forever; identity/delivery evidence survives reappearance.
- [x] Stable current and delivery-linked identities are protected across rename, delete/re-add, and catalog rebuild; unlinked tombstones use a deterministic 20,000-row/32 MiB per-root window with migration and rollback coverage.
- [x] Parser limits cover file size, entry count, per-entry and aggregate expanded bytes, aggregate names, traversal, nesting, cover size, timeout, and concurrency.
- [x] Server EPUB eligibility is aligned with the browser converter envelope, preventing a catalog card that is known to be deterministically unconvertible because of archive limits.
- [x] Cover cache writes are atomic and cache data is rebuildable.
- [x] FTS search, deterministic sorting, filtering, counts, and pagination remain profile-scoped.
- [x] Opaque book/cover/source endpoints never accept an arbitrary filesystem path.
- [x] Source streaming rechecks containment and returns indexed size/hash/ETag evidence.
- [x] Server-sent events report scan and source-health changes.

## Browser catalog and Settings UX

- [x] Normal mode contains no sample catalog, simulated counts, or simulated Kindle state.
- [x] Real profiles, roots, books, covers, source health, counts, and scan progress load from the API.
- [x] The primary library is a cover grid whose cards clearly show each book cover, title/name, authors, and relevant catalog state.
- [x] The grid and navigation adapt to narrow screens without discarding the book identity, search, filter, or transfer controls.
- [x] Settings is separated from the main library actions and rendered last/lower in the sidebar navigation.
- [x] A uniquely confirmed on-Kindle match renders a green check badge in the card's top-right corner; possible/ambiguous evidence does not receive that badge.
- [x] Search includes title, every author, series, subject, publisher, identifier, and filename.
- [x] Filters include author, series, language, subject, publisher, year, source, format, metadata completeness, and Kindle state.
- [x] Sort includes recently added, title, author, publication date, and size.
- [x] Initial loading, background indexing, empty library, no results, stale source, missing cover, and API error states are distinct.
- [x] Pagination keeps a large catalog responsive.
- [x] Switching profiles clears invalid filters and cannot leak another profile's books.
- [x] Settings CRUD, rescan, root health, and read-only mode are visible and accessible.
- [x] Last selected profile is the only catalog preference persisted in browser storage.

## Kindle connection, recovery, and inventory

- [x] Connect Kindle is user initiated and does not require selecting or converting a book first.
- [x] One MTP session remains open for inventory, safety test, and multiple sends.
- [x] Documents hierarchy is enumerated recursively and read-only.
- [x] Complete versus partial inventory state is explicit.
- [x] On a clean connection with no pending recovery, the exact-byte self-test runs automatically before inventory. A pending exact cleanup intentionally permits read-only recovery inventory first; after acknowledgement the browser automatically reruns self-test, inventory, and reconciliation before Send can resume.
- [x] Send remains disabled unless the current connection's self-test and cleanup pass.
- [x] Failure text states that no book was sent.
- [x] Manual self-test remains available in diagnostics.
- [x] Disconnect clears live readiness; cached inventory is labeled Last seen.
- [x] Browser-wide and cross-tab lease prevents simultaneous Kindle writers.
- [x] Acknowledging an exact durable recovery record reacquires the device-operation lock and reruns self-test, read-only inventory, and catalog reconciliation on the retained connection; failure remains fail-closed.
- [x] BFCache restoration, observed hidden-to-visible gaps of at least 60 seconds, navigation, duplicate tabs, claimed interfaces, disconnect, recovery races, and cleanup failures are handled; generic OS sleep detection is not claimed.

## Matching and green checks

- [x] Stable source-version-scoped managed filename token survives a failed delivery-record write.
- [x] Session-local MTP handles are never used as durable identity.
- [x] Pure matcher returns confirmed, possible, or absent.
- [x] Managed token/delivery evidence has priority over exact identifiers and normalized metadata.
- [x] Fuzzy or ambiguous evidence can produce only Possible match.
- [x] The active profile remains bounded while a same-snapshot fixed-width household claimant summary permits globally unique unmanaged metadata matches and downgrades incomplete or cross-profile collision evidence.
- [x] Only confirmed matches receive the green check.
- [x] Kindle-only and unmanaged objects remain visible and untouched.
- [x] Duplicate titles, ambiguous metadata, missing files, multiple deliveries, reconnect, and cross-profile cases are tested.

## One-click Send to Kindle

- [x] Selected source is fetched only by opaque profile-scoped catalog ID.
- [x] Received length and SHA-256 are checked against the indexed source before processing.
- [x] EPUB is converted locally; AZW3 follows a separately validated uncompressed/PalmDOC derivative path and HUFF/CDIC fails closed.
- [x] PDOC preparation changes only a copied derivative.
- [x] Preparing, Converting/Validating, Sending, and Verifying progress is visible.
- [x] Free space, bounded size, format, structure, and cover metadata are checked.
- [x] Collision-resistant managed filename never overwrites an existing object.
- [x] Double-click suppression and one active write lease prevent duplicate concurrent sends.
- [x] MTP result metadata is verified before success is shown.
- [x] Success refreshes and reconciles live inventory immediately; a green check appears only when reconciliation yields a unique confirmed match.
- [x] Send requires exact current-connection `not-on-kindle` evidence bound to the reconciled book/content hash; confirmed, possible, unknown, stale, and source-version races fail before conversion or MTP.
- [x] Delivery writes are idempotent; a later scan recovers if recording failed after transfer.
- [x] Existing bounded recovery journal and exact-current-handle cleanup remain intact.
- [x] Derivatives remain ephemeral in Release 1; originals remain byte-identical by construction and automated read-only tests.
- [x] The vendored converter preflights hostile ZIPs and caps spine/package documents, DOM/attributes/text, IR/styles/semantics, MathML, aggregate chapter cache, normalized XHTML/CSS, and AZW3 output before the corresponding retained allocation crosses its limit.
- [x] Actual checked-in-WASM regressions cover Epictetus plus archive entry/inflation attacks, a 100,001-node DOM, 4,097 itemrefs, excessive MathML depth, synthesized XHTML beyond 32 MiB, and resource-driven AZW3 output beyond 200 MiB with no partial output.

## Container, security, and operations

- [x] Multi-architecture build definition, pinned OCI index, per-architecture base digests, SBOM, and provenance configuration cover `linux/amd64` and `linux/arm64` without host-vendor dependencies.
- [x] The current schema-v13 `linux/arm64` application image builds and passes the local hardened-container smoke.
- [x] The current image executes as native `linux/arm64` and `linux/amd64` through the available cross-architecture runtime; its verified two-platform OCI index carries an SPDX SBOM and SLSA provenance attestation for each manifest.
- [x] Container runs as non-root with read-only root filesystem, dropped capabilities, and no-new-privileges.
- [x] Only `/data`, `/cache`, and bounded cache-backed temporary storage are writable.
- [x] Same-origin policy, strict Host/Origin checks, bounded bodies, CSP, frame protection, and `Permissions-Policy: usb=(self)` are implemented and covered by tests/native smoke where locally observable.
- [x] Trusted HTTPS/VPN or reverse-proxy access is documented; public no-login exposure is rejected.
- [x] Backup, restore, rollback, cache rebuild, and migration procedures are documented; helper safety and cold backup are tested.
- [x] The read-only SQLite restore-verification defect discovered by the native smoke is fixed with automated regression coverage.
- [x] The current application image restores a cold backup into a new volume, verifies schema/integrity read-only, preserves durable identities/delivery evidence, and rebuilds catalog/search/facets plus a fresh cover cache from the read-only source.
- [x] boko GPL source, notices, reproducible toolchain, checksums, and redistribution obligations remain present and match the vendored artifacts.

## Verification and release evidence

- [x] Root unit, database, filesystem, API, parser-security, browser, MTP-fault, deployment, and integration gate passes: 49/49 files and 536/536 tests, plus client typecheck, server build, and production Vite build.
- [x] A directly generated 10,000-row database corpus covers FTS, filtering, pagination, and complete match-index query budgets; no full filesystem scan is inferred from it.
- [x] Current schema-v13 native `linux/arm64` hardened-container smoke covers health/readiness, API catalog/search/facets/source/cover/delivery, restart persistence, read-only root/source, Host/Origin rejection, and security headers.
- [x] Current-image restore and catalog/cache rebuild smoke preserves profile/root/stable-book/delivery evidence, recreates derived data, and returns the exact original 459,174-byte source with its indexed SHA-256.
- [x] The current dual-architecture OCI archive contains verified `linux/amd64` and `linux/arm64` manifests plus per-platform SPDX and SLSA attestations; both architecture images start and serve the persisted catalog.
- [x] Existing physical Kindle POC evidence remains clearly separated from new automated and container evidence.
- [x] Final independent comparison found no omitted requested software feature; the unchecked entries below are evidence gates, not silently missing implementation.

## Completed local container gate and explicit external gates

- [x] Current schema-v13 rebuilt-image restore/catalog-rebuild and dual-architecture OCI build/execution completed successfully on the local acceptance runtime.
- [ ] Peak browser-process memory is measured with the maximum accepted household EPUB on the intended client; the 1.5 GiB planning allowance and enforced allocation limits are not substituted for measurement.
- [ ] The complete integrated flow is freshly retested on the physical Kindle: chooser, automatic self-test, inventory, matching, Send, open/navigation/cover, reconnect, and durable recovery.
- [ ] The real husband and wife read-only mounts, multiple-root/profile scope, incremental ingestion, mount loss/restoration, backup/restore, rebuild, and byte-identical originals are accepted on the household Docker host.
- [ ] The actual no-login service is proven private on the intended LAN/VPN, its HTTPS certificate/origin is trusted by the client, and WebUSB succeeds from that exact origin.
