# Kindle Bridge — Implementation Build Plan

Date: 2026-08-30

Status: Software implemented through Milestone 9; the root automated gate and current schema-v13 local restore/rebuild plus dual-architecture OCI acceptance pass, and Milestone 10 external acceptance remains pending

Companion document: `outputs/kindle-bridge-service-design-plan.md`

## 1. Implemented software end state

Kindle Bridge is implemented as a private, self-hosted household ebook service. It runs as a platform-agnostic Docker container, notices new or changed books in host-provided mounted directories, indexes metadata and covers once, and exposes a responsive web library.

The normal user journey is:

1. Open Kindle Bridge from a trusted computer on the household LAN or VPN.
2. Select a household library such as **Your library** or **Wife's library**.
3. Search or filter the real mounted-folder catalog.
4. Connect a Kindle through the browser's user-initiated WebUSB chooser.
5. On a clean connection, let Kindle Bridge run the exact-byte safe-write self-test immediately, then enumerate the device in the same retained session. Pending exact cleanup intentionally uses read-only recovery inventory first and remains fail-closed through acknowledgement plus fresh revalidation.
6. See a green check only where the catalog and Kindle are strongly matched.
7. Select **Send to Kindle**. Kindle Bridge fetches the source, converts a derivative in the browser when needed, and transfers it without altering the host-mounted original.

No Calibre desktop session, cloud converter, or cloud book upload is part of this flow.

## 2. Starting point and current status

The project began this build with the following physically proven POC capabilities:

- physically proven browser-local EPUB to AZW3 conversion through boko WASM;
- PDOC preparation and embedded-cover validation;
- user-initiated WebUSB connection and descriptor-derived MTP selection;
- read-only Kindle storage discovery;
- exact-byte create/read/compare/delete self-test;
- collision-resistant, no-overwrite transfer and bounded recovery journal;
- physical confirmation of readable text, chapter navigation, and a Kindle library cover;
- responsive household-library and Settings design prototypes.

Milestones 0–9 now implement the production software that was absent from that starting point:

- the platform-neutral Docker catalog service, deployment, health checks, and operations artifacts;
- persistent profiles and safe container-visible root Settings;
- SQLite migrations, catalog, FTS search, metadata, covers, delivery records, and server-sent events;
- bounded scans, durable scan requests, filesystem watchers, and scheduled reconciliation;
- a real API-backed catalog with search, filters, stable sorting, pagination, and source health;
- browser-local live Kindle inventory, three-state reconciliation, and automatic post-connection self-test;
- catalog-driven one-click Send with authoritative source validation and browser-local derivative preparation;
- exact recovery-record acknowledgement that reruns the self-test, read-only inventory, and reconciliation under the device-operation lock before restoring Send readiness;
- a reproducibly rebuilt boko artifact with pre-retention archive, spine, DOM/IR/style, MathML, normalized XHTML/CSS, cache, and 200 MiB AZW3-output limits plus actual-WASM hostile-input regressions;
- strict host/origin controls and documented private HTTPS reverse-proxy/VPN operation.

The original automated baseline was 18 test files and 133 passing tests; it is historical. The authoritative 2026-08-30 root `npm run check` completed with 49/49 test files and 536/536 tests, followed by successful client typechecking, server build, and production Vite build. Physical success still applies only to the earlier transfer POC. A fresh physical integrated journey, real household-mount/private-origin checks, and measured peak browser memory remain Milestone 10.

## 3. Implemented architecture

```text
Host directories supplied as read-only Docker mounts
        |
        v
Docker service: configuration + scanner + SQLite/FTS + source streaming
        |
        | same-origin HTTPS API
        v
Browser: catalog UI + source validation + boko conversion
        |
        | user-initiated WebUSB / MTP
        v
Kindle Documents storage
```

### Responsibility boundary

The Docker service owns:

- library/profile and root configuration;
- root health, scanning, reconciliation, metadata, covers, and search;
- persistent delivery records;
- production web assets and the private same-origin API.

The browser owns:

- active profile and UI state;
- raw Kindle serial handling, if exposed by the device;
- WebUSB permission and all MTP activity;
- connection-scoped Kindle inventory;
- the current-connection safe-write result;
- EPUB conversion, AZW3 validation, PDOC preparation, and transfer.

The backend never controls the USB device. The browser never receives an arbitrary filesystem path from an API request.

### State classes

- **System of record:** original host book files, mounted into the container read-only.
- **Durable application state:** profiles, root mappings, delivery records, migration history, and server settings. This state must be backed up.
- **Rebuildable index state:** extracted book metadata, FTS rows, source fingerprints, and derived covers. This can be recreated from the mounted sources.
- **Ephemeral state:** scan jobs, current Kindle inventory, self-test state, conversion bytes, and transfer progress.

SQLite must live on a local persistent application volume, never inside a library root or remote SMB share.

### Repository shape

```text
client/                 existing browser UI, conversion, USB, and MTP
server/                 private HTTP service, catalog, scanner, and migrations
shared/                 versioned catalog API contracts
tests/client/           current browser and controller tests
tests/server/           database, scanner, parser, API, and security tests
tests/integration/      filesystem, API-to-UI, and failure-recovery tests
Dockerfile               canonical multi-stage image
compose.yaml             canonical Compose deployment
deploy/docker/           proxy, backup, restore, rollback, and release guidance
```

Production serves the browser app and API from one HTTPS origin. Development keeps Vite on `127.0.0.1:5173` and proxies `/api` to the local service.

## 4. Build order and status

| Milestone | User-visible result | Status |
| --- | --- | --- |
| 0. Readiness | Deployment and safety decisions are recorded | Implemented |
| 1. Full-stack foundation | Real service starts and persists a migrated database | Implemented |
| 2. Persistent libraries | Settings creates real profiles and safe container roots | Implemented |
| 3. Real-catalog vertical slice | Real EPUB and supported uncompressed/PalmDOC AZW3 sources appear in the cover grid | Implemented |
| 4. Resilient incremental index | New and changed books update without re-importing everything | Implemented |
| 5. Production catalog UX | Search, filters, sorting, pagination, and source health use real data | Implemented |
| 6. Live Kindle connection | Self-test runs immediately, followed by device inventory in the same session | Implemented; fresh physical acceptance pending in Milestone 10 |
| 7. Trustworthy reconciliation | Real confirmed, possible, and absent states replace simulated checks | Implemented; fresh physical acceptance pending in Milestone 10 |
| 8. One-click Send | A catalog book is safely prepared and transferred end to end | Implemented; fresh physical acceptance pending in Milestone 10 |
| 9. Docker container hardening | The service is installable, recoverable, and safely reachable | Implemented; current schema-v13 local image acceptance passed |
| 10. Household release | Both real libraries pass the complete acceptance journey | Pending external acceptance |

“Implemented” above means the code, tests, and deployment artifacts exist. The root automated gate and current schema-v13 local image lifecycle gate pass. Neither form of evidence implies fresh integrated physical-device, real household-data/host, actual private HTTPS-origin, or measured browser-memory acceptance; those external gates are recorded below.

## 5. Milestone details

### Milestone 0 — Readiness and invariant lock — Implemented

Tasks:

- Align project guidance around the final boundary: a private Docker catalog service is required; cloud conversion/storage and backend conversion remain prohibited.
- Record the supported Docker runtime, target CPU architectures, intended hostname, certificate route, and mounted folder layout.
- Keep host storage preparation outside Kindle Bridge. Local disks and host-mounted NAS/SMB/NFS paths are all equivalent once mapped into the container.
- Choose one or more server-side allowed mount parents, for example `/libraries`, and a separate writable data volume, for example `/data`.
- Decide how the private origin is restricted to the household: VPN or reverse-proxy access control plus firewall rules. Profiles remain no-login selectors, not accounts.
- Record the maximum supported source size and a conservative browser-memory planning allowance before testing large EPUBs. Treat a real peak-memory measurement on the intended client as external acceptance rather than inferring it from allocation caps.
- Keep existing safety rules as invariants: user-initiated WebUSB, no overwrite, exact-handle cleanup, immutable originals, and no green check from ambiguous evidence.

Exit gate:

- The target Docker environment and network boundary are documented.
- A public unauthenticated route is explicitly rejected.
- The expanded root `npm run check` gate passes at 49/49 files and 536/536 tests, with client typechecking and both production builds green.

### Milestone 1 — Full-stack foundation — Implemented

Tasks:

- Add a TypeScript server entry point, configuration loader, structured redacted logging, graceful shutdown, and health/readiness endpoints.
- Add versioned SQLite migrations and a migration lock.
- Add separate storage locations for durable data and rebuildable cover/index caches.
- Add shared request/response contracts with runtime validation at the HTTP boundary.
- Add production static-file serving and a development `/api` proxy.
- Default CORS to denied; enforce allowed hosts/origins and bounded request bodies.
- Extend the project scripts so one command runs the complete development stack and `npm run check` covers client, server, and production builds.

Exit gate:

- A clean checkout can create a database, apply migrations, answer `/api/status`, and restart without losing its installation identity.
- The existing browser transfer engine behaves exactly as before.
- Migration up/down or forward/restore behavior is tested before household data is used.

### Milestone 2 — Persistent libraries and safe roots — Implemented

Data model:

- `profiles` stores display name, description, enabled state, and timestamps.
- `library_roots` stores a unique canonical root, health state, recursive/watch flags, and scan state.
- `profile_roots` maps a root to one or more profiles and owns each membership's display label, so one exact canonical path is scanned once when intentionally shared.
- Distinct overlapping or nested roots are rejected. Sharing is represented only by multiple profile memberships pointing at the same canonical root.

Tasks:

- Implement profile and root create/read/update/delete APIs and a manual rescan endpoint.
- Make mutations transactional and idempotent where retries could duplicate state. Settings replacement and direct profile creation use operation-scoped keys with a deterministic 1,000-key replay window per profile; delivery history uses fixed fields and bounded delivered/non-delivered partitions rather than arbitrary result payloads.
- Commit Settings state and selective scan intent together: new, re-enabled, moved, or scan-option-changed roots queue work, while profile/description/root-label-only edits and exact replays do not manufacture a whole-library pass.
- Bound startup and request-time root validation so a stalled host/NAS lookup can be retired on timeout, client disconnect, or service shutdown without late mutations.
- Resolve every configured path with server-side canonicalization and require containment beneath an allowed mount parent.
- Reject traversal, NUL/control characters, escaping symlinks, invalid nesting, and client-supplied source paths.
- Permit an unavailable path to be saved, but label it unavailable; never claim it is being watched.
- Connect the existing Settings UI to the service and remove its session-only behavior.
- Add an optional deployment switch that locks Settings after initial configuration without introducing user accounts.

Exit gate:

- Libraries and roots survive browser, service, and container restarts.
- A profile can have multiple roots and a root can be shared intentionally.
- Automated tests prove that foreign profile IDs and path traversal cannot expose another profile or a path outside the allowlist.
- Removing a profile or root never deletes a host file.

### Milestone 3 — One-root real-catalog vertical slice — Implemented

Build the smallest complete read path before adding watchers.

Tasks:

- Add source-file and book tables with stable opaque IDs, file fingerprint, content hash, availability, and indexed time.
- Implement a bounded one-shot scan for a single configured root.
- Detect format from file structure as well as extension.
- Extract EPUB title, all authors, language, publisher, date, subjects, series, identifiers, and cover with strict ZIP/XML limits.
- Add the corresponding bounded uncompressed/PalmDOC KF8/AZW3 metadata/cover path; reject HUFF/CDIC until a bounded decoder is proven.
- Write covers atomically into an app-private cache keyed by source hash and extractor version.
- Add profile-scoped book, cover, and source endpoints. The source endpoint accepts an opaque book/source ID only and returns indexed size/hash metadata.
- Give source and cover responses aggregate server-side deadlines and late-result guards so stalled NAS/cache I/O cannot retain stream/buffer capacity or resume database work after shutdown.
- Replace one prototype card with real API data, then remove sample data from normal mode once the whole grid is wired.

Exit gate:

- A real fixture copied into one root appears in the browser with its real metadata and cover.
- The source can be fetched only through a profile-scoped opaque ID.
- The source hash is identical before and after scanning and streaming.
- Malformed, encrypted/DRM, oversized, and unsupported inputs fail safely without stopping the service.

### Milestone 4 — Resilient incremental indexing — Implemented

Tasks:

- Treat filesystem events only as hints; add a durable work queue and scheduled full reconciliation.
- Debounce events and require a quiet/stable window before parsing a new download.
- Use size and modification time as a cheap change check, then hash changed candidates. Detect same-size rewrites.
- Use content hashes as the rename fallback because SMB inode identities are not reliable.
- Persist scan generations and commit a successful generation transactionally.
- Validate mount identity or a configured sentinel before treating a root as present.
- Mark a root unavailable when access disappears. Do not tombstone its catalog on the first empty or failed scan.
- After a confirmed healthy enumeration, retire only the missing rebuildable source/book/FTS rows so normal file churn and cover references remain bounded. Keep last-known rows on a mount-loss path, retain current/delivery-linked stable identities, and bound unlinked identity history to 20,000 rows/32 MiB per root with explicit rebuild protection.
- Reconcile cleanly when the root returns, without reparsing unchanged books.
- Bound parser concurrency, time, archive entries, expanded bytes, nesting, cover dimensions, and retry rate.
- Publish scan progress and source-health changes over server-sent events.

Exit gate:

- Adding one book parses only that book.
- Edit, rename, atomic replace, partial download, lost watcher event, service restart, mount loss, and mount restoration all have integration tests.
- An unavailable root leaves prior catalog entries visible but clearly stale/unavailable.
- A directly generated 10,000-row database corpus exercises FTS, filters, pagination, and the bounded complete match-index path within the shared-CI budget. A real 10,000-file filesystem scan/reconciliation remains a deployment performance gate rather than an inferred result.

### Milestone 5 — Production catalog and Settings UX — Implemented

Tasks:

- Replace `PROTOTYPE_BOOKS`, simulated counts, and in-memory libraries with a typed API adapter.
- Add SQLite FTS search over title, all authors, series, subject, publisher, identifiers, and source filename.
- Add deterministic, profile-scoped pagination and the planned author, series, language, subject, publisher, year, source, format, metadata-completeness, and Kindle-state filters. Bounded facet suggestions must not make a valid low-frequency value unfilterable; metadata text facets accept an exact typed value outside the suggestion list.
- Keep server-side sorting stable with an ID tie-breaker.
- Distinguish initial loading, background indexing, empty library, no results, stale source, failed source, missing cover, and API error states.
- Persist only harmless UI preferences such as the last selected profile in browser storage.
- Ensure switching profile clears invalid filters from the previous profile.
- Expose manual rescan and real source health in Settings without handling or exposing host storage credentials.

Exit gate:

- Both household profiles show only their configured books.
- Search, counts, filters, sort, and pagination agree under concurrent indexing.
- The grid stays responsive for the representative large-library dataset.
- Normal mode contains no simulated Kindle status or catalog records.

### Milestone 6 — Live Kindle inventory and automatic self-test — Implemented; physical acceptance pending

Tasks:

- Refactor the current controller so connection no longer requires a pre-converted EPUB.
- Keep one connection open across the self-test, inventory, and one or more sends, while preserving clean disconnect behavior.
- Recursively enumerate the Documents hierarchy read-only and model complete versus partial inventory scans. Retain and page the bounded device presentation rather than discarding everything after the first screen; the default limit is 10,000 readable objects with 100-row UI pages.
- Capture only the bounded metadata needed for matching: object identity where persistent support is proven, parent, filename, size, and safe parsed identifiers.
- Automatically run the existing exact-byte self-test after every successful clean connection. If an exact recovery record is pending, first allow only the read-only inventory needed to identify and present that cleanup; do not enable Send.
- Enable Send only when the self-test and cleanup pass in the current connection.
- When the user acknowledges an exact durable recovery record on a retained connection, acquire the device-operation lock and rerun the same post-connect self-test, inventory, and catalog reconciliation sequence. A failure remains fail-closed and does not restore Send readiness.
- Keep the manual self-test in diagnostics.
- Add a browser-wide device lease using platform locking plus cross-tab coordination so two tabs cannot write simultaneously.
- Clearly label cached information as **Last seen**; never display it as a live connected inventory.

Exit gate:

- **Connect Kindle** remains a direct user action. With no pending recovery, the exact-byte self-test proceeds first and inventory follows automatically. A pending exact cleanup intentionally allows read-only recovery inventory first, followed by self-test, inventory, and reconciliation after acknowledgement.
- A failure displays **Safe-write check failed. No book has been sent.** and Send stays disabled.
- Disconnect, BFCache restoration, long observed hidden/visible browser gaps, navigation, duplicate tabs, already-claimed interfaces, recovery-acknowledgement races, and every self-test transaction failure are covered by fault tests. These browser events do not prove detection of every OS sleep transition.
- The known `0x1949 / 0x9981` Kindle passes a fresh physical inventory and automatic-self-test run.

### Milestone 7 — Matching and green checks — Implemented; physical acceptance pending

Tasks:

- Add a stable, non-secret, source-version-scoped managed token to every Kindle Bridge filename and store it in a durable delivery record. Bind it to both the opaque book ID and indexed content hash so replaced bytes cannot inherit an old delivery's green state.
- Keep session-local MTP handles out of durable identity decisions.
- Implement the matcher as pure, exhaustively tested browser code using the shared catalog contracts, with three results: `confirmed`, `possible`, and `absent`.
- Use evidence in this order: managed token plus delivery record; proven persistent object identity; exact embedded identifier with normalized title/author; exact normalized title/author/size; fuzzy evidence as possible only.
- Build a compact active-profile match index for browser-side reconciliation so raw device serials and book bytes never reach the server. In the same bounded SQLite snapshot, include a fixed-width collision summary of other enabled/available household claimants so globally unique unmanaged evidence can confirm without downloading every profile; incomplete or colliding summaries fail yellow.
- Let Kindle-state catalog queries accept only bounded confirmed/possible book ID sets and re-scope every ID to the active profile.
- Show Kindle-only/unmanaged objects separately. Never overwrite, rename, or delete them.

Exit gate:

- Only `confirmed` receives the green check.
- Ambiguous title, duplicate title, missing identifier, unmanaged file, renamed managed file, multiple deliveries, cross-profile, and reconnect cases have tests.
- A failed or partial inventory cannot silently turn a possible match into confirmed.

### Milestone 8 — One-click Send to Kindle — Implemented; physical acceptance pending

Tasks:

- Fetch a selected source through its opaque ID with expected size, hash, and ETag.
- Enforce size before buffering and hash the exact downloaded bytes before conversion.
- Detect the actual format rather than trusting the filename.
- For EPUB, convert a copy through the existing worker. For uncompressed/PalmDOC KF8/AZW3, validate a copy through a separately tested structural/readable-text path; reject HUFF/CDIC.
- Keep the browser converter fail-closed before hostile input is retained: preflight ZIP structure and inflation claims, cap spine/package documents, bound DOM/IR/style/MathML growth, cap normalized XHTML and generated CSS, clear transient IR when safe, and enforce the 200 MiB AZW3 limit with a bounded seekable writer before output allocation can cross it.
- Apply PDOC metadata preparation only to the derivative.
- Check free space, generate a collision-resistant managed filename, suppress double-clicks, and keep one active Kindle write lease.
- Transfer through the proven MTP path and verify returned metadata.
- Add the successful object to the live inventory immediately and write an idempotent delivery record with an operation ID.
- Require exact `not-on-kindle` authority for the current connection and bind it to the match-index content hash. Refetch and compare that version before source download so catalog replacement cannot reuse an earlier absence verdict.
- If transfer succeeds but delivery recording fails, retain the managed filename token so the next inventory scan can reconstruct a strong match.
- Preserve the bounded recovery journal for interruption between `SendObjectInfo` and completed object transfer.
- Keep V1 derivatives ephemeral in the browser; do not add an upload/cache protocol yet.

Exit gate:

- One click advances through **Preparing**, **Converting** when needed, **Sending**, and **Verifying**.
- Existing Kindle objects are never overwritten, broadly deleted, moved, or renamed.
- Host-mounted source hashes are identical before and after the operation.
- Network loss, changed source, conversion failure, insufficient space, USB loss at every write phase, delivery-record failure, and retry are tested.
- Actual checked-in WASM tests cover normal Epictetus conversion plus archive entry/inflation attacks, a 100,001-node wide DOM, 4,097 OPF itemrefs, excessive MathML depth, synthesized XHTML beyond 32 MiB, and resource-driven AZW3 output beyond 200 MiB without returning partial bytes.
- On the physical Kindle, the exact sent book indexes, opens, navigates chapters, and shows its cover.

### Milestone 9 — Docker container deployment and hardening — Implemented; current local acceptance passed

The only deployment artifact is a standard, platform-agnostic Docker/OCI container image plus Docker Compose configuration. No host-vendor integration or platform-specific application package will be created or maintained.

Tasks:

- Produce a pinned multi-stage image without host-vendor dependencies and test the supported Docker architectures, initially `linux/amd64` and `linux/arm64`.
- Run as a non-root UID/GID with a read-only container filesystem; only `/data` and optional `/cache` are writable.
- Mount book directories read-only. The Docker host owns all local/NAS/SMB/NFS mounting and credentials; the app receives only container paths and never stores those credentials.
- Add health/readiness checks, graceful shutdown, migration locking, backup, restore, rollback, and catalog rebuild procedures.
- Serve UI and API from one trusted HTTPS origin. Add strict host/origin policy, CSP, frame protection, and `Permissions-Policy: usb=(self)`.
- Verify the real hostname and certificate as a WebUSB secure context. Document that Chromium desktop is required and USB permission is origin-specific.
- Add rate and concurrency bounds for source streaming, scan jobs, and Settings mutations.
- Add finite startup-root, Settings-path, source-response, and cover-response deadlines, independently of cooperative client cancellation.
- Redact paths where appropriate, raw device serials, book bytes, converter output, and storage credentials from logs.
- Ship boko GPL source/notices/checksums and produce the dependency/license inventory required for redistribution.

Exit gate:

- Fresh install, upgrade, rollback, backup/restore, mount loss, and complete catalog rebuild are rehearsed on a clean Docker host.
- Network testing proves the service is not publicly reachable without a real authentication layer.
- The actual reverse-proxy/VPN HTTPS origin completes the physical WebUSB flow.
- Container and dependency checks pass on every supported Docker architecture.

Completed local acceptance scope: the current schema-v13 image exercised the native `linux/arm64` hardened container across health/readiness, API catalog/search/facets/source/cover/delivery, restart persistence, read-only root/source enforcement, Host/Origin rejection, and security headers; a cold backup was restored and the derived catalog/cache rebuilt while preserving stable identities and exact source bytes. A verified dual-platform OCI archive contains `linux/amd64` and `linux/arm64` application manifests with per-platform SPDX/SLSA attestations; native arm64 and cross-runtime `process.arch=x64` executions both served the persisted catalog. Publishing and accepting a concrete image on the intended household host remains external release evidence.

### Milestone 10 — Household release gate — Pending external acceptance

The first release is complete only when all of the following are demonstrated with real household data:

- Your library and Wife's library retain separate profile-scoped results across restarts.
- Each profile can use multiple configured roots.
- A new EPUB appears automatically without reparsing the unchanged collection.
- Search, sorting, filters, covers, counts, and source-health states are accurate.
- A connected Kindle is inventoried and safe-tested automatically after the chooser.
- Strong matches are green, uncertain matches remain possible, and Kindle-only items stay untouched.
- A missing EPUB can be sent with one action and the green state survives reconnecting.
- The original host-mounted file is byte-identical before and after indexing and transfer.
- Failure recovery never requires broad Kindle deletion.
- Backup/restore and catalog rebuild both work.
- The service is reachable only through the intended household LAN/VPN control.

## 6. API surface required for Release 1

```text
GET    /api/status
GET    /api/healthz
GET    /api/readyz
GET    /api/events

GET    /api/profiles
POST   /api/profiles
POST   /api/profiles/configuration
GET    /api/profiles/:profileId
PATCH  /api/profiles/:profileId
DELETE /api/profiles/:profileId
PUT    /api/profiles/:profileId/configuration

GET    /api/roots
GET    /api/profiles/:profileId/roots
POST   /api/profiles/:profileId/roots
PATCH  /api/profiles/:profileId/roots/:rootId
DELETE /api/profiles/:profileId/roots/:rootId
POST   /api/profiles/:profileId/roots/:rootId/rescan

GET    /api/profiles/:profileId/books
POST   /api/profiles/:profileId/books/query
GET    /api/profiles/:profileId/filters
GET    /api/profiles/:profileId/match-index
GET    /api/profiles/:profileId/books/:bookId
GET    /api/profiles/:profileId/books/:bookId/cover
GET    /api/profiles/:profileId/books/:bookId/source

POST   /api/deliveries
```

Every book, cover, source, match, and delivery operation must re-check profile/root ownership server-side. No endpoint accepts a raw source path. Mutating requests use same-origin/Origin checks, bounded bodies, transaction semantics, and idempotency keys where a retry could duplicate state.

## 7. Test strategy

### Automated root gate (`npm run check`)

- Pure unit tests for path containment, state transitions, normalizers, match confidence, filenames, hashes, and API validation.
- Database integration tests with real migrations, constraints, FTS queries, transaction rollback, restart, and backup/restore.
- Temporary-filesystem tests for add/change/rename/partial-write/mount-loss/reconcile behavior.
- Malicious EPUB/AZW3 fixtures for traversal, oversized archives, malformed metadata, excessive entries, and parser timeouts.
- Actual checked-in-WASM regressions for archive claims, pre-allocation DOM/IR/MathML/spine limits, normalized XHTML/CSS bounds, and the seekable 200 MiB AZW3 output writer.
- Browser/controller tests for loading/error states, profile isolation, automatic self-test, Send gating, double-click suppression, and recovery acknowledgement followed by locked self-test/inventory/reconciliation.
- MTP fault injection at every transaction boundary, including full storage, stale handles, disconnect, and failed cleanup.
- Production client/server typechecks and builds.

### Additional release checks

- Direct boko Rust library and focused integration suites when that toolchain is available.
- Native hardened-container smoke, backup/restore/rebuild rehearsal, cross-runtime amd64 execution, and multi-platform OCI/SBOM/provenance inspection.

### Performance evidence and pending gates

- [x] A directly generated 10,000-row database corpus covers FTS, filters, pagination, and complete match-index query budgets; it does not exercise filesystem scanning.
- [ ] A real large-library filesystem scan/reconciliation is measured on the intended Docker host while concurrent API browsing remains responsive.
- [ ] A maximum-size source test measures the browser memory ceiling on the intended client; allocation caps and the 1.5 GiB planning allowance do not substitute for this measurement.
- [ ] Repeated watcher/reconciliation soak with deliberately dropped events on the intended mounted storage.

### Physical gates

Mocks can prove behavior, not Kindle acceptance. Any release that changes conversion, PDOC preparation, USB, MTP, inventory, matching evidence, or Send orchestration must be retested on the physical Kindle. Final acceptance still requires unplugging/ejecting, indexing, opening the exact file, navigating chapters, and checking the cover.

## 8. Principal risks and controls

| Risk | Required control |
| --- | --- |
| Missing host mount looks like an empty folder | Mount/sentinel health check; no deletion on the first empty or failed generation |
| Watcher events are lost on network-backed host filesystems | Events are hints; periodic full reconciliation is authoritative |
| A configured path escapes its root | Allowlisted parents, `realpath` containment, symlink rejection, read-only mounts |
| A hostile EPUB exhausts the service or browser | Server/converter-aligned archive limits plus pre-retention spine, DOM/IR/style, MathML, normalized XHTML/CSS, cache, and capped-output bounds, tested in Rust and the vendored WASM route |
| No-login service exposes the collection | LAN/VPN or proxy access control and firewall; never public without authentication |
| HTTPS origin cannot use WebUSB | Trusted certificate and real-hostname physical test before release |
| Two tabs or apps contend for the Kindle | Browser-wide lock, cross-tab lease, one active MTP writer |
| USB fails after object creation | Existing journal, trustworthy current-session handle, exact cleanup only; acknowledgement reruns locked self-test/inventory/reconciliation before Send can resume |
| Transfer succeeds but DB recording fails | Stable managed filename token and idempotent delivery retry |
| Conversion consumes excessive browser memory | Enforced pre-retention converter/output limits, transferable buffers, no V1 derivative cache, plus a still-required measured peak on the intended browser |
| Database loss removes non-rebuildable history | Separate durable/rebuildable state, backups, restore drill, migration rollback |
| A fuzzy match is presented as certain | Three-state matcher; green reserved for strong evidence |

## 9. Explicitly deferred

- DRM removal or DRM-protected books;
- Calibre integration;
- server-side or cloud conversion;
- cloud book storage;
- PDF, DOCX, MOBI, or other unproven conversion paths;
- derivative uploads or a persistent conversion cache;
- public internet exposure without authentication;
- private user accounts before an authentication milestone is approved;
- automatic deletion, overwrite, rename, or bidirectional Kindle sync;
- mobile Safari, Firefox, iOS, or other browsers without the required WebUSB support.

## 10. Completion and next gate

The read-only catalog slice and the later watcher, inventory, reconciliation, Send, converter-hardening, recovery, and Docker software are implemented. The authoritative root gate passes at 49/49 files and 536/536 tests with typechecking and production builds. The current schema-v13 local image passes restore/rebuild, hardened native arm64, cross-runtime amd64, and attested dual-architecture OCI acceptance. Before household release:

1. Repeat the expanded journey on the physical Kindle: user-initiated chooser, automatic exact-byte self-test, complete/partial inventory behavior, confirmed/possible matching, catalog-driven Send, Kindle indexing/open/navigation/cover, reconnect, and durable match recovery.
2. Configure the real husband and wife read-only host mounts, including multiple roots, and verify profile scope, incremental ingestion, source health, byte-identical originals, mount loss/restoration, backup/restore, and rebuild on the intended host.
3. Verify the intended LAN/VPN exposure and exact trusted HTTPS origin on the client that will use WebUSB. The no-login service must not be publicly reachable.
4. Measure peak browser memory with the largest accepted household EPUB on the intended WebUSB client and record the result against the documented planning allowance.

Preserve the generic operator checklist as unchecked until a concrete household release digest, host, origin, and Kindle run exist.

Only after those external checks pass should Milestone 10 and the household release be marked complete.
