# Hardcover series enrichment

## Scope

Add Hardcover to ShelfSend's reviewed metadata lookup, including series names and fractional volume numbers. Keep original mounted books immutable, conversion/USB browser-local, existing cover providers unchanged, and deployment configuration in the GUI. Work on `codex/user-experience-polish`; do not push main.

## Milestone 1 — Connection and persistence

- Add a compact Hardcover token section in Settings with save, test, remove, and useful connection errors.
- Store credentials in durable server-side Settings, retaining masked responses, revision checks, and read-only Settings mode.
- Add a data-preserving schema migration for the new metadata provider and durable lookup jobs.
- Keep Hardcover distinct from providers that download covers.

## Milestone 2 — Series lookup

- Query Hardcover from the Docker backend only, using its documented GraphQL endpoint.
- Match ISBN first; fall back to title/author search when no ISBN result is available.
- Normalize bounded suggestions with title/author evidence, series name, and numeric volume (including fractions and zero).
- Represent each series membership as an explicit alternative. Never silently choose the first series.
- Pace requests for Hardcover's quota, honor rate-limit cooldown, and report expired tokens, permissions, malformed responses, and timeouts.

## Milestone 3 — Review and bulk workflow

- Add Hardcover to individual metadata lookup and existing resumable bulk lookup jobs.
- Let users choose one series per book and apply selected rows together. Show batch results and retain failed rows for retry.
- Show the series and volume prominently on each candidate, then review selected fields before applying.
- Default to filling missing fields, preserving existing values and deliberate overrides. Keep series name/number coherent when changing the selected series.
- Reuse revision/source-hash checks and durable catalog overlays. No automatic candidate application or original-file edits.

## Milestone 4 — Verification and handoff

- Run focused adapter, persistence/API, and client tests for changed behavior.
- Check the compact Settings/review presentation and requirement coverage.
- Run `npm run check` once at final handoff; record its actual result, including any pre-existing failures.
- Push the completed work to the existing feature branch. A real Hardcover account/token check remains distinguishable from automated fixture validation.

## Validation record

Implemented all scoped milestones on `codex/user-experience-polish`.

- Focused adapter, credential/migration/API, series-ordering, metadata review, and bulk application tests passed. Coverage includes multiple series, fractional/zero volumes, token errors, rate limits, original-file immutability, explicit overrides, concurrent edits, and partial retry.
- Chrome visual checks covered compact Hardcover Settings, individual series review, and bulk choices in the actual rendered UI. The review's low-contrast surfaces and cramped controls were corrected.
- `npm run check` ran once: **1,062 passed, 2 failed (1,064 tests / 104 files)**. The legacy version-5 upgrade fixture omitted the real schema's `profiles` table; the fixture was corrected and that test passed on a targeted rerun. The other failure remains: 10,000-book setup took **48.7 seconds** against a **45-second** performance limit. Its limit was not weakened and the suite was not rerun to seek a lucky pass.
- `npm run build` passed separately after the test gate stopped the combined command (client typecheck, server compile, production client bundle). The existing large-bundle warning remains.
- A real Hardcover token/account request has **not** been tested. After deployment, save the token in **Settings → Series & book details (Hardcover)**, run Test, and review a known book before a larger lookup.

### Requirement coverage

| Requirement | Implemented and checked |
| --- | --- |
| Simple GUI token setup, server persistence | Collapsed Settings section; save/test/remove, masked status, restart and migration tests |
| ISBN first, title/author fallback | Backend GraphQL adapter and fixtures; no browser API requests |
| Fractions and multiple series | Numeric positions including 0 and 1.5; explicit series alternatives, no initial Hardcover selection |
| Individual and bulk review | Field selection, per-book series choices, batch application and retry results |
| Preserve existing metadata by default | Fill-missing behavior and explicit replacement; revision/source revalidation |
| Preserve originals and transfer behavior | Catalog overlays only; source-byte regression; no conversion/USB implementation changes |
| Feature branch delivery | Target `codex/user-experience-polish` only; main is not the push target |

The outstanding performance gate and live provider acceptance are recorded limitations, not claimed passes. Pending comparison-layout and transparent-backdrop changes from the preceding UI requests are included in this branch delivery; unrelated README/package/license edits are excluded.

API references: [schema](https://github.com/hardcoverapp/hardcover-docs/blob/main/schema.graphql), [Getting Started](https://github.com/hardcoverapp/hardcover-docs/blob/main/src/content/docs/api/Getting-Started.mdx).
