"""
make_wrench_logo.py — draws the HOLOFIX "exploded wrench" mark: one wrench silhouette, repeated as
coloured layers offset down-left, like the parts of a device pulled apart in the 3D view.

    python -m scripts.make_wrench_logo

Writes four files into frontend/ (the page already picks the right one per theme and motion setting):
    logo.svg / logo-light.svg        animated: on load the layers burst out of the wrench, then every
                                     60 s they snap back in and burst out again (about 2 s of motion)
    favicon.svg / favicon-light.svg  the same mark, still (tab icon, and for people who turn motion off)

The animation is SMIL inside the SVG, so it runs even when the file is shown with a plain <img>.
"""

from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "frontend"

# The wrench, in its own 210-unit space: open jaw at the top right, handle to the bottom left.
# (No hole in the handle: through a hole you would see a dot of the layer behind, which reads as noise.)
WRENCH = """
<circle cx="135" cy="65" r="40" fill="#fff"/>
<line x1="135" y1="65" x2="52" y2="148" stroke="#fff" stroke-width="30" stroke-linecap="round"/>
<rect x="119" y="10" width="32" height="55" fill="#000" transform="rotate(45 135 65)"/>
<circle cx="135" cy="65" r="16" fill="#000"/>"""

STEP = 13                     # offset between two layers (wrench units); large enough to read at 28 px
SCALE, TX, TY = 1.69, 110, 64  # places the wrench + its layers in the middle of the 512 tile

# One look per site theme: tile colours, then the layers from back to front (front = the wrench itself).
THEMES = {
    "dark":  {"bg": "#070a0e", "stroke": None,      "dot": "#6fe7f0",
              "layers": ["#6fe7f0", "#2f7bff", "#f5b04c", "#f6f3ec"]},
    "light": {"bg": "#f6f2e9", "stroke": "#d9d1c0", "dot": "#0f6c74",
              "layers": ["#0f6c74", "#2f5fd0", "#d9822b", "#0b0e12"]},
}

# Timeline of one 60 s cycle, as (time in s, how far the layers are out: 0 = inside the wrench, 1 = rest).
# Burst out with a small overshoot, hold, then pull back in just before the cycle repeats.
CYCLE = 60.0
KEYS = [(0.0, 0.0), (0.3, 0.0), (1.0, 1.15), (1.3, 1.0), (58.6, 1.0), (59.4, 0.0), (60.0, 0.0)]
SPLINES = ["0 0 1 1", "0.2 0.8 0.3 1", "0.4 0 0.6 1", "0 0 1 1", "0.6 0 0.9 0.5", "0 0 1 1"]


def layer(color: str, depth: int, animated: bool) -> str:
    """One copy of the wrench, `depth` steps behind the front one."""
    dx, dy = -STEP * depth, STEP * depth
    anim = ""
    if animated and depth:
        values = ";".join(f"{dx * k:.2f} {dy * k:.2f}" for _, k in KEYS)
        times = ";".join(f"{t / CYCLE:.4f}" for t, _ in KEYS)
        anim = (f'<animateTransform attributeName="transform" type="translate" dur="{CYCLE:g}s" '
                f'repeatCount="indefinite" calcMode="spline" values="{values}" keyTimes="{times}" '
                f'keySplines="{";".join(SPLINES)}"/>')
    return (f'<g transform="translate({dx} {dy})"><use href="#w" fill="{color}"/>{anim}</g>'
            if not anim else f'<g><use href="#w" fill="{color}"/>{anim}</g>')


def svg(theme: str, animated: bool) -> str:
    t = THEMES[theme]
    stroke = f' stroke="{t["stroke"]}" stroke-width="6"' if t["stroke"] else ""
    layers = t["layers"]
    # back to front: the deepest layer first, the wrench itself (depth 0) last
    body = "".join(layer(c, len(layers) - 1 - i, animated) for i, c in enumerate(layers))
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="HOLOFIX">
<defs>
<pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="8" cy="8" r="1.3" fill="{t["dot"]}" opacity=".12"/></pattern>
<mask id="shape" maskUnits="userSpaceOnUse" x="-80" y="-80" width="370" height="370"><rect x="-80" y="-80" width="370" height="370" fill="#000"/>{WRENCH}
</mask>
<g id="w"><rect x="-80" y="-80" width="370" height="370" mask="url(#shape)"/></g>
</defs>
<rect x="3" y="3" width="506" height="506" rx="102" fill="{t["bg"]}"{stroke}/>
<rect width="512" height="512" rx="102" fill="url(#dots)"/>
<g transform="translate({TX} {TY}) scale({SCALE})">{body}</g>
</svg>
"""


if __name__ == "__main__":
    for theme, suffix in (("dark", ""), ("light", "-light")):
        (OUT / f"logo{suffix}.svg").write_text(svg(theme, animated=True))
        (OUT / f"favicon{suffix}.svg").write_text(svg(theme, animated=False))
        print("wrote", f"logo{suffix}.svg", f"favicon{suffix}.svg")
