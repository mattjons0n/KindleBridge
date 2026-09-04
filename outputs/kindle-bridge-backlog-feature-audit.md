# Kindle Bridge backlog implementation audit

This document is the release-candidate omission audit for the backlog program in
[`kindle-bridge-backlog-build-plan.md`](kindle-bridge-backlog-build-plan.md). It separates software evidence from evidence that can only be collected with the household deployment, a provider credential, or the physical Kindle.

## Evidence rules

- **Implemented** means code and focused automated coverage exist in this repository.
- **Default off** means the bounded implementation exists, but production use remains disabled because the required physical acceptance has not been supplied.
- **External acceptance pending** is not an automated failure and must never be reported as physical proof.
- The final check result, commit, image result, and exact test count are recorded only after the candidate is frozen.

## Milestone map

| Milestone | User-facing or engineering outcome | Primary implementation | Focused automated evidence | Release state |
| --- | --- | --- | --- | --- |
| 0 | Shared capabilities, bounded context, activity vocabulary, ceilings | `client/src/book-action-capabilities.ts`, `client/src/library-browser-context.ts`, `client/src/activity-center.ts`; shared contract ceilings | `tests/client/book-action-capabilities.test.ts`, `tests/client/library-browser-context.test.ts`, `tests/client/activity-center.test.ts` | Implementation candidate |
| 1 | Valid Open Library redirects and GUI-managed Google Books key | `server/cover-providers.ts`, provider settings migration/routes/client/Settings UI | `tests/server/cover-providers.test.ts`, `tests/server/cover-provider-settings.test.ts`, metadata-editor/UI tests | Implementation candidate; live provider checks pending |
| 2 | Book details, density, URL/back/focus/scroll context | dedicated device-anonymous `GET .../details` DTO, `library-prototype-view.ts`, route/context codecs | `tests/server/book-details-state.test.ts`, `tests/client/library-browser-context.test.ts`, `tests/client/library-route.test.ts`, catalog-client/browser/view tests | Implementation candidate |
| 3 | Durable profile queue, bounded filtered selection, reviewed verified batch | schema/API/client queue state plus `client/src/send-queue.ts` and library UI | `tests/server/durable-library-state.test.ts`, `tests/server/durable-library-http.test.ts`, `tests/client/send-queue.test.ts`, queue/controller/view tests | Implementation candidate; physical batch/retry pending |
| 4 | Explain/confirm/reject/undo possible matches | `client/src/kindle/manual-match-decisions.ts`, reconciliation/controller/review UI | manual decision and reconciliation/controller/UI tests | Implementation candidate; physical reconnect/reversal pending |
| 5 | Upload-first safe Update on Kindle | `client/src/safe-kindle-update.ts`, `client/src/replacement-cleanup-journal.ts`, `ConnectedKindle.updateManagedBook` and UI orchestration | safe-update, cleanup-journal, device-runtime update, controller/view tests | Implementation candidate; physical update pending |
| 6 | Series ordering, quality hints, and queue actions | `shared/series.ts`, series APIs, `client/src/series-browser.ts`, library series view | `tests/client/series-browser.test.ts`, durable-library and library-view tests | Implementation candidate |
| 7 | Smart shelves, pinning, Favorite and Want to read | schema/API/query codec, `client/src/smart-shelves.ts`, shelf/annotation UI | `tests/server/shelf-query.test.ts`, `tests/client/smart-shelves.test.ts`, durable HTTP/client/view tests | Implementation candidate |
| 8 | Health inbox, reviewed metadata import, duplicate review, bounded bulk jobs | `shared/catalog-issues.ts`, issue/provider/job schema and API, `client/src/metadata-candidates.ts`, inbox/editor UI | `tests/server/catalog-issues.test.ts`, `tests/server/metadata-lookup-worker.test.ts`, `tests/client/metadata-candidates.test.ts`, database/HTTP/view tests | Implementation candidate; live provider checks pending |
| 9 | Quiet activity/device center and Advanced diagnostics | `client/src/activity-center.ts` and top-bar/drawer integration | activity/controller/view/accessibility tests | Implementation candidate; physical journey pending |
| 10 | Bounded `GetPartialObject` probe | MTP range primitive, `client/src/kindle/partial-object-probe.ts`, Advanced adapter | MTP contracts/object-store/probe tests | Default off; physical support/benefit gate pending |
| 11 | Exact bounded KFX/AZW8 sidecar metadata reader | `client/src/kindle/kfx-metadata.ts`, `client/src/kindle/kfx-sidecar.ts`, inventory gate | KFX parser/association/inventory tests | Default off; physical KFX gate pending |
| 12 | Browser-only bounded reading progress/state evidence | `client/src/kindle/krds-reading-state.ts`, `reading-sidecars.ts`, `reading-state.ts`, gated presentation | KRDS/sidecar/association/presentation tests | Default off; physical per-format/state gate pending |
| 13 | Evidence-based safe-write cadence decision | `client/src/kindle/safe-write-cadence.ts`; default remains `always` | safe-write cadence trigger/fault tests | Implemented decision: always test; adaptive mode inert |
| 14 | Final integrated check, Docker/deployment docs, and omission audit | this audit, README/handoff/server/deployment documentation | final `npm run check`, Docker build/smoke and diff audit | Automated candidate gate passed; external acceptance remains below |

## Non-omission checks

- Mounted originals remain immutable; edits and covers live in `/data`, extracted covers in `/cache`, and conversion/PDOC work only on browser-local derivatives.
- Profiles remain organizational views, not authentication boundaries; no Calibre, cloud conversion/storage, NAS-vendor package, or application-managed SMB/NFS mount was introduced.
- WebUSB permission remains user initiated. No Send, Remove, Update, or Kindle-cache mutation bypasses current write proof.
- Existing Kindle objects are never overwritten or broadly deleted. Possible, stale, partial, and ambiguous evidence cannot authorize deletion.
- Update uses **prepare → upload → verify → durably record → exact old delete → absence verification**; low capacity never silently switches to delete-first.
- Provider results are reviewed overlays. No candidate auto-selects fields and no provider receives source bytes, paths, Kindle data, or arbitrary outbound URLs.
- Raw Kindle inventory and reading evidence remain browser-local. Experimental partial/KFX/reading behavior remains disabled until physical acceptance.
- Queue, shelf, issue, candidate, activity, sidecar, and decision records have explicit ceilings and reject oversized destructive/transfer work rather than silently truncate it.
- The default UI keeps secondary surfaces in drawers/sheets and low-level probes under Advanced.

## Final candidate record

- Feature candidate Git revision: `1ae91a1188631793c099230d581fcfb8770247ed`
- Final `npm run check`: **passed** in the pinned Node.js 24.20.0 Docker build on 2026-09-04 — 93 test files and 948 tests passed; client/server type checks and the production Vite build passed
- Canonical Docker build/smoke: **passed** as native `linux/arm64` image `sha256:1749294bd084341518f1c6727a752445a84a9d51ba9c6f75c605cb79a1a427d0`; a fresh empty `/data` and `/cache` tmpfs booted as UID/GID 1000 with a read-only root filesystem, all capabilities dropped, `no-new-privileges`, and PID limit 128; `/api/healthz` returned `{"live":true}` and `/api/readyz` returned database/cache ready
- Live Open Library/Google Books acceptance: requires deployment egress and, for Google Books, a user-supplied key
- Existing household `/data` upgrade, restart, cold backup/restore, and derived rebuild rehearsal: external acceptance pending
- Native `linux/arm64` image and in-image CycloneDX SBOM generation: passed; cross-runtime `linux/amd64` execution and registry provenance verification remain pending the publishing environment
- Household read-only mounts and private HTTPS/WebUSB origin: external acceptance pending
- Maximum-supported-EPUB browser memory measurement on the intended client: external acceptance pending
- Physical `0x1949 / 0x9981` consolidated journey: external acceptance pending
