# Third-party notices

## boko

- Project: <https://github.com/zacharydenton/boko>
- Version: 0.5.0
- Upstream source base: `b148716498fdac70134555293a7405913988256a`
- Downstream archive changes: Kindle Bridge adds a fail-closed EPUB central-directory
  preflight before boko's ZIP parser retains entries. The included source caps
  archives at 20,000 entries, 256 MiB aggregate inflated bytes, 2,048 bytes per
  entry name, 8 MiB of aggregate entry-name bytes, a 24 MiB central directory,
  128 MiB per inflated entry, and a 1,000:1 declared compression ratio. Inflated
  data must exactly match its bounded central-directory declaration.
- Downstream browser-conversion changes add a fail-closed content/allocation envelope. EPUB
  package, navigation, NCX, encryption, stylesheet, and spine documents are
  capped at 8 MiB each before inflation/decoding; the spine is capped at 4,096
  item references and 128 MiB of aggregate declared XHTML. Each parsed document
  is capped at 100,000 retained DOM nodes, 100,000 attributes, 4 MiB of
  attribute data, 8 MiB of retained DOM/IR text, 100,000 IR nodes and semantic
  attributes, 25,000 computed styles, and a 256-level DOM-to-IR transform
  depth. Node, text, semantic-map, and style limits are reserved before their
  N+1 append/intern operation. MathML is preflighted before recursive
  conversion at 4,096 source elements, 128 levels, 20,000 retained canonical
  expression nodes, and 8 MiB of owned strings per document. The all-spine IR
  cache is capped at
  1,000,000 nodes, 1,000,000 semantic attributes, 64 MiB of retained text, and
  100,000 styles, plus 200,000 canonical math nodes and 32 MiB of math-owned
  strings. Normalized XHTML streams into a capped buffer limited to 32 MiB per
  document and 128 MiB aggregate; link rewriting preflights its final size and
  mutates that buffer in place. The generated normalized stylesheet is capped
  at 32 MiB by checking each complete rule before retaining it. Browser AZW3
  export uses a seekable capped writer that rejects an
  extending write before its output `Vec` can grow beyond 200 MiB (209,715,200
  bytes). Import preflight, DOM/IR/MathML, and normalized-content violations use
  boko's downstream `ResourceLimit` error class (`resource limit exceeded:
  ...`). Streaming OPF N+1 and capped-writer failures are surfaced as bounded
  invalid-data/I/O errors. No original source bytes are modified.
- License: GPL-3.0-or-later
- Included source: `third_party/boko/`
- Browser JavaScript SHA-256: `738797303669e53c45c050537640d5535d8c54072b8770a78064e5b080c0d3cc`
- WebAssembly SHA-256: `5cc7e4fcd9116218ad7dcaae54e0dbfdead726069c4e6f40176e63a55605c338`
- Build toolchain: Rust 1.91.1 (`ed61e7d7e`, 2025-11-07), wasm-pack 0.13.1,
  and the Cargo-locked wasm-bindgen 0.2.108 dependencies.
- Build command (from `third_party/boko/`):
  `wasm-pack build --target web --out-dir web/pkg --no-default-features --features wasm`

The checked-in browser artifacts are generated from the included downstream
source and used through a project-authored Web Worker adapter. The upstream
base, downstream behavior, exact toolchain, build command, checksums, and
license are recorded so the artifact remains auditable and reproducible. boko
is provided without warranty under the terms of the GNU General Public License
version 3 or later.

## Calibre KFX format reference

- Project: <https://github.com/kovidgoyal/calibre>
- Source revision: `2601151d9233e8312b4e307222a9b3b05e2729bd`
- Reference files: `src/calibre/ebooks/metadata/kfx.py` and
  `src/calibre/devices/mtp/driver.py`
- Copyright: Kovid Goyal and John Howell, with KFX reverse-engineering credit
  recorded in the upstream source
- License: GPL-3.0

Kindle Bridge's separately written, bounded TypeScript reader uses Calibre's
published descriptions of the CONT/ENTY/PackedIon framing, matching-relevant
property numbers, and exact `<book stem>.sdr/assets/metadata.kfx` convention.
It does not include or depend on Calibre at runtime, does not parse general KFX
book content, and is distributed under Kindle Bridge's GPL-3.0 license.

## KRDS reading-sidecar format reference

- Project: <https://github.com/K-R-D-S/KRDS>
- Source revision: `9c8a0b0ec9cb6af72fba900a6f9b09f92de477de`
- Reference file: `krds.py`
- Copyright: 2019 John Howell; the referenced revision also records later
  contributor additions
- License: GPL-3.0
- Supplemental observed-format documentation:
  <https://github.com/zevisvei/kindle-reading-dashboard/blob/main/docs/KRDS-format.md>

Kindle Bridge's separately written bounded TypeScript reader uses the published
KRDS signature, primitive/object framing, `timer.model`, and `lpr` structure
descriptions. It retains only a validated percentage and last-read timestamp,
never annotation text, positions, history, or arbitrary decoded objects. It has
no KRDS runtime dependency and is distributed under Kindle Bridge's GPL-3.0
license.
