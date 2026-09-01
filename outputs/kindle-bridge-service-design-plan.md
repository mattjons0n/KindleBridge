# Kindle Bridge — Library Service Design Plan

Date: 2026-08-29

## Product outcome

Kindle Bridge becomes a self-hosted household ebook library. A platform-agnostic Docker service continuously indexes book directories mounted into its container. A user opens the web interface, chooses a household profile, connects a Kindle, sees which catalog books are already on it, and sends any missing book with one action.

The browser retains the proven conversion and USB-transfer technology:

```text
Host directories supplied as read-only Docker mounts
  → Docker-hosted indexer and metadata catalog
  → private HTTPS web app
  → browser-local format check / boko conversion
  → user-initiated WebUSB + automatic safe-write test
  → Kindle MTP Documents storage
```

## Non-negotiable principles

- Original library files are immutable. Conversion always creates a separate in-memory or cached derivative.
- EPUB bytes may travel from the private backend to the user's browser, but never to a cloud converter.
- The first WebUSB permission remains user initiated. On a clean connection, the exact-byte self-test runs immediately and Kindle inventory follows automatically in the same session. A pending exact-cleanup record intentionally permits only read-only recovery inventory first; acknowledgement must trigger a new self-test, inventory, and reconciliation before Send can resume.
- The self-test must pass in the current connection before Send is enabled.
- Existing Kindle content is never broadly deleted, overwritten, renamed, or moved.
- A green check means a strong match. Fuzzy or uncertain matches are shown as possible matches, never as confirmed.
- Profiles select library views and folder sets; without login they are not security boundaries.
- The initial no-login deployment is private to a trusted LAN or VPN. Public internet exposure requires authentication later.

## Recommended deployment

### Docker library service

Run a small TypeScript service as a standard Docker/OCI container on any compatible Docker host. Supply configured book roots through ordinary read-only bind mounts or Docker volumes, for example:

```yaml
volumes:
  - /host/path/husband:/libraries/husband:ro
  - /host/path/wife:/libraries/wife:ro
  - kindle-bridge-data:/data
```

```text
/libraries/husband  → profile: Your library
/libraries/wife     → profile: Wife's library
```

Kindle Bridge only handles paths visible inside the container. The host decides whether each source comes from a local disk, NAS, SMB mount, NFS mount, or another storage system. The application does not mount remote storage, store storage credentials, or depend on a host brand.

The service owns:

- folder configuration and health;
- initial scans, filesystem-change hints, and scheduled reconciliation;
- bounded EPUB metadata and cover extraction;
- SQLite catalog and full-text search;
- the web UI and private API;
- source-file streaming by opaque book ID.

Serve it over HTTPS through the host's reverse proxy or a private VPN hostname. HTTPS is required for WebUSB away from `localhost`.

### Browser client

The browser owns:

- household profile selection;
- catalog search, sorting, filtering, and covers;
- WebUSB permission and MTP sessions;
- Kindle Documents inventory;
- automatic exact-byte self-test;
- source-format inspection;
- local boko EPUB → AZW3 conversion;
- PDOC preparation, cover validation, transfer, and verification.

Keeping book conversion in the browser reuses the physically proven POC and keeps the Docker service independent of Calibre.

## Folder monitoring and ingestion

Filesystem watchers are treated as hints, not the source of truth. The indexer should:

1. Perform an initial recursive scan when a source becomes available.
2. Debounce change events and wait until size and modification time are stable before parsing.
3. Reconcile every configured root periodically to catch dropped or coalesced events.
4. Record source-unavailable state without treating every missing file as deleted.
5. Hash only new or changed files; use size and modification time as the cheap first check.
6. Ignore partial downloads, temporary files, unsupported formats, and symlinks escaping a configured root.
7. Extract title, all authors, language, publisher, publication date, subjects, series, identifiers, and cover from EPUB metadata where present.

Adding one book should index only that book. A full scan may verify the catalog, but unchanged files must not be re-imported or reparsed.

## Profiles and folders

A profile has a display name and one or more server-configured folder roots. Every catalog query is scoped by profile ID.

Example:

```text
Your library
  - /libraries/husbandlibrary
  - /libraries/shared-nonfiction

Wife's library
  - /libraries/wifelibrary
```

The UI remembers the last selected profile locally. Anyone who can reach a no-login server can switch profiles, so profile separation is organizational rather than confidential.

## Catalog data model

Implemented SQLite tables:

- `profiles` — profile name and enabled state.
- `library_roots` — canonical read-only root, source health, and scan state.
- `profile_roots` — profile/root memberships, display labels, and enabled state; an exact shared path is scanned once.
- `source_files` — root, contained relative path, format, size, modification time, content hash, and availability; profile scope is derived through `profile_roots`.
- `books` — normalized title, author sort key, series, language, publisher, publication date, identifiers, subjects, and cover reference.
- `books_fts` — FTS5 index over title, authors, series, subjects, publisher, identifiers, and source filename.
- `configuration_writes` — operation-scoped idempotency evidence for atomic Settings saves and direct profile creation, bounded to 1,000 retained keys per profile.
- `scan_requests` — one bounded, generation-guarded durable work row per root.
- `deliveries` — bounded fixed transfer evidence: book, device pseudonym, status, generated filename, artifact hash/size, MTP identity, and time. Arbitrary result payloads are rejected and not retained.
- `catalog_book_identities` — stable rename/delete/re-add/rebuild identity evidence; current and delivery-linked rows are protected, while unlinked tombstones use a 20,000-row/32 MiB per-root window.
- `catalog_rebuild_pending_roots` — temporary durable protection for identity continuity between an explicit catalog clear and its first confirmed replacement scan.

Settings state and the scan intent it actually requires commit in one writer transaction. An exact replay wakes the retained generation without advancing it. Renaming a profile, changing its description, or changing only a root label does not scan source bytes; new, re-enabled, moved, or scan-option-changed roots queue only the affected work.

Raw Kindle inventory, connection state, self-test bytes/results, and session-local MTP handles remain browser-only and are not stored in the service database. Delivery device keys are installation-HMAC pseudonyms; raw serials are never sent to or persisted by the service.

Library files in the read-only host mounts are the system of record. Extracted catalog rows are rebuildable; profiles, root mappings, migrations, and delivery history are durable application state and must be backed up with the `/data` volume.

## Search, sort, and filters

Search covers:

- title;
- every author/creator;
- series;
- subject/tag;
- publisher;
- ISBN and other identifiers;
- source filename as a fallback.

Initial filters:

- author;
- series;
- language;
- subject;
- publisher;
- year;
- source folder;
- format;
- metadata completeness;
- On Kindle, Not on Kindle, and Possible match.

Initial sorts:

- recently added;
- title;
- author;
- publication date;
- file size.

Use normalized deterministic sort keys and paginated queries so a large library remains responsive.

## Kindle connection flow

The final everyday flow on a clean connection is:

1. User selects **Connect Kindle** and completes the browser device chooser.
2. Open USB and inspect MTP storage read-only.
3. Immediately run the existing exact-byte create/read/compare/delete self-test.
4. Mark the Kindle ready only after cleanup is proven.
5. Enumerate the Documents hierarchy and build a connection-scoped inventory in the same retained session.
6. Reconcile the active profile's bounded match index against the inventory in the browser using Calibre-compatible active-library title/author rules. Other household profiles do not downgrade an exact selected-profile match; indistinguishable rows inside the selected profile are assigned deterministically.

If an exact-cleanup record is pending, the retained session instead performs only the read-only recovery inventory needed to present that record. Send remains disabled; acknowledgement must be followed by a new self-test, inventory, and reconciliation before normal readiness can return.

The manual self-test remains available in diagnostics, but it is not part of the normal path.

If the test fails, show **Safe-write check failed. No book has been sent.** Keep Send disabled and preserve the existing bounded recovery workflow.

## Matching catalog books to Kindle objects

Use the strongest available evidence in this order:

1. A prior Kindle Bridge delivery record plus persistent MTP object identity where supported.
2. A source-version-scoped short managed identifier in the generated collision-resistant filename, exact size, and a delivered record. The identifier binds the opaque catalog book ID to the indexed content hash so replacement bytes cannot inherit prior delivery evidence.
3. Exact embedded identifier plus normalized title and author.
4. Exact normalized title/author/size agreement.
5. Fuzzy title or filename similarity only as **Possible match**.

MTP object handles are session-local and cannot be durable identities. Never turn an ambiguous match green, and never automatically replace or delete an unmanaged object.

## Send to Kindle flow

Clicking **Send to Kindle** operates on a logical catalog book:

1. Fetch the selected source from the private catalog API by opaque book ID.
2. Verify that the returned file still matches its indexed size/hash metadata.
3. Detect the format.
4. For EPUB, convert a copy locally through the existing boko worker.
5. For an uncompressed or PalmDOC-compressed KF8/AZW3, copy it into browser memory and run the separately tested structural, readable-text, and cover validation. Reject HUFF/CDIC because Release 1 has no bounded decoder for it.
6. Prepare only the derivative as PDOC when required for modern Kindle cover display.
7. Generate a collision-resistant managed filename; never overwrite.
8. Transfer over the already-tested MTP path and verify returned metadata.
9. Refresh the live inventory and reconcile it immediately. Show the green check only when that refreshed inventory yields a confirmed active-library association. Multiple exact device copies may associate with the same deterministically allocated catalog row; genuinely fuzzy evidence remains **Possible match**.

V1 supports EPUB plus uncompressed or PalmDOC-compressed KF8/AZW3. HUFF/CDIC AZW3 and other formats receive a clear unsupported-format state until their decoding or conversion path is separately proven.

## Private API outline

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
GET    /api/profiles/:profileId/roots
POST   /api/profiles/:profileId/roots
PATCH  /api/profiles/:profileId/roots/:rootId
DELETE /api/profiles/:profileId/roots/:rootId
POST   /api/profiles/:profileId/roots/:rootId/rescan
GET    /api/profiles/:profileId/books
POST   /api/profiles/:profileId/books/query
GET    /api/profiles/:profileId/books/:bookId
GET    /api/profiles/:profileId/books/:bookId/cover
GET    /api/profiles/:profileId/books/:bookId/source
GET    /api/profiles/:profileId/filters
GET    /api/profiles/:profileId/match-index
POST   /api/deliveries
```

The source endpoint accepts only opaque database IDs, resolves paths server-side, rechecks canonical-root containment, and never accepts an arbitrary filesystem path.

## Security and reliability boundaries

- Read-only bind mounts or Docker volumes for library sources.
- Strict path canonicalization and symlink containment.
- Parser limits for archive entries, expanded size, file size, nesting, and processing time.
- Same-origin API, strict Origin checks, and no analytics or external artwork calls by default.
- Book and cover cache stored in an app-private directory with configurable retention.
- Finite startup-root, Settings-path, source-response, and cover-response deadlines retire stalled I/O on timeout, disconnect, or shutdown without late database/event work.
- Raw book bytes, conversion output, host paths where appropriate, storage credentials, and device serials excluded from logs.
- Storage mounting and any required credentials remain the Docker host's responsibility, outside the application.
- Source loss creates an unavailable state rather than mass deletion.
- One active write lease per Kindle and exact current-session cleanup only.
- Preserve boko source, checksums, GPL notices, and redistribution obligations.

## Delivery milestone status

- **0. Product foundation — implemented.** The normal catalog and Settings surfaces use persistent server data; sample/simulated data is no longer part of normal mode. The original physical-device POC remains available as diagnostics.
- **1. Docker service and profile isolation — implemented and automated.** The service, migrations, safe roots, multiple folders, shared-root deduplication, health/readiness, and profile-scoped APIs are present.
- **2. Incremental catalog — implemented and automated.** Durable generation-guarded scans, watcher hints, quiet-window processing, reconciliation, bounded worker parsing, covers, FTS, pagination, and mount-loss safeguards are present.
- **3. Kindle inventory and automatic self-test — implemented; fresh physical acceptance pending.** Connection no longer requires a selected EPUB. On a clean connection, the exact-byte self-test precedes bounded read-only inventory in one retained MTP session. Pending exact cleanup takes the intentionally read-only recovery path first and remains fail-closed until acknowledgement plus a fresh self-test, inventory, and reconciliation.
- **4. Matching and green checks — implemented; fresh physical acceptance pending.** Managed delivery evidence and bounded read-only Kindle metadata feed conservative confirmed/possible/absent reconciliation. Metadata or hierarchy incompleteness remains explicit.
- **5. One-click Send — implemented; fresh physical acceptance pending.** Authoritative source fetch, browser-local derivative preparation, verified no-overwrite transfer, live inventory refresh, and idempotent delivery recovery are wired.
- **6. Docker deployment and hardening — implemented; current local acceptance passed.** Generic Docker/Compose artifacts, HTTPS/VPN guidance, non-root/read-only runtime, backup/restore/rollback/rebuild procedures, supply-chain artifacts, and bounded operations are present. The schema-v13 local acceptance image passed restore/rebuild plus native `linux/arm64` and cross-runtime `linux/amd64` execution, and its verified two-platform OCI archive carries per-platform SPDX/SLSA attestations. Publishing and accepting a concrete digest on the intended household host remains external release evidence.
- **Household release — pending external acceptance.** The complete flow must still be repeated on the known `0x1949 / 0x9981` Kindle, the real household mounts/profiles, and the intended trusted private HTTPS origin. Earlier POC evidence and automated mocks do not satisfy this gate.

## Explicitly out of scope for the first release

- DRM removal or DRM-protected EPUB support.
- Calibre integration.
- Cloud conversion or cloud book storage.
- Public unauthenticated internet exposure.
- Automatic Kindle deletion, overwrite, rename, or bidirectional sync.
- Treating profiles as private accounts before authentication exists.
- Platform-specific application packages; deployment is Docker/OCI only.
