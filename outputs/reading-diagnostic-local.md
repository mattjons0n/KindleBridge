# Local Kindle reading diagnostic

Run the Vite client and open `http://127.0.0.1:5173/reading-diagnostic.html` in Chrome on the USB-connected computer. No catalog backend or server deployment is needed. This separate HTML entry is not part of the production build; its runtime operation also requires development mode.

1. Disconnect Kindle in any other application/browser tab.
2. Note titles the physical Kindle shows as unread, in progress (including percentage), and read. Include model/firmware if available in the notes field before collecting.
3. Click **Connect and collect reading data**, select the Kindle in Chrome's chooser, and wait for completion.
4. Download the JSON report and attach it to the development conversation. The session is released after collection, cancellation, or failure.

The report records full Documents hierarchy ObjectInfo and paths, raw Base64 sidecar bytes, SHA-256, existing parser results/errors, skipped files and enumeration failures. Recognized reading files are prioritized; unknown files inside `.sdr` folders are retained too, including nested sidecars. Raw bytes support offline inspection of fields the current parser cannot interpret. No report is automatically uploaded or persisted to the catalog.

Collection is bounded to 10,000 visited objects, depth 32, 8 MiB per file, 64 MiB aggregate attempted file reads, and a five-minute aggregate collection deadline. Anything omitted by these limits is reported. Fatal transport failure or cancellation stops collection. This is a Documents-sidecar diagnostic, not a promise that firmware exposes its authoritative Read flag through MTP.

## Scope check

- Chrome user-gesture chooser and existing browser-wide device lease: reused.
- Read-only collection: read-only store interface, no self-test/cache writes, no book payload reads, no deletes.
- Original books and the normal connection/send safety flow: unchanged.
- Exact paths and raw unknown sidecar evidence: retained, not redacted.
- Device information, notes, hashes, parse failures, limits and omissions: exported together.
- Automatic reading rollout: still disabled; zero and 100% do not establish Unread/Read.
- Physical evidence: user-selected Chrome collection succeeded on 2026-09-06: 124 sidecar files, 250,735 bytes, no skipped/failed files or enumeration issues. The raw report is saved locally in Downloads, not included in Git.

## Captured-format fixes

All 32 `.azw3f`/`.azw3r` files use a LONG container version of 1. The parser previously required INT. The 16 timer records use structure version 0, previously rejected by the 1/2 allowlist; their `lpr` version is BYTE 2, previously rejected by the INT/LONG-only decoder. These three wire-shape discrepancies are now supported with reconstructed regression fixtures. Existing signature, bounds, conflict, and unsupported-version checks remain intact.

The corrected parser processes all 32 saved files without errors. Sixteen `.azw3f` files yield timer fractions and last-read timestamps; the companion `.azw3r` files yield no supported progress evidence. The user's physical comparison then disproved using these timer fractions as current reading progress or completion:

| Book | Sidecar timer fraction | User-confirmed Kindle display |
| --- | --- | --- |
| Wayward Galaxy | 10.37% | 12% |
| Artifact | 45.58% | Read |
| One Year After | 95.00% | Read |

No explicit Read/Unread flag has been established. An `EndActions` record appears for One Year After but not the also-read Artifact; it is not sufficient for complete Read detection. Keep rollout disabled. The parser's existing `progressPercent` output remains experimental timer evidence, not a validated UI percentage. A future enabled path must use a validated current-position denominator and independent completion evidence, not a percentage threshold or rounding workaround.

The related project's [format research](https://github.com/zevisvei/kindle-reading-dashboard/blob/main/docs/KRDS-format.md) describes the timer fraction as measured reading activity by words. Its [read-state research](https://github.com/zevisvei/kindle-reading-dashboard/blob/main/docs/read-state-storage.md) also distinguishes modern manual Read state from these sidecars. Those findings are context, not validation of this Kindle or permission to access cloud accounts/device internals.

Offline reanalysis uses `node scripts/inspect-reading-report.mjs <report.json>`; append `--structure` to inspect all bounded decoded fields. It reuses the actual application parser, reads only the supplied local report, and never uploads or changes it. Automatic reading collection/presentation remains gated pending physical semantic validation.

## Automated validation

Three new targeted diagnostic tests passed. Type checks and the production build passed. `npm run check` was run once: 930 tests passed and 29 failed. Twenty-six failures were localhost-listening permission errors in the sandbox; two existing watcher assertions and one existing shutdown timeout also failed. No unrelated server code or test thresholds were changed, and the full suite is not represented as green.

The subsequent captured-format parser fix passed all seven targeted parser tests and offline replay of all 32 real reading files. Its final `npm run check`, with localhost networking permitted, passed 959 of 960 tests across 95 files. The sole failure was the existing 10,000-book scale setup budget (47.76 seconds versus 45 seconds). The separate production build/type checks passed. No unchanged checks were retried and no performance threshold was loosened.
