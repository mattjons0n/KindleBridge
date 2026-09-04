# Kindle Bridge device experimental gates

Last updated: 2026-09-04

This note records the software foundations and the physical evidence still required for device-sensitive backlog milestones 5, 10, 11, 12, and 13. Automated fixtures prove bounds, ordering, and fail-closed behavior; they do not prove how the physical `0x1949 / 0x9981` Kindle behaves.

## Current shipped defaults

| Capability | Current default | Production effect |
| --- | --- | --- |
| One-click managed replacement | Integrated for eligible edited EPUBs | The action is shown only for one exact current stale KindleBridge-managed presentation and runs the guarded upload-first transaction from an exact version-bound request. Physical replacement acceptance is still pending. |
| `GetPartialObject` (`0x101b`) | Off | Normal inventory never issues it. The Advanced activity panel can arm only the next clean connection in page memory; it then requires explicit selection and confirmation of one exact, unprotected readable book directly inside Documents. |
| KFX/AZW8 sidecar metadata | `kfxSidecarMetadata: false` | KFX/AZW8 stays visible but metadata-incomplete unless a caller deliberately enables the internal gate. |
| Reading sidecars and presentation | `readingSidecars: false`; browser presentation gate `{ version: 1, enabled: false }` | No progress, timestamp, or Read/Unread state is read or presented in normal operation. Format sub-gates and the separate presentation gate remain off pending format-by-format acceptance. |
| Safe-write cadence | `always` | Every clean connection continues to run the exact-byte create/read/compare/delete proof before normal inventory and before Send becomes available. The adaptive attestation helpers are not connected to runtime persistence or authorization. |

None of these internal experiments belongs in ordinary Settings or container environment configuration.

## Milestone 5 — one-click Update on Kindle

The device/core transaction accepts only a derivative already fetched, source/edit-revalidated, overlaid, converted, PDOC-prepared, bounded, and hashed by its caller. It then owns one device-operation lock and performs: current-connection write proof; fresh complete hierarchy inventory; exact managed-old ObjectInfo and parent/type/size/protection/token revalidation; coexistence capacity check; collision-resistant no-overwrite upload; fresh new-object verification; durable delivery callback; a second exact old-object revalidation; exact-handle deletion and absence verification; and one final inventory/reconciliation callback.

The public controller hook accepts opaque profile/book IDs plus the UI-observed source hash, metadata revision, and presentation version. Before entering the device transaction it requires one unique live stale KindleBridge-managed presentation, refetches the book, overlay, optional cover, and source, binds the source size/hash/ETag/presentation, prepares the derivative locally, then repeats every mutable catalog and byte binding. Its delivery callback must verify either a bounded pending-delivery journal write or server acceptance under the same idempotent operation ID before it returns and permits old-copy deletion. Every explicit result installs or safely downgrades the freshest available inventory; non-`updated` outcomes retain queue intent and revoke further mutation authority until reconciliation/recovery.

Delivery-record failure retains both copies and returns `new-copy-kept-old-recording-required`. Old-copy deletion or absence-verification failure retains the verified new copy and returns `new-copy-kept-old-cleanup-required`. Both paths attempt to persist a bounded local v1 intervention record before reconciliation, and journal failure remains separately visible. The journal is explanatory evidence only: it cannot authorize deletion without a new complete live inventory and exact ObjectInfo checks. A final reconciliation failure after proven replacement returns `updated-reconciliation-required` without obscuring the verified update. Edited AZW3 remains rejected before device locking or mutation.

Physical acceptance still requires:

- Edit metadata and a cover on a real EPUB; retain the mounted source's exact pre/post hash and bytes.
- Start from one current exact KindleBridge-managed old presentation, confirm temporary capacity for both, run Update, and inspect operation timing/order.
- Verify the replacement handle, direct Documents parent, collision-resistant filename, managed token, size, readable/openable PDOC, cover, and chapter navigation.
- Verify the old exact handle is absent, one current presentation remains after reconnect, and the delivery/reconciliation state is current.
- Exercise insufficient capacity and disconnect immediately before upload, after upload, before deletion, during deletion/absence verification, and before final reconciliation. At every point confirm either the old copy or the verified new copy remains and the UI reports the precise retry/intervention state.
- Confirm a possible/manual-only match, an ambiguous target, a stale size/name/token/ObjectInfo, a protected object, and an edited AZW3 can never authorize deletion.

Rollback is to leave the Update action hidden and use the existing separate exact Remove and Send flows. Replacement intervention records remain bounded and inert; rollback or startup must never auto-delete either copy.

## Milestone 10 — bounded partial reads

The protocol primitive encodes standard `GetPartialObject` with unsigned offset/range overflow checks, a 4 MiB per-request hard allocation ceiling, exact transaction/response parameter validation, returned-byte-count agreement, normal abort/inactivity behavior, and the session's one-operation queue. The probe itself caps samples at 64 KiB, checks prefix, overlap, middle, tail, repeat, exact EOF, and beyond EOF where unsigned offsets permit, and compares ranges with a bounded whole-object reference only for objects at or below 256 KiB by default (hard maximum 1 MiB). Results expose counts, equality, timings, EOF behavior, and the validated OK response code—never sampled bytes or parsed book metadata.

The byte-free Advanced result adapter is callable only when the connection was explicitly created with its development flag. Its UI control is deliberately absent from ordinary Settings and container configuration: the user must arm the next clean connection in the current page session, wait for the ordinary exact-byte test and complete inventory, explicitly select one unprotected readable book directly inside Documents, and confirm the run. Nested sidecars, cache/diagnostic files, protected files, folders, and non-book files are never offered. ConnectedKindle revalidates the selected exact object and current parent before reading. One attempt is allowed per connection unless the user explicitly confirms a repeat. The visible/copyable result is a fixed byte-free metric projection. DeviceInfo must advertise `0x101b`; model names and mocks never imply support.

Physical acceptance still requires:

- Capture the physical DeviceInfo operation list and verify whether `0x101b` is advertised.
- Explicitly select a disposable, unprotected test book and run prefix, overlapping, middle, tail, repeated, and exact-EOF ranges. Capture requested/returned sizes, response codes, timings, equality, and any nonfatal unsupported response without logging bytes.
- For a small object, compare against the bounded `GetObject` reference. Repeat after clean disconnect/reconnect and confirm identical samples.
- Compare total bytes and elapsed time with today's full metadata read for representative small and large supported PalmDB/MOBI files.
- Exercise abort, command/inactivity deadline, cable removal, invalid handle/range, short/over-return, and response-count mismatch. A fatal transport or protocol-desynchronization error must retire the connection and must not trigger a full-read fallback.
- Only if that passes, build and accept the segmented PalmDB/MOBI byte-source integration. Until then, production metadata continues using the existing bounded full-object path.

Rollback is simply to keep the development connection flag and any future `partialMetadataReads` gate off. There is no migration or durable device state.

### Explicit `GetObjectPropList` prohibition

`GetObjectPropList` (`0x9805`) is intentionally absent from `MtpOperationCode` and must never be emitted for the known `0x1949 / 0x9981` Kindle. Calibre/libmtp marks this exact device under Android-bug flags that include broken `GetObjectPropList`. The partial-read experiment does not weaken that prohibition; contract tests assert the forbidden opcode is absent.

## Milestone 11 — KFX/AZW8 metadata sidecar

Normal hierarchy traversal still prunes every `.sdr` descendant. The default-off reader starts only from an exact, unique sibling `<book stem>.sdr`, relists live parent handles, and permits only `<book>.sdr/assets/metadata.kfx`. It is bounded to 2,000 books, 32 direct children per inspected folder, 4 MiB per sidecar, and 128 MiB aggregate by default. The dedicated CONT/ENTY/PackedIon parser retains only title, authors, identifiers, and language, with strict version, container/entity, field, depth, string, decoded-total, duplicate, and conflict limits. It never requests the main KFX/AZW8 book and parsing failure returns to conservative metadata-unknown behavior.

Physical acceptance still requires:

- Use at least one real unmanaged KFX/AZW8 book on `0x1949 / 0x9981` and record the exact live parent/path layout and observed CONT/ENTY/PackedIon versions.
- Capture a legally usable sanitized fixture and verify parsed title, authors, identifiers, and language against an independent display/source.
- Confirm the exact sidecar byte count remains within limits and is byte-identical before/after inspection.
- Confirm diagnostics show `metadata.kfx` alone was read, never the main KFX/AZW8 object or unrelated/deeper assets.
- Reconnect, repeat, and verify the resulting match is correct and unique. Missing, ambiguous, conflicting, version-drifted, or malformed sidecars must remain unknown rather than absent or confirmed.

Rollback is `kfxSidecarMetadata: false`, which is the current default and restores today's unsupported-format behavior without a migration or cache-format change.

## Milestone 12 — reading progress and state

The default-off reader reuses exact sibling association and only inspects direct children of that exact book's `.sdr` folder. Its format allowlist is AZW3 `.azw3f`/`.azw3r`, KFX/AZW8 `.yjf`/`.yjr`, and legacy AZW/MOBI/PRC `.mbs`/`.mbp1`. Defaults cap 2,000 books, 4,000 candidate sidecars, 32 direct children, depth exactly one, 2 MiB per object, and 64 MiB aggregate. There are no writes, renames, or deletes. The bounded KRDS parser retains only documented `timer.model` percentage and `lpr`/`updated_lpr` time evidence. It never treats 0% as Unread or 100% as Read; `explicitState` stays false and status stays Unknown/In progress until a distinct physical explicit-state field is proven.

The separate browser presentation gate is versioned and defaults off. Its projector accepts only one fresh, confirmed, unique live object claim per opaque catalog book ID; duplicate, possible, stale, malformed, missing, and over-limit evidence fails to Unknown. Disconnect retires retained evidence to **Last seen**, while profile change clears it completely. A bounded, pagination-independent selector returns only opaque IDs for the scoped include-ID catalog query—never progress, time, path, sidecar, or device data. Pure grid/list descriptors make Unknown structurally different from known 0% and expose a separate text-labelled open/closed-book state shape only for explicit state evidence. No UI consumes these contracts until the physical gate passes.

Physical acceptance still requires:

- On a managed PDOC AZW3, capture sanitized bounded fixtures at not-started, mid-book, and completed states, after closing the book, after reconnect, and after a Kindle reboot.
- Establish the exact direct sidecar filename/path, container/field versions, stable percentage/timestamp semantics, refresh timing, and whether paired files agree.
- Compare the displayed percentage/status with the Kindle and byte-check every inspected sidecar before and after the read-only probe.
- Prove missing, malformed, duplicate, conflicting, stale, unsupported, unenumerated, possible-match, and ambiguous-match evidence displays Unknown and never attaches to the wrong catalog book.
- Validate disconnect/BFCache/long-hidden retirement before accepting Last seen behavior.
- Repeat the full matrix separately for KFX or legacy formats only when a real sample exists; acceptance of AZW3 must not silently enable another format.

Rollback is `readingSidecars: false`, with every format sub-gate off, plus the independent versioned browser presentation gate disabled. No reading-state UI/filter should ship before the physical state matrix passes; disabling either gate changes neither catalog nor Kindle contents.

## Milestone 13 — safe-write cadence decision

The supplied physical logs already separate the two phases clearly:

- 20:25:13 inspection → 20:25:14 exact-byte pass: about 1 second; inventory completed at 20:25:34: about 20 seconds.
- 20:26:06 inspection and exact-byte pass occurred within the same logged second; inventory completed at 20:26:26: about 20 seconds.
- 21:33:41 inspection and exact-byte pass occurred within the same logged second; inventory completed at 21:34:01: about 20 seconds.
- 21:34:24 inspection and exact-byte pass occurred within the same logged second; inventory completed at 21:34:45: about 21 seconds.

The safe-write test contributed roughly 0–1 second while metadata inventory contributed roughly 20–21 seconds. Removing or deferring the self-test therefore would not materially fix the reported connection delay. The shipped decision remains policy `always`: the current eager proof stays in place, and experimental attestation constructors/decision helpers remain inert—not persisted, not consumed by connection orchestration, and unable to authorize any mutation.

If later measurements materially change that conclusion, adaptive behavior requires a new physical gate covering first use, storage loss, app/policy/fingerprint change, expiry, Kindle reboot, USB/MTP fault, unclean lifecycle, interrupted write, pending recovery, cleanup failure, explicit diagnostic, concurrent mutation requests, and the first Send/Remove/Update/cache write. Deferred evidence must never be labeled current-session proof, and every mutation must run exactly one current-session test before proceeding.

Rollback/default is always `always`; any stored experimental attestation remains inert and requires no migration.

## Consolidated physical evidence matrix

| Milestone | Required physical states/samples | Evidence to retain | Enable decision |
| --- | --- | --- | --- |
| 5 — Update | Edited EPUB; sufficient/insufficient capacity; stale, protected, ambiguous, and manual-only old targets; disconnect before/after every mutation boundary | Source hashes/byte equality, exact old/new ObjectInfo, operation order, delivery outcome, absence relist, final inventory, readable cover/navigation after reconnect | Retain the integrated action only if physical acceptance confirms every failure keeps a known readable copy and only an exact current managed old object can be deleted; otherwise hide it and use separate Send/Remove |
| 10 — partial read | Advertised operation; small and large unprotected PalmDB/MOBI; prefix/overlap/middle/tail/repeat/EOF/beyond-EOF; reconnect; abort/timeout/cable fault | DeviceInfo operations, request/response counts and codes, timings, equality metrics, full-reference comparison for a small object, connection fault state; never bytes | Enable a later `partialMetadataReads` path only if correct, repeatable, non-corrupting, and materially faster; otherwise record do-not-enable |
| 11 — KFX metadata | At least one real unmanaged KFX/AZW8 plus missing/ambiguous/invalid sidecars; reconnect | Exact live path/parents, versions, bounded sidecar size/hash, sanitized fixture, parsed fields, match result, read-handle diagnostics proving no whole-book read | Enable `kfxSidecarMetadata` only after the accepted physical format subset passes |
| 12 — reading state | Managed PDOC AZW3 at not-started/mid/completed, after close/reconnect/reboot; real KFX/legacy samples separately | Exact sidecar paths, versions, pre/post sidecar hashes, validated percent/time, explicit-state observation (if any), ambiguity/lifecycle outcomes | Enable each format independently; keep Read/Unread unknown unless a distinct explicit field is physically proven |
| 13 — cadence | Existing four measured repeat connections; only revisit with first use, reconnect, mutation, reboot, fault, interruption, recovery, and lifecycle matrix | Separate self-test/inventory/ready timings and exact cleanup/source-integrity evidence | Current decision is `always`; adaptive behavior remains inert because the measured 0–1 second proof is not the ~20-second bottleneck |

## Omission status

- Milestone 5 device/core safety ordering, controller-side double-bound EPUB preparation, durable delivery gate, explicit fault outcomes, inventory installation, queue disposition, visible capability/confirmation/result wiring, and activity summary are implemented. Physical Kindle acceptance remains pending; rollback hides the action without changing device or source state.
- Milestone 10A/10B protocol, controller, and session-only Advanced activity-panel diagnostic are implemented and default off; physical probing and 10C production PalmDB/MOBI integration remain intentionally disabled/pending.
- Milestone 11 parser/locator software exists behind its default-off gate; real KFX physical fixtures and acceptance remain pending.
- Milestone 12 parser/locator/evidence-model software plus isolated catalog projection, lifecycle retirement, bounded opaque-ID filtering, and accessible grid/list presentation contracts exist behind default-off gates. Central controller/view wiring and all physical state/format acceptance remain intentionally pending; no reading UI ships yet.
- Milestone 13 is closed for current behavior by the observed timing decision: retain eager `always`. Adaptive helpers do not change runtime behavior.
