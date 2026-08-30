#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "lxml", "pypdf", "beautifulsoup4"]
# ///
"""Proof-of-decode: extract KVG math containers from a KP gold-master KFX and
render them to standalone SVG using the reverse-engineered format rules.

Rules (from kfxlib yj_to_epub_misc.py/yj_to_epub_content.py):
  container $272: viewBox = 0 0 $66 $67; shapes in $250
  shape $159==$273: path from $249 (inline list or {name, $403} -> $692[name].$693[idx])
  path opcodes: 0=M(2) 1=L(2) 2=Q(4) 3=C(6) 4=Z(0)
  $98 transform: [a,b,c,d,e,f] with b/c SWAPPED vs SVG matrix order
  $76 stroke-width, $70 fill, $75/$498 stroke
"""
import os
import sys

for cand in ["~/code/kfx/kfx_input", "~/code/kfx/kfx_output"]:
    p = os.path.expanduser(cand)
    if os.path.isdir(p):
        sys.path.insert(0, p)
        break

from kfxlib import yj_book  # noqa: E402

OPCODES = {0: ("M", 2), 1: ("L", 2), 2: ("Q", 4), 3: ("C", 6), 4: ("Z", 0)}


def path_to_d(path):
    p = list(path)
    d = []
    while p:
        inst = p.pop(0)
        name, nargs = OPCODES[int(inst)]
        d.append(name)
        for _ in range(nargs):
            d.append(f"{p.pop(0):g}")
    return " ".join(d)


def transform_to_svg(vals):
    vals = list(vals)
    vals[1], vals[2] = vals[2], vals[1]  # KFX stores b/c swapped
    return "matrix(%s)" % " ".join(f"{v:g}" for v in vals)


def main(kfx_path, out_dir, limit=6):
    book = yj_book.YJ_Book(kfx_path)
    book.decode_book()

    bundles = {}   # name -> path_list
    kvgs = []      # raw kvg structs, discovered by walking storylines

    def walk(data):
        t = type(data).__name__
        if hasattr(data, "value") and t == "IonAnnotation":
            walk(data.value)
        elif isinstance(data, (list, tuple)):
            for v in data:
                walk(v)
        elif hasattr(data, "items"):
            if data.get("$159") == "$272" or data.get("$608") == "$272":
                kvgs.append(data)
            for v in data.values():
                walk(v)

    for frag in book.fragments:
        if frag.ftype == "$692":
            bundles[str(frag.value.get("name"))] = frag.value["$693"]
        elif frag.ftype == "$259":
            walk(frag.value)

    print(f"path_bundles: {len(bundles)}  kvg containers: {len(kvgs)}")

    os.makedirs(out_dir, exist_ok=True)
    for i, kvg in enumerate(kvgs[:limit]):
        w = kvg.get("$66")
        h = kvg.get("$67")
        parts = [
            f'<svg xmlns="http://www.w3.org/2000/svg" version="1.1" '
            f'viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
            f'preserveAspectRatio="xMidYMid meet">'
        ]
        for shape in kvg.get("$250", []):
            if shape.get("$159") != "$273":
                parts.append(f"<!-- unhandled shape type {shape.get('$159')} -->")
                continue
            pathref = shape["$249"]
            if hasattr(pathref, "items"):
                path = bundles[str(pathref["name"])][pathref["$403"]]
            else:
                path = pathref
            d = path_to_d(path)
            attrs = [f'd="{d}"']
            if "$98" in shape:
                attrs.append(f'transform="{transform_to_svg(shape["$98"])}"')
            if "$76" in shape:
                attrs.append(f'stroke-width="{shape["$76"]:g}"')
            if "$70" in shape:
                attrs.append(f'fill="{shape["$70"]}"')
            parts.append(f"<path {' '.join(attrs)}/>")
        parts.append("</svg>")
        out = os.path.join(out_dir, f"eq{i:03d}.svg")
        with open(out, "w") as f:
            f.write("\n".join(parts))
        print(f"wrote {out}  (viewBox 0 0 {w} {h}, {len(kvg.get('$250', []))} shapes)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 6)
