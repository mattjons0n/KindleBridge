# Kindle Bridge project guidance

## Current objective

Maintain and complete the private, self-hosted Kindle Bridge household ebook library. The implemented platform-agnostic Docker service monitors configured read-only directories mounted into the container, indexes metadata and covers, and serves catalog/source bytes to the browser. EPUB conversion remains browser-local through boko WASM, and Kindle transfer remains browser-local through WebUSB/MTP. Do not introduce Calibre, a cloud conversion service, cloud book storage, or platform-specific packaging unless the user explicitly changes the product requirements.

## Verified baseline

- Local URL: `http://127.0.0.1:5173/`
- Use Node.js 24 or newer.
- Install dependencies with `npm ci`.
- Run locally with `npm run dev`.
- Validate all changes with `npm run check`.
- The original transfer POC baseline was 18 test files and 133 passing tests. Do not report that as the current expanded-suite count; use the latest complete `npm run check` output.
- Physical testing succeeded on an MTP Kindle with USB IDs `0x1949 / 0x9981`.
- EPUB conversion, MTP connection, exact-byte self-test, book transfer, book opening, chapter navigation, and library-cover display have all been confirmed on the physical device.
- Milestones 0–9 of the household implementation are present: the normal UI uses the real API/SQLite catalog, persistent Settings, scanner/watcher, live Kindle inventory/matching, catalog-driven Send flow, and Docker deployment artifacts.
- The expanded integrated flow still requires fresh physical Kindle acceptance and real household-mount/private-HTTPS acceptance. Never infer either from mocks, localhost, or the earlier single-book POC.

## Important implementation decisions

- `client/vendor/boko/boko_bg.wasm` is a required runtime artifact and must remain in the repository.
- Corresponding boko source and license material live under `third_party/boko`.
- Modern MTP Kindles may not expose `system/thumbnails`, so converted sideloads are prepared as Kindle personal documents (`PDOC`) in `client/src/api/azw3-sideload.ts`.
- The PDOC preparation is an offset-preserving EXTH metadata edit from `EBOK` to `PDOC`. It also verifies embedded cover records before transfer.
- PDOC files show their embedded cover in the Kindle library but are classified under Documents rather than Books.
- WebUSB access must remain user initiated. Never overwrite or broadly delete existing Kindle content.
- **Update Kindle copy** is upload-first and applies only to one freshly revalidated stale KindleBridge-managed presentation of an edited EPUB: prepare, upload, verify, durably record, revalidate the exact old object, delete that handle, verify absence, then reconcile. Never fall back to delete-first when temporary capacity is insufficient; a possible/manual/fuzzy match is not replacement authority.
- Preserve the collision-resistant filename, bounded recovery journal, exact-handle cleanup, descriptor-derived MTP interface selection, and clean USB/session shutdown behavior.
- Treat host-mounted originals as immutable. Format conversion and PDOC preparation may modify only a derived copy.
- Keep no-login deployments private to a trusted LAN or VPN. Profiles are organizational views, not access-control boundaries.
- A green on-Kindle check requires a strong match; ambiguous matches must remain visibly uncertain.
- Kindle metadata acceleration is browser-operated and non-authoritative by itself. It may use the bounded checksum-protected A/B cache files at the selected Kindle storage root plus the browser-local fallback. Reuse portable parsed fields only after current live enumeration and an exact unadjusted-path/object-format/size/modification-time match; browser fallback additionally requires the pseudonymous device/storage evidence. Never send either cache to the backend or use it to resurrect an absent object. Update the Kindle-resident cache only after the current exact-byte self-test and complete hierarchy inventory, preserve one verified slot during rotation, and never claim or alter Calibre's `metadata.calibre`.
- Do not enable MTP `GetObjectPropList` (`0x9805`) on the known `0x1949 / 0x9981` Kindle: Calibre/libmtp blacklists it for that exact VID/PID. `GetPartialObject` and targeted KFX sidecar parsing remain physical-probe/backlog work.
- The initial WebUSB chooser remains user initiated. On a clean connection, the expanded product runs the exact-byte self-test first, then enumerates inventory automatically before enabling Send. If exact cleanup is pending, allow only the read-only recovery inventory first; acknowledgement must be followed by a new self-test, inventory, and reconciliation before Send can resume.
- Deploy the catalog service only as a standard, platform-agnostic Docker/OCI container. Host directories are supplied through ordinary read-only bind mounts or Docker volumes; the application does not mount or manage SMB/NFS storage. Do not create or maintain platform-specific packages.
- Keep SQLite durable state under `/data`, rebuildable cover/index cache under `/cache`, and allowed source mounts beneath configured container parents such as `/libraries`.
- Settings paths are container-visible paths, never host paths, share URLs, or storage credentials.
- Optional provider credentials are configured through the compact Settings UI, stored only in durable server-side `/data`, and never returned unmasked, logged, or persisted in the browser. Provider results are reviewed overlays and must never rewrite mounted originals.
- Profile queues, shelves, annotations, issue dispositions, duplicate preferences, and metadata lookup jobs are durable bounded intent. Revalidate queue/source/presentation/device evidence at execution time, reject ceiling overflow explicitly, and never let browser convenience state become Kindle deletion authority.
- Preserve profile scoping, realpath containment, bounded source streams/scans/parser workers, strict host/origin handling, and no-login private-network guidance.

## Working expectations

- Read `README.md` and `PROJECT_HANDOFF.md` before making architectural changes.
- Preserve the no-Calibre and no-cloud boundary. The private Docker catalog service is required; conversion and Kindle USB/MTP activity remain browser-local.
- Add or update tests with behavior changes.
- Run `npm run check` before declaring work complete.
- Complete a requirement-by-requirement omission audit before declaring a milestone or release complete.
- Physical Kindle success cannot be inferred from mocks; clearly distinguish automated validation from device confirmation.
