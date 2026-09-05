# Onboarding and reading history build plan

## Scope

Implement in the existing application, not the separate modern-GUI mockup.

1. **Onboarding:** offer setup on an unconfigured installation, create the first profile and container-visible source folder through the existing validated configuration API, show indexing health, offer user-initiated optional Kindle connection, remember Skip for now, and allow restarting setup from Settings. Optional API keys never gate setup.
2. **Reading presentation:** connect existing browser-only reading evidence to grid/list progress and distinct reading-state labels, plus pagination-independent status filtering. Unknown is not zero or Unread; disconnect retires evidence to Last seen and profile changes clear it. Keep unvalidated device formats and automatic presentation disabled until physical acceptance.
3. **Read books shelf:** persist only opaque profile/book membership after an exact, unique, explicitly Read observation. Keep membership after disconnect/removal; do not retain raw sidecars, percentages, positions, device identifiers, or Kindle timestamps on the server. Reuse bounded durable personal annotations and shelf queries.

## Milestones and checks

- A: durable schema/API contracts for setup dismissal and completed-book membership; targeted persistence, validation, profile-isolation and query tests.
- B: onboarding controller and accessible staged UI using existing Settings validation and immutable-source policy; targeted first-visit, skip/reopen, error and successful configuration tests.
- C: reading projection, grid/list UI, filtering and idempotent shelf recording; targeted unknown/explicit-state, ambiguous association, disconnect/profile and durable-history tests. No invented Read state from 100% progress.
- D: one final `npm run check`, requirement-by-requirement omission review, and explicit handoff of physical-device dependencies.

## Physical acceptance boundary

Existing KRDS parsing can expose percentage/time but does not prove the Kindle's explicit Read/Unread flag. Test real unread/mid-book/completed fixtures after close, reconnect and reboot before enabling each automatic format and presentation gate. Software wiring is not evidence of device validation. If explicit completion is not exposed by stock MTP, report that limitation instead of silently substituting an inferred completion flag.

## Out of scope

Modern-GUI rollout, backup/restore tooling, unrelated recovery redesign, Calibre/cloud conversion, source edits, and Kindle sidecar writes. GitHub publication was subsequently authorized as a separate handoff step.

## Implementation and omission review — 2026-09-05

| Requirement | Software status | Remaining evidence |
| --- | --- | --- |
| Show setup when no library has roots configured | Implemented; configured and read-only installations do not auto-open it | None for automated behavior |
| Remember Skip across visits; reopen from Settings | Installation-wide SQLite singleton and bounded typed API; save failure remains visible | Tested in a real browser after reload |
| Create library/path without modifying sources | Uses the established configuration validation/idempotency flow; reduced-clutter setup form | Real household mount acceptance remains external |
| Indexing step and optional connection | Live folder status/count, optional user-initiated Connect; unsupported browsers can finish | Physical connection acceptance remains external |
| Grid/list reading progress and separate state indicator | Wired behind the default-off presentation gate; unknown differs from 0%, explicit state differs from presence | Actual percentage and explicit-state semantics must pass physical tests |
| Reading filter across pages/profiles | Opaque include/exclude IDs applied by the catalog before pagination; cleared on profile/shelf changes | Device observations still gated |
| Last seen on disconnect; no cross-profile carryover | Browser evidence retired/cleared; no live authority retained | Physical reconnect/lifecycle matrix still required |
| Durable Read books shelf | Bounded profile annotation flag and built-in shelf; only current unique explicit Read evidence auto-records; original/sideload removal does not delete membership | Current KRDS parser has no physically proven explicit Read/Unread flag, so automatic population is NOT enabled |
| Source/device safety and scope | No source modifications, no sidecar writes, no conversion/backend USB changes; modern mockup not rolled out | No additional established-safety re-audit performed |

### Validation record

- Targeted onboarding, projection, durable database and shelf-query checks: 19 passed initially.
- Full wizard happy/error flow: passed. Targeted HTTP contracts and updated built-in shelf checks: 5 passed. HTTP tests required localhost-listening permission.
- One `npm run check`: **93 files / 954 tests passed; 1 file / 1 timing assertion failed**. The 10,000-book fixture setup took 47.13 s against its existing 45 s limit. No timing threshold was changed.
- Focused rerun of the failed scale case plus final reading/filter tests: **2 files / 6 tests passed**, total 38.22 s. This does not erase the full-run timing failure.
- Client/server TypeScript checks and production build passed. After the browser layout review, the CSS/template-only compact wizard refinement was rebuilt successfully.
- Real-browser fresh-install check: welcome appears, Get started opens the compact library form, Skip persists after reload, and Run setup wizard is available in Settings. The check used separate temporary state, not the household library.
- Physical Kindle testing, real-mount acceptance, and Docker release promotion were not performed. The user subsequently requested publication to GitHub main.
