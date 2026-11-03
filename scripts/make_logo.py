"""
make_logo.py — draws the HOLOFIX "H" mark in the scan-line hologram style (glowing parallel line
segments; shading = where the lines break, like an LED/CRT display). Writes SVG files.

    python -m scripts.make_logo                      # writes frontend/logo.svg + favicon.svg
    python -m scripts.make_logo --options /tmp/logos  # also every option, to compare

How it works, in 3 steps:
  1. Rasterise a SHADE image (0 = empty, 1 = brightest): a flat H, or a 3D extruded H whose faces get
     different brightness from a light direction.
  2. Cut that image into stripes (vertical or horizontal). Along each stripe, keep a sample when its
     shade beats a noise threshold. The noise is chunky (constant over a few samples), so dark areas
     become dashes, not dust.
  3. Merge kept samples into rounded line segments and wrap them in an SVG with a glow filter.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

N = 512                       # working resolution of the shade image
CYAN, CORE = "#6fe7f0", "#d8fdff"
BG = "#070a0e"

# Two looks, matching the site's two themes. "rest" = colour of the lines most of the time,
# "band" = colour of the short glitchy band that sweeps down.
THEMES = {
    "dark":  {"bg": "#070a0e", "border": None, "rest": "#d8fdff", "band": "#6fe7f0", "dots": "#6fe7f0", "glow": 7},
    "light": {"bg": "#f6f2e9", "border": "#d9d1c0", "rest": "#0f6c74", "band": "#1f1d1a", "dots": "#0f6c74", "glow": 0},
}

# The H as a polygon, in a 0..1 box (x right, y down): two posts and a crossbar.
H = [(0.18, 0.14), (0.38, 0.14), (0.38, 0.41), (0.62, 0.41), (0.62, 0.14), (0.82, 0.14),
     (0.82, 0.86), (0.62, 0.86), (0.62, 0.59), (0.38, 0.59), (0.38, 0.86), (0.18, 0.86)]


def texture(shade, strength=0.6, seed=2, blur=14) -> np.ndarray:
    """Multiply by smooth random blotches: bright areas get a few organic breaks, like the reference art."""
    from PIL import ImageFilter
    rng = np.random.default_rng(seed)
    noise = Image.fromarray((rng.uniform(0, 255, (N // 32, N // 32))).astype("uint8")).resize((N, N), Image.BICUBIC)
    noise = np.asarray(noise.filter(ImageFilter.GaussianBlur(blur)), dtype=float) / 255
    noise = (noise - noise.min()) / (noise.max() - noise.min() + 1e-9)
    holes = np.clip((noise - 0.62) / 0.38, 0, 1)        # only the top of the blotches cut holes
    return shade * (1 - strength * holes)


def flat_shade(gradient=0.25) -> np.ndarray:
    img = Image.new("L", (N, N), 0)
    ImageDraw.Draw(img).polygon([(x * N, y * N) for x, y in H], fill=255)
    a = np.asarray(img, dtype=float) / 255
    yy = np.linspace(0, 1, N)[:, None]
    return a * (1 - gradient * yy)            # a little darker towards the bottom


def layered_shade(dx=0.035, dy=0.035, gradient=0.1) -> np.ndarray:
    """"2.5D": the flat H in front, a dimmer copy shifted down-right behind it (reads as thickness,
    stays clean at small sizes, unlike a full perspective extrusion)."""
    front = flat_shade(gradient)
    back = np.roll(np.roll(front, int(dy * N), axis=0), int(dx * N), axis=1)
    return np.where(front > 0.05, front, back * 0.6)


def solid_shade(yaw=32, pitch=-16, depth=0.3) -> np.ndarray:
    """Extruded H seen in perspective. Each face gets a brightness from a fixed light direction."""
    cy, sy = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
    cp, sp = math.cos(math.radians(pitch)), math.sin(math.radians(pitch))

    def project(x, y, z):
        x, y = x - 0.5, y - 0.5
        x, z = x * cy + z * sy, -x * sy + z * cy           # turn around the vertical axis
        y, z = y * cp - z * sp, y * sp + z * cp            # tilt
        f = 2.6 / (2.6 + z)                                # perspective
        return (0.5 + x * f * 0.92) * N, (0.5 + y * f * 0.92) * N, z

    front = [project(x, y, 0) for x, y in H]
    back = [project(x, y, depth) for x, y in H]
    light = np.array([-0.45, -0.6, -0.65]); light /= np.linalg.norm(light)

    faces = []
    for i in range(len(H)):                                # side walls
        j = (i + 1) % len(H)
        (x0, y0), (x1, y1) = H[i], H[j]
        n = np.array([y1 - y0, -(x1 - x0), 0.0]); n /= np.linalg.norm(n)   # outward normal (polygon is clockwise)
        # rotate the normal like the geometry
        nx, nz = n[0] * cy + n[2] * sy, -n[0] * sy + n[2] * cy
        ny, nz = n[1] * cp - nz * sp, n[1] * sp + nz * cp
        if nz > 0.02:                                      # facing away from the camera: hidden
            continue
        shade = 0.4 + 0.35 * max(0.0, float(np.dot([nx, ny, nz], light)))
        quad = [front[i], front[j], back[j], back[i]]
        faces.append((max(p[2] for p in quad), shade, quad))
    faces.sort(key=lambda f: -f[0])                         # far first (painter's algorithm)

    img = Image.new("L", (N, N), 0)
    d = ImageDraw.Draw(img)
    for _, shade, quad in faces:
        d.polygon([(p[0], p[1]) for p in quad], fill=int(shade * 255))
    d.polygon([(p[0], p[1]) for p in front], fill=255)
    return np.asarray(img, dtype=float) / 255


def stripes(shade, pitch, width, vertical=True, chunk=6, seed=1, glitch=0.0, jitter=0.12):
    """Segments (x, y, w, h, brightness) in 0..N units.
    A sample is lit when its shade passes ~0.5 (with a little chunky noise, so edges break into dashes).
    Dimmer faces (the sides of the 3D H) are drawn on every other stripe only: fewer lines = darker,
    which is how the reference art shows depth."""
    rng = np.random.default_rng(seed)
    a = shade if vertical else shade.T
    segs, step = [], 2
    for k, c in enumerate(range(pitch // 2, N, pitch)):
        col = a[:, c]
        noise = np.repeat(rng.uniform(-jitter, jitter, N // (step * chunk) + 2), chunk)
        shift = rng.normal(0, glitch * N) if glitch and rng.random() < 0.2 else 0.0
        run = None
        for idx, t in enumerate(range(0, N, step)):
            v = col[t]
            side = 0.05 < v < 0.8
            on = v > 0.32 + noise[idx] and not (side and k % 2)
            if on and run is None:
                run = [t, v]
            if (not on or t + step >= N) and run is not None:
                start, bright = run
                if t - start >= 4:
                    seg = (c - width / 2, start + shift, width, t - start, bright)
                    segs.append(seg if vertical else (seg[1], seg[0], seg[3], seg[2], seg[4]))
                run = None
    return segs


def svg(segs, theme="dark", title="HOLOFIX", colour=None) -> str:
    """Still mark. colour(i, b) may give each line its own colour (used for the still favicon)."""
    t = THEMES[theme]
    glow = (f'<filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="{t["glow"]}" '
            'result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>') if t["glow"] else ""
    r = f"{N * 0.2:.0f}"
    border = f' stroke="{t["border"]}" stroke-width="6"' if t["border"] else ""
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {N} {N}" role="img" aria-label="{title}">',
           f'<defs>{glow}<pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse">'
           f'<circle cx="8" cy="8" r="1.3" fill="{t["dots"]}" opacity=".12"/></pattern></defs>',
           f'<rect x="3" y="3" width="{N - 6}" height="{N - 6}" rx="{r}" fill="{t["bg"]}"{border}/>',
           f'<rect width="{N}" height="{N}" rx="{r}" fill="url(#dots)"/>']
    if t["glow"]:
        out.append(f'<radialGradient id="halo"><stop offset="0" stop-color="{t["band"]}" stop-opacity=".16"/>'
                   f'<stop offset="1" stop-color="{t["band"]}" stop-opacity="0"/></radialGradient>'
                   f'<circle cx="{N/2}" cy="{N/2}" r="{N*0.42}" fill="url(#halo)"/>')
    out.append('<g filter="url(#glow)">' if t["glow"] else "<g>")
    for i, (x, y, w, h, b) in enumerate(segs):
        c = colour(i, b) if colour else t["rest"]
        out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{min(w, h) / 2:.1f}" '
                   f'fill="{c}" opacity="{0.35 + 0.65 * b:.2f}"/>')
    out.append("</g></svg>")
    return "\n".join(out)


def animated_svg(segs, theme="dark", seconds=3.2, band=0.2, seed=21, title="HOLOFIX") -> str:
    """CRT refresh: a SHORT band of "band"-coloured lines sweeps down the H and wraps to the top.
    Each line is one colour or the other, never in between (SMIL calcMode="discrete").
    Glitchy on purpose: the band's edge is ragged (each line enters/leaves a little early or late),
    about a quarter of the lines inside it stay in the rest colour, and a few lines flicker on their own.
    The lines never move, so the H stays readable. Pure SVG: animates in an <img>, no JavaScript."""
    t, rng = THEMES[theme], np.random.default_rng(seed)
    top, span = 0.1 * N, 0.8 * N                      # the band only travels over the H itself
    def times_values(windows):
        """windows = [(start, end)] in 0..1 of the cycle, where the line shows the band colour."""
        marks = sorted({0.0} | {round(x % 1, 4) for w in windows for x in w})
        def inside(m):
            return any((a <= m < b) if b <= 1 else (m >= a or m < b - 1) for a, b in windows)
        vals = [t["band"] if inside(m + 1e-6) else t["rest"] for m in marks]
        return ";".join(map(str, marks)), ";".join(vals)
    def anim(y_center):
        p = ((y_center - top) / span) % 1
        windows = []
        if rng.random() > 0.25:                       # ~1 line in 4 skips the band (stays the rest colour)
            start = p + rng.normal(0, 0.02)
            windows.append((start % 1, start % 1 + band * rng.uniform(0.6, 1.1)))
        if rng.random() < 0.12:                       # a few stray flickers elsewhere in the cycle
            q = rng.uniform(0, 1)
            windows.append((q, q + 0.04))
        if not windows:
            return ""
        keys, vals = times_values(windows)
        return (f'<animate attributeName="fill" dur="{seconds}s" repeatCount="indefinite" calcMode="discrete" '
                f'keyTimes="{keys}" values="{vals}"/>')
    out, i = [], 0
    for line in svg(segs, theme, title).split("\n"):
        if line.startswith("<rect x=") and "url(#dots)" not in line and 'fill="' + t["bg"] not in line and i < len(segs):
            x, y, w, h, _ = segs[i]; i += 1
            a = anim(y + h / 2)
            if a:
                line = line.replace("/>", ">" + a + "</rect>")
        out.append(line)
    return "\n".join(out)


OPTIONS = {
    "a_flat_vertical":     lambda: stripes(texture(flat_shade(0.1), seed=3), pitch=17, width=8, vertical=True, seed=3),
    "b_flat_scanlines":    lambda: stripes(texture(flat_shade(0.1), seed=4), pitch=15, width=7, vertical=False, seed=5, glitch=0.012),
    "c_layered_vertical":  lambda: stripes(texture(layered_shade(), seed=3), pitch=15, width=7, vertical=True, seed=3),
    "d_layered_scanlines": lambda: stripes(texture(layered_shade(), seed=4), pitch=13, width=6, vertical=False, seed=5, glitch=0.01),
    "e_solid_3d":          lambda: stripes(texture(solid_shade(yaw=-32), seed=9), pitch=11, width=5, vertical=True, seed=11),
    "f_flat_clean":        lambda: stripes(flat_shade(0.0), pitch=24, width=12, vertical=True, seed=13, jitter=0.0),
}


CHOSEN = "d_layered_scanlines"


def main():
    """Writes, in frontend/: logo.svg + logo-light.svg (animated, header, one per theme) and
    favicon.svg (still, browser tab). With --options DIR, also every option in OPTIONS, to compare."""
    frontend = Path(__file__).resolve().parents[1] / "frontend"
    segs = OPTIONS[CHOSEN]()
    (frontend / "logo.svg").write_text(animated_svg(segs, "dark"))
    (frontend / "logo-light.svg").write_text(animated_svg(segs, "light"))
    # Still version: the look of one paused frame (bright front, a short cyan stretch in the middle).
    still = lambda i, b: CYAN if (0.42 * N < segs[i][1] < 0.62 * N) or b < 0.9 else CORE
    (frontend / "favicon.svg").write_text(svg(segs, "dark", colour=still))
    (frontend / "favicon-light.svg").write_text(svg(segs, "light"))
    print("wrote frontend/logo.svg, logo-light.svg, favicon.svg, favicon-light.svg")
    if "--options" in sys.argv:
        out = Path(sys.argv[sys.argv.index("--options") + 1]); out.mkdir(parents=True, exist_ok=True)
        for name, make in OPTIONS.items():
            (out / f"{name}.svg").write_text(svg(make()))
        print("wrote the options to", out)


if __name__ == "__main__":
    main()
