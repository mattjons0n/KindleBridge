# Kindle Browser POC — No-Calibre Build Plan

## Objective

Prove on one recorded Mac/Chromium/Kindle combination that a DRM-free EPUB can be converted locally in the browser and transferred directly to Kindle storage through WebUSB/MTP, with no Calibre installation, cloud upload, or conversion backend.

```text
DRM-free EPUB
  → browser Web Worker
  → boko WebAssembly
  → structurally validated AZW3 Blob
  → WebUSB
  → MTP Documents association
  → Kindle indexing and physical open
```

The local server serves only static browser assets on localhost. It never receives the book.

## Milestone 0 — Browser-local conversion

- Accept one `.epub` up to 200 MB.
- Read its bytes in the browser and transfer them to a dedicated worker.
- Initialize a pinned, vendored boko WASM build.
- Inspect title/author metadata and convert EPUB → AZW3.
- Reject conversion errors and outputs without the `BOOKMOBI` container signature.
- Keep the validated Blob in memory; allow an optional backup download.

Acceptance: a real public-domain EPUB converts in the built app and the output passes structural validation. No network request contains book bytes.

## Milestone 1 — WebUSB discovery

- Require localhost/secure context and a WebUSB-capable Chromium browser.
- Request a user-selected Amazon USB device.
- Derive the MTP configuration, interface, alternate setting, and bulk endpoints from descriptors.
- Never infer that USB access proves MTP writes or Kindle ingestion.

Acceptance: the selected Kindle opens and the expected MTP interface is claimed.

## Milestone 2 — Read-only MTP inspection

- Read device information before opening the session.
- Open an MTP session with monotonic transaction IDs.
- Enumerate storage and locate the writable Documents association.
- Report capacity and free space without modifying the device.

Acceptance: the target Kindle returns a usable storage ID and Documents handle.

## Milestone 3 — Exact-byte write proof

- Generate a small collision-resistant test filename.
- Journal bounded recovery metadata before object creation.
- Send metadata and bytes, read the object back, and compare every byte.
- Delete only the exact handle created by this operation.
- Block later writes if cleanup cannot be proven.

Acceptance: create/read/compare/delete succeeds and the test object is absent afterward.

## Milestone 4 — Send the converted artifact

- Use the exact in-memory Blob produced in milestone 0.
- Sanitize and collision-proof its Kindle filename.
- Never overwrite an existing object.
- Stream progress, verify returned size/storage/parent metadata, close MTP, release USB, and close the device.

Acceptance: MTP metadata matches the generated filename and byte length, and USB closes cleanly.

## Milestone 5 — Physical Kindle acceptance

- Eject or unplug the Kindle and wait for indexing.
- Find the exact generated filename.
- Open the book, navigate chapters, and inspect readable text.
- Record manual confirmation; do not infer it from successful MTP metadata.

Acceptance: the physical Kindle indexes and opens the exact converted artifact.

## Cross-cutting requirements

- DRM-free EPUB only for the POC.
- No Calibre, Kindle Previewer, Express server, database, or cloud conversion.
- No general delete, rename, move, or overwrite features.
- No raw serial persistence or logging.
- Bounded timeouts, sizes, diagnostics, and recovery records.
- A real WASM conversion integration test plus USB/MTP/Kindle/state/controller/view tests.
- Pin and include converter source, license, revision, and artifact checksums.

## Verification command

```sh
npm run check
```
