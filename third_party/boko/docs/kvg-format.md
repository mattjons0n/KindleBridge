# KVG: Kindle Vector Graphics (reverse-engineered)

KVG is the vector-shape format KFX uses for on-device math rendering (and
other vector content). It is the **only** visual math path on Kindle: the
`mathml` ($690) and `alt_text` ($584) annotations are overlays on the KVG
render (accessibility / pan-zoom / possibly live re-render on new firmware),
never standalone render sources — a device test confirmed annotations without
KVG leak as visible garbage on pre-5.18.2 firmware.

Decoded 2026-07-20 from Kindle Previewer gold masters (Essential Math for AI:
2,497 equations / 5 path bundles) cross-checked against kfxlib's KVG→SVG
converter (`yj_to_epub_misc.py`, `yj_to_epub_content.py`). Verified by
re-rendering gold-master equations to SVG with these rules and comparing
visually (`tools/kvg2svg.py`): typeset output matches KP exactly.

## Structure overview

```
container ($270)  'yj.classification': math ($688), render: inline ($283 — inline math only)
│                 annotations ($683): [alt_text ($584), mathml ($690)] → content refs
│                 pan_zoom_viewer ($684): enabled, layout: vertical
└── container ($270)  'yj.classification': mathsegment ($689), layout: vertical
    └── KVG element:
        { id, type ($159): kvg ($272),
          kvg_content_type ($686): text ($269),      // always $269 for math
          fixed_width ($66): px-int,                 // viewBox width
          fixed_height ($67): px-int,                // viewBox height
          width  ($56): {value, unit: em},           // layout (CSS) size
          height ($57): {value, unit: em},
          max_width: {value: 100, unit: percent},
          style: <style sym>,
          shape_list ($250): [shape, ...],
          content_list ($146): [...] }               // only for nested $270 text shapes
```

Maps to SVG as:
`<svg viewBox="0 0 {fixed_width} {fixed_height}" preserveAspectRatio="xMidYMid meet">`
with the em `width`/`height` as the CSS box. Kindle scales the viewBox into
the em box, so coordinates are resolution-independent; the em sizes tie the
equation to the surrounding font size.

## Shapes ($250 entries)

```
{ path ($249): <path-ref>,
  transform ($98): [a, b, c, d, e, f],   // see swap note below
  stroke_width ($76): 0.,
  type ($159): shape ($273) }
```

Shape types ($159): `$273` path (the only one KP math uses), `$837` line,
`$836` rectangle, `$835` ellipse, `$838` polygon, `$839` polyline,
`$270` container (nested text rendered as `svg:text`).

Fill/stroke: `$70` fill, `$75`/`$498` stroke, `$76` stroke-width, plus dash
properties ($531/$532/$77/$529/$530). KP math shapes set `stroke_width: 0`
and no fill → renderer default = solid black fill (SVG semantics).

### Transform

Six-value affine, but **KFX stores b and c swapped relative to SVG
`matrix(a b c d e f)` order** (kfxlib swaps `vals[1], vals[2]` with
`transform_matrix_swap=True` for shapes). For the axis-aligned matrices math
uses (b = c = 0) the swap is invisible.

Glyph outlines are y-up (font convention); the viewBox is y-down. Every glyph
shape therefore carries a y-flip transform:

```
[s, 0, 0, -s, tx, ty]     // scale s (1.0 body, ~0.707 script), pen at (tx, ty)
```

`ty` is the baseline's y in viewBox coordinates.

## Path bundles ($692) — shared glyph outlines

```
{ name: p2, path_list ($693): [ [outline...], [outline...], ... ] }
```

A shape's `path` ($249) is either an inline coordinate array or a reference
`{name: <bundle>, index ($403): <n>}` → `path_bundle[name].path_list[n]`.
This is glyph-level dedup: one outline per distinct glyph, referenced by
every occurrence with a per-use transform (Essential Math: 2,497 equations
share 5 bundles ≈ 150 KB).

### Outline encoding

A flat number array of opcode-prefixed instructions:

| opcode | op | args |
|---|---|---|
| 0 | M moveto | x y |
| 1 | L lineto | x y |
| 2 | Q quadratic Bézier | cx cy x y |
| 3 | C cubic Bézier | c1x c1y c2x c2y x y |
| 4 | Z closepath | — |

Multiple contours per glyph = multiple M…Z runs in one array. Coordinates are
float px in the y-up glyph space (TrueType quadratics land as opcode 2, CFF
cubics as opcode 3).

## Observed unit conventions (KP)

- ≈ **979 viewBox units per em** (`fixed_height / height_em` ≈
  `fixed_width / width_em` ≈ 979 across equations). Any internally
  consistent scale works — the viewBox normalizes it — but matching KP's
  constant keeps outputs comparable.
- The box is glyph-tight per equation; baseline `ty` ≈ 521.8 for a
  732-high box in one sample (≈ 0.53 em ascent above baseline).
- KP typesets with its own bundled Computer-Modern-style math font,
  regardless of the book's embedded fonts.
- `adjust_pixel_value` is identity for EPUB-sourced books (PDF-backed books
  divide px by 100).

## Emission checklist for boko's KVG spoke

1. Typeset the Math AST into positioned glyphs (font with OpenType MATH
   table, e.g. STIX Two Math / Latin Modern Math, both OFL).
2. Extract glyph outlines → opcode arrays (y-up, unscaled); dedup into
   path bundles per book.
3. Per glyph occurrence: shape with `[s, 0, 0, -s, pen_x, baseline_y]`.
4. Container: tight bbox → fixed_width/height; em sizes = bbox / units-per-em
   at the equation's font size; `kvg_content_type: text`.
5. Wrap in mathsegment + math containers; attach `mathml` + `alt_text`
   annotations (they are legitimate only with the KVG present) +
   `pan_zoom_viewer: enabled`.
6. Verify with `tools/kvg2svg.py` (render → rasterize → compare) and
   kfxcheck's full mode (the "Missing svg for mathml annotation" error class
   must stay extinct).

## Verification tooling

`tools/kvg2svg.py <book.kfx> <outdir> [limit]` — extracts KVG containers and
path bundles via kfxlib and emits standalone SVGs using exactly the rules
above. Rasterize with `vips copy eq000.svg eq000.png` /
`vips flatten … --background 255` and eyeball, or diff against Kindle
Previewer renders.
