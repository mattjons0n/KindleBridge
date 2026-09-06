# Recorded Kindle reading data — implementation handoff

## Delivered scope

- Existing cover/title click opens the same book-details drawer, now with **Kindle reading data**.
- Normal successful connection and post-mutation inventory collect bounded direct reading sidecars across supported book formats. Unsupported/malformed sidecars produce per-file errors where a candidate is readable; absent, ambiguous and over-limit data is not treated as Unread.
- One confirmed device copy is required before its observations are shown under a catalog book. Ambiguous associations are explained instead of combining multiple books' data.
- Summaries include reading time, counted words, saved last/furthest positions, available timestamps, timer activity fraction, word-count coverage, reader preferences, page mapping, and annotation presence. Typed decoded fields are expandable with an explicit 16 KiB per-file preview ceiling.
- This is recorded activity, **not current completion percentage or Read/Unread status**. No progress bar, status filter, completion label or Read-books membership is derived from it. The existing semantic rollout gates remain off.
- Browser-session-only data follows inventory lifecycle; last-seen inventory is labelled. No durable/server-side reading history or raw-byte upload is added.
- Original files, Kindle contents, transfer self-test, conversion, matching/deletion authority and platform-agnostic Docker packaging remain unchanged. The sidecar observation collector uses only reads, with before/after ObjectInfo checks.
- Local raw diagnostic and offline report inspector are included for development; no personal capture is committed.
- No backlog entries were added.

## Validation

- Four targeted recorded-data tests passed, covering real inventory propagation, no semantic evidence/writes, malformed data, cumulative fractions above one, escaping, ambiguity, missing data and last-seen display.
- Earlier parser regression tests passed; all 32 physically captured reading files decode. User comparison established why timer activity is not completion.
- Final `npm run check`: 962 passed / 2 failed across 96 files (964 tests). Failures were the selected-profile controller UI assertion and the existing 10,000-row ingest timing ceiling (54.39 s versus 45 s).
- Exactly those two failed tests were run once with one worker: both passed; 71 unrelated tests skipped. This does not erase the full-suite failure or claim a green complete Docker gate.
- Production type checks/server build/client build passed separately.
- Chrome verification of the built app with an isolated catalog confirmed cover click opens the existing drawer and displays the new section/disconnected state. Populated observations have automated pipeline/render coverage; a fresh physical integrated connection remains to be checked on the deployed app.

## Deployment

GitHub main is the delivery target. No RRserver deployment connection or command is configured in this workspace; server promotion remains an operator/Bob step. Run the deployment's normal Node 24/Docker gate before promoting. Do not assume a Git push has changed the live container.
