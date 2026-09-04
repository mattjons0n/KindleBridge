# Docker deployment and operations

Kindle Bridge ships only as a standard Docker/OCI container. It has no host-vendor integration and never mounts local, NAS, SMB, or NFS storage itself. Start with the locked decisions in [`MILESTONE-0.md`](MILESTONE-0.md).

## 1. Prerequisites

- Docker Engine 26+ and Docker Compose v2.24+ on a supported `linux/amd64` or `linux/arm64` host.
- A host directory containing DRM-free EPUB files and/or supported uncompressed/PalmDOC-compressed KF8/AZW3 files. HUFF/CDIC AZW3 is rejected. If that directory is network-backed, the host must mount and monitor it before Docker starts.
- A stable private hostname and trusted HTTPS certificate for non-localhost WebUSB use.
- A trusted household LAN/VPN. The no-login service must not be exposed directly to the public internet.

The default single source mount maps a host directory to `/libraries`. For separate household collections, add one read-only child mount per source:

```yaml
services:
  kindle-bridge:
    volumes:
      - /host/books/husband:/libraries/husband:ro
      - /host/books/wife:/libraries/wife:ro
      - kindle-bridge-data:/data
      - kindle-bridge-cache:/cache
```

Settings accepts container paths such as `/libraries/husband`; it does not accept `smb://` URLs or host-only paths. Storage credentials stay on the host. A root may be shared by profiles and is scanned once; profiles are organizational selectors, not access-control boundaries.

## 2. Build and verify an image

The Dockerfile pins Node 24.20.0 by OCI-index digest. Its `linux/amd64` and `linux/arm64` digests are checked into [`base-image.lock`](base-image.lock). The image build runs `npm run check` before assembling the runtime stage.

Build one native image from the repository root:

```sh
docker compose build --pull kindle-bridge
```

For a multi-platform release, install Buildx and run from the repository root:

```sh
IMAGE=registry.example/kindle-bridge \
VERSION=0.1.0 \
BUILD_DATE=2026-08-29T00:00:00Z \
VCS_REF=0123456789abcdef \
SOURCE_URL=https://example.invalid/kindle-bridge \
docker buildx bake --file deploy/docker/docker-bake.hcl --push
```

The Bake target publishes `linux/amd64` and `linux/arm64` variants with BuildKit SBOM and provenance attestations. Tests and asset compilation run once per build on the native build platform; the architecture-specific runtime stage is still resolved independently for each target. This avoids treating QEMU benchmark timings as application results. The image also contains:

- `/app/dist/release/sbom.cdx.json` — complete npm build dependency inventory;
- `/app/dist/release/sbom.runtime.cdx.json` — runtime npm inventory;
- `/app/dist/release/boko-artifacts.sha256` — vendored JavaScript/WASM checksums;
- `/usr/share/kindle-bridge/LICENSE` and `THIRD_PARTY_NOTICES.md`;
- `/usr/share/kindle-bridge/source` — application source, build inputs, and complete corresponding boko source.

For a production Compose file, set `KINDLE_BRIDGE_IMAGE` to an immutable release digest rather than a mutable tag.

## 3. Configure and start

Copy [`kindle-bridge.env.example`](kindle-bridge.env.example) to a private environment file outside the repository, replace every example value, and pass it explicitly:

```sh
docker compose --env-file /private/path/kindle-bridge.env up -d
docker compose --env-file /private/path/kindle-bridge.env ps
```

Compose binds HTTP to `127.0.0.1:8080` by default. This keeps the unauthenticated origin off external interfaces. Configure initial libraries while `CATALOG_SETTINGS_MODE=read-write`; after setup, `read-only` prevents Settings mutations until the container is deliberately reconfigured.

Optional Google Books access is configured after startup in **Settings → Online cover search**. It is not part of the normal deployment environment. The saved key is server-side durable state in `/data`; Open Library and local cover upload/paste continue to work without it.

The runtime is UID/GID `1000:1000`, has a read-only root filesystem, no Linux capabilities, `no-new-privileges`, and a bounded process count. Only `/data` and `/cache` are writable. `/data` is durable and includes SQLite, optional provider credentials, queue/shelf/annotation intent, issue dispositions, metadata-lookup review jobs, and user-selected replacement covers under `/data/metadata-covers`; `/cache` is rebuildable and is also the runtime temporary directory, so a fresh empty volume or bind mount works without initialization. The browser owns WebUSB, so never pass a USB device into the container or run the service privileged.

Before first start, the host source directories must grant UID/GID `1000:1000` read permission on book files and search (`x`) permission on every parent directory. Named `/data` and `/cache` volumes are initialized by the image and must remain writable by that identity. If host policy cannot grant those permissions, prepare equivalent ACLs on the host; do not make the container privileged or writable against source mounts.

For network-backed mounts, configure a small marker filename (for example `.kindle-bridge-volume`) in each library root and enter that relative name in the root's **Mount sentinel** field. The marker must live on the intended backing volume, not in a parent mountpoint. Kindle Bridge will retain the previous catalog if the path exists but the marker disappears. The recorded mount identity is opaque host evidence and may also change after a backing-volume swap; either condition requires operator review before the replacement is accepted.

## 4. Health, readiness, and shutdown

`GET /api/healthz` is the liveness endpoint. `GET /api/readyz` is the stricter container-readiness contract. Docker health is healthy only when `/api/readyz` succeeds and its JSON body contains `"ready": true`; an HTTP 200 alone is not sufficient. The health probe calls loopback, so keep `127.0.0.1` in `CATALOG_ALLOWED_HOSTS` alongside the external hostname.

Useful checks:

```sh
docker compose ps
curl --fail --header 'Accept: application/json' http://127.0.0.1:8080/api/readyz
docker compose logs --tail 100 kindle-bridge
```

Compose sends `SIGTERM`, uses an init process, and allows 30 seconds for shutdown. Signal handling is active before allowed-root validation and the initial scan start. The service first stops accepting HTTP work and ends SSE leases, immediately retires Settings and cover validation, then drains active source requests while cooperatively aborting scans and terminating parser workers. The shared drain uses `CATALOG_SHUTDOWN_TIMEOUT_MS` (20 seconds by default, 1,000–25,000 ms); request retirement prevents late filesystem completions from continuing into SQLite. SQLite closes after the HTTP and scanner shutdown participants have either settled or reported failure. If the deadline expires, remaining HTTP sockets are aborted, active source descriptors are closed on a best-effort basis, and scanner work is retired within the 30-second Compose grace period. A host/kernel filesystem call that cannot be cancelled may still require Docker's final forced stop; the application observes any late completion without resuming the retired request. Use `docker compose stop`; do not use `docker kill` for normal maintenance. A forced termination requires a readiness check and root reconciliation after restart.

## 5. HTTPS, Host, Origin, and WebUSB

Outside the browser's localhost exception, WebUSB requires a secure context. Use one HTTPS origin for both UI and API. [`Caddyfile.example`](Caddyfile.example) demonstrates a proxy on the same Docker network, a locally trusted certificate, a 1 MiB request-body ceiling, CSP, frame denial, MIME sniffing protection, a strict referrer policy, HSTS, and `Permissions-Policy: usb=(self)`.

Set both controls exactly:

- `CATALOG_ALLOWED_HOSTS` contains the exact readiness authority `127.0.0.1:8080` and the external hostname, including a non-default port if present; no wildcard.
- `CATALOG_ALLOWED_ORIGINS` contains the complete external origin (`https://host[:port]`), without path or trailing slash; no wildcard.
- `CATALOG_REQUIRE_ORIGIN=true` remains enabled so browser mutations without an Origin are rejected.

The default server bounds are a 1 MiB JSON body, 20,000 IDs in each include/exclude book set, 64 concurrent requests, 4 concurrent source streams, 600 requests per source address per minute, a maximum of 64 SSE event streams, 2 concurrent scans, and one active scan per configured root. A complete source response has a ten-minute deadline, a cover response has 30 seconds, and both request-time Settings path validation and startup allowed-root validation have ten seconds. These controls release capacity and bar late database/event work even when a NAS operation or connected client stalls. The body and ID bounds accommodate a representative 10,000-book profile without allowing unbounded request amplification. Metadata extraction uses 2 reusable parser workers with a 15-second deadline per source. Each active root scan has a hard ten-minute wall-clock deadline, and each root is bounded to 1,000,000 encountered entries and 50,000 traversed directories. A deadline or traversal failure preserves prior catalog rows and the unacknowledged durable generation; a timeout reports `scan_timeout`, releases the shared scan slot, and is retried with bounded backoff so one stalled host/NFS/CIFS operation cannot hold startup readiness or every later root indefinitely. `CATALOG_RECONCILE_MS` runs the frequent bounded-fingerprint pass (15 minutes by default); `CATALOG_DEEP_RECONCILE_MS` runs an automatic full-hash sweep (24 hours by default), while Settings **Rescan** requests a deep pass immediately. The last successful full-root completion is persisted in `/data` per root: startup itself remains bounded, then a first/overdue deep generation is durably queued, and repeated container restarts cannot postpone or discard it. The clock advances only after successful full-root acknowledgement. The configurable bounds use `CATALOG_MAX_BODY_BYTES`, `CATALOG_MAX_CONCURRENT`, `CATALOG_MAX_SOURCE_STREAMS`, `CATALOG_SOURCE_RESPONSE_TIMEOUT_MS`, `CATALOG_COVER_RESPONSE_TIMEOUT_MS`, `CATALOG_SETTINGS_VALIDATION_TIMEOUT_MS`, `CATALOG_ROOT_POLICY_TIMEOUT_MS`, `CATALOG_RATE_PER_MINUTE`, `CATALOG_SHUTDOWN_TIMEOUT_MS`, `CATALOG_MAX_CONCURRENT_SCANS`, `CATALOG_SCAN_TIMEOUT_MS`, `CATALOG_MAX_SCAN_ENTRIES`, `CATALOG_MAX_SCAN_DIRECTORIES`, `CATALOG_METADATA_WORKERS`, and `CATALOG_METADATA_TIMEOUT_MS`; the ID-set ceiling, scanner depth/file/watch ceilings, and event lease are fixed safety limits. Keep the defaults until a measured household load test justifies a change.

The derived cover cache is pruned at startup and every `CATALOG_COVER_PRUNE_MS` (one day by default). Only unreferenced objects older than `CATALOG_COVER_RETENTION_MS` (seven days by default) are removed; retained disabled/unavailable book history still protects its referenced covers.

Durable retry and identity histories also have fixed retention envelopes. Settings and direct profile creation retain 1,000 operation-scoped idempotency keys per profile; delivery history retains 40,000 delivered and 10,000 non-delivered rows per profile and never accepts arbitrary result payloads. A confirmed healthy scan retires missing rebuildable catalog rows, while a mount outage keeps last-known rows unavailable. Current and delivery-linked stable identities are protected; unlinked delete/re-add history is limited to the newest 20,000 rows and 32 MiB per root. An explicit catalog rebuild marks its roots pending so this compaction cannot remove their identity evidence before the replacement scan succeeds.

The proxy must preserve the external Host and must not rewrite the browser to a second API origin. Restrict the proxy with LAN firewall rules, a private VPN, or a real authentication gateway. Profiles do not make a public deployment safe.

Trust Caddy's local root CA on every client before testing. Desktop Chromium is the supported browser. The first USB chooser remains user initiated, and permission is tied to the exact scheme/host/port. Changing the origin can also strand a browser-local recovery-journal entry, so inspect or finish interrupted transfers before changing it.

For defense in depth, block container egress unless the operator enables online cover or metadata search. Catalog indexing, source-cover extraction, conversion, and Kindle transfer require no cloud service. Google Books/Open Library lookup is the sole optional product feature that needs outbound HTTPS; if it is enabled, restrict egress to the documented provider hosts (`www.googleapis.com`, `books.google.com`, `books.googleusercontent.com`/Google image redirects, `openlibrary.org`, `covers.openlibrary.org`, `archive.org`, and Archive.org data nodes matching `iaNNNNNN.us.archive.org`) and keep arbitrary destinations blocked. Lookup sends only normalized title/author/identifier query terms, never a mounted file, source bytes, a container path, or a browser-supplied fetch URL. Kindle Bridge accepts an Open Library image only through its exact HTTPS cover-ID-bound archive redirect chain; the broader Archive.org sites are not arbitrary fetch targets. Uploaded, dragged, and clipboard-pasted covers remain fully local.

## 6. Cold backup

Back up all of `/data`; do not back up `/cache`. The archive must include both SQLite and `/data/metadata-covers`, otherwise restored metadata may reference missing user-selected images. SQLite contains the schema-v17 durable application state: profiles/roots, stable identities, deliveries, overlays, provider settings and mutation replays, queues, shelves, annotations, issue dispositions/preferences, and bulk lookup jobs/results. It also contains a configured Google Books key in plaintext appropriate to this private self-hosted threat model, so restrict backup ownership and mode just as carefully as the live volume. A consistent cold backup avoids copying SQLite while a migration or write transaction is active.

1. Record the exact image digest and environment file in the backup log.
2. Stop cleanly and wait for the container to exit.
3. Run the bounded helper, which mounts the data volume read-only and creates a timestamped archive plus SHA-256 file. It atomically reserves both names and refuses a same-second retry instead of overwriting prior evidence.
4. Start again and confirm readiness.

```sh
docker compose --env-file /private/path/kindle-bridge.env stop kindle-bridge
KINDLE_BRIDGE_IMAGE=kindle-bridge:local \
  deploy/docker/backup-data.sh kindle-bridge-data /absolute/private/backup-directory
docker compose --env-file /private/path/kindle-bridge.env up -d
```

Store the archive, checksum, image digest, and environment backup together. The `/data` archive contains any saved cover-provider API keys, and the environment file can disclose local paths; both must remain private.

## 7. Non-destructive restore and rollback

The restore helper refuses to overwrite an existing volume. It reserves the new volume with a one-use ownership label, rejects a concurrent claimant or attached container, binds the adjacent checksum digest to the exact selected archive, restores as root only inside the new isolated volume, then runs SQLite integrity, foreign-key, and supported-schema checks before reporting success. The current data volume remains available for immediate rollback.

```sh
KINDLE_BRIDGE_IMAGE=kindle-bridge:local \
  deploy/docker/restore-data.sh \
  /absolute/private/backup-directory/kindle-bridge-data-YYYYMMDDTHHMMSSZ.tar.gz \
  kindle-bridge-data-restored-YYYYMMDD
```

Then set `KINDLE_BRIDGE_DATA_VOLUME=kindle-bridge-data-restored-YYYYMMDD`, start the exact image paired with that backup, and verify:

- `/api/readyz` reports ready;
- profiles, root assignments, and Settings mode are correct;
- delivery history exists;
- Send-later order, smart shelves/pins, annotations, issue ignore/duplicate preference, provider status, and metadata-lookup review jobs exist;
- every source root is available and a reconciliation completes;
- a sample cover and source download work within the correct profile.

A lookup job that was `running` at shutdown is intentionally recovered as `paused` with any `searching` entry returned to `pending`; resume it explicitly after the restored service is ready. Candidate results are review material only and never apply themselves during recovery.

For an application rollback, stop the service, select the previous immutable image digest and its pre-upgrade data-volume snapshot together, then start. Do not run an older image against a database already migrated by a newer one unless that release explicitly documents backward compatibility. The new queue, shelf, annotation, provider, issue, and lookup rows are additive/inert when their UI is disabled, but that does not by itself prove that an older binary accepts schema version 17; retain the paired snapshot and never delete this user intent merely to roll back a feature.

## 8. Cache and catalog rebuild

To rebuild derived covers and temporary artifacts, stop the service and select a fresh empty cache volume through `KINDLE_BRIDGE_CACHE_VOLUME`. Keep `/data` and every source mount unchanged, restart, and request a reconciliation for each configured root. Confirm that book counts, FTS search, facets, covers, and source streaming recover before retiring the old cache.

To rebuild the derived SQLite catalog while retaining profiles, root configuration, stable book identities, delivery evidence, metadata overrides, provider configuration, Send-later entries, shelves, annotations, issue dispositions/preferences, metadata-lookup jobs/results, and user-selected covers, first make a cold backup and stop every container using the data volume. Then run:

```sh
KINDLE_BRIDGE_IMAGE=kindle-bridge:local \
  deploy/docker/rebuild-catalog.sh kindle-bridge-data
```

The helper refuses a missing or in-use volume, verifies the existing database before mutation, and clears only rebuildable source/catalog rows. During that interval queue entries hydrate as missing/retired and derived issues disappear; neither condition deletes their durable intent. Restart with the identical `/libraries` mounts and fresh `/cache`, then request a deep rescan for every enabled root. Do not discard the pre-rebuild backup until stable IDs reattach and profiles, root assignments, delivery matches, overlays, queue status/order, shelf counts, annotations, issue dispositions/preferences, lookup review state, search/facets, cover serving, and source streaming have all been checked.

For a complete disaster rebuild without `/data`, create fresh data/cache volumes, recreate profiles and container root assignments in Settings, and rescan all sources. Original books recover catalog metadata and covers, but delivery history and prior device evidence require the `/data` backup; they cannot be reconstructed reliably from filenames alone.

Never delete or write to a source mount as part of a rebuild. If a mount disappears or is empty unexpectedly, restore the host mount first. Kindle Bridge must show the root as unavailable and retain its last known catalog until a later successful scan.

## 9. Upgrade rehearsal

Before a household upgrade:

1. Run `npm run check` and build the exact release image.
2. Validate both OCI architectures and inspect SBOM/provenance attestations.
3. Make a cold `/data` backup and keep the old image digest.
4. Start the new image on a restored copy of the data volume first; verify schema version 17, wait for readiness, and reconcile roots.
5. Stop and start that restored copy twice more. Each restart must remain ready without reapplying migration side effects; compare profile/root/book/delivery/overlay/provider/queue/shelf/annotation/issue/job counts with the pre-upgrade record.
6. Exercise search, series pagination/order, queue and shelf mutations, issue review, metadata candidate review/import, cover/source fetch, Settings lock, mount loss/recovery, and restart persistence.
7. Rehearse a cache/catalog rebuild against a second restored copy and confirm the durable intent above survives while only derived catalog/cache data is reconstructed.
8. Promote the tested image/data pair. Keep the prior immutable image and pre-upgrade volume snapshot paired until the release is accepted.

Use [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) as the evidence record. Automated checks cannot prove WebUSB secure-context behavior or Kindle acceptance; those lines require a physical device at the real household HTTPS origin.

## 10. Troubleshooting boundaries

- **Unhealthy container:** inspect `/api/status` for detail, `/api/readyz` for readiness, and redacted logs; confirm `/data` and `/cache` are writable by UID 1000 and no migration is already active.
- **Unavailable source:** repair the host mount outside Kindle Bridge, verify the Compose mount is `ro`, then reconcile. Do not remove catalog entries to hide a mount failure.
- **WebUSB unavailable:** confirm desktop Chromium, a trusted certificate, the exact allowed Host/Origin, top-level (not iframe) use, and `Permissions-Policy: usb=(self)`.
- **Settings disabled:** this is expected when `CATALOG_SETTINGS_MODE=read-only`; change the deployment setting deliberately and restart rather than bypassing it.
- **Interrupted Kindle send:** use the browser's bounded recovery flow. Never broadly delete Kindle Documents from the server or container.
