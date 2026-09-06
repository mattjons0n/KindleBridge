# Inline single-book sending

## Scope

1. Replace the single-book progress dialog with a faded, color-filling Send button in grid and list cards. Show preparation, sending, verification and verified completion in place. Retain the existing dialog for multi-book batches.
2. Make a second click request cancellation. Abort source download/conversion promptly; during USB transfer, finish the active command before deleting only its newly created object and verifying absence. Keep the connection alive for cleanup.
3. Show “Cancelling…” until cleanup completes, then “Cancelled”. Never report a verified book as cancelled after its commit point. Keep existing recovery reporting if USB loss or a device error prevents verified cleanup.
4. Preserve accessible button focus, progress descriptions, an off-card status if a refresh removes the card, batch summaries, duplicate prevention, source immutability and existing exact-handle recovery.

## Validation and handoff

- Targeted UI tests: no single-send dialog; fill progress; second-click cancellation; terminal success/cancellation/failure; no stale progress regression; one selected book stays inline; multi-book dialog retained.
- Targeted device/controller tests: cancel before upload, during upload and verification; exact cleanup; failed cleanup remains a failure; post-verification cancellation is unavailable.
- Run `npm run check` once at final handoff. Review these requirements against the implementation and push only task files to `main`.
- Physical acceptance remains separate: send and cancel on a real connected Kindle, confirm no new cancelled file remains. Unplugging the Kindle cannot guarantee immediate cleanup; unresolved cleanup must remain explicit and recoverable.

## Implementation result — 2026-09-06

- Implemented inline fill, phase labels, verified receipt and second-click cancellation for single grid/list sends, including one-book selections. Multi-book dialogs and partial-failure summaries remain intact.
- Preparation has its own abort signal; USB commands retain their live session for exact-handle cleanup. Cancellation closes at the verified-object commit boundary. Cleanup failure remains an error with the existing recovery journal.
- Progress updates preserve button focus and cannot replace “Cancelling…” while cleanup is pending. Retry uses a fresh token and revalidates the source/device. Degraded post-transfer matching remains visible. Off-card status retains access when the active card leaves the visible catalog page.
- Requirement check: requested UI, cancellation, verified cleanup, batch distinction and original-file protection are covered; no transfer-engine replacement or unrelated application changes are included.
- Validation: `npm run check` ran once: 950 passed, 31 failed. Of those failures, 29 server/watch tests passed with local-server permissions; two obsolete popup assertions were updated for the inline UI and passed. All 981 tests are accounted for across that run and focused reruns. Type checking, server build and final client production build passed.
- Chrome visual inspection was blocked by the locked Mac. Real-device cancellation has not been exercised for this change; automated cleanup tests are not physical-device confirmation.
