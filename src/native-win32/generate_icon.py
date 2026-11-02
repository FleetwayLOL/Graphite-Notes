#!/usr/bin/env python3
"""
Generates 8 crisp multi-size Windows .ICO icons (16, 20, 24, 32, 40, 48, 64, 256 px PNG-in-ICO)
in pure Python (struct + zlib) depicting a full-bleed strict geometric 'G' monogram
on a matte rounded square for Graphite.
"""

import math
import struct
import zlib
from pathlib import Path


VARIANTS = {
    "app_bw.ico": {
        "c1": (0.16, 0.17, 0.21),
        "c2": (0.08, 0.09, 0.11),
        "dark_ink": False,
    },
    "app.ico": {
        "c1": (0.15, 0.36, 0.78),
        "c2": (0.09, 0.22, 0.54),
        "dark_ink": False,
    },
    "app_white.ico": {
        "c1": (0.98, 0.98, 0.99),
        "c2": (0.87, 0.89, 0.93),
        "dark_ink": True,
    },
    "app_purple.ico": {
        "c1": (0.37, 0.21, 0.72),
        "c2": (0.22, 0.11, 0.47),
        "dark_ink": False,
    },
    "app_yellow.ico": {
        "c1": (0.95, 0.73, 0.15),
        "c2": (0.79, 0.53, 0.06),
        "dark_ink": True,
    },
    "app_red.ico": {
        "c1": (0.77, 0.16, 0.21),
        "c2": (0.49, 0.08, 0.13),
        "dark_ink": False,
    },
    "app_green.ico": {
        "c1": (0.10, 0.53, 0.38),
        "c2": (0.05, 0.32, 0.23),
        "dark_ink": False,
    },
    "app_pink.ico": {
        "c1": (0.75, 0.19, 0.48),
        "c2": (0.47, 0.10, 0.31),
        "dark_ink": False,
    },
}


def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else (hi if v > hi else v)


def sd_rounded_box(px, py, cx, cy, hw, hh, r):
    dx = abs(px - cx) - (hw - r)
    dy = abs(py - cy) - (hh - r)
    out_d = math.hypot(max(dx, 0.0), max(dy, 0.0))
    in_d = min(max(dx, dy), 0.0)
    return out_d + in_d - r


def sd_letter_g(nx: float, ny: float) -> float:
    """
    Signed distance to a bold, full-scale strict geometric capital 'G' centered at (0.50, 0.50).
    """
    cx, cy = 0.50, 0.50
    dx = nx - cx
    dy = ny - cy
    r_mid = 0.268
    half_th = 0.060  # total stroke width = 0.120, outer radius = 0.328 (65.6% of full-bleed icon)

    r = math.hypot(dx, dy)
    d_ring = abs(r - r_mid) - half_th

    th1 = -0.66
    n1x, n1y = math.sin(th1), -math.cos(th1)
    th2 = -0.03
    n2x, n2y = -math.sin(th2), math.cos(th2)

    s1 = -(dx * n1x + dy * n1y)
    s2 = -(dx * n2x + dy * n2y)
    d_cut = min(s1, s2)
    d_arc = max(d_ring, d_cut)

    bar_left = 0.492
    bar_right = cx + r_mid + half_th
    bar_top = 0.474
    bar_bot = 0.580
    bar_cx = 0.5 * (bar_left + bar_right)
    bar_cy = 0.5 * (bar_top + bar_bot)
    bar_hw = 0.5 * (bar_right - bar_left)
    bar_hh = 0.5 * (bar_bot - bar_top)
    d_bar = sd_rounded_box(nx, ny, bar_cx, bar_cy, bar_hw, bar_hh, 0.006)
    d_bar_clipped = max(d_bar, r - (r_mid + half_th))

    return min(d_arc, d_bar_clipped)


def blend(dst, src):
    dr, dg, db, da = dst
    sr, sg, sb, sa = src
    out_a = sa + da * (1.0 - sa)
    if out_a <= 1e-6:
        return (0.0, 0.0, 0.0, 0.0)
    r = (sr * sa + dr * da * (1.0 - sa)) / out_a
    g = (sg * sa + dg * da * (1.0 - sa)) / out_a
    b = (sb * sa + db * da * (1.0 - sa)) / out_a
    return (r, g, b, out_a)


def render_png(size: int, spec: dict) -> bytes:
    rows = []
    aa = 1.0 / size
    c1 = spec["c1"]
    c2 = spec["c2"]
    dark_ink = spec["dark_ink"]

    # Full-bleed square (fills 99% of the icon canvas so 24x24 taskbar icon is a full 24x24px!)
    hw = 0.494
    corner_r = 0.175

    for y in range(size):
        row = bytearray([0])  # PNG filter type 0
        ny = (y + 0.5) / size
        for x in range(size):
            nx = (x + 0.5) / size
            col = (0.0, 0.0, 0.0, 0.0)

            d_bg = sd_rounded_box(nx, ny, 0.5, 0.5, hw, hw, corner_r)
            a_bg = clamp(0.5 - d_bg / aa)
            if a_bg > 0.0:
                t = clamp(ny * 0.85 + nx * 0.15)
                r = c1[0] * (1.0 - t) + c2[0] * t
                g = c1[1] * (1.0 - t) + c2[1] * t
                b = c1[2] * (1.0 - t) + c2[2] * t
                col = blend(col, (r, g, b, a_bg))

                # Crisp 1px inner border so dark icon edges stand out clearly on dark Windows taskbar
                border_w = max(0.014, 0.85 / size)
                rim = clamp(1.0 - abs(d_bg + border_w * 0.55) / (aa * 1.15))
                if rim > 0.0:
                    if dark_ink:
                        col = blend(col, (0.08, 0.10, 0.14, rim * 0.28 * a_bg))
                    else:
                        rim_alpha = (0.42 - 0.14 * ny) * rim * a_bg
                        col = blend(col, (1.0, 1.0, 1.0, clamp(rim_alpha)))

            d_g = sd_letter_g(nx, ny)
            a_g = clamp(0.5 - d_g / aa)
            if a_g > 0.0 and a_bg > 0.0:
                ink = (0.09, 0.10, 0.13) if dark_ink else (0.98, 0.99, 1.00)
                col = blend(col, (ink[0], ink[1], ink[2], a_g * a_bg))

            r8 = int(round(clamp(col[0]) * 255))
            g8 = int(round(clamp(col[1]) * 255))
            b8 = int(round(clamp(col[2]) * 255))
            a8 = int(round(clamp(col[3]) * 255))
            row.extend((r8, g8, b8, a8))
        rows.append(bytes(row))

    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def build_ico(out_path: Path, spec: dict):
    sizes = [16, 20, 24, 32, 40, 48, 64, 256]
    png_blobs = [render_png(s, spec) for s in sizes]

    header = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries = []
    for s, blob in zip(sizes, png_blobs):
        w_b = 0 if s == 256 else s
        h_b = 0 if s == 256 else s
        entries.append(struct.pack("<BBBBHHII", w_b, h_b, 0, 0, 1, 32, len(blob), offset))
        offset += len(blob)

    out_path.write_bytes(header + b"".join(entries) + b"".join(png_blobs))


if __name__ == "__main__":
    base = Path(__file__).resolve().parent
    total = 0
    for fname, spec in VARIANTS.items():
        p = base / fname
        build_ico(p, spec)
        total += p.stat().st_size
    print(f"Generated {len(VARIANTS)} multi-res .ico icons ({total:,} bytes total)")
