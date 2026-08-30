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
- [ ] Restart preserves installation identity, profiles, roots, Settings mode, and delivery history.
- [ ] Removing a source mount reports unavailable without mass deletion; restoring it reconciles normally.
- [ ] Cold backup produces a checksum-valid archive.
- [ ] Restore into a new volume preserves durable state and leaves the old volume untouched.
- [ ] Upgrade is tested against a restored copy; rollback selects the previous image and data snapshot together.
- [ ] Fresh cache plus reconciliation rebuilds covers, search, facets, and source serving.

## Load and privacy

- [ ] A 10,000-book catalog remains paginated, its bounded book-set match query succeeds, and health stays responsive during reconciliation.
- [ ] Source streaming, scans, and Settings changes honor configured rate/concurrency/body bounds.
- [ ] Startup-root validation, Settings path validation, source responses, and cover reads honor their configured deadlines and release capacity after timeout/disconnect.
- [ ] Logs contain no storage credentials, raw source bytes, conversion output, host paths where prohibited, or raw device serials.
- [ ] No analytics, external cover fetch, cloud conversion, or cloud book storage request occurs.

## Physical secure-origin acceptance

- [ ] Desktop Chromium trusts the real household certificate and reports a secure context.
- [ ] A user gesture opens the WebUSB chooser. On a clean connection the exact-byte self-test runs first and automatic inventory follows in the same session; pending exact cleanup stays read-only until acknowledgement plus a fresh self-test, inventory, and reconciliation.
- [ ] Confirmed/possible/absent matching remains conservative on the physical Kindle.
- [ ] Send prepares only a derivative, transfers and verifies it, then the exact book opens, navigates chapters, and displays its cover.
- [ ] A second household profile and its real mounted roots remain scoped correctly across restart.
