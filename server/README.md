# Kindle Bridge catalog service

The catalog service is a vendor-neutral Node.js HTTP service. SQLite stores durable profile/root configuration and delivery history plus a rebuildable search index. Original ebook directories are only read. Extracted cover files are derived cache entries written atomically under `/cache`.

## Container run

The repository-root `Dockerfile` and `compose.yaml` are the only canonical deployment artifacts. Build from the repository root:

```sh
docker build -t kindle-bridge .
docker run --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  -p 127.0.0.1:8080:8080 \
  -e CATALOG_ALLOWED_ROOTS=/libraries \
  -e CATALOG_ALLOWED_HOSTS=localhost:8080,127.0.0.1:8080 \
  -e CATALOG_ALLOWED_ORIGINS=http://127.0.0.1:8080 \
  -v kindle-bridge-data:/data \
  -v kindle-bridge-cache:/cache \
  -v /srv/ebooks:/libraries:ro \
  kindle-bridge
```

The example binds only to loopback. For household LAN/VPN use, put the service behind an authenticated HTTPS/VPN boundary and set `CATALOG_ALLOWED_HOSTS` to the exact public hostnames. Do not publish it directly to the internet.

## Configuration

- `CATALOG_DATABASE_PATH` — SQLite file, default `/data/catalog.sqlite`.
- `CATALOG_CACHE_DIRECTORY` — rebuildable cover cache, default `/cache`.
- `CATALOG_ALLOWED_ROOTS` — comma-separated or JSON-array container directories under which API-configured roots may exist. The canonical image sets `/libraries`.
- `CATALOG_ALLOWED_HOSTS` — exact allowed HTTP authorities, including any non-default port. The default only permits the loopback authorities on port 8080.
- `CATALOG_ALLOWED_ORIGINS` — when non-empty, the authoritative list of exact browser origins. Include the same-origin browser URL as well as any proxy origin you intend to use.
- `CATALOG_REQUIRE_ORIGIN` — defaults to `true`; keep enabled for browser deployments.
- `CATALOG_SETTINGS_MODE` — `read-write` or `read-only`. Manual rescan remains allowed in read-only mode.
- `CATALOG_MAX_BODY_BYTES` — JSON request ceiling, default 1 MiB. Book-set queries accept at most 20,000 include IDs and 20,000 exclude IDs, enough for a representative 10,000-book profile.
- `CATALOG_MAX_CONCURRENT`, `CATALOG_MAX_SOURCE_STREAMS`, `CATALOG_RATE_PER_MINUTE` — request, source-stream, and per-address rate bounds.
- `CATALOG_SOURCE_RESPONSE_TIMEOUT_MS` — aggregate server deadline for one source response, including containment checks, immutable snapshot/hash verification, and delivery to the client; default ten minutes.
- `CATALOG_COVER_RESPONSE_TIMEOUT_MS` — deadline for a derived-cover response; default 30 seconds. A retired response releases its buffered slot and cannot schedule late database work.
- `CATALOG_SETTINGS_VALIDATION_TIMEOUT_MS`, `CATALOG_ROOT_POLICY_TIMEOUT_MS` — finite deadlines for request-time source-root validation and startup validation of allowed container roots; both default to ten seconds. Client disconnect and service shutdown cancel Settings validation independently of these deadlines.
- `CATALOG_SHUTDOWN_TIMEOUT_MS` — shared HTTP/source drain and scanner-retirement deadline, default 20 seconds and capped at 25 seconds so forced cleanup fits the container's 30-second stop grace.
- `CATALOG_QUIET_WINDOW_MS`, `CATALOG_STABILITY_WINDOW_MS`, `CATALOG_RECONCILE_MS`, `CATALOG_DEEP_RECONCILE_MS`, `CATALOG_MAX_CONCURRENT_SCANS` — watcher debounce, the minimum unchanged-file interval before ingestion (250 ms in the bare service; the canonical Compose deployment deliberately sets 2 seconds for host/NAS-backed mounts), frequent bounded reconciliation (default 15 minutes), automatic full deep reconciliation (default 24 hours), and scan concurrency.
- `CATALOG_SCAN_TIMEOUT_MS` — hard wall-clock deadline for one active per-root scan, default `600000` (ten minutes). The clock starts only after the root owns a scan slot. Timeout releases that slot, preserves prior rows and the unacknowledged durable scan generation, reports `scan_timeout`, and schedules bounded-backoff recovery; lifecycle or Settings cancellation remains authoritative over timeout handling.
- `CATALOG_MAX_SCAN_ENTRIES`, `CATALOG_MAX_SCAN_DIRECTORIES` — per-root traversal ceilings, default `1000000` directory entries and `50000` traversed directories. Exceeding either preserves the prior catalog and reports a root scan error.
- `CATALOG_METADATA_WORKERS`, `CATALOG_METADATA_TIMEOUT_MS` — persistent isolated-parser pool size (default `2`) and per-source deadline (default `15000`). A timed-out worker is terminated and replaced.
- `CATALOG_COVER_RETENTION_MS`, `CATALOG_COVER_PRUNE_MS` — unreferenced-cover retention (default seven days) and prune interval (default one day). Referenced covers, including disabled/unavailable catalog history, are retained.

The profile match-index response is deliberately non-paginated because reconciliation requires one coherent snapshot. It includes only currently available source/book rows, fails before loading rows when a profile exceeds 20,000 books or 40,000 delivered-history rows, and refuses JSON above 32 MiB; it never returns a silently truncated index. A fixed-width collision summary is computed in the same read transaction from bounded, preflighted metadata claims in the other enabled profiles. That lets a globally unique unmanaged match become green without loading every household profile into the browser; an incomplete summary or another strong claimant keeps metadata-only evidence uncertain. Ordinary catalog pages use the same 32 MiB ceiling. Both paths preflight selected SQLite text bytes, iterate rows without retaining a full raw row set, measure the exact JSON encoding, and only then allocate one exactly sized response buffer. The browser applies the same ceiling while streaming bounded catalog JSON.

Buffered JSON, single-book, cover, and static-file responses share a two-active-response FIFO gate. Additional requests wait without building their body, abort on client/shutdown close, and time out after ten seconds; the lease remains held until the HTTP response emits `finish` or `close`. Source books use their separate bounded streaming path.

Household configuration collections are intentionally finite and non-paginated: at most 100 profiles, 1,000 distinct roots, 100 roots in one profile, and 2,000 total profile-to-root memberships. Profile collections have a 512 KiB raw UTF-8 field budget and root collections have a 4 MiB budget; creates, configuration replacements, and updates assert these limits inside their transaction, while list/scan paths preflight before loading rows. Profile/root lists and full configuration responses use the buffered-response gate above. Filter suggestions are deterministically truncated in SQLite before JavaScript row materialization: each of eight facets receives 128 KiB and 500 values, for at most 1 MiB/4,000 values overall. Truncation affects suggestions only: the API's exact author, subject, language, publisher, series, year, format, and root queries still search the full catalog. In the current UI, the typed author, subject, publisher, and series fields therefore remain exact; select-only facets show the retained suggestions. Filter responses also hold the buffered-response lease through `finish`/`close`.

The browser does not call `response.json()` for catalog endpoints. It rejects a declared `Content-Length` above 32 MiB immediately, otherwise streams with the same incremental byte ceiling, cancels at the first over-limit chunk before retaining it, and only then decodes and parses JSON. This applies to success and HTTP error envelopes; the match index keeps its endpoint-specific error codes while using the same bounded reader.

Settings replacements and direct `POST /api/profiles` creation require an `Idempotency-Key`. Their shared operation-scoped replay ledger retains a deterministic window of 1,000 accepted keys per profile; reusing a retained key with different input is a conflict. Delivery history retains at most 40,000 delivered and 10,000 non-delivered rows per profile, with exact-byte compaction for evidence exposed by matching. Delivery requests accept only fixed, bounded transfer evidence: arbitrary nested `result` payloads are rejected and legacy `result_json` values are cleared by migration.

Settings state and any required scan intent commit together. Replaying a successful request wakes the retained generation without adding another event or scan. Display-only profile, description, or root-label edits do not scan source bytes; new, re-enabled, moved, or scan-option-changed roots queue only the work they require.

A confirmed healthy scan retires missing rebuildable source, book, and FTS rows, allowing their covers to age out of `/cache`; a mount-loss path instead retains last-known rows as unavailable. Stable book identities and retained delivery evidence survive delete/re-add, rename, and catalog rebuild. Current identities and identities protected by retained deliveries are never pruned. Unlinked identity tombstones are bounded per root to the newest 20,000 rows and an exact 32 MiB raw-data window, while rebuild-pending roots are protected until their first confirmed replacement scan.

Configured roots may optionally specify a relative sentinel filename and an expected mount device identity. The scanner also requires confirmed scan generations: the first failed or unexpectedly empty generation changes root health but does not invalidate the entire prior catalog.

Initial ingestion, new/stat-changed files, and watcher-dirty paths are hashed from a descriptor-bound immutable snapshot. For unchanged files, startup and the frequent `CATALOG_RECONCILE_MS` pass compare a persisted `qf1` fingerprint made from at most four 4 KiB samples; only a mismatch escalates to a full source copy/hash. Separately, `CATALOG_DEEP_RECONCILE_MS` performs an automatic full hash of every unchanged source (daily by default), catching changes outside the samples even after watcher loss. The last successful full-root completion is stored in SQLite. A first full ingestion establishes that root's baseline; an existing/migrated root with no completion or an overdue root is durably queued after bounded startup, and another restart cannot reset its deadline or discard the request. Only a successfully acknowledged full-root scan advances the clock. An unchanged deep hash skips metadata parsing. **Rescan** requests the same deep verification immediately and advances the same durable clock when successful. Cover presence checks are stat-only; cover bytes are read only when served.

Back up the `/data` volume with the documented cold-backup helper or another SQLite-consistent volume snapshot. `/cache` is intentionally excluded and rebuilds from the read-only source mounts. SIGTERM/SIGINT handling is installed before the initial scan. Shutdown stops new HTTP work and closes event streams first, cooperatively aborts scans and parser workers within the shared `CATALOG_SHUTDOWN_TIMEOUT_MS` deadline, retires any still-pending filesystem work from database access, and closes SQLite last.

## Development checks

```sh
npm run build:server
npx vitest run --config tests/server/vitest.config.ts
```
