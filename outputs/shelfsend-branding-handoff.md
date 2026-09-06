# ShelfSend branding handoff

## Scope completed

- ShelfSend name in the corner wordmark, browser title, onboarding, Settings/help/recovery text, user-facing match/update messages, and current README/handoff documentation.
- Local books-and-send-arrow brand mark, matching SVG browser icon, and “Browser to reader” corner subtitle. README uses “From your browser to your e-reader” and states current Kindle support.
- Kindle-specific Connect/Send/remove wording retained. No claim that other readers already work.
- Existing package name, repository URL, website address, Docker image/service/volume names, environment variables, browser keys, device locks, recovery journals, managed identities, and Kindle cache filenames retained. No data migration or external repository/domain rename.
- Historical output reports and backlog remain unchanged. No feature work or transfer policy changes included.

## Validation

- Both dedicated branding/compatibility tests pass after correcting their browser-environment setup and Node file-URL handling.
- Production type checks and server/client build passed.
- Chrome visual check of the built app verified the ShelfSend corner name/mark/subtitle and browser title against the isolated test catalog.
- One final `npm run check` ran with `VITEST_MAX_WORKERS=1`: 961 passed, 5 failed across 97 files / 966 tests. It had loaded the earlier branding fixtures before their fixes (two failures); the other three failures were existing five-second timeouts in two controller tests and the provider/pasted-image test. The corrected branding file passed 2/2, the controller cases passed 2/2 (70 skipped), and the pasted-image case passed 1/1 (9 skipped). No timeout or performance threshold was loosened and the complete suite was not repeated. This is not a claim of a clean full-suite or Docker run.

## Deployment

Push the branding commit to the existing GitHub main. Bob/server operator still owns the Docker build gate and RRserver promotion. This change does not itself rename or redeploy the running container, repository, or public address.
