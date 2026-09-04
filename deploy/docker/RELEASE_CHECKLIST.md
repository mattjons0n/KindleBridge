# Docker/OCI release evidence

Record the image digest, data-volume snapshot, date, operator, target host, browser version, and physical Kindle used. Do not check a line based only on mocks when it explicitly calls for a real host or device.

## Build and supply chain

- [ ] `npm ci` and `npm run check` pass from a clean checkout.
- [ ] Native `docker compose build --pull kindle-bridge` completes.
- [ ] The published OCI index contains both `linux/amd64` and `linux/arm64` application manifests.
- [ ] BuildKit provenance and SBOM attestations are attached to the release digest.
- [ ] In-image npm SBOMs, GPL license/notices, boko checksums, and corresponding boko/application source are present.
- [ ] The vendored boko JavaScript and WASM checksums match `THIRD_PARTY_NOTICES.md`.

## Fresh install and hardening

- [ ] A new `/data` volume migrates once and the service becomes ready.
- [ ] The runtime UID/GID is `1000:1000`; root filesystem writes fail outside `/data` and `/cache`.
- [ ] Linux capabilities are empty, `no-new-privileges` is set, and no USB device is mapped.
- [ ] Every library mount is read-only and a before/after source hash is unchanged.
- [ ] The direct HTTP listener is loopback-only; an off-LAN/non-VPN client cannot reach the service.
- [ ] Host and mutating-Origin rejection, CSP, frame denial, content-type protection, referrer policy, and `usb=(self)` are verified at the real HTTPS origin.

## Storage lifecycle

- [ ] Graceful stop during an active scan/source response closes SSE and the listener first, drains work, and exits inside 30 seconds with no corrupted migration/database state.
- [ ] A restored copy upgrades additively to schema version 17; two further restarts remain ready without duplicate migration effects, and recorded profile/root/book/delivery/overlay/provider/queue/shelf/annotation/issue/job counts are preserved as intended.
- [ ] Restart preserves installation identity, profiles, roots, Settings mode, delivery history, metadata overrides, provider configuration, Send-later order, shelves/pins, annotations, issue dispositions/preferences, bulk lookup jobs/results, and user-selected replacement covers.
- [ ] Restart and cold restore preserve only the masked public state and working behavior of a configured Google Books key; API responses, logs, and browser storage never contain the key.
- [ ] The `/data` backup is treated as a secret-bearing archive because it contains provider credentials; restored ownership/mode remain restrictive.
- [ ] Removing a source mount reports unavailable without mass deletion; restoring it reconciles normally.
- [ ] Cold backup produces a checksum-valid archive.
- [ ] Restore into a new volume preserves durable state, including `/data/metadata-covers`, and leaves the old volume untouched.
- [ ] Upgrade is tested against a restored copy; rollback selects the previous image and data snapshot together.
- [ ] Fresh cache plus a derived catalog rebuild reconstructs books/covers/search/facets/source serving without deleting queue entries, shelves, annotations, issue dispositions/preferences, provider configuration, or lookup jobs; restored stable IDs reattach that intent.
- [ ] A lookup interrupted while running reopens paused with searching entries pending; resume, cancel, and completed-failure retry preserve review-ready results and never auto-apply an overlay.
- [ ] Rollback uses the previous immutable image and its paired pre-upgrade `/data` snapshot. Additive queue/shelf/annotation/provider/issue/job rows remain inert when hidden and are not deleted as a rollback step.

## Load and privacy

- [ ] A 10,000-book catalog remains paginated, its bounded book-set match query succeeds, and health stays responsive during reconciliation.
- [ ] Queue/shelf/selection/annotation/issue/lookup limits reject overflow explicitly: 1,000 queue entries, 500 IDs per add, 5,000 selected IDs, 100 shelves/eight pins, 20,000 annotations/issues, 12 provider candidates, and 100 books/100 retained jobs for bulk lookup.
- [ ] Source streaming, scans, and Settings changes honor configured rate/concurrency/body bounds.
- [ ] Startup-root validation, Settings path validation, source responses, and cover reads honor their configured deadlines and release capacity after timeout/disconnect.
- [ ] Logs contain no storage credentials, raw source bytes, conversion output, host paths where prohibited, or raw device serials.
- [ ] No analytics, cloud conversion, or cloud book storage request occurs. When optional lookup is disabled, no provider request occurs; when enabled, egress is limited to the documented Google Books/Open Library/validated Archive.org hosts. Only normalized title/author/identifier terms leave the service—never source bytes, container paths, or arbitrary URLs—and selected cover bytes are copied into `/data`.
- [ ] Google Books add/replace/test/remove works through Settings, respects read-only mode and revision conflicts, and a missing key points back to Settings without attempting an upstream request.
- [ ] A live Open Library preview/import follows the current validated Archive.org redirect chain; unrelated hosts, paths, IDs, schemes, ports, credentials, and excessive redirects remain rejected.
- [ ] Provider metadata lookup remains explicit and review-before-apply; partial field/cover import is atomic under source-hash/revision checks and a failed import leaves no referenced or orphaned partial overlay.
- [ ] Bulk lookup enforces two concurrent provider calls, four request starts per second, three bounded transient attempts, pause/cancel/explicit retry, per-book results, and coalesced event hints.
- [ ] Catalog health covers missing covers, incomplete/parser failures, unavailable roots/sources, low-confidence provider results, and suspected duplicates. Accepted or superseded provider evidence retires low-confidence issues.
- [ ] Duplicate review can choose/clear a preferred current group member or reject/undo rejection; the preference survives rebuild, changes no source file, and never implies Kindle presence for another edition.

## Physical secure-origin acceptance

- [ ] Desktop Chromium trusts the real household certificate and reports a secure context.
- [ ] A user gesture opens the WebUSB chooser. On a clean connection the exact-byte self-test runs first and automatic inventory follows in the same session; pending exact cleanup stays read-only until acknowledgement plus a fresh self-test, inventory, and reconciliation.
- [ ] Confirmed/possible/absent matching remains conservative on the physical Kindle.
- [ ] Send prepares only a derivative, transfers and verifies it, then the exact book opens, navigates chapters, and displays its cover. An edited EPUB shows the selected title/author/cover while its mounted source hash remains unchanged.
- [ ] A physical multi-book Send keeps `Book X of Y`, marks each returned object verified, reports the exact batch summary, leaves only unsent books selected after an induced failure, and reconciles once when the batch ends.
- [ ] A second household profile and its real mounted roots remain scoped correctly across restart.
