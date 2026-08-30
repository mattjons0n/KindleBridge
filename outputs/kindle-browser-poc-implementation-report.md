# Kindle Browser POC — Implementation Report

Date: 2026-08-29

## Outcome

The POC now implements the intended no-Calibre path. EPUB conversion runs in a dedicated browser worker using vendored boko WebAssembly. There is no conversion API or application backend, and a pre-existing AZW3 fixture is not a gate.

The corrected development build is running at <http://127.0.0.1:5173>.

The complete flow has now been confirmed on a physical MTP Kindle with USB IDs `0x1949 / 0x9981`, including conversion, connection, exact-byte self-test, transfer, book opening, chapter navigation, and library-cover display.

## Implemented milestones

| Gate | Implemented evidence | Physical acceptance remaining |
|---|---|---|
| 0 — Convert | Browser file selection, 200 MB bound, worker isolation, boko WASM EPUB parsing/conversion, metadata display, `BOOKMOBI` validation, exact in-memory artifact identity | Confirmed |
| 1 — WebUSB | User device chooser, Amazon vendor filter, descriptor-derived MTP alternate/endpoints, bounded open/claim/release | Confirmed |
| 2 — MTP read | Device info, session open, storage enumeration, writable-space selection, Documents association discovery | Confirmed |
| 3 — Byte test | Journaled object creation, exact readback comparison, current-handle-only deletion, cleanup verification | Confirmed |
| 4 — Send | Collision-resistant non-overwriting filename, Blob streaming, progress, returned metadata checks, clean close | Confirmed |
| 5 — Open | Explicit physical confirmation; never inferred from MTP success | Confirmed |
| Cover | Embedded-cover metadata verification and offset-preserving `EBOK` to `PDOC` preparation for modern MTP Kindles | Confirmed |

## Removed architecture

- Express/Multer conversion server
- `/api/health` and `/api/convert`
- Calibre `ebook-convert` discovery and child processes
- server temp-file and upload lifecycle
- mandatory known-good AZW3 fixture
- native Calibre/Amazon transfer validation gate
- conversion-service retry UI

The only local server is Vite, used to provide a localhost origin for browser assets and WebUSB.

## Converter provenance

- boko 0.5.0, GPL-3.0-or-later
- pinned source revision `b148716498fdac70134555293a7405913988256a`
- source included under `third_party/boko`
- artifact checksums recorded in `THIRD_PARTY_NOTICES.md`

## Verification record

`npm run check` passes:

- 17 test files
- 119 tests
- TypeScript validation
- Vite production build
- real public-domain EPUB → AZW3 conversion through the vendored WASM
- output `BOOKMOBI` signature and metadata assertions

Live in-app-browser verification converted `epictetus.epub` (448.4 KiB) to `epictetus.azw3` (502.8 KiB), displayed title `Short Works` and author `Epictetus`, marked Gate 0 passed, and enabled the WebUSB gate. The user must initiate the WebUSB chooser and physical Kindle steps.

Subsequent physical-device validation completed the remaining gates on Kindle USB IDs `0x1949 / 0x9981`. The first transferred `EBOK` artifact opened correctly but showed a grey library tile. The converter pipeline was then updated to verify embedded cover records and prepare sideloads as `PDOC`; a repeat transfer displayed the cover successfully and the user confirmed that it worked flawlessly.
