"""Hirakubo-zaki lighthouse (Ishigaki Island) seen from the hill — pixel art generator.

Native canvas is 640x360 (16:9). Exports are nearest-neighbor upscales, so every
size keeps exactly the same palette.

    python hirakubo_pixel.py              # render + export 640x360 / 1920x1080 / 3840x2160
    python hirakubo_pixel.py --crops DIR  # also write zoomed detail crops for inspection
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H = 640, 360
HY = 146  # horizon row (= eye level)
LX = 213  # lighthouse axis x
LBASE = 228  # tower base row
LGAL = 138  # gallery underside row
F = 500.0  # focal length (px)
CAM_H = 60.0  # eye height above the sea (m)

YY, XX = np.mgrid[0:H, 0:W]
OUT = Path(__file__).resolve().parent
MINCHO = "/System/Library/Fonts/ヒラギノ明朝 ProN.ttc"


# ---------------------------------------------------------------- palette
def ramp(*cs):
    return np.array([[int(c[i : i + 2], 16) for i in (1, 3, 5)] for c in cs], np.uint8)


PAL = {
    "sky": ramp(
        "#1b49a3",
        "#2157b4",
        "#2966c3",
        "#3478cf",
        "#438bd9",
        "#579ee2",
        "#6fb1ea",
        "#8cc3f0",
        "#abd4f4",
        "#c9e3f7",
    ),
    # lighthouse, clouds and foam share one cool white ramp
    "white": ramp(
        "#5a6b86", "#7b8eab", "#9fb1ca", "#c0cfe0", "#dde6ef", "#f2f6fa", "#ffffff"
    ),
    "deep": ramp(
        "#0a2257",
        "#0e2d6d",
        "#133a84",
        "#1a4a9b",
        "#235db0",
        "#316fbf",
        "#4a86c9",
        "#6f9fd0",
        "#96b9dc",
    ),
    "lagoon": ramp(
        "#1a5573",
        "#1e6f90",
        "#2689a8",
        "#33a3b8",
        "#48bbc1",
        "#6ccec8",
        "#98ded2",
        "#c4ecdf",
    ),
    "coral": ramp("#173a47", "#23525b", "#356661", "#4d7a67", "#6a8a6a"),
    "grass": ramp(
        "#122616",
        "#19361b",
        "#224a22",
        "#2e5f29",
        "#3d7630",
        "#518e37",
        "#6aa63f",
        "#8abb4b",
        "#abcd62",
    ),
    "straw": ramp("#6d6a3a", "#8f8a4c", "#b1a862", "#cfc37f"),
    "bush": ramp("#0c1f14", "#13301b", "#1d4424", "#2a5a2d", "#3a7236", "#4f8a3f"),
    "isle": ramp("#1d3b31", "#294f38", "#386640", "#4c7e4a", "#669656"),
    "rock": ramp("#2a292c", "#434046", "#5f5a5b", "#7e7772", "#9c948a"),
    "stone": ramp(
        "#2f2b28", "#4b4640", "#6a6359", "#8a8174", "#aa9f8e", "#c8c1ae", "#e0dac8"
    ),
    "wood": ramp("#241810", "#3d2a1b", "#5a3f29", "#78583a", "#977550", "#b39a72"),
    "door": ramp("#3a2215", "#5a331e", "#7b4a29", "#9c6436", "#b98048"),
}

BAY4 = (
    np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]) + 0.5
) / 16
BAYER = np.tile(BAY4, (H // 4 + 1, W // 4 + 1))[:H, :W]


def quant(val, rp, dither=False):
    n = len(rp)
    v = np.clip(val, 0, n - 1)
    if dither:
        b = np.floor(v)
        idx = b + ((v - b) > BAYER)
    else:
        idx = np.floor(v + 0.5)
    return rp[np.clip(idx, 0, n - 1).astype(int)]


def paint(img, mask, val, rp, dither=False):
    val = np.broadcast_to(np.asarray(val, float), (H, W))
    img[mask] = quant(val, rp, dither)[mask]


def put(img, x, y, color):
    if 0 <= x < W and 0 <= y < H:
        img[y, x] = color


def ramp_index(rp, color):
    return int(np.argmin(np.abs(rp.astype(int) - np.asarray(color, int)).sum(1)))


# ---------------------------------------------------------------- noise
_LAT = {}


def vnoise(u, v, seed):
    g = _LAT.setdefault(seed, np.random.default_rng(seed).random((512, 512)))
    x0 = np.floor(u).astype(np.int64)
    y0 = np.floor(v).astype(np.int64)
    fx, fy = u - x0, v - y0
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    x0, y0 = x0 % 512, y0 % 512
    x1, y1 = (x0 + 1) % 512, (y0 + 1) % 512
    return (g[y0, x0] * (1 - fx) + g[y0, x1] * fx) * (1 - fy) + (
        g[y1, x0] * (1 - fx) + g[y1, x1] * fx
    ) * fy


def fbm(u, v, seed, octaves=4):
    s, amp, norm = 0.0, 1.0, 0.0
    for o in range(octaves):
        s = s + amp * vnoise(u * 2**o, v * 2**o, seed + 101 * o)
        norm += amp
        amp *= 0.5
    return s / norm


def noise1(t, seed):
    r = np.random.default_rng(seed).random(4096)
    i = np.floor(t).astype(int)
    f = t - i
    f = f * f * (3 - 2 * f)
    return r[i % 4096] * (1 - f) + r[(i + 1) % 4096] * f


def blur(a, r):
    k = 2 * r + 1
    for _ in range(2):
        c = np.cumsum(np.pad(a, ((0, 0), (r + 1, r)), mode="edge"), axis=1)
        a = (c[:, k:] - c[:, :-k]) / k
        c = np.cumsum(np.pad(a, ((r + 1, r), (0, 0)), mode="edge"), axis=0)
        a = (c[k:, :] - c[:-k, :]) / k
    return a


# ---------------------------------------------------------------- geometry
def curve(points, wobble=0.0, seed=0, scale=9.0):
    px, py = zip(*points)
    xs = np.arange(W)
    y = np.interp(xs, px, py)
    if wobble:
        y = y + wobble * (noise1(xs / scale, seed) - 0.5) * 2
    return y


LAND_PTS = [
    (0, 296),
    (40, 284),
    (90, 268),
    (130, 252),
    (150, 240),
    (166, 227),
    (182, 221),
    (250, 221),
    (268, 226),
    (292, 236),
    (340, 243),
    (400, 248),
    (460, 252),
    (520, 250),
    (580, 247),
    (640, 246),
]
SURF_PTS = [
    (0, 197),
    (80, 191),
    (160, 186),
    (240, 182),
    (320, 179),
    (380, 176),
    (462, 175),
    (540, 177),
    (640, 181),
]
ISLAND = dict(x0=382, x1=460, base=174, top=157)

land_y = curve(LAND_PTS, wobble=1.2, seed=11, scale=6)
surf_y = curve(SURF_PTS, wobble=1.0, seed=12, scale=14)

LAND = YY >= land_y[None, :]
SKY = YY <= HY
SEA = ~SKY & ~LAND
DEEP = SEA & (YY < surf_y[None, :])
LAGOON = SEA & ~DEEP

# ground-plane coordinates of the sea surface (metres)
SEA_Z = F * CAM_H / np.maximum(YY - HY, 0.5)
SEA_X = (XX - W / 2) * SEA_Z / F


def island_top(xs):
    t = np.clip((xs - ISLAND["x0"]) / (ISLAND["x1"] - ISLAND["x0"]), 0, 1)
    # steep western shoulder, low rounded crown, long tail to the east
    prof = np.where(
        t < 0.3,
        np.sin(np.clip(t / 0.3, 0, 1) * np.pi / 2) ** 0.6,
        np.cos(np.clip((t - 0.3) / 0.7, 0, 1) * np.pi / 2) ** 0.75,
    )
    prof = prof + 0.10 * (noise1(xs / 2.5, 21) - 0.5)
    return ISLAND["base"] - (ISLAND["base"] - ISLAND["top"]) * np.clip(prof, 0, None)


ISLE_TOP = island_top(np.arange(W))
ISLE = (
    (XX >= ISLAND["x0"])
    & (XX <= ISLAND["x1"])
    & (YY >= np.round(ISLE_TOP)[None, :])
    & (YY <= ISLAND["base"])
)

# stepped path: quadratic bezier from the viewer down to the lighthouse platform
PATH_P = np.array([[342, 362], [320, 282], [240, 233]], float)
PATH_W = (58, 9)
STEPS = 20
S_NEAR, S_FAR = 1 / (362 - HY), 1 / (233 - HY)


def path_rows():
    t = np.linspace(0, 1, 4000)
    p0, p1, p2 = PATH_P
    pts = (
        ((1 - t) ** 2)[:, None] * p0
        + (2 * (1 - t) * t)[:, None] * p1
        + (t**2)[:, None] * p2
    )
    w = PATH_W[0] + (PATH_W[1] - PATH_W[0]) * t**0.75
    cx, hw = np.full(H, np.nan), np.full(H, np.nan)
    for y in range(H):
        k = np.argmin(np.abs(pts[:, 1] - y))
        if abs(pts[k, 1] - y) < 1.0:
            cx[y], hw[y] = pts[k, 0], w[k] / 2
    return cx, hw


PATH_CX, PATH_HW = path_rows()
_valid = ~np.isnan(PATH_CX)
PATH_EDGE = np.where(
    _valid[:, None],
    np.abs(XX - np.nan_to_num(PATH_CX)[:, None]) - np.nan_to_num(PATH_HW)[:, None],
    999.0,
)
PATH = LAND & (PATH_EDGE < (vnoise(XX / 2.0, YY / 2.0, 101) - 0.5) * 2.2)

# carved marker post 「石垣島最北端」 standing at the viewpoint (foreground, right)
POST = dict(x0=556, x1=575, side=4, top=190)
DEPTH = np.clip((YY - 218) / 142, 0, 1)  # 0 = far (the cape) … 1 = at the viewer's feet


# ---------------------------------------------------------------- shading helpers
def puff_height(puffs, seed, jitter=0.2, squash=1.0):
    hgt = np.zeros((H, W))
    nz = fbm(XX / 5.0, YY / 5.0, seed, 3) - 0.5
    for cx, cy, r in puffs:
        ry = r * squash
        x0, x1 = max(int(cx - r - 3), 0), min(int(cx + r + 4), W)
        y0, y1 = max(int(cy - ry - 3), 0), min(int(cy + ry + 4), H)
        if x0 >= x1 or y0 >= y1:
            continue
        sx, sy = XX[y0:y1, x0:x1] + 0.5, YY[y0:y1, x0:x1] + 0.5
        d2 = (
            ((sx - cx) / r) ** 2 + ((sy - cy) / ry) ** 2 + jitter * nz[y0:y1, x0:x1] * 2
        )
        h = np.sqrt(np.clip(1 - d2, 0, None)) * r
        hgt[y0:y1, x0:x1] = np.maximum(hgt[y0:y1, x0:x1], h)
    return hgt


def lambert(hgt, light=(-0.55, -0.7, 0.55)):
    gy, gx = np.gradient(hgt)
    n = np.stack([-gx, -gy, np.ones_like(hgt)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    lv = np.array(light) / np.linalg.norm(light)
    return np.clip(n @ lv, 0, 1)


def despeckle(img, allow, passes=2):
    key = (
        (img[..., 0].astype(np.int64) << 16)
        | (img[..., 1].astype(np.int64) << 8)
        | img[..., 2]
    )
    for _ in range(passes):
        up, dn = np.roll(key, 1, 0), np.roll(key, -1, 0)
        lf, rt = np.roll(key, 1, 1), np.roll(key, -1, 1)
        # a pixel differing from 3+ agreeing neighbours is noise, not detail
        for a, b, c in ((up, dn, lf), (up, dn, rt), (up, lf, rt), (dn, lf, rt)):
            iso = allow & (a == b) & (b == c) & (key != a)
            key = np.where(iso, a, key)
    img[..., 0] = key >> 16 & 255
    img[..., 1] = key >> 8 & 255
    img[..., 2] = key & 255


def line(img, x0, y0, x1, y1, color):
    n = int(max(abs(x1 - x0), abs(y1 - y0))) + 1
    for i in range(n):
        t = i / max(n - 1, 1)
        put(img, int(round(x0 + (x1 - x0) * t)), int(round(y0 + (y1 - y0) * t)), color)


def clump(cx, cy, w, h, n, rmin, rmax, seed):
    """Random cluster of puffs inside an ellipse, bigger puffs toward the crown."""
    rng = np.random.default_rng(seed)
    puffs = []
    for _ in range(n):
        a, rr = rng.uniform(0, 2 * np.pi), rng.uniform(0, 1) ** 0.6
        x, y = cx + np.cos(a) * rr * w / 2, cy + np.sin(a) * rr * h / 2
        up = 1 - 0.35 * (y - cy) / (h / 2 + 1e-6)
        puffs.append((x, y, rng.uniform(rmin, rmax) * up))
    return puffs


def draw_blob(
    img,
    puffs,
    seed,
    rp="bush",
    dark=0.0,
    squash=1.0,
    tex=2.6,
    tex_amp=1.8,
    jitter=0.35,
    shadow=True,
):
    hgt = puff_height(puffs, seed, jitter=jitter, squash=squash)
    m = hgt > 0
    lit = lambert(blur(hgt, 1))
    leaf = fbm(XX / tex, YY / tex, seed + 5, 2)
    v = 0.2 + lit * (len(PAL[rp]) - 1.1) + (leaf - 0.5) * tex_amp - dark
    if shadow:  # contact shadow on the grass, thrown down-right
        sh = LAND & ~m & (np.roll(np.roll(m, 2, 0), 1, 1) | np.roll(m, 1, 0))
        paint(img, sh, GRASS_V - 2.4, PAL["grass"])
    tmp = img.copy()
    paint(tmp, m, v, PAL[rp])
    despeckle(tmp, m, 1)
    img[m] = tmp[m]
    return m


# ---------------------------------------------------------------- layers
def sky_value():
    t = np.clip(YY / HY, 0, 1)
    return t**1.3 * 8.4 + 0.5 * (1 - XX / W) * t


def paint_wisps(img, v, wisp):
    """High cirrus wisps: a thresholded, strongly stretched noise field."""
    m = SKY & (wisp > 0.63) & (YY < 75) & (YY > 6)
    paint(img, m, v + 1.0 + (wisp - 0.63) * 10, PAL["sky"], dither=True)


def layer_sky(img):
    v = sky_value()
    paint(img, SKY, v, PAL["sky"], dither=True)
    paint_wisps(img, v, fbm(XX / 80.0, YY / 6.0, 31, 3))


def draw_cloud(img, puffs, base, seed, squash=1.0):
    hgt = puff_height(puffs, seed, jitter=0.3, squash=squash)
    bottom = base + np.round((vnoise(XX / 7.0, 0 * XX, seed + 3) - 0.5) * 2)
    m = (hgt > 0) & (YY <= bottom) & SKY
    lit = lambert(blur(hgt, 2))
    top = min(cy - r * squash for _, cy, r in puffs)
    vert = np.clip((base - YY) / max(base - top, 1), 0, 1)
    shade = 0.12 + 0.72 * lit + 0.28 * vert
    shade -= 0.45 * np.clip((YY - (base - 7)) / 7, 0, 1)  # flat, shadowed underside
    paint(img, m, 1.5 + shade * 5.0, PAL["white"])


def cumulus(x0, x1, base, height, seed, tiers=3, lean=0.0):
    """Overlapping puffs in tiers: wide flat-based skirt, narrower rising heads."""
    rng = np.random.default_rng(seed)
    puffs = []
    for tier in range(tiers):
        f = tier / max(tiers - 1, 1)
        a = x0 + (x1 - x0) * (0.18 * f + lean * f)
        b = x1 - (x1 - x0) * (0.38 * f - lean * f)
        rr = height * (0.34 - 0.10 * f)
        x = a
        while x <= b:
            t = (x - a) / max(b - a, 1)
            r = max(2.5, rr * (0.45 + 0.55 * np.sin(np.pi * t) ** 0.7) * rng.uniform(0.85, 1.12))
            cy = base - r * 0.45 - f * height * 0.55 + rng.uniform(-1, 1)
            puffs.append((x, cy, r))
            x += r * rng.uniform(0.55, 0.8)
    return puffs


BIG_CLOUD = [(356, 97, 7), (366, 95, 9), (378, 92, 11), (392, 89, 13), (414, 87, 15),
             (440, 86, 16), (466, 87, 15), (490, 89, 13), (507, 92, 11), (520, 95, 8),
             (530, 97, 6), (384, 76, 13), (407, 68, 17), (434, 62, 20), (461, 66, 17),
             (486, 74, 13), (506, 82, 9), (424, 46, 14), (446, 42, 14), (466, 50, 11),
             (410, 54, 10), (438, 30, 9), (452, 32, 7), (398, 80, 9), (476, 58, 9),
             (455, 78, 12)]
# (puffs, flat base row, seed) in drawing order
CLOUDS = [
    (BIG_CLOUD, 100, 201),
    (cumulus(44, 112, 50, 27, 202, tiers=3), 50, 202),
    (cumulus(96, 160, 104, 30, 203, tiers=3, lean=-0.05), 104, 203),
    (cumulus(580, 632, 120, 20, 204, tiers=2), 120, 204),
]


def horizon_bank_profile():
    """Heights (px) of distant trade-wind cumulus heads resting on the horizon haze."""
    rng = np.random.default_rng(207)
    top = np.zeros(W)
    x = rng.uniform(0, 10)
    while x < W + 10:
        w = rng.uniform(6, 20)
        h = rng.uniform(1.5, 3.2) * (w / 10) ** 0.8
        xs = np.arange(int(x - w / 2), int(x + w / 2) + 1)
        xs = xs[(xs >= 0) & (xs < W)]
        top[xs] = np.maximum(top[xs], h * np.sqrt(np.clip(1 - ((xs - x) / (w / 2)) ** 2, 0, 1)))
        x += w * rng.uniform(0.45, 0.8) + (rng.uniform(12, 50) if rng.random() < 0.28 else 0)
    return top


def paint_horizon_bank(img, top):
    top = top * np.clip((np.abs(np.arange(W) - LX) - 30) / 10, 0, 1)   # keep clear of the lantern
    top = np.floor(top + 0.35)
    dh = np.gradient(top)
    bottom = HY - 2
    m = SKY & (bottom - YY < top[None, :]) & (YY <= bottom)
    below_top = top[None, :] - (bottom - YY)
    v = np.where(below_top <= 1, 6.0 - 1.0 * (dh[None, :] < -0.2), 4.4)
    v = np.where(below_top > 3, 3.6, v)
    paint(img, m, v, PAL["white"])


def layer_clouds(img):
    for puffs, base, seed in CLOUDS:
        draw_cloud(img, puffs, base, seed)
    paint_horizon_bank(img, horizon_bank_profile())


def deep_base():
    """Open-water brightness without surface texture: horizon haze + cobalt over the reef slope."""
    r = YY - HY
    fade = np.clip((r - 3) / 16, 0, 1)
    to_reef = np.clip(surf_y[None, :] - YY, 0, None)
    v = 1.25 + 5.6 * np.exp(-(r - 1) / 2.3) + 2.4 * np.exp(-to_reef / 4.5)
    return v, fade, to_reef


def lagoon_fields():
    """Static lagoon: water colour by depth, coral heads and sand pockets on the seabed."""
    below = np.clip(YY - surf_y[None, :], 0, None)
    shore = np.clip(land_y[None, :] - YY, 0, None)
    depth = fbm(SEA_X / 55.0, SEA_Z / 55.0, 51, 4)
    zone = np.clip((fbm(SEA_X / 150.0, SEA_Z / 150.0, 55, 3) - 0.38) / 0.24, 0, 1)
    v = 3.3 + (depth - 0.5) * 3.0 + 1.1 * (1 - zone)
    v = v + 2.2 * np.exp(-below / 3.5) + 2.6 * np.exp(-shore / 9.0)
    c = fbm(SEA_X / 10.0, SEA_Z / 10.0, 61, 4)
    thr = 0.75 - 0.20 * zone - 0.08 * np.exp(-below / 10.0) + 0.08 * np.exp(-shore / 8.0)
    coral = LAGOON & (c > thr)
    coral_v = (3.4 - (c - thr) * 22 + (depth - 0.5) * 2 - zone * 0.6
               + 1.2 * np.exp(-below / 14.0))
    sand = LAGOON & (fbm(SEA_X / 11.0, SEA_Z / 11.0, 63, 3) > 0.66 + 0.1 * zone) & ~coral
    return v, coral, coral_v, sand


def layer_sea(img):
    # ---- open water beyond the reef
    v, fade, to_reef = deep_base()
    wind = fbm(SEA_X / 70.0, SEA_Z / 40.0, 41, 3)
    v = v + fade * (wind - 0.5) * 2.2
    paint(img, DEEP, v, PAL["deep"], dither=True)
    caps = fbm(SEA_X / 5.0, SEA_Z / 7.0, 43, 2)
    cap_thr = 0.86 - 0.06 * np.exp(-to_reef / 10)
    img[DEEP & (caps > cap_thr) & (fade > 0.3)] = PAL["white"][4]
    img[DEEP & (caps > cap_thr + 0.04) & (fade > 0.3)] = PAL["white"][6]
    # ---- lagoon inside the reef
    v, coral, coral_v, sand = lagoon_fields()
    paint(img, LAGOON, v, PAL["lagoon"])
    paint(img, coral, coral_v, PAL["coral"])
    img[sand] = PAL["lagoon"][7]
    despeckle(img, SEA)
    # ---- surf on the reef edge
    s = YY - surf_y[None, :]
    brk = vnoise(XX / 4.0, np.zeros_like(XX, float), 71)
    brk2 = vnoise(XX / 1.7, np.zeros_like(XX, float), 72)
    img[SEA & (s >= -1.0) & (s < 0.2) & (brk > 0.22)] = PAL["white"][6]
    img[SEA & (s >= 0.2) & (s < 1.4) & (brk > 0.40)] = PAL["white"][5]
    img[SEA & (s >= -2.0) & (s < -1.0) & (brk2 > 0.72)] = PAL["white"][4]
    trail = fbm(SEA_X / 3.0, SEA_Z / 5.0, 73, 2)
    img[LAGOON & (s >= 1.4) & (s < 6) & (trail > 0.58 + s * 0.035)] = PAL["lagoon"][7]
    # ---- rocky western shoreline with a lick of foam (the eastern crest hides its shore)
    wet = (
        SEA
        & (land_y[None, :] - YY < 2.5 + 2.0 * vnoise(XX / 3.0, 0 * XX, 75))
        & (YY > 200)
        & (XX < 182)
    )
    img[wet] = PAL["rock"][1]
    img[wet & (vnoise(XX / 1.5, YY / 1.5, 76) > 0.6)] = PAL["rock"][2]
    lick = SEA & ~wet & np.roll(wet, 1, 0) & (vnoise(XX / 2.0, 0 * XX, 77) > 0.35)
    img[lick] = PAL["white"][5]


def layer_island(img):
    xt = (XX - ISLAND["x0"]) / (ISLAND["x1"] - ISLAND["x0"])
    hgt = np.maximum(ISLAND["base"] - ISLE_TOP[None, :], 1)
    rel = (YY - ISLE_TOP[None, :]) / hgt
    rock_line = 0.62 + 0.22 * (noise1(XX / 2.0, 22) - 0.5)
    veg = ISLE & (rel < rock_line)
    leaf = fbm(XX / 2.2, YY / 2.2, 81, 2)
    v = 2.4 + 1.6 * (0.45 - xt) - 1.2 * rel + (leaf - 0.5) * 2.0 + 1.0 * (rel < 0.15)
    paint(img, veg, v, PAL["isle"])
    rock = ISLE & ~veg
    rv = (
        2.2
        + 2.0 * (0.4 - xt)
        + (vnoise(XX / 1.5, YY / 1.5, 82) - 0.5) * 1.6
        - 1.2 * (rel > 0.82)
    )
    paint(img, rock, rv, PAL["rock"])
    despeckle(img, ISLE, 1)
    base = ISLAND["base"] + 1
    for x in range(ISLAND["x0"] - 3, ISLAND["x1"] + 5):
        n = noise1(np.array([x / 2.0]), 23)[0]
        if n > 0.35:
            put(img, x, base, PAL["white"][6 if n > 0.6 else 5])
        if x < ISLAND["x0"] + 6 and n > 0.5:
            put(img, x - 2, base - 1, PAL["white"][5])


GRASS_V = np.zeros((H, W))


def grass_value():
    clump_n = fbm(XX / 16.0, YY / 7.0, 91, 4)
    fine = vnoise(XX / 2.2, YY / 1.6, 92)
    swath = fbm(XX / 70.0, YY / 16.0, 94, 3)  # wind-combed light/dark swaths
    ridge = np.exp(-np.clip(YY - land_y[None, :], 0, None) / 9.0)
    v = (
        5.3
        - 2.4 * DEPTH
        + (clump_n - 0.5) * 3.0
        + (fine - 0.5) * 1.0
        + 0.9 * ridge
        + (swath - 0.5) * 2.6
    )
    # the western slope faces the afternoon sun
    return v + 0.8 * np.clip((200 - XX) / 200, 0, 1) * (1 - DEPTH * 0.5)


def straw_fields():
    """Patches of sun-dried grass: mask and straw-ramp value."""
    fine = vnoise(XX / 2.2, YY / 1.6, 92)
    dry = fbm(XX / 26.0, YY / 10.0, 93, 3)
    grain = vnoise(XX / 1.3, YY / 0.9, 95)
    straw = LAND & (dry > 0.62) & (grain > 0.45) & (DEPTH > 0.12) & (DEPTH < 0.85)
    return straw, 1.0 + (dry - 0.62) * 12 + (fine - 0.5)


def layer_land(img):
    GRASS_V[:] = grass_value()
    paint(img, LAND, GRASS_V, PAL["grass"])
    straw, straw_v = straw_fields()
    paint(img, straw, straw_v, PAL["straw"])
    despeckle(img, LAND)


def layer_far_bushes(img):
    draw_blob(img, clump(262, 224, 60, 16, 16, 3.5, 7, 301), 301, squash=0.8)
    draw_blob(img, clump(160, 234, 30, 16, 9, 3, 5.5, 302), 302, squash=0.8)
    draw_blob(img, clump(372, 247, 36, 8, 10, 2.5, 5, 303), 303, squash=0.6)
    draw_blob(img, clump(612, 248, 64, 10, 14, 3, 6, 304), 304, squash=0.6)
    draw_blob(img, clump(130, 262, 30, 10, 8, 3, 5.5, 305), 305, squash=0.75)
    draw_blob(img, clump(470, 262, 26, 8, 7, 2.5, 4.5, 306), 306, squash=0.7)


def layer_path(img):
    s = 1.0 / np.maximum(YY - HY, 1)
    k = (s - S_NEAR) / (S_FAR - S_NEAR) * STEPS
    frac = k - np.floor(k)
    rows = np.maximum((S_FAR - S_NEAR) / STEPS * (YY - HY) ** 2, 1e-3)  # rows per step
    sh = np.clip(1.3 / rows, 0, 0.45)
    nos = np.clip(1.0 / rows, 0, 0.3)
    across = (XX - np.nan_to_num(PATH_CX)[:, None]) / np.maximum(
        np.nan_to_num(PATH_HW)[:, None], 1
    )
    wear = fbm(XX / 5.0, YY / 3.0, 111, 3)
    v = 4.4 - 0.5 * across + (wear - 0.5) * 1.4 - 0.6 * (1 - DEPTH)
    v = np.where(frac < sh, 2.2, v)
    v = np.where(frac > 1 - nos, 5.6, v)
    paint(img, PATH, v, PAL["stone"])
    rim = LAND & ~PATH & (PATH_EDGE < 1.5 + DEPTH * 1.5)
    paint(img, rim, 1.8 + wear * 1.5, PAL["wood"])


def draw_tufts(img, n, seed, region):
    rng = np.random.default_rng(seed)
    ys, xs = np.nonzero(region)
    for i in rng.choice(len(xs), n):
        x, y = int(xs[i]), int(ys[i])
        near = DEPTH[y, x]
        base = int(np.clip(round(GRASS_V[y, x]), 1, 6))
        length = 1.5 + near * 8 * rng.uniform(0.6, 1.2)
        for _ in range(rng.integers(2, 5)):
            bx = x + rng.integers(-2, 3) * (0.5 + near)
            lean = rng.uniform(0.25, 0.75)
            lb = max(1, int(length * rng.uniform(0.55, 1.0)))
            for kk in range(lb):
                px = int(round(bx + lean * kk * kk / lb))
                idx = base + 1 if kk < lb - 1 else base + 2
                put(img, px, y - kk, PAL["grass"][min(idx, 8)])
        put(img, x, y + 1, PAL["grass"][max(base - 2, 0)])


def layer_lighthouse(img):
    wr, st, rk, dr = PAL["white"], PAL["stone"], PAL["rock"], PAL["door"]
    lxz = np.array([-0.62, 0.78]) / np.hypot(0.62, 0.78)

    def cyl(hw, x):
        n = np.clip((x + 0.5 - LX) / hw, -1, 1)
        return n * lxz[0] + np.sqrt(1 - n * n) * lxz[1]

    # ---- concrete platform, seen from above
    pcx, pcy, prx, pry = LX + 3, LBASE + 1, 38, 8
    e = ((XX + 0.5 - pcx) / prx) ** 2 + ((YY + 0.5 - pcy) / pry) ** 2
    plat = e <= 1
    paint(img, plat, 5.0 - 0.6 * (e > 0.75), st)
    sh = plat & (XX > LX + 12) & (np.abs(YY - (LBASE - (XX - LX - 12) * 0.22)) < 2.6)
    img[sh] = st[3]
    # ---- low curved wall around the front-right of the platform
    for th in np.linspace(-0.15 * np.pi, 0.55 * np.pi, 220):
        x = int(round(pcx + prx * np.cos(th)))
        yb = int(round(pcy + pry * np.sin(th)))
        face = 4 if np.cos(th) < 0.55 else 3
        for dy in range(1, 3):
            put(img, x, yb - dy, wr[face])
        put(img, x, yb - 3, wr[6])
        put(img, x, yb, wr[2])
    # ---- annex (flat-roofed utility building) on the left
    ax0, ax1, ay0, ay1 = 172, 197, 212, 232
    img[ay0 : ay1 + 1, ax0 : ax1 + 1] = wr[5]
    img[ay0 : ay1 + 1, ax0] = wr[6]
    img[ay0 : ay1 + 1, ax1 - 1 : ax1 + 1] = wr[3]
    img[ay0, ax0 : ax1 + 1] = wr[3]  # shadow under the roof slab
    img[ay0 - 3, ax0 - 1 : ax1 + 2] = wr[6]
    img[ay0 - 2 : ay0, ax0 - 1 : ax1 + 2] = wr[4]
    img[ay0 - 2 : ay0, ax1 : ax1 + 2] = wr[3]
    img[216:219, 176:181] = rk[1]  # vent
    img[216, 176:181] = rk[0]
    img[219 : ay1 + 1, 186:193] = rk[2]  # steel door
    img[219 : ay1 + 1, 186] = rk[1]
    img[219, 186:193] = rk[1]
    img[219 : ay1 + 1, 189] = rk[1]
    img[ay1, ax0 : ax1 + 1] = st[3]
    for y in range(202, ay0 - 3):  # globe lamp on the roof
        put(img, 193, y, rk[2])
    for dx, dy, c in (
        (-1, -1, 6),
        (0, -1, 6),
        (1, -1, 4),
        (-1, 0, 6),
        (0, 0, 5),
        (1, 0, 3),
        (-1, 1, 4),
        (0, 1, 3),
        (1, 1, 2),
        (0, -2, 5),
    ):
        put(img, 193 + dx, 199 + dy, wr[c])
    # ---- tower
    for y in range(LGAL, LBASE):
        hw = 13.5 - 1.0 * (LBASE - y) / (LBASE - LGAL)
        for x in range(int(np.floor(LX - hw)), int(np.ceil(LX + hw))):
            v = 0.4 + cyl(hw, x) * 6.0
            if y < LGAL + 3:
                v -= 1.6  # shade under the gallery
            put(img, x, y, wr[int(np.clip(round(v), 0, 6))])
    rng = np.random.default_rng(9)
    for x in rng.choice(np.arange(LX - 9, LX + 10), 4, replace=False):  # rain streaks
        for y in range(LGAL + 3, LGAL + 3 + rng.integers(3, 8)):
            img[y, x] = wr[max(ramp_index(wr, img[y, x]) - 1, 0)]
    for wy in (LGAL + 22, LGAL + 52):  # small windows
        img[wy : wy + 4, LX - 5 : LX - 3] = rk[1]
        img[wy + 4, LX - 5 : LX - 3] = wr[6]
    # ---- entrance porch + rust-brown door
    px0, px1, py0 = LX - 8, LX + 7, LBASE - 21
    img[py0:LBASE, px0 : px1 + 1] = wr[4]
    img[py0:LBASE, px0] = wr[5]
    img[py0:LBASE, px1 - 1 : px1 + 1] = wr[2]
    img[py0 - 2, px0 - 1 : px1 + 2] = wr[6]
    img[py0 - 1, px0 - 1 : px1 + 2] = wr[3]
    dx0, dx1, dy0 = LX - 5, LX + 4, LBASE - 17
    img[dy0:LBASE, dx0 : dx1 + 1] = dr[2]
    img[dy0:LBASE, dx0 : dx0 + 2] = dr[3]
    img[dy0:LBASE, dx1] = dr[1]
    img[dy0, dx0 : dx1 + 1] = dr[0]
    img[dy0:LBASE, dx0 - 1] = dr[0]
    img[dy0 + 2 : LBASE - 1 : 3, dx0 + 1 : dx1] = dr[1]  # louvres
    put(img, dx1 - 2, dy0 + 9, dr[4])
    img[LBASE, px0 - 1 : px1 + 2] = st[5]
    # ---- gallery disc (just above eye level: its underside shows)
    for y in range(LGAL - 7, LGAL):
        for x in range(LX - 18, LX + 18):
            v = 1.0 + cyl(18, x) * 5.2
            if y == LGAL - 7:
                v += 1.0
            if y >= LGAL - 2:
                v -= 2.2
            put(img, x, y, wr[int(np.clip(round(v), 0, 6))])
    # ---- lantern housing behind the railing
    for y in range(LGAL - 22, LGAL - 7):
        for x in range(LX - 7, LX + 7):
            v = 0.8 + cyl(7, x) * 5.4
            put(img, x, y, wr[int(np.clip(round(v), 0, 6))])
    img[LGAL - 19 : LGAL - 14, LX - 6 : LX + 6] = rk[0]
    img[LGAL - 19 : LGAL - 14, LX - 4] = PAL["sky"][7]
    img[LGAL - 19, LX - 6 : LX + 6] = rk[1]
    img[LGAL - 23, LX - 7 : LX + 7] = rk[2]
    img[LGAL - 24, LX - 5 : LX + 5] = rk[1]
    for dx, dy, c in (
        (-1, -27, 5),
        (0, -27, 6),
        (1, -27, 4),
        (-2, -26, 6),
        (-1, -26, 6),
        (0, -26, 5),
        (1, -26, 4),
        (2, -26, 3),
        (-2, -25, 5),
        (2, -25, 2),
    ):
        put(img, LX + dx, LGAL + dy, wr[c])  # radome
    for y in range(LGAL - 32, LGAL - 24):  # wind vane
        put(img, LX - 5, y, rk[1])
    for x in range(LX - 8, LX - 2):
        put(img, x, LGAL - 32, rk[1])
    put(img, LX - 8, LGAL - 33, rk[1])
    # ---- railing
    for x in range(LX - 17, LX + 17):
        lit = x < LX + 4
        put(img, x, LGAL - 13, wr[5] if lit else wr[2])
        put(img, x, LGAL - 10, wr[4] if lit else wr[2])
        if (x - LX) % 3 == 0:
            for y in range(LGAL - 12, LGAL - 7):
                put(img, x, y, wr[4] if lit else wr[1])
    # ---- mast
    for y in range(78, LGAL - 13):
        put(img, LX + 11, y, rk[1])
    for x in range(LX + 9, LX + 14):
        put(img, x, 90, rk[1])
    put(img, LX + 12, 84, rk[2])
    put(img, LX + 12, 85, rk[2])


def layer_fence(img):
    wd = PAL["wood"]
    posts = []
    for k in np.arange(0.6, STEPS - 1.5, 1.6):
        y = int(round(HY + 1 / (S_NEAR + k / STEPS * (S_FAR - S_NEAR))))
        if np.isnan(PATH_CX[y]):
            continue
        hgt = max(3, int(round(0.088 * (y - HY) + 0.5)))
        wid = max(2, int(round(hgt * 0.3)))
        x = int(round(PATH_CX[y] + PATH_HW[y] + 1 + 0.04 * (y - HY)))
        posts.append((x, y, hgt, wid))
    posts.sort(key=lambda p: p[1])
    for (xa, ya, ha, wa), (xb, yb, hb, wb) in zip(posts, posts[1:]):
        for a in (0.28, 0.68):
            y0, y1 = ya - ha * (1 - a), yb - hb * (1 - a)
            line(img, xa + wa // 2, y0, xb + wb // 2, y1, wd[3])
            if hb >= 12:
                line(img, xa + wa // 2, y0 + 1, xb + wb // 2, y1 + 1, wd[1])
    for x, y, hgt, wid in posts:
        for yy in range(y - hgt, y + 1):
            for dx in range(wid):
                c = 4 if dx == 0 else (1 if dx == wid - 1 else 2)
                put(img, x + dx, yy, wd[c])
        for dx in range(wid):
            put(img, x + dx, y - hgt, wd[5])
        for dx in range(1, max(2, hgt // 3)):  # cast shadow toward the upper right
            put(img, x + wid + dx - 1, y - dx // 2, PAL["grass"][1])


def layer_near(img):
    draw_blob(img, clump(40, 318, 90, 34, 22, 6, 12, 311), 311, dark=0.3, squash=0.85)
    draw_blob(img, clump(622, 300, 50, 26, 12, 5, 10, 312), 312, dark=0.3, squash=0.85)
    draw_blob(img, clump(246, 300, 34, 12, 9, 3.5, 6, 313), 313, squash=0.8)


def layer_rocks(img):
    for cx, cy, w, h, n, seed in (
        (602, 348, 40, 20, 8, 131),
        (636, 338, 26, 18, 6, 132),
        (538, 352, 22, 12, 5, 133),
    ):
        m = draw_blob(
            img,
            clump(cx, cy, w, h, n, 4, 8, seed),
            seed,
            rp="stone",
            squash=0.7,
            tex=1.6,
            tex_amp=1.2,
            jitter=0.5,
        )
        pits = m & (vnoise(XX / 1.4, YY / 1.2, seed + 9) > 0.8)
        img[pits] = PAL["stone"][1]


def glyph_mask(text, size, thr=0.3, ss=6):
    """Supersampled vertical text; area coverage keeps thin mincho strokes alive."""
    font = ImageFont.truetype(MINCHO, size * ss, index=1)  # W6
    im = Image.new("L", (size * ss, size * ss * len(text)), 0)
    d = ImageDraw.Draw(im)
    for i, ch in enumerate(text):
        d.text(
            (size * ss / 2, (i + 0.5) * size * ss), ch, fill=255, font=font, anchor="mm"
        )
    a = np.asarray(im, float).reshape(size * len(text), ss, size, ss).mean((1, 3)) / 255
    return a > thr


def layer_post(img):
    st = PAL["stone"]
    x0, x1, top, side = POST["x0"], POST["x1"], POST["top"], POST["side"]
    rng = np.random.default_rng(17)
    # cast shadow first: thrown up and to the right across the grass
    for i in range(1, 44):
        for w in range(0, 6):
            x, y = x1 + side + i, H - 1 - i // 2 - w
            if 0 <= x < W and 0 <= y < H and LAND[y, x]:
                img[y, x] = PAL["grass"][
                    max(ramp_index(PAL["grass"], img[y, x]) - 2, 0)
                ]
    notch = {x0 + 7: 1, x0 + 8: 2, x0 + 9: 1}
    for x in range(x0, x1 + side + 1):
        t = top + notch.get(x, 0) + (1 if x > x1 - 3 else 0) + (2 if x > x1 else 0)
        for y in range(t, H):
            if x == x0:
                c = 5
            elif x < x0 + 5:
                c = 4
            elif x < x1 - 4:
                c = 3
            elif x <= x1:
                c = 2
            else:  # side face turned from the sun
                c = 1 if x < x1 + side else 0
            put(img, x, y, st[c])
        put(img, x, t, st[6 if x <= x1 else 2])
        put(img, x, t + 1, st[5 if x <= x1 else 1])
    for _ in range(14):  # grain and weather checks
        x = int(rng.integers(x0 + 1, x1))
        y = int(rng.integers(top + 4, H - 20))
        for yy in range(y, min(H, y + int(rng.integers(6, 30)))):
            put(img, x, yy, st[max(ramp_index(st, img[yy, x]) - 1, 1)])
    g = glyph_mask("石垣島最北端", 16)
    gy, gx = np.nonzero(g)
    ox, oy = x0 + 2, top + 9
    for y, x in zip(gy, gx):
        put(img, ox + x + 1, oy + y + 1, st[5])  # lit lower lip of the carving
    for y, x in zip(gy, gx):
        put(img, ox + x, oy + y, st[0])


def layer_foreground(img):
    rng = np.random.default_rng(77)
    gr = PAL["grass"]
    for _ in range(460):
        x = int(rng.integers(-10, W + 10))
        if 300 < x < 380 and rng.random() < 0.85:
            continue
        y = int(H - 1 + rng.integers(0, 6))
        ln = int(rng.integers(8, 26))
        lean = rng.uniform(0.3, 0.9)
        c = int(rng.integers(1, 4))
        for k in range(ln):
            px = int(round(x + lean * k * k / ln))
            put(img, px, y - k, gr[c + (2 if k > ln - 3 else 0)])
            put(img, px + 1, y - k, gr[max(c - 1, 0)])


# ---------------------------------------------------------------- main
def render():
    img = np.zeros((H, W, 3), np.uint8)
    layer_sky(img)
    layer_clouds(img)
    layer_sea(img)
    layer_island(img)
    layer_land(img)
    layer_far_bushes(img)
    layer_path(img)
    tuft_zone = (
        LAND & ~PATH & (PATH_EDGE > 1.5) & ~((np.abs(XX - LX) < 45) & (YY < 240))
    )
    draw_tufts(img, 2600, 7, tuft_zone)
    draw_tufts(img, 900, 8, LAND & (np.abs(PATH_EDGE) < 3.5) & (YY > 245))
    layer_lighthouse(img)
    layer_fence(img)
    layer_near(img)
    layer_rocks(img)
    layer_post(img)
    layer_foreground(img)
    return img


def palette_size(img):
    return len(np.unique(img.reshape(-1, 3), axis=0))


def export(img):
    n = palette_size(img)
    paths = []
    for scale, name in (
        (1, "hirakubo_640x360.png"),
        (3, "hirakubo_1920x1080.png"),
        (6, "hirakubo_3840x2160.png"),
    ):
        big = np.repeat(np.repeat(img, scale, 0), scale, 1)
        assert (
            big.shape[:2] == (H * scale, W * scale)
            and big.shape[1] * 9 == big.shape[0] * 16
        )
        assert palette_size(big) == n
        Image.fromarray(big).save(OUT / name, optimize=True)
        paths.append(OUT / name)
    return n, paths


def crops(img, outdir):
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    boxes = {
        "lighthouse": (160, 70, 320, 245),
        "island": (360, 150, 480, 190),
        "post": (480, 180, 640, 360),
        "left": (0, 180, 200, 360),
        "path": (230, 220, 420, 360),
        "sky": (320, 0, 640, 150),
    }
    for name, (a, b, c, d) in boxes.items():
        sub = img[b:d, a:c]
        z = max(1, 900 // max(sub.shape[:2]))
        Image.fromarray(np.repeat(np.repeat(sub, z, 0), z, 1)).save(
            outdir / f"crop_{name}.png"
        )


if __name__ == "__main__":
    art = render()
    colors, files = export(art)
    print(f"palette: {colors} colors")
    for f in files:
        print(f)
    if "--crops" in sys.argv:
        crops(art, sys.argv[sys.argv.index("--crops") + 1])
