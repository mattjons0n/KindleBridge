# Approved modern GUI — implementation and acceptance

## Scope and build units

Integrate the approved Kindle Bridge Next mockup into the real application, validate, and publish to main. No simulated catalog or transfer behavior ships.

1. Warm canvas, soft sidebar, editorial headings, local line icons, cover spacing and responsive comfortable/compact grid.
2. Sidebar brand; Settings below shelves; truthful activity, source health, queue and device controls.
3. Compact filter disclosure, search/sort and synchronized All books / On Kindle / Not on Kindle quick filters.
4. Direct card actions, three-dot menus, list selection and bulk actions; existing dialogs and confirmations retained.
5. Consistent settings/onboarding/details/queue/metadata/activity surfaces, system light/dark colors and reduced motion.
6. Targeted regression tests, final check, browser verification, scoped omission audit, commit and push.

## Requirement-by-requirement omission audit

| Requirement | Implementation |
| --- | --- |
| Real app, approved design | Production renderer and stylesheet; no mock data or timer-based transfer simulation |
| Direct card action | Existing Send eligibility; Send later while disconnected; confirmed states and three-dot actions retained |
| Profiles and shelves | Profile scoping and all built-in/custom shelves, including Read books, retained |
| Settings lower down | Separate sidebar-bottom control after shelves |
| Search/filter/sort/pagination | Existing IDs and API behavior retained; quick tabs share the Kindle filter |
| List and bulk actions | Existing capabilities, queue, Send and removal controls retained |
| Recovery messages | Directly below topbar before library content; cleanup-action regression retained |
| Settings and dialogs | Existing data flows and confirmations with shared palette |
| Accessibility/responsiveness | Semantic buttons/disclosure, decorative local SVGs, focus outlines, narrow layouts, reduced motion |
| Source/conversion/USB | No backend, converter, matching or device-authority changes |
| Reading gates | Unchanged; automatic detection remains off pending physical evidence |

## Validation

- Targeted existing catalog UI suite: 66 tests passed.
- New compact-filter/shell/action regression: passed after correcting quick-tab/select synchronization during partial result updates.
- One full `npm run check`: 955 passed, one failed because the recovery-order test expected the old outer wrapper. Its selector was updated to the new workspace; the targeted recovery test then passed, including the cleanup callback assertion. No unchanged full-suite retry.
- Client/server TypeScript and production build passed. Final CSS refinements were followed by a client production rebuild.
- Browser acceptance uses an isolated temporary SQLite catalog and the repository EPUB fixture: onboarding/configuration/indexing, real cover, filters, list selection, book details and metadata editor. Desktop 1440px and narrow 390px checked; narrow page has no horizontal overflow. Dark mode reviewed visually; light mode uses the corresponding shared palette.
- No physical Kindle transfer, real household mount acceptance or server deployment was performed. Reading gates remain unchanged.
