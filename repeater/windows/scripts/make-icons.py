"""Render the mothman sigil into the Windows repeater's icon files.

The sigil's source of truth is assets/images/mothman-logo.svg (the app's own logo). This reads its
lines, circles and Bezier strokes directly and rasterises them with Pillow at 8x, so the .ico has
hand-tuned small sizes instead of a 1024 px image squeezed into 16 px:

* 48 px and up: the glyph at 70% of a full-bleed rounded tile, the strokes at their own weight.
* 32 px and down (tray, title bar, small icons): the glyph cropped to 88% of the tile and its
  strokes thickened, because a 27-unit stroke on a 1024 grid is under half a pixel at 16 px.

Run from the repository root:  python apps/repeater/scripts/make-icons.py
Outputs (committed): apps/repeater/windows/Assets/repeater.ico and repeater-256.png.
"""

import math
import pathlib
import re
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parents[3]
SOURCE = ROOT / "assets/images/mothman-logo.svg"
OUT = ROOT / "apps/repeater/windows/Assets"
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
SUPERSAMPLE = 8
TILE = "#eef2f5"
EDGE = "#c9d3db"
NS = "{http://www.w3.org/2000/svg}"


def parse():
    """(strokes, dots): strokes are (points, width, colour); dots are (x, y, r, colour)."""
    tree = ET.parse(SOURCE)
    strokes, dots = [], []
    for el in tree.iter():
        tag = el.tag.replace(NS, "")
        if tag == "line" and el.get("stroke") != "none":
            pts = [(float(el.get("x1")), float(el.get("y1"))), (float(el.get("x2")), float(el.get("y2")))]
            strokes.append((pts, float(el.get("stroke-width")), el.get("stroke")))
        elif tag == "circle" and el.get("fill") not in (None, "none"):
            dots.append((float(el.get("cx")), float(el.get("cy")), float(el.get("r")), el.get("fill")))
        elif tag == "path":
            strokes.append((flatten(el.get("d")), float(el.get("stroke-width")), el.get("stroke")))
    return strokes, dots


def flatten(d):
    tokens = re.findall(r"[MQC]|-?\d+(?:\.\d+)?", d)
    pts, i, cmd = [], 0, None
    cur = (0.0, 0.0)
    while i < len(tokens):
        if tokens[i] in "MQC":
            cmd = tokens[i]
            i += 1
        nums = lambda n: [float(t) for t in tokens[i:i + n]]
        if cmd == "M":
            cur = tuple(nums(2)); pts.append(cur); i += 2
        elif cmd == "Q":
            cx, cy, x, y = nums(4); i += 4
            for t in [k / 24 for k in range(1, 25)]:
                pts.append(((1 - t) ** 2 * cur[0] + 2 * (1 - t) * t * cx + t * t * x,
                            (1 - t) ** 2 * cur[1] + 2 * (1 - t) * t * cy + t * t * y))
            cur = (x, y)
        elif cmd == "C":
            c1x, c1y, c2x, c2y, x, y = nums(6); i += 6
            for t in [k / 24 for k in range(1, 25)]:
                a, b, c, e = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
                pts.append((a * cur[0] + b * c1x + c * c2x + e * x, a * cur[1] + b * c1y + c * c2y + e * y))
            cur = (x, y)
    return pts


def render(size, strokes, dots):
    small = size <= 32
    fill = 0.88 if small else 0.70
    weight = (2.1 if size <= 20 else 1.6) if small else (1.3 if size <= 48 else 1.0)
    big = size * SUPERSAMPLE
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    radius = big * 0.22
    edge = max(SUPERSAMPLE, round(big / 128))
    draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=radius, fill=TILE, outline=EDGE, width=edge)

    xs = [x for pts, _, _ in strokes for x, _ in pts] + [x for x, _, r, _ in dots]
    ys = [y for pts, _, _ in strokes for _, y in pts] + [y for _, y, r, _ in dots]
    pad = 27 / 2
    x0, x1, y0, y1 = min(xs) - pad, max(xs) + pad, min(ys) - pad, max(ys) + pad
    scale = big * fill / max(x1 - x0, y1 - y0)
    ox = (big - (x1 - x0) * scale) / 2 - x0 * scale
    oy = (big - (y1 - y0) * scale) / 2 - y0 * scale
    at = lambda p: (p[0] * scale + ox, p[1] * scale + oy)

    for pts, width, colour in strokes:
        w = width * scale * weight
        mapped = [at(p) for p in pts]
        draw.line(mapped, fill=colour, width=max(1, round(w)), joint="curve")
        for x, y in (mapped[0], mapped[-1]):
            draw.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=colour)
    for x, y, r, colour in dots:
        cx, cy = at((x, y))
        rr = r * scale * (weight if small else 1.0)
        draw.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=colour)
    return image.resize((size, size), Image.LANCZOS)


def main():
    strokes, dots = parse()
    images = {size: render(size, strokes, dots) for size in SIZES}
    OUT.mkdir(parents=True, exist_ok=True)
    largest = images[SIZES[-1]]
    largest.save(OUT / "repeater.ico", sizes=[(s, s) for s in SIZES],
                 append_images=[images[s] for s in SIZES[:-1]])
    largest.save(OUT / "repeater-256.png")
    print("wrote", OUT / "repeater.ico")


if __name__ == "__main__":
    main()
