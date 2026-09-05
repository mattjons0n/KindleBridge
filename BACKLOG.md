# Kindle Bridge — Backlog

Detailed implementation sequence, dependencies, validation, rollout, and omission audit: [`outputs/kindle-bridge-backlog-build-plan.md`](outputs/kindle-bridge-backlog-build-plan.md).

## Reconsider automatic safe-write test cadence

**Status:** Decision implemented — retain the automatic exact-byte test on every clean connection. The supplied physical timings put this proof at roughly 0–1 second while inventory took roughly 20–21 seconds, so an adaptive skip would add risk without materially fixing the reported delay. The tested adaptive-policy helpers remain inert and the shipped policy remains `always`.

Evaluate whether the exact-byte create/read/compare/delete test needs to run after every clean Kindle connection, or whether it can run only on first use and again after relevant application/device changes, browser or USB faults, interrupted transfers, or an explicit diagnostic request.

Any future change must preserve:

- collision-resistant, no-overwrite book transfers;
- current-session ownership of every created MTP handle;
- exact-handle cleanup and the bounded recovery journal;
- post-transfer handle, parent, filename, and size verification;
- fail-closed behavior after an interrupted or unverified write.

Before changing the policy, measure the safe-write test separately from inventory on the physical `0x1949 / 0x9981` Kindle. Kindle Bridge now labels those phases separately, prunes `.sdr` sidecars, skips redundant managed-file reads, and maintains a portable Kindle-resident metadata cache with a browser-local fallback. Measure again before assuming the self-test is the remaining bottleneck; a first scan and genuine cache misses can still require bounded full-object reads.

Acceptance requires tests for every retained trigger and failure path, plus a fresh physical Kindle transfer/reconnect/recovery run.

## Probe partial-object metadata reads on the physical Kindle

**Status:** Software probe implemented, default off — the bounded protocol primitive and development-only diagnostic are present, while production metadata reads remain unchanged until the physical `0x1949 / 0x9981` capability and benefit gate passes.

Run a bounded, read-only physical capability probe for MTP `GetPartialObject` (`0x101b`) on the known `0x1949 / 0x9981` Kindle. If the device advertises and correctly implements it, a future version could read only the PalmDB/MOBI metadata region on a cache miss instead of downloading an entire supported book.

Do not enable MTP `GetObjectPropList` (`0x9805`) for this device. Calibre's pinned libmtp table maps [the exact `0x1949 / 0x9981` model](https://github.com/kovidgoyal/calibre/blob/2601151d9233e8312b4e307222a9b3b05e2729bd/src/calibre/devices/mtp/unix/upstream/music-players.h#L2602-L2605) to `DEVICE_FLAGS_ANDROID_BUGS`, whose [definition explicitly includes the broken `GetObjectPropList` flag](https://github.com/kovidgoyal/calibre/blob/2601151d9233e8312b4e307222a9b3b05e2729bd/src/calibre/devices/mtp/unix/upstream/device-flags.h#L310-L319). The current implementation must continue using conservative per-object metadata reads unless new physical evidence and fault tests justify a different path.

Acceptance for a partial-read implementation requires exact operation-support capture, bounded byte/range handling, malformed/truncated response tests, fallback to the existing full-object path, transport-fault retirement, and a fresh physical inventory/matching run. A synthetic DeviceInfo fixture is not evidence of device support.

## Add a bounded KFX sidecar metadata reader

**Status:** Bounded reader implemented, default off — parser, exact sidecar association, limits, and hostile fixtures are present; real KFX/AZW8 physical-format and reconciliation acceptance is still required before enabling it.

Real KFX metadata uses a different container from PalmDB/MOBI. Calibre handles it with a dedicated reader, often targeting `<book>.sdr/assets/metadata.kfx`; Kindle Bridge now avoids downloading an entire KFX/AZW8 book only to fail the MOBI parser. Until the bounded reader passes its physical gate and is enabled, unmanaged KFX/AZW8 objects remain visible and make metadata-based absence unknown. Managed Kindle Bridge filename tokens continue to provide their existing stronger evidence.

Acceptance requires strict container/field/count/byte bounds, malformed and hostile fixtures, exact parent-sidecar association, no traversal of unrelated `.sdr` assets, no whole-book fallback, and physical reconciliation against the known Kindle.

## Read Kindle progress and reading state from sidecars

**Status:** Browser projection, grid/list UI, status filtering and durable Read books shelf integration implemented, default off for automatic reading detection. The physical format/state matrix still needs to establish trustworthy semantics, including an explicit Read/Unread field. See `outputs/onboarding-reading-build-plan.md`.

Add best-effort, browser-local reading progress for books that have a strong exact association with an object in the current live Kindle inventory. MTP does not expose a standard semantic progress property; the implementation must selectively enumerate and download only the small Kindle reader-data sidecars associated with that exact book. Candidate reverse-engineered KRDS files are AZW3 `.azw3f`/`.azw3r`, KFX `.yjf`/`.yjr`, and legacy MOBI `.mbs`/`.mbp1`. Known fields can include last and furthest positions, an estimated percentage, a timestamp, and local reading-time data. See the [KRDS parser](https://github.com/K-R-D-S/KRDS/blob/9c8a0b0ec9cb6af72fba900a6f9b09f92de477de/krds.py) and the [current format observations](https://github.com/zevisvei/kindle-reading-dashboard/blob/main/docs/KRDS-format.md).

Keep progress evidence separate from an authoritative Kindle **Mark as Read/Unread** state. That explicit modern state may live in a system database or Amazon cloud state that stock MTP does not expose. The browser model should therefore distinguish `unread`, `in-progress`, `read`, and `unknown`, with optional validated `0–100` progress, last-read time, provenance, and live/last-seen freshness. Missing, unsupported, malformed, stale, unenumerated, or ambiguously matched sidecars must resolve to `unknown`, never `unread`. The exact evidence rules for `read` and `unread` must be fixed only after the physical probe; reaching or approaching the end must not silently become an authoritative device flag.

Dashboard requirements:

- Put a thin faded progress track directly beneath the cover on every grid card. Fill it with the dashboard accent color only when a validated percentage is known; accompany it with accessible percentage text and progress semantics so color is not the only signal. Unknown progress must not look like zero progress.
- Add a compact equivalent in list view.
- Add a separate read-state icon/badge for known **Read** and **Unread** states. It must occupy a different card location and use a different visual shape from the existing top-right Kindle-presence check, with explicit accessible text and tooltips. Unknown state must not receive a misleading Read or Unread icon.
- Add a distinct **Reading status** filter with **Any**, **Unread**, **In progress**, **Read**, and **Unknown**. Keep it separate from both the existing Kindle-presence filter and the sort-order control. Filtering must remain correct across pagination and profile switches; bounded opaque book-ID selection may be reused without sending raw sidecar data to the service.

The current broad `.sdr` pruning must be relaxed only through targeted inspection after exact parent/book association. Allowlist sidecar extensions and paths; enforce strict object-count, nesting, per-object, and aggregate-byte limits; use conservative `GetObjectHandles`/`GetObjectInfo` plus targeted `GetObject`; and keep `GetObjectPropList` disabled on `0x1949 / 0x9981`. Never write, rename, replace, or delete a Kindle sidecar. Raw sidecar bytes, exact positions, timestamps, reading history, and derived progress remain in the browser and are never persisted by or sent to the backend/cloud.

The subsequently approved **Read books** shelf adds one narrow exception: opaque per-profile/book completed membership persists in server annotations after an exact explicit Read observation. No raw reading evidence, device identity, position, percentage or Kindle timestamp accompanies it. Membership survives disconnect/removal; it is history, not a claim about current device state.

Acceptance requires malformed, truncated, oversized, duplicate, version-drift, and unsupported-sidecar fixtures; exact and ambiguous association tests; lifecycle/disconnect downgrade tests; correct accessible grid/list rendering and filtering; and a bounded physical probe on the known `0x1949 / 0x9981` Kindle. Test controlled not-started, mid-book, and completed states before and after reconnect/reboot for a managed PDOC AZW3 plus any KFX or legacy sample actually present. A missing sidecar or mock-only success is not device evidence.

## Manage cover-provider API keys in Settings

**Status:** Implemented — Google Books credentials are managed through the compact Settings UI and durable `/data` state. A real user-supplied key still needs live deployment acceptance.

Make the application Settings page the normal place for a user to add, replace, test, and remove API keys used by online cover providers, beginning with Google Books. A standard Docker deployment must not require operators to maintain a long list of optional environment variables; the container should start normally and Open Library plus all fully local features should continue working when no key is configured.

Keep the page simple: use one compact **Online cover search** section, show only the providers that actually require configuration, mask a saved key, and put infrequent actions such as replacing, testing, or removing it behind a small edit control rather than adding permanent fields throughout Settings. Clearly show **Not configured**, **Working**, or a concise actionable failure without exposing the secret.

Store configured keys durably under `/data` as server-side secrets. Never return a saved key to the browser, include it in logs/events/errors, or place it in browser storage. Settings mutations must follow the existing read-write-mode and origin protections. The Google Books search path should resolve its key from this persisted setting; deployment-time key configuration must not be required for the normal workflow.

Acceptance requires persistence across container restart, add/replace/remove/test flows, masked settings reads, redaction tests, a no-key Google Books error that points the user to Settings, and confirmation that Open Library and local cover upload/paste remain usable without any API key.

## Follow Open Library's validated cover redirects

**Status:** Implemented — the fixed provider flow accepts only the validated ID-bound HTTPS Open Library/Archive.org chain. A live provider search/import remains deployment acceptance rather than mock evidence.

Open Library's `covers.openlibrary.org` endpoint can redirect a selected cover through an Archive.org cover archive and then to an Archive.org data host. Extend the existing manual redirect validation to accept only the expected HTTPS Open Library/Archive.org cover chain for the exact requested cover ID and size. Do not enable unrestricted redirects or accept an arbitrary host, path, cover ID, scheme, port, or URL containing credentials.

Keep all remote fetching server-side and continue returning only same-origin cover previews to the browser. Update the Docker egress guidance for the narrowly required Archive.org hosts.

Acceptance requires a successful test for the observed two-hop redirect chain plus rejection tests for HTTP downgrades, unrelated or lookalike hosts, mismatched cover IDs/sizes, credentials, excessive redirects, and unexpected paths. A live Open Library cover search/import should also be included in deployment acceptance because mocked redirects cannot prove the provider's current behavior.

## Usability roadmap

**Status:** Software implementation complete as a release candidate — milestones 1–9 are integrated, bounded, and covered by focused automated tests. The final integrated Node 24/container gate, physical Kindle, live-provider, and real-mount/private-origin acceptance remain explicitly separate evidence.

These improvements should remove steps from the common **find → choose → connect → transfer/manage** journey without turning the clean library page or Settings into a control panel. Keep secondary detail, diagnostics, and maintenance actions progressively disclosed.

### 1. Add a persistent Send-later queue

Allow a user to add eligible books to a durable, profile-specific queue before a Kindle is connected. Replace the repeated disabled **Connect to send** card action with **Add to queue** while disconnected; keep Kindle connection as one clear global action. Retain queued books across pagination, filters, grid/list changes, reloads, and temporary source unavailability.

Provide **Select visible** and **Select all filtered missing books**, then show a queue review containing exact titles, eligibility, expected conversion, total source size, and—when connected—estimated device-space impact. Connecting a Kindle should lead to one **Transfer all** action using the existing verified batch flow. Revalidate source, presentation revision, device state, capacity, and Kindle presence immediately before every transfer; stale or newly ineligible entries must be explained rather than silently sent. After a partial failure, retain only unsent items for retry.

Acceptance requires queue add/remove/clear/reorder, cross-page and all-filtered selection, per-profile isolation, reload persistence, stale-entry handling, deduplication, accessibility, batch-fit estimation, and physical Kindle transfer/retry coverage. Queue persistence must not move conversion or MTP work out of the browser, and WebUSB connection must remain user initiated.

### 2. Add one-click Update on Kindle

When metadata or a cover is edited and an exact prior KindleBridge presentation is still on the connected Kindle, offer **Update Kindle copy** instead of making the user separately remove it, close the editor, find the book, and send again. Prepare and validate the new derivative, confirm the replacement, require enough capacity for both copies, transfer and verify the new presentation, durably record it, then revalidate and remove only the exact old object and verify its absence.

This is an orchestration of the existing guarded Send and remove primitives, not an overwrite operation. If preparation or transfer fails, the old copy must remain untouched. If old-copy cleanup fails after the new copy verifies, report both copies and retain an exact cleanup task. When there is not enough space to hold both temporarily, stop with a clear explanation and leave the separate manually confirmed remove-then-queue workflow available; do not silently switch to delete-first behavior.

Acceptance requires edited EPUB coverage, unchanged-source confirmation, stale/ambiguous/prior-object rejection, insufficient-capacity handling, disconnects before and after removal, exact deletion authority, successful replacement verification, and a physical Kindle run.

### 3. Explain and resolve Possible matches

Make the yellow/question-mark state actionable. Opening it should show the suspected Kindle file, the catalog book, and a plain-language evidence breakdown such as normalized title, authors, identifier, filename, size, ambiguity, or incomplete device metadata. Offer reversible **Same book** and **Not this book** decisions when the user has enough information.

Persist a confirmed association or rejection as bounded, device-specific evidence and re-check it against the current live inventory on every connection. A saved decision must never resurrect an absent object or make a changed object authoritative. Destructive removal must still require a fresh exact-object revalidation; a fuzzy candidate alone must never authorize deletion. Also expose Kindle-only/unassociated files in the same comparison workflow so the user can understand the whole device without navigating to an unrelated administration panel.

Acceptance requires one/many/no-candidate states, confirm/reject/undo, device and profile scoping, changed or missing objects, duplicate editions, incomplete inventories, accessible evidence text, and reconnect tests on a physical Kindle.

### 4. Add a read-only Book details drawer

Make a cover or title open a compact details drawer without leaving the current grid/list position. Show the large cover, description, full authorship, series and position, publication data, identifiers, subjects, language, format/size, source health, metadata provenance, Kindle status, and last verified transfer information. Put **Send/Add to queue**, **Edit metadata & cover**, **Update Kindle copy**, and eligible **Remove from Kindle** actions in this context while retaining the three-dot shortcut menu.

Author, series, subject, publisher, and language values should be clickable filter shortcuts. Closing the drawer must restore focus and the previous scroll position. This follows the discoverable details/Quickview pattern documented by [Calibre](https://manual.calibre-ebook.com/gui.html#book-details) without copying its desktop complexity.

Acceptance requires keyboard and screen-reader operation, deep-link/back-button behavior where appropriate, stale/unavailable-source presentation, long/absent metadata, and correct actions for disconnected, possible, confirmed, prior-presentation, and busy device states.

### 5. Add series-first browsing

Create a series view that groups books by normalized series name and orders volumes by series number. Make series chips open that view, flag missing or duplicate sequence numbers without pretending Kindle Bridge owns the missing source files, and provide **Add next book to queue** plus **Add missing Kindle volumes to queue** actions. Series actions must use the selected profile and current strong Kindle evidence.

Keep this useful for books without a reliable index: show them after numbered volumes and make metadata correction easy. Add series and series-number sorting to list view. Calibre's first-class series metadata and [Tag browser](https://manual.calibre-ebook.com/gui.html#tag-browser) are the interaction reference.

Acceptance requires decimal volume numbers, gaps, duplicates, unnumbered books, edited series overlays, pagination-independent ordering, profile switching, current Kindle status, and exact bulk-queue contents.

### 6. Add a metadata and library-health inbox

Provide one compact **Needs attention** view for missing covers, incomplete or malformed metadata, parser/indexing failures, low-confidence records, suspected duplicate editions, and unavailable source files. Every issue should identify the affected catalog item or container-visible source, explain the reason and last attempt, and offer the smallest relevant action such as edit, retry, rescan, ignore, or review duplicates.

Extend online lookup from cover-only search to optional metadata candidates. Show a field-by-field preview/diff and let the user choose which title, author, description, publisher, date, identifiers, series, subjects, or cover values become overlays. Support bounded bulk lookup/normalization with review before applying anything. Never alter, rename, delete, or rewrite mounted originals; duplicate handling chooses a preferred catalog presentation rather than modifying torrent files. Calibre's [metadata review and bulk-download workflow](https://manual.calibre-ebook.com/metadata.html) is the usability reference.

Acceptance requires partial candidate application, conflicting/no-result handling, duplicate review without source mutation, bounded concurrency and provider use, optimistic revision/source-hash checks, resumable failures, clear issue retirement, and confirmation that every applied change lives only under durable `/data` overlays.

### 7. Add smart shelves and lightweight personal state

Let each profile save the current search, filters, sort, and Kindle-status constraints as a named smart shelf. Include useful optional presets such as **Not on Kindle**, **Recently added**, **Favorites**, **Want to read**, **Missing cover**, and **Series in progress**. Allow only a few shelves to be pinned in the sidebar; keep the rest in one compact chooser so navigation does not become cluttered.

Add profile-specific **Favorite** and **Want to read** state as lightweight catalog annotations. Keep manually assigned state distinct from live Kindle-derived reading progress or Read/Unread evidence tracked elsewhere in this backlog. Use Calibre's [saved searches](https://manual.calibre-ebook.com/gui.html#saving-searches) and [Virtual Libraries](https://manual.calibre-ebook.com/virtual_libraries.html) as the model for reusable subsets.

Acceptance requires create/rename/update/delete/pin, per-profile separation, unavailable or renamed facet values, URL/reload behavior, result counts, accessible navigation, and migration-safe persistence.

### 8. Add a compact activity and device center

Make the existing top status/Kindle area open one unobtrusive center for device phase, model, last inventory time, free/total storage, queued count and bytes, projected capacity, current batch progress, recent verified transfers/removals, watcher and scan health, newly indexed books, and actionable failures. Use plain phases such as **Disconnected**, **Connecting**, **Checking safe writes**, **Reading books**, **Ready**, **Transferring**, and **Needs attention**.

Keep routine success quiet and put technical diagnostics/debug-log controls under **Advanced**. Failed work should name the affected book or source and provide **Retry failed**, **Rescan**, or the relevant settings link. This adapts Calibre's dedicated [Jobs panel](https://manual.calibre-ebook.com/gui.html#jobs) while keeping Kindle Bridge's normal interface calm.

Acceptance requires correct live state transitions, reload/last-seen behavior, space calculations, coalesced batch events, bounded history, source-mount loss/recovery, error redaction, keyboard/focus behavior, and physical device validation.

### 9. Improve display density and remember browsing context

Use more of a wide desktop viewport while preserving readable card sizes, and offer a simple **Comfortable / Compact** density preference rather than adding several layout controls. Keep the existing responsive grid/list behavior, enlarge small action targets where needed, and make mobile/tablet browsing useful even when that browser cannot perform WebUSB transfers.

Remember each profile's grid/list choice, density, filters, sort, page or result position, open smart shelf, and scroll position. Switching profile or opening and closing a details drawer should not make the user lose their place. Unsupported browsers should still browse, edit metadata, and manage the Send-later queue, with one concise explanation that Kindle connection requires a supported Chromium desktop environment.

Acceptance requires wide, laptop, tablet, and narrow viewport checks; zoom and long-title coverage; persisted per-profile state; reliable restoration after navigation/reload; minimum accessible targets; and no horizontal overflow in Settings, drawers, queue review, or bulk actions.
