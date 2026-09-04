# Kindle Bridge — Backlog Build Plan

Date: 2026-09-04

Status: Implemented software release candidate. Device-sensitive experiments remain default off, and the physical Kindle, live-provider, real-mount/private-origin, and final container evidence called out below remain separate acceptance gates.

Source backlog: [`BACKLOG.md`](../BACKLOG.md)

Implemented baseline: [`kindle-bridge-implementation-build-plan.md`](kindle-bridge-implementation-build-plan.md)

## 1. Goal

Complete every item in `BACKLOG.md` as a sequence of independently releasable changes while preserving Kindle Bridge's current safety and architecture. The finished product should make the common household journey feel direct:

1. Find or discover a book.
2. Decide what should go to the Kindle, even while it is disconnected.
3. Connect once and understand exactly what Kindle Bridge is doing.
4. Transfer, update, compare, or remove the intended books with explicit verification.
5. Correct catalog presentation without ever modifying the mounted originals.

The main library and Settings must remain simple. Secondary detail, diagnostics, maintenance, and uncommon configuration belong in drawers, compact centers, or progressively disclosed sections—not as a growing set of permanent navigation items.

This plan covers all 15 backlog objectives:

- automatic safe-write cadence evaluation;
- a physical `GetPartialObject` probe and possible bounded partial metadata reads;
- bounded KFX sidecar metadata;
- Kindle reading progress and reading state;
- GUI-managed cover-provider API keys;
- validated Open Library/Archive.org cover redirects;
- the nine-item usability roadmap: Send-later queue, Update on Kindle, Possible-match resolution, Book details, series browsing, metadata/library-health inbox, smart shelves/personal state, activity/device center, and display/context improvements.

## 2. Non-negotiable boundaries

Every milestone must preserve these constraints:

- Deployment remains one platform-neutral Docker/OCI service. Do not add a Synology package or make Kindle Bridge mount SMB/NFS storage.
- Host book directories remain read-only. Metadata changes, cover replacements, conversion, update, and transfer operate only on overlays or derivatives.
- SQLite durable state and provider configuration live under `/data`; rebuildable extracted covers/indexes live under `/cache`.
- EPUB conversion, AZW3 validation, PDOC preparation, raw Kindle inventory, WebUSB, and MTP remain browser-local.
- WebUSB permission remains directly user initiated, and only one browser-wide device lease may own the Kindle.
- Existing Kindle objects are never overwritten, renamed, moved, or broadly deleted. Deletion always targets a freshly revalidated exact object.
- Exact-handle cleanup, the bounded recovery journal, collision-resistant filenames, post-transfer verification, and clean shutdown remain mandatory.
- Strong evidence is required for a green check. Partial, stale, missing, ambiguous, unsupported, or fuzzy evidence must remain possible or unknown.
- `GetObjectPropList` (`0x9805`) remains disabled for the known `0x1949 / 0x9981` Kindle.
- Device metadata caches never replace current live enumeration and never authorize resurrection of an absent object.
- No raw device serial, raw inventory, sidecar bytes, reading history, book bytes, or conversion output is sent to the backend.
- Online providers receive only bounded metadata queries. No provider accepts a browser-supplied fetch URL, and no cloud provider receives source book bytes.
- Profiles remain organizational views, not authentication boundaries. No-login deployment remains private to a trusted LAN/VPN or protected private HTTPS route.
- All new collections, inputs, outputs, histories, retries, parsers, reads, and queues receive explicit count, byte, time, and concurrency ceilings.

## 3. Reuse the implemented platform

Do not re-platform or rebuild working capabilities. Extend the existing seams:

- `shared/catalog-contracts.ts` for versioned API contracts and runtime validation;
- `server/migrations.ts` and `server/catalog-database.ts` for additive durable state;
- `server/http-server.ts` for profile-scoped and global Settings routes;
- `client/src/catalog-client.ts` for typed same-origin API calls;
- `client/src/catalog-browser.ts` for catalog/UI state and server-event reconciliation;
- `client/src/controller.ts` and `client/src/device-runtime.ts` for device orchestration;
- `client/src/kindle/` for inventory, matching, metadata caches, sidecars, and evidence;
- `client/src/library-prototype-view.ts` and `client/src/styles.css` for the current real UI despite their historical names;
- the current verified batch Send, exact removal, source validation, overlay, and MTP primitives.

Before feature work, extract one pure `bookActionCapabilities()` projection used by grid cards, list rows, the details drawer, queue, series view, match review, and activity center. It must be the single answer for whether a book can be queued, sent, updated, removed, or reviewed given source health, presentation revision, live inventory completeness, match strength, write proof, recovery state, and current device work. New views must not recreate those rules independently.

### State placement

| State | Location | Reason |
| --- | --- | --- |
| Profiles, roots, deliveries, queue, smart shelves, personal annotations, issue dispositions, provider credentials | SQLite under `/data` | Durable household application state and backup scope |
| Replacement covers and metadata overlays | Existing durable `/data` paths/tables | Source files remain immutable |
| Extracted source covers and catalog index | `/cache` and rebuildable tables | Reconstructable from mounted sources |
| Layout density and per-profile browsing context | Validated/versioned browser storage | Harmless client preference; no server configuration clutter |
| Manual Kindle match decisions | Bounded IndexedDB keyed by pseudonymous device/storage evidence | Device-specific evidence remains browser-local |
| Live inventory, MTP handles, transfer bytes, sidecar evidence, current progress | Browser memory; optional bounded browser-local last-seen presentation | Never backend authority |
| Existing portable parsed-metadata cache | Current checksum-protected Kindle A/B slots | Preserve the established live-match and write-proof rules |

### Additive durable schema

Use forward-only, restart-safe migrations and preserve a cold backup before the first deployment containing each schema change.

Planned tables or equivalent normalized structures:

- `provider_credentials`: one fixed-enum provider row, secret value, revision, explicit configured/removed state, timestamps, and bounded last-test status. The secret is never serialized by a read API.
- `send_queue_entries`: profile ID, stable book ID, rank, queued source hash, queued presentation version, timestamps, and a unique profile/book constraint. Queue records must survive index rebuilds and temporary source loss.
- `smart_shelves`: profile ID, name, versioned validated query JSON, optional pinned rank, optimistic revision, and timestamps.
- `profile_book_annotations`: profile ID, stable book ID, `favorite`, `want_to_read`, and timestamps.
- `catalog_issue_dispositions`: stable derived-issue signature, profile, ignored/resolved state, and timestamps. Scanner facts remain derived; only user disposition is durable.

Do not add a durable backend table for raw device objects, progress, or manual device evidence.

## 4. Build order

| Milestone | Outcome | Depends on | Relative size |
| --- | --- | --- | --- |
| 0. Baseline and shared contracts | Measured, versioned starting point and common capability/event models | Current main | M |
| 1. Cover-provider reliability and Settings | Open Library imports work; Google Books key is configured simply in the GUI | 0 | M |
| 2. Browsing foundation | Book-details drawer, responsive density, and remembered context | 0 | L |
| 3. Persistent Send-later queue | Books can be planned across pages before connection and sent as one verified batch | 2 | XL |
| 4. Possible-match review | Users can understand, confirm, reject, and undo uncertain associations | 2 | L |
| 5. One-click Update on Kindle | An edited managed copy can be replaced through one guarded workflow | 3, 4 | L |
| 6. Series-first browsing | Series are ordered, audited, and queue-aware | 3 | M |
| 7. Smart shelves and personal state | Reusable profile views, favorites, and want-to-read state | 2, 3 | L |
| 8. Metadata and library-health inbox | Catalog problems and provider candidates become actionable | 1, 2, 7 | XL |
| 9. Activity and device center | One quiet place explains scans, device phases, capacity, queues, and failures | 3–8 | L |
| 10. Physical partial-read probe | `GetPartialObject` support is proven or explicitly rejected | 0 | M research gate |
| 11. Bounded KFX metadata | Supported KFX/AZW8 sidecars improve matching without whole-book reads | 0 | XL hardware/parser gate |
| 12. Kindle reading progress/state | Validated sidecars drive browser-local progress and status UI | 4, 11 | XL hardware/parser gate |
| 13. Safe-write cadence decision | Evidence either retains every-connect testing or safely defers it until first mutation | 0, 9 | M research/safety gate |
| 14. Integrated release and omission audit | All accepted milestones pass automated, Docker, household, and physical gates | Every shipped milestone | L |

Milestones 1 and 2 may run in parallel after Milestone 0. Milestones 10 and 11 are separate browser/device research lanes and may also run in parallel with server/catalog usability work. A research milestone is complete when it produces a defensible **enable** or **do not enable** decision; it must not be kept open merely because the physical device rejects a proposed optimization.

### Releasable slices

1. **Provider repair:** Milestones 0–1.
2. **Browsing base:** Milestone 2.
3. **Planned transfer and device confidence:** Milestones 3–5.
4. **Discovery and organization:** Milestones 6–7.
5. **Maintenance and operational clarity:** Milestones 8–9.
6. **Device intelligence and performance:** accepted portions of Milestones 10–13.
7. **Consolidated household release:** Milestone 14.

Each slice should be independently deployable and reversible without requiring unfinished later slices.

## 5. Milestone details

### Milestone 0 — Baseline, contracts, and shared foundations

**User-visible outcome:** None. Later features start from one measured baseline and share the same action and activity rules.

Tasks:

- Read the current schema version, release checklist, and latest complete `npm run check` result at implementation time. Do not copy historical test counts into a new release report.
- Back up `/data`, record the deployed Git/image revision, and capture the current profile/root/book/delivery counts before the first migration.
- Record physical timings on `0x1949 / 0x9981` for USB open, DeviceInfo/session, storage inspection, exact-byte self-test create/write/read/delete, hierarchy enumeration, metadata reads, cache work, reconciliation, and disconnect.
- Capture cold browser, same-page reconnect, reload, browser restart, Kindle reboot, and post-fault samples. Keep timing logs bounded and free of raw inventory or device identity.
- Add or extract the pure shared `bookActionCapabilities()` projection. Cover disconnected, connecting, recovery, partial inventory, possible match, confirmed current presentation, exact prior presentation, unavailable source, changed source/presentation, insufficient write proof, and busy operation states.
- Define a versioned UI route/context codec and a versioned activity-event model before adding drawers, queue routes, or persistent views.
- Choose and document explicit ceilings for queue entries, shelves, pinned shelves, issue rows, bulk selection IDs, provider candidates, provider concurrency, activity history, sidecar objects, and browser-local decision records. Reject oversized work rather than silently truncate a destructive or transfer action.
- Add no new user-facing low-level feature flags. Experimental device capabilities use internal gates that default off until physical acceptance.

Targeted validation:

- Pure capability-table tests prove every view receives the same Send/Update/Remove decision and reason.
- Route/context codecs reject unknown versions, malformed values, excessive text, and cross-profile state.
- Activity payload validation rejects arbitrary nested/raw errors and secret-like fields.
- Baseline physical timings distinguish safe-write time from inventory time.

Exit gate:

- The baseline, ceilings, proposed schema versions, and rollout boundaries are recorded.
- All later milestone contracts can reuse one action projection and one bounded event vocabulary.
- No product safety behavior has changed.

### Milestone 1 — Cover-provider reliability and simple GUI configuration

**User-visible outcome:** Open Library covers import successfully through their real redirect chain, and a user can configure Google Books from one compact Settings row without editing Docker configuration.

#### 1A. Validate Open Library redirects

- Refactor the generic redirect loop into a provider-specific state machine while continuing to use manual redirects.
- Start only from the generated URL `https://covers.openlibrary.org/b/id/{id}-{size}.jpg?default=false`.
- Permit the observed first hop only when it is an HTTPS `archive.org` Open Library cover-archive path carrying the same cover ID, size, and archive bucket.
- Permit the observed data-node hop only when it is an HTTPS Archive.org host and exact `view_archive.php` request referencing that same bucket, ZIP, cover ID, and size.
- Reject credentials, fragments, non-default ports, HTTP downgrades, lookalike hosts, unexpected paths or parameters, changed IDs/sizes/buckets, skipped/reordered hops, and excess redirects.
- Preserve response timeout, abort handling, image media-type checks, decoded-image validation, and byte/dimension ceilings.
- Continue serving only a same-origin preview URL to the browser.

#### 1B. Move Google Books key setup into Settings

- Add one provider-credential row per fixed provider with a monotonic revision, explicit never-configured/configured/removed state, timestamps, and fixed-enum last-test result.
- Treat `CATALOG_GOOGLE_BOOKS_API_KEY` as a deprecated one-time bootstrap only: import it only when the database has never made a provider choice. An explicit GUI removal must not allow an old environment value to reappear after restart.
- Make the persisted GUI value authoritative and resolve it at request time so save/replace/remove works without restarting the container.
- Add service-global, fixed-provider routes equivalent to:
  - `GET /api/settings/cover-providers`;
  - `PUT /api/settings/cover-providers/google-books`;
  - `DELETE /api/settings/cover-providers/google-books` with expected revision;
  - `POST /api/settings/cover-providers/google-books/test`.
- Apply existing host, origin, Settings read-write mode, request-size, rate, concurrency, abort, and timeout protections. Mutations use idempotency and optimistic revision checks.
- Return only provider name, `configured`, fixed mask, revision, last-tested time, and fixed safe status/error code. Never return key characters, length, request URL, or raw provider response.
- Test with one fixed bounded Google Books query and distinguish working, invalid/restricted key, quota exhausted, timeout, and temporarily unavailable. Discard a test result if the key changed while the request was in flight.
- Add one compact service-level **Online cover search** row in Settings. Collapsed state shows Google Books plus **Not configured**, **Working**, or a concise failure and an **Edit** action. Expanded state has an empty password input, **Save & test**, **Cancel**, and progressively disclosed **Remove key**.
- Never prefill the password field, retain entered text in application snapshots, write it to browser storage, or include it in an event/error/log. Clear the input after submission.
- When Google Books is unconfigured, default cover search to Open Library and show **Configure Google Books in Settings** instead of making a doomed request.
- Store the credential server-side under `/data`. Do not add a second deployment secret merely to claim application-level encryption; rely on the private deployment, non-root container, volume ownership, and restricted backups, and document that `/data` backups contain provider credentials.

Targeted validation:

- Extend `tests/server/cover-providers.test.ts` with the valid observed two-hop chain and every rejected redirect variation above.
- Add same-origin preview/import integration coverage through the redirect chain and prove the mounted source hash is unchanged.
- Add migration, first-start bootstrap, explicit removal, restart, revision race, Settings-lock, provider timeout, and key-redaction tests.
- Scan API responses, SSE payloads, structured logs, error strings, and browser storage for a distinctive test key.
- Add UI tests for compact/expanded states, focus, keyboard use, save/test/remove, and Open Library fallback.
- Perform one bounded live Open Library search/preview/import because mocks cannot establish the provider's current redirect behavior. Perform one live Google Books key test only with a user-supplied development key.

Exit gate:

- A normal Compose deployment has no required provider-key environment setup.
- A GUI-configured key survives restart, can be replaced or explicitly removed, and never appears in a read response or log.
- Open Library search, preview, and import work against the live service while arbitrary outbound destinations remain blocked.
- README, server documentation, Docker egress guidance, backup guidance, and the release checklist describe the new behavior.

Rollback:

- Disable the affected provider without disabling local upload/paste or catalog use.
- The deprecated environment bootstrap remains a one-release compatibility path only when the database has never been configured.
- Schema additions are additive; rolling back the application leaves the provider row inert.

### Milestone 2 — Browsing foundation, Book details, and remembered context

**User-visible outcome:** The library uses wide screens comfortably, remembers each profile's browsing position, and opens full book information from a cover or title.

Tasks:

- Add `comfortable` and `compact` density modes with readable minimum cover/card sizes and accessible action targets. Let the shell use more wide-screen space without forcing tiny text or excessive columns.
- Keep the existing responsive grid/list implementation. Verify the sidebar, toolbar, drawer, list, metadata editor, and Settings at laptop, wide desktop, tablet, narrow phone, high zoom, and long-title extremes.
- Add a versioned per-profile browsing-context record for layout, density, filters, sort, result offset or stable anchor, open shelf, and scroll position.
- Use precedence `valid URL state → saved profile context → defaults`. The URL owns shareable route/filter/book state; browser storage owns density, scroll, and other harmless preferences.
- Clamp stale page offsets after catalog changes and restore scroll only after the matching result anchor has rendered. Switching profiles must restore that profile rather than carrying invalid facets across.
- Add a read-only details DTO using effective metadata, source-versus-overlay provenance, source/root health, cover, and latest verified delivery summary. Do not include a device identifier or infer live Kindle state on the server.
- Make cover/title activation open a lazy-loaded side drawer keyed by opaque profile/book IDs. Include cover, description, authors, series/index, publication data, identifiers, subjects, language, format/size, source health, metadata provenance, and last verified delivery.
- Make author, series, subject, publisher, and language values filter shortcuts.
- Feed all visible actions through `bookActionCapabilities()`: **Add to queue/Send**, **Edit metadata & cover**, **Update Kindle copy**, and **Remove from Kindle** appear only with their exact reason/state.
- Support Escape, backdrop, explicit close, browser back/forward, focus return, deep link, and scroll restoration. Invalidate/reload the open drawer on relevant book/root events without discarding unrelated UI context.
- On a browser without WebUSB, retain browsing, metadata editing, and queue planning and show one concise compatibility explanation.

Targeted validation:

- Test corrupted/oversized/old context, profile isolation, URL precedence, clamped offsets, reload, back/forward, focus return, and late data.
- Test absent/long metadata, unavailable sources, edited overlays, and delivery history.
- Run the full capability matrix in the drawer and existing grid/list surfaces.
- Add keyboard, screen-reader naming, focus-trap, reduced-motion, high-zoom, viewport, and no-horizontal-overflow checks.

Exit gate:

- Cover/title opens complete read-only information without losing the user's place.
- Grid/list and density preferences restore per profile.
- Secondary detail remains out of the main library layout until requested.

### Milestone 3 — Persistent Send-later queue

**User-visible outcome:** A user can plan a transfer while disconnected, across pages and filters, then connect once and transfer the reviewed queue.

Data and API:

- Add queue entries containing profile ID, stable book ID, rank, queued content hash, queued presentation version, and timestamps. Do not foreign-key only to rebuildable book rows if that would erase intent during an index rebuild.
- Enforce a unique profile/book pair, explicit per-profile limit, bounded serialized response, stable rank, and queue revision.
- Add typed profile-scoped routes for hydrated queue read, idempotent bounded batch add, remove, clear, and optimistic reorder/replace.
- Add a bounded query-to-ID operation that applies the existing catalog search/facets/sort without pagination. It must fail explicitly when the configured selection ceiling is exceeded.
- Publish one coalesced `queue.updated` event; do not emit one event per row during bulk changes.
- Hydration classifies each entry as ready, source unavailable, source changed, presentation changed, already on current Kindle, possible/unknown, unsupported, or missing/retired. Never silently delete a stale item merely to make the queue appear clean.

Client and UI:

- Replace disconnected **Connect to send** card buttons with **Add to queue**. Keep **Connect Kindle** as the single global device action.
- Persist queue count in the top bar and expose a review drawer with remove, clear, reorder, current eligibility, conversion expectation, total source bytes, and a clearly labelled approximate device-space estimate.
- Add **Select visible** and **Select all filtered**. Offer **Select all filtered missing books** only when the current Kindle inventory and metadata evidence are complete; last-seen or disconnected state can never prove absence.
- Resolve all-filtered catalog IDs server-side, intersect Kindle-dependent eligibility with the complete browser-local match index, and send only bounded opaque IDs back to the queue API.
- Generalize the existing verified batch sender to consume queue entries. Immediately before each book, refetch source and overlay, re-check current hash/presentation, require current exact not-on-Kindle authority, and re-check capacity.
- Dequeue only books that transferred and verified. On partial failure, keep the failed and unsent entries, select them for retry, and retain the existing exact success/failure summary.
- Recalculate queue status on profile events, source events, edits, inventory changes, reconnect, and lifecycle retirement without starting conversion or USB work.

Targeted validation:

- Cover migration, restart, catalog rebuild, temporary source loss, profile deletion, duplicate add, idempotent replay, concurrent reorder, queue ceiling, and stale hydration.
- Test page/filter/layout/profile changes, reload, select-visible versus all-filtered, disconnected versus live complete inventory, possible/unknown entries, source/edit races, and already-present books.
- Test multi-book success, every partial-failure position, retry selection, one final reconciliation, queue/event coalescing, and projected-space messaging.
- Run a physical multi-book queue transfer, forced partial failure, reconnect, and retry.

Exit gate:

- The complete intended batch can be assembled without the Kindle attached and survives a reload.
- No queued snapshot bypasses current source, presentation, match, write-proof, capacity, or MTP checks.
- Verified successes leave the queue; only actionable failures and unsent books remain.

Rollback:

- Hide queue UI and fall back to current-page Send without deleting queue rows.
- An older application ignores the additive queue table; source and Kindle contents are unchanged.

### Milestone 4 — Explain and resolve Possible matches

**User-visible outcome:** A question mark explains itself, and the user can make a reversible, device-specific association decision.

Tasks:

- Preserve a bounded `MatchReview` from the existing pure matcher/reconciliation path instead of reducing it to `possible`. Include evidence tier, normalized comparisons, candidate display metadata, ambiguity/conflicts, inventory completeness, and why stronger proof is unavailable.
- Keep raw candidates in the browser. Add no raw-device backend endpoint.
- Add a bounded, checksummed/versioned IndexedDB decision store scoped by pseudonymous browser/device/storage evidence, selected profile, stable book ID, and a digest of canonical live object evidence. Never persist an MTP handle as the sole identity.
- Support **Same book**, **Not this book**, and **Undo**. Rejections remove only that candidate and rerun deterministic allocation. Confirmation applies only when a fresh complete enumeration contains the exact same object signature.
- Retire or ignore decisions when the device, storage, profile, book version, path, format, size, or validated modification evidence changes. A decision cannot resurrect a missing object.
- Let an explicit current decision establish confirmed presence for display/duplicate prevention, but keep removal behind fresh complete-inventory and ObjectInfo/parent/size/format/protection revalidation.
- Open review from the yellow badge and from the details drawer. Cover one, many, and no-candidate explanations.
- Bring Kindle-only/unassociated items into the same comparison drawer with clear source and deletion eligibility. Do not mix them into the server catalog or grant deletion from fuzzy evidence.

Targeted validation:

- Test every evidence tier and plain-language reason; one/many/no candidates; confirm/reject/undo; corruption and bounded eviction; profile/device/storage scoping; changed or missing objects; duplicate books/editions; partial metadata and partial inventories.
- Test deterministic allocation before and after a decision and prove a decision for one profile cannot change another profile's match.
- Test reconnect, reload, lifecycle retirement, and fresh revalidation for Send and removal.
- Complete a physical match-review decision, disconnect/reconnect, reversal, and exact removal-authority check.

Exit gate:

- No yellow state is unexplained.
- A saved choice helps only while its exact live evidence still exists.
- Possible/fuzzy evidence alone never enables a destructive action.

### Milestone 5 — One-click Update on Kindle

**User-visible outcome:** After editing an EPUB's metadata or cover, one guided action safely installs the new presentation and retires the exact old managed copy.

Safety decision:

The preferred order is **prepare → upload new copy → verify and record new copy → delete exact old copy → verify absence**. This temporarily needs capacity for both copies, but it avoids leaving the user with no readable copy if transfer fails. If the Kindle cannot hold both, the one-click safe update stops with an explicit capacity explanation; a separate manually confirmed remove-then-queue workflow remains available. Do not silently switch to delete-first behavior.

Tasks:

- Surface **Update Kindle copy** only for an edited supported presentation with one exact current prior KindleBridge presentation and no ambiguous target.
- Fully fetch, validate, overlay, convert, PDOC-prepare, bound, and hash the new derivative before acquiring deletion authority.
- Acquire the existing device-operation lock, ensure current-session write proof, refresh/revalidate complete inventory, re-check the prior exact target, check collision and capacity for coexistence, and show one confirmation naming both presentations.
- Transfer the collision-resistant new presentation without overwrite and verify handle, parent, filename, size, and readable metadata as currently required.
- Create/recover the durable delivery record before deleting the old copy. If delivery recording is unavailable, retain both copies and show a retry/cleanup state.
- Revalidate the old ObjectInfo, current Documents parent membership, type, size, protection state, and exact managed evidence immediately before deletion. Delete only that handle and verify its absence.
- Perform one final inventory/reconciliation and emit a single coherent activity summary.
- If preparation or new transfer fails, leave the old copy untouched and keep the edited book queued. If old-copy cleanup fails after the new copy verifies, report a duplicate cleanup task rather than treating the update as wholly absent.
- Preserve the existing bounded upload recovery journal for interruption before new-object verification; add only the minimum bounded replacement-stage evidence needed to explain a verified-new/pending-old-cleanup state.
- Keep edited AZW3 replacement unavailable until the existing bounded reconstructed-container limitation is solved; explain that before any device mutation.

Targeted validation:

- Inject source/edit races, conversion failure, unsupported AZW3 overlay, insufficient coexistence capacity, stale/changed/ambiguous old target, collision, delivery-record failure, deletion failure, and disconnect at every MTP boundary.
- Assert exact operation order, no overwrite, no old deletion before verified durable new identity, one hardware lock, one final reconciliation, and accurate retry/cleanup state.
- Test successful edited EPUB cover/metadata replacement and original source byte identity.
- Complete a physical update, reconnect, confirm one current presentation, open/navigate it, and verify the source file is unchanged.

Exit gate:

- The common edit-to-Kindle path is one guided operation.
- Every failure prefers a retained old copy or a verified new copy over silent book loss.
- Only exact current managed objects are eligible for cleanup.

Rollback:

- Hide the orchestration action and retain the existing separate exact Remove and Send operations.
- Any pending cleanup appears through the existing recovery/activity path and remains bounded.

### Milestone 6 — Series-first browsing

**User-visible outcome:** Series appear in reading order, gaps and duplicate numbers are visible, and missing Kindle volumes can be queued together.

Tasks:

- Derive a canonical series key and numeric ordering from effective metadata, including saved overlays. Preserve the display string separately; do not group unrelated books by fuzzy title alone.
- Add profile-scoped series summary and series-page queries, or equivalent extensions to the current catalog query, with stable pagination and counts.
- Add `series` and `seriesIndex` sorts. Order finite numbered volumes first, including decimals, then unnumbered volumes with stable title/ID tie-breakers.
- Make series chips and the details drawer link to a focused series view. Show the description, ordered covers/rows, current Kindle state, source availability, and metadata-edit shortcut.
- Flag duplicate indices and defensible missing positive-integer sequence positions as review hints. Do not claim that a missing number means a file should exist, and do not invent gaps around decimal novellas.
- Add **Add next missing volume to queue** and **Add all series books missing from Kindle**. These actions feed Milestone 3's queue and require selected-profile scope plus a complete current Kindle comparison. When disconnected, allow adding an explicitly selected series/book set but label device absence as unknown.
- Keep unnumbered or malformed entries usable and place them after numbered volumes instead of hiding them.

Targeted validation:

- Test Unicode/case/punctuation normalization, decimals, zero/negative/unreasonably large indices, duplicate positions, gaps, unnumbered entries, and series renamed by an overlay.
- Test stable ordering across pages, profile isolation, source loss, live versus last-seen Kindle evidence, and exact queued IDs.
- Test back/deep-link behavior, accessible group headings, long series names, and empty/no-result states.

Exit gate:

- A user can open any series, understand its local sequence quality, and create the intended queue without manually searching each title.
- Series actions never treat stale or possible device evidence as authoritative absence.

### Milestone 7 — Smart shelves and lightweight personal state

**User-visible outcome:** Each household profile can reuse useful views and mark books as Favorite or Want to read without cluttering the sidebar.

Data and API:

- Add bounded `smart_shelves` and `profile_book_annotations` state using stable profile/book identity rather than rebuildable source rows.
- Define one canonical, versioned query codec for search text, catalog facets, sort, personal-state filters, and an optional Kindle-state constraint. Never persist raw SQL or an arbitrary expression language.
- Exclude transient pagination, scroll, MTP handles, and current device IDs from a shelf definition.
- Provide immutable built-in presets and idempotent/optimistic create, rename, update, delete, pin, unpin, reorder, and annotation mutations.
- Limit name length, shelf count, pinned count, query bytes, and mutation batch size. Publish coalesced typed events.
- Calculate server-resolvable counts from the catalog. Calculate Kindle-dependent results only after current browser reconciliation; while disconnected, show **Connect to compare** instead of an old absence count.

Client and UI:

- Add optional presets such as **Not on Kindle**, **Recently added**, **Favorites**, **Want to read**, **Missing cover**, and—once evidence exists—**Series in progress**.
- Let the user save the current query with a short name and optionally pin it. Show only the small bounded pinned set in the sidebar; keep all shelves in one chooser/manage sheet.
- Add unobtrusive Favorite and Want-to-read actions in the details drawer and three-dot menu.
- Keep manual personal state visually and semantically separate from live Kindle-derived reading state in Milestone 12.
- Feed shelf bulk actions through the queue and shared capabilities rather than implementing another selection system.

Targeted validation:

- Test migrations, restart/rebuild retention, CRUD, idempotency, revision conflicts, bounds, pin ordering, built-in protection, annotation updates, and profile deletion.
- Test invalid or renamed facet values, URL/reload behavior, counts, offline Kindle-dependent semantics, queue integration, and cross-profile isolation.
- Test keyboard navigation, focus return, screen-reader names, narrow layout, and maximum shelf/name lengths.

Exit gate:

- A profile can reproduce a useful filtered view in one action.
- Pinned navigation remains intentionally small.
- Manual state never masquerades as device reading evidence.

Rollback:

- Hide shelf/personal-state UI while retaining additive rows for later re-enable. Normal catalog queries remain unchanged.

### Milestone 8 — Metadata and library-health inbox

**User-visible outcome:** Missing metadata, bad covers, parse/index failures, source problems, low-confidence records, and possible duplicates are collected in one actionable view.

Issue model:

- Represent current issues as derived facts with stable type/signature, severity, affected profile/book/source/root, safe reason code, first/last observed time, last attempt, and current availability.
- Persist only user disposition such as ignored/unignored plus any bounded retry state. Retire a derived issue automatically when its underlying fact disappears, while retaining enough history to avoid immediate notification churn.
- Initial categories: missing cover, incomplete core metadata, malformed/unsupported metadata, parser/index failure, low-confidence provider data, unavailable source/root, and suspected duplicate edition.
- Expose profile-scoped paginated counts/filtering plus explicit **Edit**, **Retry**, **Rescan**, **Ignore**, **Undo ignore**, or **Review duplicates** actions as appropriate.
- Never expose a source from another profile or accept a client path. Use stable opaque IDs and server-owned container-relative display data.

Metadata lookup:

- Extend the fixed Google Books/Open Library provider adapters from cover candidates to bounded metadata candidates. Send only normalized title, author, or identifier queries; never book bytes or host paths.
- Return a normalized candidate with provenance and fixed fields for title, authors, description, publisher, published date, identifiers, language, subjects, series/index when genuinely supplied, and optional cover candidate.
- Show a field-by-field source/current/candidate diff. Nothing is selected implicitly merely because a provider returned it.
- Apply only chosen fields and optional cover through the existing source-hash and metadata-revision preconditions. Commit a single-book selection atomically, including cover-asset rollback on failure.
- Add bounded bulk lookup with explicit maximum batch, provider concurrency/rate/backoff, per-book status, pause/cancel, restart-safe progress, and review before applying overlays.
- Coalesce catalog/SSE refresh after a batch instead of reloading the full page for every field or book.

Duplicate review:

- Derive candidates from exact content hash, exact normalized identifier, and conservative title/author/edition evidence; label why each group exists.
- Let the user choose a preferred catalog presentation or reject the grouping. Do not delete, rename, move, merge, or rewrite a mounted torrent file.
- Keep distinct editions/formats available when the user wants them and ensure one preferred row does not falsely claim every duplicate is on Kindle.

Targeted validation:

- Exercise issue creation, stable signatures, repeated scans, retry, ignore/unignore, automatic retirement, mount loss/restoration, parse failures, and bounded history.
- Test provider no-result, ambiguity, timeout, quota, invalid key, redirect failure, partial field selection, source/revision conflict, and cover-asset rollback.
- Test bulk limits, cancellation, restart/resume, provider concurrency/backoff, event coalescing, and one failed item among successes.
- Test exact and fuzzy duplicate groups, preference/rejection, stable identities across rebuild, cross-profile behavior, and byte-identical originals.
- Verify every applied edit and selected cover exists only in durable `/data` overlay state.

Exit gate:

- The user can identify which file/book needs attention, understand why, and invoke the smallest relevant action.
- Provider suggestions are reviewed overlays, never automatic source mutations.
- A duplicate workflow never changes torrent contents.

### Milestone 9 — Compact activity/device center and final context integration

**User-visible outcome:** One quiet top-bar surface explains what the server and Kindle are doing, shows capacity and recent outcomes, and offers the relevant recovery action.

Tasks:

- Project one bounded activity read model from existing application/device state, scan SSE, source/root health, queue, deliveries/removals, and the operation-event vocabulary from Milestone 0. Do not duplicate action eligibility in the activity UI.
- Use clear device phases: **Disconnected**, **Connecting**, **Checking safe writes**, **Reading books**, **Comparing library**, **Ready**, **Transferring**, **Removing**, **Updating**, and **Needs attention**.
- Show device model, last live inventory time, completeness, free/total storage, queue count/bytes, approximate queued capacity, current batch/title/progress, recent verified transfers/removals/updates, watcher and scan state, newly indexed count, and actionable failures.
- Keep free-space and queue estimates explicit about conversion uncertainty. Recalculate exact capacity per prepared book before every write.
- Combine server-side job summaries with browser-only device summaries in the UI. Persist only bounded safe summaries needed after reload; do not send device inventory, serial, paths, sidecar data, raw errors, or debug logs to the server.
- Coalesce repetitive success and batch progress. Keep a failure until acknowledged/resolved and provide the smallest valid action: **Retry failed**, **Open queue**, **Reconnect**, **Rescan**, or **Open Settings**.
- Put technical logs, cache diagnostics, physical probes, and export controls under **Advanced**. Routine household use should not display them.
- Finish Milestone 2's context restoration across the queue, details, match review, series, shelves, inbox, activity center, Settings, and bulk bars.
- Complete responsive/a11y polish: predictable focus, escape/back behavior, reduced motion, high zoom, target sizes, and no horizontal overflow.

Targeted validation:

- Test deterministic phase transitions, concurrent/coalesced events, bounded history, reload/last-seen display, capacity math, partial batch summaries, source loss/recovery, retry wiring, redaction, and stale-state downgrades.
- Test keyboard-only and screen-reader operation plus wide desktop, laptop, tablet, phone, high zoom, long titles, and maximum queue/error text.
- Run physical connect, inventory, queued transfer, removal, update, disconnect, reconnect, and failure/recovery while observing the center.

Exit gate:

- At any point the user can answer: **Is the library healthy? Is the Kindle ready? What is happening now? What succeeded? What needs me?**
- The default page remains quiet when everything is healthy.

Rollback:

- Revert to the existing top-bar status and retain the underlying operation summaries for diagnostics. No device or source state depends on the drawer.

### Milestone 10 — Bounded `GetPartialObject` capability probe

**User-visible outcome:** None until physically proven. The milestone determines whether cache-miss metadata can be read without downloading an entire PalmDB/MOBI file.

#### 10A. Add the protocol primitive

- Add MTP operation `GetPartialObject` (`0x101b`) and a `readObjectRange(handle, offset, length)` abstraction below the Kindle metadata reader.
- Permit it only when DeviceInfo advertises the operation. Never infer support from a model name or fixture.
- Enforce unsigned arithmetic, offset-plus-length overflow checks, requested allocation cap, response-code/transaction validation, returned-byte count agreement, EOF semantics, abort, inactivity deadline, aggregate deadline, and one-operation-at-a-time transport ownership.
- Treat a fatal USB/transport/protocol-desynchronization error as connection-ending. Do not attempt a full-read fallback on a potentially desynchronized session.
- Keep `GetObjectPropList` disabled and add a contract test proving it is never emitted.

#### 10B. Add a development-only physical probe

- Place the probe under Advanced diagnostics, never normal inventory or Settings.
- Require the user to select one existing non-protected test object explicitly.
- Read small bounded ranges at start, overlapping offsets, middle, end, and beyond/at EOF as applicable.
- Compare overlaps and, only for a small object below the existing safe full-read cap, compare against a bounded `GetObject` reference.
- Record operation support, requested/returned byte counts, response codes, timing, EOF behavior, and equality only. Do not log file bytes or parsed metadata.
- Run no more than once per connection unless the user explicitly starts it again.

#### 10C. Integrate only after the physical gate passes

- Refactor PalmDB/MOBI metadata parsing behind a bounded byte-source interface.
- Range-read the PalmDB header and record table, validate all record offsets against current ObjectInfo size, then request only the bounded record-zero/MOBI/EXTH region needed for matching metadata.
- Account both requested and returned partial bytes in inventory budgets and diagnostics.
- On a nonfatal unsupported/invalid-operation response, disable partial reads for the rest of that connection and use the existing bounded full-object path. On a fatal transport error, retire the connection without fallback.
- Do not use partial reads to inspect a whole KFX/AZW8 book.

Targeted validation:

- Test exact operation parameters, response transaction IDs, boundary/EOF behavior, overflow, excessive length, over-return, truncation, count mismatch, unsupported response, abort, timeout, and fatal transport errors.
- Test segmented PalmDB fixtures whose headers/tables cross range boundaries and assert metadata equality with the existing reader.
- Test one-session downgrade, no operation when unadvertised, total-byte accounting, and no fallback after a fatal error.

Physical decision gate:

- Capture advertised operations and repeat correct bounded reads before/after reconnect on `0x1949 / 0x9981`.
- Compare metadata, total bytes, and time against the existing full reader across representative small and large supported files.
- If support is absent, inconsistent, corrupting, or not materially beneficial, record **do not enable** and keep the existing reader. That is a completed milestone.
- If it passes, ship behind an internal `partialMetadataReads` gate that remains off until the full physical inventory/matching acceptance run succeeds.

Rollback:

- Disable the internal gate. No durable migration or cache format change is required.

### Milestone 11 — Bounded KFX/AZW8 sidecar metadata reader

**User-visible outcome:** Unmanaged KFX/AZW8 books with valid supported sidecars can participate in strong matching without downloading the entire book.

#### 11A. Build an exact reusable sidecar locator

- Preserve normal broad `.sdr` pruning during hierarchy display.
- After live hierarchy enumeration, associate a KFX/AZW8 object only with its exact sibling `<book stem>.sdr` directory.
- Inspect only the allowlisted two-level route `<book>.sdr/assets/metadata.kfx` for this milestone.
- Require exact parent relationships from the current inventory, not string-prefix matching alone.
- Apply provisional ceilings of 2,000 associated books, 32 inspected direct children per folder, 4 MiB per metadata sidecar, and 128 MiB total. Validate/freeze these values against physical samples before release.
- Do not expose sidecar assets as ordinary device books or as removal targets.

#### 11B. Implement the minimum parser

- Collect legally usable, sanitized fixtures from controlled physical samples and record format/version observations before coding inference rules.
- Add a dedicated bounded parser for only the observed container structures and fields needed for title, authors, identifiers, and language.
- Enforce container length, section and field counts, nesting depth, scalar/string size, decoded-value total, duplicate/conflicting field rules, and supported versions.
- Perform no rendering, scripting, unrelated asset traversal, or whole-book fallback.
- Treat output as normal non-authoritative metadata evidence under the same strong matching rules used by PalmDB/MOBI.
- For the first accepted release, reread the small current sidecar rather than expanding the portable cache format. Revisit caching only after measured need.

Targeted validation:

- Valid sanitized fixtures plus malformed, truncated, oversized, deeply nested, duplicate/conflicting, hostile, and unsupported-version containers.
- Exact sibling/parent association; reject wrong stem, wrong parent, duplicate sidecars, deeper alternatives, and unrelated assets.
- Assert the full KFX/AZW8 object is never requested.
- Missing, ambiguous, or invalid sidecars must retain incomplete/unknown matching evidence rather than become absent or confirmed.

Physical acceptance:

- Use at least one real unmanaged KFX/AZW8 sample on `0x1949 / 0x9981`.
- Verify the actual sidecar path, bounded bytes, parsed metadata, match result, reconnect behavior, and diagnostics proving the main KFX object was not downloaded.

Rollback:

- Keep an internal `kfxSidecarMetadata` gate off until physical acceptance. Disabled or failed parsing returns exactly to today's conservative unsupported-format behavior.

### Milestone 12 — Kindle reading progress and reading state

**User-visible outcome:** Strongly matched books can show validated browser-local progress and reading status, while unknown evidence remains visibly unknown.

#### 12A. Physical format discovery

- Reuse Milestone 11's exact sidecar locator and add a read-only diagnostic allowlist for AZW3 `.azw3f`/`.azw3r`, KFX `.yjf`/`.yjr`, and legacy MOBI `.mbs`/`.mbp1` candidates.
- Capture bounded local fixtures from controlled not-started, mid-book, and completed states for a managed PDOC AZW3. Add KFX or legacy formats only when actually present.
- Repeat after closing the book, disconnect/reconnect, and Kindle reboot to establish which fields and timestamps are stable.
- Define no authoritative Read/Unread inference before this evidence exists. Progress near 100% alone must not silently become **Read**.

#### 12B. Parser and evidence model

- Add format-specific bounded parsers with the same malformed/truncated/oversized/version-drift/conflict posture as other Kindle parsers.
- Produce a browser-only model with `status: unread | in-progress | read | unknown`, optional validated `progressPercent` in `0–100`, optional last-read time, provenance/format, and `freshness: live | last-seen`.
- Attach evidence only to one strongly and uniquely matched current Kindle object. Possible or ambiguous matches receive no progress association.
- Missing, malformed, unsupported, stale, unenumerated, or contradictory evidence resolves to `unknown`, never `unread`.
- Use Read/Unread only when an explicit physical field/combination is proven. Keep this distinct from the manual Favorite/Want-to-read annotations in Milestone 7.
- Never write, rename, replace, or delete a sidecar.

#### 12C. Reconciliation and UI

- Carry evidence on the browser-local inventory model and map it to opaque catalog book IDs only after matching.
- On disconnect or lifecycle retirement, remove action authority and either label a bounded snapshot **Last seen** or downgrade it to unknown according to the validated evidence policy.
- For pagination-independent filtering, derive bounded opaque book-ID sets in the browser and reuse the catalog's scoped include-ID query. Never send progress values, timestamps, raw sidecar data, paths, or device identity to the server.
- Add a thin accessible progress track beneath each grid cover and a compact list equivalent. Unknown must not look like 0%.
- Add a separate Read/Unread shape/location from the top-right Kindle-presence check, with text/tooltips so color is not the only signal.
- Add the distinct filter **Any / Unread / In progress / Read / Unknown** and recompute it correctly on profile switch, reconnect, and pagination.

Targeted validation:

- Controlled fixtures for every accepted state plus malformed, truncated, oversized, duplicate, conflicting, and unsupported formats.
- Exact/possible/ambiguous association, object/aggregate caps, no unrelated `.sdr` traversal, and zero sidecar mutation.
- Disconnect, BFCache, long hidden interval, profile switch, reconnect, and reboot freshness semantics.
- Pagination-independent scoped ID filtering and proof that no backend request contains progress, timestamp, or raw evidence.
- Grid/list accessibility, badge separation, unknown-versus-zero behavior, and narrow/high-zoom rendering.

Physical acceptance:

- Validate a managed PDOC AZW3 at not-started, mid-book, and completed states before and after reconnect/reboot.
- Confirm the displayed value/state against the Kindle itself and byte-check that every inspected sidecar is unchanged.
- Accept additional KFX/legacy support format by format; unsupported formats remain unknown.

Rollback:

- Separate internal gates for discovery, parsing, and UI default off until their physical evidence exists. Disabling them removes progress/filter presentation without affecting catalog or device contents.

### Milestone 13 — Evidence-based safe-write cadence

**User-visible outcome:** A clean repeat connection may become faster, but no device mutation occurs without a current-session exact-byte write proof.

#### 13A. Decide whether change is worthwhile

- Use Milestone 0 and activity-center timings to compare self-test latency against enumeration, metadata reads, cache work, and total ready time.
- Agree a material user-visible improvement threshold before changing behavior.
- If the self-test is not a meaningful contributor, retain automatic testing on every connection and close this backlog item with the measurements.

#### 13B. Adaptive policy only if justified

- Store a bounded browser-local attestation keyed by the existing pseudonymous installation/device/storage evidence. Include policy version, VID/PID, reported model/device version, selected interface, storage identity, last clean proof time, and an expiry—not raw serial or inventory.
- Always run the self-test after first use/browser storage loss, unknown device/storage, app or policy version change, expired proof, changed device/interface fingerprint, USB/MTP fault, unclean lifecycle, interrupted or unverified write, pending recovery, cleanup failure, or explicit diagnostic request.
- A clean repeat browse-only connection with valid evidence may enumerate and reconcile first while explicitly showing **Safety check will run before changing Kindle**.
- Centralize every mutation behind one concurrent-safe `ensureCurrentConnectionWriteProof()`: Send, Remove, Update, and Kindle-resident cache mutation must run exactly one self-test in the current connection, refresh affected inventory/reconciliation, and only then resume.
- Pending recovery never takes the shortcut. Any relevant fault invalidates the attestation before presenting the error.
- Browser storage loss or an unrecognized state fails back to the current eager self-test.
- Keep the manual diagnostic test under Advanced. Do not add cadence options to Settings.

Targeted validation:

- Every eager trigger above, valid clean skip, expiry/version change, one test for concurrent mutation requests, inventory changes during deferred proof, cache-write gating, recovery gating, failure/abort/cleanup invalidation, and lifecycle retirement.
- Assert that no mutation-capable call path bypasses `ensureCurrentConnectionWriteProof()`.
- Assert the UI never labels deferred evidence as current-session passed.

Physical acceptance:

- First connect tests automatically; a qualifying clean second browse-only connect becomes measurably faster.
- First Send, Remove, Update, or cache write in that connection runs the deferred self-test once and then completes normally.
- Repeat after browser update/fingerprint change, Kindle reboot, cable/USB fault, interrupted transfer, and recovery.
- Confirm exact self-test cleanup and byte-identical host originals.

Rollback:

- Internal policy defaults to `always` until acceptance. Rollback selects `always`; stored attestations become inert and require no migration.

### Milestone 14 — Integrated release, deployment, and omission audit

**User-visible outcome:** Every accepted backlog feature works together on the real household deployment without regressing source immutability, Kindle safety, or UI clarity.

Tasks:

- Freeze feature work and perform a requirement-by-requirement audit using the matrix in Section 10. Every acceptance sentence must point to code, automated evidence, physical evidence where required, or an explicit **not enabled** research decision.
- Upgrade a copy of the current household `/data`, restart twice, and prove all new migrations are idempotent and preserve profiles, roots, stable books, deliveries, metadata/cover overlays, queues, shelves, annotations, provider configuration, and issue disposition.
- Repeat cold backup/restore and derived catalog/cache rebuild. Confirm whether backups contain provider credentials and retain restrictive ownership/mode.
- Run the complete Node 24 `npm run check` once on the final candidate after the milestone-focused tests are green. Record the actual file/test/build result instead of a historical count.
- Build the canonical hardened Docker image and repeat health/readiness, read-only root, read-only container filesystem, non-root UID/GID, origin/Host policy, Settings read-only mode, restart, shutdown, source/cover streaming, and bounded-response checks.
- Verify `linux/amd64` and `linux/arm64` artifacts and update dependency/license/SBOM/provenance evidence when dependencies or the image changed.
- Test the real Google Books key Settings flow and real Open Library redirect flow from the intended container egress policy.
- Test both real household profiles and every configured read-only mount: add/change/rename a source, recover a temporarily unavailable mount, and verify original hashes before and after scanning, editing, queueing, transfer, update, duplicate review, and rebuild.
- Test the intended private HTTPS origin and WebUSB permission behavior. Localhost or mocks do not establish remote-origin acceptance.
- Run one consolidated physical Kindle journey covering only physically accepted capabilities: connect, eager/deferred safe-write path as applicable, inventory/cache, confirmed and manual-resolved matches, Kindle-only comparison, queue batch, forced partial failure/retry, metadata/cover update, exact removal/cleanup, series queue, activity states, KFX metadata if enabled, progress/state if enabled, disconnect, reconnect, and recovery.
- Inspect the Kindle: transferred/updated books index, open, navigate, show the intended cover, and do not leave unintended duplicates or diagnostic/cache artifacts visible in the library.
- Measure connection phase timings, inventory bytes, partial/full metadata reads, sidecar reads, queue response sizes, browser memory for the maximum accepted EPUB, and catalog query responsiveness at the supported large-library corpus.
- Update `README.md`, `PROJECT_HANDOFF.md`, `AGENTS.md` where durable rules changed, server/deployment guides, release checklist, backup/restore procedure, troubleshooting, and the final feature audit.

Exit gate:

- Automated, Docker, provider-live, real-mount/private-origin, and required physical evidence are recorded separately and accurately.
- Every shipped backlog item is marked implemented in `BACKLOG.md` with a link to its evidence; rejected device experiments record why they remain disabled.
- The omission matrix contains no unmapped requirement and the final audit finds no silently omitted feature.
- Source files remain byte-identical and the release retains all device-write invariants.

## 6. API and event plan

Route names may be adjusted to match the established router, but responsibilities and trust boundaries must remain:

| Surface | Purpose | Key controls |
| --- | --- | --- |
| `GET /api/settings/cover-providers` | Sanitized global provider state | Never serialize secrets |
| `PUT/DELETE /api/settings/cover-providers/:provider` | Replace or remove a fixed provider credential | Settings write mode, Host/Origin, revision, idempotency, fixed provider enum |
| `POST /api/settings/cover-providers/:provider/test` | One bounded provider health test | Current revision, timeout, fixed query, safe error codes |
| `GET /api/profiles/:profileId/send-queue` | Hydrated queue and stale reasons | Profile scope, response ceiling |
| `POST/PATCH/DELETE .../send-queue` | Bounded add/reorder/remove/clear | Stable IDs, idempotency, optimistic queue revision |
| `POST /api/profiles/:profileId/books/selection` | Resolve filters to bounded opaque book IDs without pagination | Same catalog query validator, explicit overflow |
| `GET /api/profiles/:profileId/books/:bookId/details` | Details drawer DTO | Existing profile/source containment; device-anonymous response |
| `GET/POST/PATCH/DELETE .../shelves` | Smart-shelf lifecycle | Versioned query codec, limits, revision/idempotency |
| `PATCH .../books/:bookId/annotation` | Favorite/Want-to-read state | Profile/book scope, fixed booleans |
| `GET/PATCH .../issues` | Issue query and disposition | Derived facts, stable signatures, bounded history |
| `GET .../metadata-search` | Bounded provider metadata candidates | Fixed providers/endpoints, timeout/rate/candidate caps |
| `POST .../metadata-import` | Apply selected candidate fields as overlays | Expected source hash/revision, atomic cover rollback |

Proposed typed/coalesced SSE additions:

- `queue.updated` with profile and revision only;
- `shelf.updated` with profile and affected opaque shelf ID;
- `annotation.updated` with profile/book IDs;
- `issues.updated` with profile and aggregate count/version;
- existing book/root/delivery events reused where possible.

Do not stream password inputs, provider response bodies, full filtered ID lists, activity logs, raw paths, match candidates, Kindle objects, or reading evidence over SSE.

## 7. Verification strategy

### Quota-conscious implementation loop

For each milestone:

1. Batch the schema/contracts/service/client/view work into one coherent behavior slice.
2. Run only the smallest directly affected test file or explicit new regression while iterating.
3. Do not repeat an unchanged check that already passed.
4. Run client typechecking early only when shared types or broad controller/view contracts changed.
5. Run `npm run check` once at that releasable slice's final handoff, or earlier only after a cross-cutting failure justifies it.
6. Run Docker, provider-live, or physical checks only for milestones that touch those boundaries.

### Automated coverage by layer

- **Pure/domain:** action capabilities, queue eligibility, series ordering, shelf query codec, issue signatures, provider redirect state machine, match-review reasons, decision signatures, device read-policy decisions, and reading-state inference.
- **Database/migrations:** forward upgrade, restart, idempotency, optimistic revision, operation replay, profile deletion, catalog rebuild retention, bounds, pruning, backup/restore, and explicit removed-secret state.
- **HTTP/security:** runtime validators, opaque/profile scope, Host/Origin, Settings lock, body/response/time/concurrency caps, aborts, fixed provider IDs/URLs, secret redaction, and late-result guards.
- **Client/controller:** stale responses, profile switches, SSE coalescing, reload/context restoration, queue lifecycle, partial batch retry, drawer focus/back behavior, match decisions, update failure phases, and activity projection.
- **MTP/USB:** exact operation encoding, one transaction/lease, abort/timeouts, fatal retirement, exact object revalidation, no overwrite, exact cleanup, range boundaries, sidecar traversal limits, and no forbidden `GetObjectPropList`.
- **Integration:** real API-backed pages, 10,000-row catalog behavior, cross-page selection, source/edit races, scanner issue lifecycle, temporary mount loss, provider candidate import, and byte-identical sources.
- **Accessibility/visual:** keyboard-only flow, focus return/trap, screen-reader labels/live regions, non-color status, reduced motion, high zoom, long text, and responsive overflow.

### Physical evidence matrix

| Change | Physical Kindle required before enablement? |
| --- | --- |
| Provider Settings/Open Library | No Kindle; live providers and real Docker egress required |
| Details/density/shelves/health | No, except device-dependent labels exercised in final journey |
| Queue/batch transfer | Yes |
| Manual Possible-match decision | Yes |
| Update on Kindle | Yes |
| Series queue actions | Yes for device-dependent missing-volume behavior |
| Activity/device center | Yes for phase/capacity/operation truthfulness |
| `GetPartialObject` | Yes; advertised/mocked support is insufficient |
| KFX metadata | Yes with an actual unmanaged KFX/AZW8 sample |
| Reading progress/state | Yes for every enabled format/state |
| Safe-write cadence change | Yes for every trigger, deferred mutation, and recovery path |

## 8. Rollout and rollback

- Land additive schema migrations before code that writes new rows. Old deployments must ignore new tables safely; do not require a destructive down migration.
- Preserve a cold `/data` backup before each schema-bearing deployment and test restore with the exact candidate image.
- Release provider repair, browsing foundation, queue, matching decisions, update, discovery, and maintenance as separate slices so one UI feature can be rolled back without reverting device protocol work.
- Keep physical-device experiments behind internal defaults-off capability gates. Do not expose a growing list of experimental toggles in Settings or Compose.
- A runtime provider can be disabled independently. Local upload/paste, catalog scanning, conversion, and Kindle transfer must continue without network providers.
- Queue, shelves, annotations, issues, and provider rows are inert if their UI is rolled back; never delete user intent during rollback.
- Browser-local decision/progress stores are versioned. Unknown/new versions are ignored safely rather than partially interpreted.
- MTP range reads fall back only after nonfatal capability failure; transport faults retire the connection. KFX/progress failures fall back to unknown metadata/status.
- Safe-write rollout always retains `always` as the immediate rollback mode.
- If an Update leaves both verified new and old managed copies, present an exact cleanup task. Never auto-delete during rollback or startup.

## 9. Principal risks and controls

| Risk | Control |
| --- | --- |
| Stale queue sends changed/unwanted bytes | Store queued hash/presentation; refetch and revalidate everything before conversion/MTP |
| Cross-page bulk selection exceeds safe work size | Explicit selection/queue ceilings and overflow errors; never silent truncation |
| Update loses the only readable copy | Upload, verify, and durably identify new copy before exact old-copy deletion |
| Manual match binds the wrong edition forever | Reversible browser-local decision bound to exact live signature/device/profile/book version |
| Manual match becomes deletion authority | Fresh complete inventory and exact ObjectInfo revalidation remain mandatory |
| Provider redirect creates SSRF/open proxy | Fixed initial URLs and per-hop provider state machine; no client URL input |
| API key leaks through UI/log/backup assumptions | Never serialize/prefill; systematic redaction tests; document protected backups |
| Smart shelves become an arbitrary query engine | Versioned fixed-field codec, no SQL/expression input, count/byte caps |
| Issue/history tables grow indefinitely | Stable signatures, automatic retirement, bounded histories and pruning |
| Provider bulk lookup causes quota or UI noise | Explicit batch cap, concurrency/rate/backoff, review queue, coalesced events |
| Series inference invents missing books | Exact effective series key; gaps are hints only; decimals handled conservatively |
| Activity center contradicts action buttons | One shared capability projection and event vocabulary |
| Partial MTP operation corrupts session | Defaults-off physical gate, strict transactions, fatal retirement, safe fallback only |
| Sidecar format drift yields false metadata/state | Strict allowlists/versions/bounds; failure becomes unknown; physical fixtures |
| Near-complete progress is mislabelled Read | Read/Unread requires separately proven explicit evidence |
| Skipped self-test permits unsafe mutation | Central current-session proof guard; eager triggers; `always` rollback |
| New UI overwhelms the simple page | Details, shelves, inbox, activity, and advanced diagnostics are progressively disclosed |
| Migration or rollback loses household intent | Additive tables, stable IDs, cold backup/restore rehearsal, inert rollback state |

## 10. Backlog omission matrix

| `BACKLOG.md` objective | Primary milestone | Required completion evidence |
| --- | --- | --- |
| Reconsider automatic safe-write test cadence | 0, 9, 13 | Phase measurements; trigger/fault tests; physical decision; eager fallback or accepted adaptive flow |
| Probe partial-object metadata reads | 10 | Protocol tests; physical support/correctness/benefit result; enabled integration or explicit rejection |
| Add bounded KFX sidecar metadata reader | 11 | Bounded parser/association tests; actual KFX physical reconciliation; no whole-book read |
| Read Kindle progress and reading state | 12 | Controlled physical states; bounded parsers; browser-local lifecycle/filter/UI evidence; zero mutation |
| Manage cover-provider API keys in Settings | 1B | Migration/restart; compact GUI; live key test; removal; redaction; no normal Compose requirement |
| Follow Open Library redirects | 1A | Valid two-hop and hostile redirect tests; live search/preview/import; updated egress docs |
| Persistent Send-later queue | 3 | Durable cross-page/profile queue; all-filtered bounds; physical batch/failure/retry |
| One-click Update on Kindle | 5 | Prepare/upload/verify/record/delete order; injected faults; physical edited EPUB replacement |
| Explain and resolve Possible matches | 4 | Evidence UI; confirm/reject/undo; exact scoping; changed-object tests; physical reconnect |
| Read-only Book details drawer | 2 | Complete DTO; actions; filter shortcuts; URL/back/focus/scroll/accessibility |
| Series-first browsing | 6 | Stable order/gap/duplicate tests; queue actions; profile/device correctness |
| Metadata and library-health inbox | 8 | Issue lifecycle; candidate diff/import; bulk controls; duplicate non-mutation; `/data` overlays |
| Smart shelves and personal state | 7 | Versioned CRUD/pinning; per-profile persistence; offline Kindle semantics; manual/device distinction |
| Compact activity and device center | 9 | Truthful phases/capacity/history; coalescing; redaction; recovery actions; physical flow |
| Display density and remembered context | 2, 9 | Per-profile restore; wide/narrow/high-zoom/a11y pass across every new surface |

The audit is complete only when every row has a concrete code reference, automated test reference, and—where marked—physical or live-provider evidence. A backlog sentence cannot be considered implemented merely because a neighboring feature exists.

## 11. Explicitly outside this plan

- Authentication/accounts or treating profiles as security boundaries.
- Cloud conversion, cloud book storage, or sending source book bytes to metadata providers.
- Backend USB/MTP access or server-side conversion.
- Calibre as a runtime dependency.
- Synology/vendor-specific packaging or application-managed SMB/NFS mounts.
- Automatic deletion/overwrite, automatic duplicate merging, or editing mounted source files.
- Enabling `GetObjectPropList` on the known Kindle.
- A browser ebook reader, OPDS server, annotations/highlight sync, or unrelated feature expansion.
- Support claims for untested Kindle models, browsers, or sidecar formats.

## 12. Final definition of done

The backlog program is complete only when:

1. Every accepted backlog item has shipped code, bounded contracts, tests, documentation, and evidence in the omission matrix.
2. Every research-gated item has either passed real-device acceptance or records a clear no-enable decision while preserving the safe existing behavior.
3. The main library and Settings remain simple under real household use; advanced controls are discoverable but not permanently exposed.
4. Queue, matching, update, removal, progress, and activity never disagree about current device authority.
5. No feature alters a mounted original, broadens deletion authority, bypasses current write proof, or sends raw Kindle/book data to the backend or cloud.
6. The final `npm run check`, hardened Docker lifecycle, backup/restore/rebuild, real provider, real mount/private HTTPS, and required physical Kindle checks pass and are reported separately.
7. A final requirement-by-requirement audit confirms that no backlog feature or acceptance condition was accidentally omitted.
