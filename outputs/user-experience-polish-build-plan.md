# ShelfSend user-experience polish

Branch: `codex/user-experience-polish`. Do not merge or push to `main`.

## 1. A calmer library

- Rename the navigation and default collection headings from Household to Libraries/Library. Keep user-created library names intact.
- Remove the container-folder card, no-sign-in explanation and technical licensing footer from everyday browsing. Keep documentation, license files and third-party notices intact.
- Show one readable library-update status in the header, with technical folder details in Settings.
- Make the On Kindle, Possible matches and Ready to send totals clickable filters. Keep the selected filter visible and keyboard accessible.
- Include the local fixes for the false interrupted-write warning and connected-only On Kindle sidebar item.

## 2. Settings owns technical tools

- Move the original transfer controls into a collapsed Settings section named Diagnostics. Keep logs, recovery and existing diagnostic actions available.
- Move the raw Kindle file inventory into Settings → Diagnostics. Remove it from the bottom of the library dashboard.
- Keep genuine recovery warnings visible wherever the user is; changing the layout must not hide failures requiring action.

## 3. Clear, readable actions

- Simplify batch sending to current book title, Book X of Y, overall progress and a short status. Remove converter/protocol steps from the everyday dialog.
- Preserve exact verified outcomes, partial-failure summaries and unsent-book retry selection.
- Redesign removal confirmation with readable dark/light colors, clear book titles, inspectable exact filenames and sizes, and distinct Cancel/Remove actions.

## 4. Needs attention becomes a guided repair list

- Lead each issue with the affected book and a plain-language explanation.
- Provide one obvious next step appropriate to the issue: choose a cover, edit book details, compare duplicates or check the library folder.
- Put alternate actions, ignored issues, source paths and technical information behind secondary controls/disclosures.
- Retain reviewed metadata overlays, duplicate preferences, retry and ignore/restore behavior. Never rewrite original books.

## 5. Keep books visible while checking folders

- Keep the current On Kindle book list visible during routine scan/comparison refreshes and show an unobtrusive updating indicator.
- Refresh it when current results arrive. Real removal, source changes and connection loss still update the view honestly.
- Any retained display is presentation only: it cannot authorize Send, replacement or deletion while current checks are unavailable.

## 6. Validate and publish the branch

- Run targeted tests for changed behavior; do not repeat unchanged passing checks during implementation.
- Visually inspect the real renderers for light/dark contrast, desktop/narrow layouts, batch/removal dialogs, Settings and Needs attention.
- Run `npm run check` once at final handoff (with localhost test-server permissions). Record any failures and only rerun the affected checks after a justified correction.
- Check every requirement above against the implementation. Commit only this work and the two prior local fixes; preserve unrelated README/package/docs edits.
- Push `codex/user-experience-polish` to GitHub. Do not deploy or change `main`.

## Implementation review

| Requested change | Implementation |
| --- | --- |
| Readable removal dialog | Theme-aware surfaces/text, full wrapping filenames, separate warning and destructive action. |
| Quiet sidebar and clearer index status | Removed folder-monitor card and no-sign-in note; one readable header status remains. |
| Diagnostics out of the dashboard | Settings → Diagnostics contains Kindle files, manual transfer tools, reports and the optional probe. Disclosures stay open during updates. |
| Libraries wording | Renamed navigation and default collection/configuration copy; custom library names/descriptions are preserved. |
| Clickable summary numbers | Status buttons reset narrower filters and open the corresponding whole-library subset, with selected state and route updates. |
| Clearer Needs attention | Book-first repair cards; one next step, explicit duplicate preference, secondary actions and paths under details. |
| Technical footer removed | No everyday licensing/implementation footer; repository license, third-party notices and boko source remain untouched. |
| Scan continuity | Bounded display-only Kindle filter membership survives normal scan refreshes. Fresh evidence still controls badges and all device actions. |
| Raw Kindle file list removed | Available only in Settings Diagnostics, with independent search and existing pagination/comparison tools. |
| Simple batch feedback | Book X of Y, current title, one overall bar, verified-results list on completion, named partial failures and retry selection. |
| Earlier local fixes | Normal owned writes no longer flash recovery warnings; genuine leftovers still do. On Kindle Browse item requires a connected device. |
| Branch-only delivery | Work is isolated on `codex/user-experience-polish`; unrelated README/package/docs work is excluded. |

Visual review used the real production renderers and CSS with static sample data: dashboard, removal, active/completed/failed batches and library review, in dark/light themes and 390px/1440px layouts. This is not physical Kindle acceptance testing.

## Validation result

- Focused scan/summary, dialog, health, and AppView tests passed. Updated catalog-renderer tests passed; only changed copy assertions needed adjustment.
- Final `npm run check`: 101 test files, 1,017 tests passed; the existing 10,000-book setup benchmark alone failed (49.20 seconds against its 45-second budget). No functional test failed.
- One isolated rerun of that benchmark passed (35.85 seconds for the test command). No budget or test was weakened.
- Because the test gate stops before building on failure, `npm run build` was run separately and passed: client typecheck, server compilation and production bundle.
- Verified the built application at localhost, including Settings → Diagnostics and its Kindle-file search. No physical device transfer or server deployment was performed.
