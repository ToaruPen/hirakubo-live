"""Seamless 60 fps loop of the Hirakubo-zaki pixel art, animated with simple physics.

Everything that moves is periodic in the loop length T by construction: every temporal
phase is 2π·((n·i) mod N)/N for an integer harmonic n and frame index i, so frame N is
exactly frame 0.

Physics (SI units; x = east / screen right, z = north / away from the viewer):
  wind        one vector for the whole scene: summer monsoon from the SW, blowing toward
              the NE — 6 m/s over the grass, 7 m/s over the sea, 8 m/s at cloud base
  gusts       Taylor's frozen turbulence: a gust pattern advected with the mean wind
              (k·U = ω = 2πn/T); grass answers as a damped oscillator (f0 1.3 Hz, ζ 0.3),
              bending (tuft lean) and flashing its lighter side (sheen)
  swell       8 s swell from the NNE, deep-water dispersion ω² = gk. The same component
              draws the incoming crests, times every break along the reef (it arrives
              obliquely, so the break peels along the reef) and the splash on the island
  wind waves  1.2–3 s waves: ω² = gk offshore, ω² = gk·tanh(kh) (h = 1.5 m) in the lagoon.
              Rendered as reflection brightness ∝ −∂η/∂z and band-limited by each pixel's
              footprint on the water, so they fade out toward the horizon instead of aliasing
  whitecaps   breaking events that ride the crest at phase speed, then leave foam that
              decays exponentially; the offshore wind blows reef spray seaward
  clouds      angular drift = wind speed / distance. A seamless loop needs zero net
              displacement, so each height field is blended between its positions at t and
              t − T before quantisation: the puffs travel with the wind, the outline returns

    python hirakubo_loop.py --gate                 # compositing check: static frame == still
    python hirakubo_loop.py --preview DIR          # key frames, contact sheet, periodicity
    python hirakubo_loop.py --render DIR           # all frames + 1080p60 / 4K60 MP4
    python hirakubo_loop.py --check DIR            # wrap and flicker statistics
"""

import subprocess
import sys
import time
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from PIL import Image

import hirakubo_pixel as hp
from hirakubo_pixel import (
    CAM_H,
    DEEP,
    DEPTH,
    F,
    HY,
    ISLAND,
    ISLE,
    LAGOON,
    LAND,
    PAL,
    POST,
    SEA,
    SEA_X,
    SEA_Z,
    SKY,
    XX,
    YY,
    H,
    W,
    blur,
    despeckle,
    fbm,
    lambert,
    noise1,
    paint,
    quant,
    surf_y,
    vnoise,
)

FPS = 60
T = 24.0  # loop length (s): three periods of the 8 s swell
N = round(FPS * T)  # 1440 frames; frame N is frame 0
G = 9.81
OUT = Path(__file__).resolve().parent

WIND = np.array([np.sin(np.pi / 4), np.cos(np.pi / 4)])  # blowing toward the NE (from SW)
U_GRASS, U_SEA, U_CLOUD, U_CIRRUS = 6.0, 7.0, 8.0, 15.0
CLOUD_BASE = 640.0  # trade-cumulus base above eye level (m)
CIRRUS_H = 8900.0  # cirrus above eye level (m)
BANK_DIST = 40000.0  # distance of the cumulus heads on the horizon (m)
EYE_OVER_CAPE = 13.0  # eye height over the lighthouse platform: ground plane for the hill

SWELL_N = 3  # 3 cycles per loop → 8 s swell
SWELL_DIR = np.array([-np.sin(np.radians(20)), -np.cos(np.radians(20))])  # from the NNE
SET_AMP = np.array([1.0, 0.8, 0.6])  # a three-wave set
LAGOON_DEPTH = 1.5
BORE_SPEED = np.sqrt(G * 1.2)  # whitewater bore over the reef flat, √(gh)
REFLECT = 5.0  # brightness (ramp steps) per unit surface slope toward the viewer
SWELL_REFLECT = 12.0  # swell also modulates short-wave roughness → stronger signature
SHEEN = 0.45  # grass brightness (ramp steps) per σ of gust deflection
SENTINEL = np.array([255, 0, 255], np.uint8)


def tphase(n, i):
    """Temporal phase of integer harmonic n at frame i, exact modulo the loop."""
    return 2 * np.pi * ((n * i) % N) / N


def rot(v, a):
    c, s = np.cos(a), np.sin(a)
    return np.array([c * v[0] - s * v[1], s * v[0] + c * v[1]])


# ground plane under the hill and the sea-surface footprint of one pixel (m)
GZ = F * EYE_OVER_CAPE / np.maximum(YY - HY, 1.0)
GX = (XX - W / 2) * GZ / F
FOOT_X = SEA_Z / F
FOOT_Z = SEA_Z**2 / (F * CAM_H)


def band_limit(k, sigma=0.7):
    """Response of a plane wave averaged over a Gaussian pixel footprint on the water."""
    return np.exp(-0.5 * sigma**2 * ((k[0] * FOOT_X) ** 2 + (k[1] * FOOT_Z) ** 2))


def k_deep(om):
    return om * om / G


def k_finite(om, h):
    """Solve ω² = g k tanh(k h) by Newton iteration."""
    k = om * om / G / np.sqrt(np.tanh(om * om * h / G))
    for _ in range(40):
        th = np.tanh(k * h)
        k -= (G * k * th - om * om) / (G * th + G * k * h * (1 - th * th))
    return k


class Advected:
    """Frozen gust pattern carried by the mean wind: plane waves with k·U = 2πn/T."""

    def __init__(self, speed, harmonics, spread, slope, seed, osc=None, atten=False):
        rng = np.random.default_rng(seed)
        self.comps = []
        for n in harmonics:
            th = np.radians(rng.uniform(-spread, spread))
            k = 2 * np.pi * n / (T * speed * np.cos(th)) * rot(WIND, th)
            amp, ph = n**-slope, rng.uniform(0, 2 * np.pi)
            if osc:  # steady-state response of a damped oscillator
                f0, zeta = osc
                r = n / T / f0
                resp = 1 / complex(1 - r * r, 2 * zeta * r)
                amp, ph = amp * abs(resp), ph + np.angle(resp)
            self.comps.append((k, n, amp, ph, band_limit(k) if atten else None))
        self.norm = np.sqrt(0.5 * sum(c[2] ** 2 for c in self.comps))  # → unit variance

    def __call__(self, X, Z, i):
        out = 0.0
        for k, n, amp, ph, att in self.comps:
            term = amp * np.cos(k[0] * X + k[1] * Z - tphase(n, i) + ph)
            out = out + (term if att is None else term * att)
        return out / self.norm


class Waves:
    """Linear gravity waves → reflection brightness ∝ −∂η/∂z, band-limited per pixel."""

    def __init__(self, harmonics, direction, spread, steep, seed, depth=None):
        rng = np.random.default_rng(seed)
        self.comps = []
        for n in harmonics:
            om = 2 * np.pi * n / T
            kk = k_deep(om) if depth is None else k_finite(om, depth)
            d = rot(direction, np.radians(rng.uniform(-spread, spread)))
            ph = rng.uniform(0, 2 * np.pi)
            # η = a cos ψ, ψ = k·x − ωt  →  −∂η/∂z = a k_z sin ψ = (ak)·d_z·sin ψ
            self.comps.append((kk * d, n, steep * d[1], ph, band_limit(kk * d)))

    def __call__(self, i):
        out = 0.0
        for k, n, s, ph, att in self.comps:
            out = out + s * np.sin(k[0] * SEA_X + k[1] * SEA_Z - tphase(n, i) + ph) * att
        return out


# ---------------------------------------------------------------- sky
class Cloud:
    def __init__(self, puffs, base, seed, dist=None):
        self.p = np.array(puffs, float)
        self.base, self.seed = base, seed
        dist = dist or CLOUD_BASE * F / (HY - base)
        # sideways drift, plus sinking toward the horizon as it recedes (px/s)
        self.v = np.array([F * U_CLOUD * WIND[0] / dist, (HY - base) * U_CLOUD * WIND[1] / dist])
        r = self.p[:, 2].max()
        pad = int(np.ceil(np.abs(self.v).max() * T)) + 12
        self.box = (
            max(int(self.p[:, 1].min() - r) - pad, 0),
            min(base + pad + 4, HY + 1),
            max(int(self.p[:, 0].min() - r) - pad, 0),
            min(int(self.p[:, 0].max() + r) + pad, W),
        )
        y0, y1, x0, x1 = self.box
        self.X, self.Y = XX[y0:y1, x0:x1], YY[y0:y1, x0:x1]
        self.sky = SKY[y0:y1, x0:x1]
        self.top = min(cy - rr for _, cy, rr in puffs)
        # the blended base edge is fractional between the seam copies; a fixed per-column cut
        # in [0, 1) lets each column step to the new row at its own moment, not all at once
        self.cut = np.random.default_rng(seed + 7).random(self.X.shape[1])[None, :]

    def field(self, d):
        dx, dy = d
        nz = fbm((self.X - dx) / 5.0, (self.Y - dy) / 5.0, self.seed, 3) - 0.5
        hgt = np.zeros(self.X.shape)
        for cx, cy, r in self.p:
            d2 = (
                ((self.X + 0.5 - cx - dx) / r) ** 2
                + ((self.Y + 0.5 - cy - dy) / r) ** 2
                + 0.3 * nz * 2
            )
            hgt = np.maximum(hgt, np.sqrt(np.clip(1 - d2, 0, None)) * r)
        edge = np.round((vnoise((self.X - dx) / 7.0, 0 * self.X, self.seed + 3) - 0.5) * 2)
        return hgt, self.base + dy + edge

    def draw(self, img, i):
        t, w = i / FPS, i / N
        ha, ba = self.field(self.v * t)
        hb, bb = self.field(self.v * (t - T))
        # the two copies' sinking cancels in the blend, so the flat base sits exactly on a
        # pixel row; round off float noise or that row blinks on and off frame to frame
        hgt, bottom = (1 - w) * ha + w * hb, np.round((1 - w) * ba + w * bb, 6)
        base = self.base + (1 - w) * self.v[1] * t + w * self.v[1] * (t - T)
        # trim the thin fringe where only one of the two blended copies reaches. The bar grows
        # like sqrt(w) so a lone copy (hgt = w*h) clears it only once w > (2/h)^2: the second
        # copy fades in pixel by pixel instead of snapping in whole on the frame after the seam
        m = (
            (hgt > 2.0 * np.sqrt(min(w, 1 - w)))
            & (self.Y <= np.floor(bottom + self.cut))
            & self.sky
        )
        lit = lambert(blur(hgt, 2))
        vert = np.clip((base - self.Y) / max(base - self.top, 1), 0, 1)
        shade = 0.12 + 0.72 * lit + 0.28 * vert
        shade -= 0.45 * np.clip((self.Y - (base - 7)) / 7, 0, 1)
        y0, y1, x0, x1 = self.box
        sub = img[y0:y1, x0:x1]
        sub[m] = quant(1.5 + shade * 5.0, PAL["white"])[m]


class Sky:
    def __init__(self):
        self.v = hp.sky_value()
        self.base = np.zeros((H, W, 3), np.uint8)
        paint(self.base, SKY, self.v, PAL["sky"], dither=True)
        self.v_cirrus = F * U_CIRRUS * WIND[0] / (CIRRUS_H * F / (HY - 40))
        self.clouds = [Cloud(p, b, s) for p, b, s in hp.CLOUDS]
        self.bank = hp.horizon_bank_profile()
        self.v_bank = F * U_CLOUD * WIND[0] / BANK_DIST

    def draw(self, img, i):
        t, w = i / FPS, i / N
        img[:] = self.base
        wisp = np.zeros((H, W))
        X, Y = XX[:76], YY[:76]
        wisp[:76] = (1 - w) * fbm((X - self.v_cirrus * t) / 80.0, Y / 6.0, 31, 3) + w * fbm(
            (X - self.v_cirrus * (t - T)) / 80.0, Y / 6.0, 31, 3
        )
        hp.paint_wisps(img, self.v, wisp)
        for c in self.clouds:
            c.draw(img, i)
        xs = np.arange(W, dtype=float)
        a = np.interp(xs - self.v_bank * t, xs, self.bank, left=0, right=0)
        b = np.interp(xs - self.v_bank * (t - T), xs, self.bank, left=0, right=0)
        hp.paint_horizon_bank(img, (1 - w) * a + w * b)


# ---------------------------------------------------------------- sea
class Whitecaps:
    """Breaking events on wind waves: ride the crest at phase speed, then foam decays."""

    def __init__(self, count=700, seed=45):
        rng = np.random.default_rng(seed)
        zn, zf = 650.0, 3500.0
        self.z0 = np.sqrt(rng.uniform(zn**2, zf**2, count))  # uniform per unit area
        self.x0 = rng.uniform(-1.15, 1.15, count) * self.z0 * (W / 2) / F
        self.size = np.exp(rng.normal(np.log(5.0), 0.5, count))
        self.life = rng.uniform(1.2, 3.0, count)
        self.birth = rng.integers(0, N, count)
        self.c = G * 3.0 / (2 * np.pi)  # phase speed of the 3 s wind sea

    def draw(self, img, i):
        age = ((i - self.birth) % N) / FPS
        ride = np.minimum(age, 0.8)
        along = self.c * ride + 0.15 * age  # crest speed while breaking, then wind drift
        X, Z = self.x0 + WIND[0] * along, self.z0 + WIND[1] * along
        y, x = HY + F * CAM_H / Z, W / 2 + X * F / Z
        wpx = self.size * (1 + 0.4 * np.minimum(age, 1.5)) * F / Z
        inten = (
            np.minimum(1, age / 0.12)
            * np.exp(-np.maximum(age - 0.8, 0) / self.life)
            * np.clip((wpx - 0.35) / 1.0, 0, 1) ** 1.5  # sub-pixel caps blur away
            * np.clip((y - HY - 6) / 14, 0, 1)
        )  # and vanish in the haze
        wr, dp = PAL["white"], PAL["deep"]
        for j in np.argsort(inten):
            if inten[j] < 0.06:
                continue
            row = round(y[j])
            half = max(wpx[j], 1.0) / 2
            xs = np.arange(round(x[j] - half), round(x[j] + half) + 1)
            xs = xs[(xs >= 0) & (xs < W)]
            if row >= H or not len(xs):
                continue
            xs = xs[DEEP[row, xs] & (surf_y[xs] - row > 1.5)]
            c = (
                wr[6]
                if inten[j] > 0.55
                else wr[5]
                if inten[j] > 0.3
                else wr[4]
                if inten[j] > 0.14
                else dp[7]
            )
            img[row, xs] = c


class Surf:
    """Swell breaking on the reef edge and against the island, timed by the swell phase."""

    def __init__(self, swell):
        self.k, self.n, _, self.ph, _ = swell.comps[0]
        self.om = 2 * np.pi * self.n / T
        cols = np.arange(W)
        zr = F * CAM_H / (surf_y - HY)
        self.kx_reef = self.k[0] * (cols - W / 2) * zr / F + self.k[1] * zr
        zi = F * CAM_H / (ISLAND["base"] + 1 - HY)
        self.kx_isle = self.k[0] * (cols - W / 2) * zi / F + self.k[1] * zi
        self.reef = 0.75 + 0.25 * noise1(cols / 23.0, 74)  # reef-crest depth varies
        self.brk = vnoise(XX / 4.0, np.zeros_like(XX, float), 71)
        self.brk2 = vnoise(XX / 1.7, np.zeros_like(XX, float), 72)
        self.s = YY - surf_y[None, :]
        self.y0, self.y1 = int(surf_y.min()) - 5, int(np.ceil(surf_y.max())) + 8

    def timing(self, kx, i):
        """Time since the last crest reached each column, and that wave's set amplitude."""
        cyc, frac = divmod(self.n * i, N)
        u = 2 * np.pi * frac / N - kx - self.ph  # ωt − k·x − φ, wrapped exactly
        tau = np.mod(u, 2 * np.pi) / self.om
        m = (cyc + np.floor(u / (2 * np.pi)).astype(int)) % 3
        return tau, SET_AMP[m], m

    def face(self, i):
        """Steepening face of the incoming crest just seaward of the reef (darker)."""
        tau, amp, _ = self.timing(self.kx_reef, i)
        period = T / self.n
        f = np.clip((tau - (period - 1.1)) / 1.1, 0, 1) * amp
        return -1.6 * f[None, :] * ((self.s >= -3.5) & (self.s < -1))

    def draw(self, img, i):
        wr = PAL["white"]
        tau, amp, m = self.timing(self.kx_reef, i)
        inten = (amp * self.reef * (0.5 + 0.5 * np.exp(-tau / 2.5)))[None, :]
        s = self.s
        img[SEA & (s >= -1) & (s < 0.2) & (self.brk > 1 - 1.2 * inten)] = wr[6]
        img[SEA & (s >= 0.2) & (s < 1.4) & (self.brk > 1.1 - 1.0 * inten)] = wr[5]
        # spray torn off the lip and blown seaward by the offshore wind
        sp = np.clip(tau / 0.7, 0, 1)[None, :]
        spray = (
            SEA
            & (tau[None, :] < 0.7)
            & (s >= -1 - 3.5 * sp)
            & (s < -1)
            & (self.brk2 > 0.5 + 0.45 * sp)
        )
        img[spray] = wr[5]
        # lingering foam carried shoreward by the bore
        y0, y1 = self.y0, self.y1
        zb = SEA_Z[y0:y1] + BORE_SPEED * tau[None, :]
        trail = np.zeros((y1 - y0, W))
        for j in range(3):
            f = fbm(SEA_X[y0:y1] / 3.0, zb / 5.0, 73 + 7 * j, 2)
            trail = np.where(m[None, :] == j, f, trail)
        ires = (amp * self.reef * np.exp(-tau / 5.0))[None, :]
        sb = s[y0:y1]
        band = (
            LAGOON[y0:y1]
            & (sb >= 1.4)
            & (sb < 6)
            & (trail > 0.58 + 0.035 * sb - 0.15 * (ires - 0.3))
        )
        img[y0:y1][band] = PAL["lagoon"][7]

    def draw_island(self, img, i):
        """Swell breaking at the island's foot, drawn after the island itself."""
        wr = PAL["white"]
        tau_i, amp_i, _ = self.timing(self.kx_isle, i)
        base = ISLAND["base"] + 1
        for x in range(ISLAND["x0"] - 3, ISLAND["x1"] + 5):
            n = noise1(np.array([x / 2.0]), 23)[0]
            ii = amp_i[x] * (0.3 + 0.7 * np.exp(-tau_i[x] / 2.0))
            if n > 1 - 0.9 * ii:
                hp.put(img, x, base, wr[6] if n > 1 - 0.5 * ii else wr[5])
            if x < ISLAND["x0"] + 6 and tau_i[x] < 1.0 and n > 0.4:  # splash up the west face
                for dy in range(1, int(3.5 * (1 - tau_i[x]) * amp_i[x]) + 1):
                    hp.put(img, x - 2, base - dy, wr[5])


class Sea:
    def __init__(self):
        self.deep_v, self.fade, self.to_reef = hp.deep_base()
        self.lag_v, self.coral, self.coral_v, self.sand = hp.lagoon_fields()
        self.rough = Advected(U_SEA, [1, 2, 2, 3, 4, 5, 6, 8], 40, 0.6, 41, atten=True)
        self.swell = Waves([SWELL_N], SWELL_DIR, 0, 0.035, 42)
        self.chop = Waves([8, 10, 12, 16, 20], WIND, 35, 0.08, 43)
        self.chop_lagoon = Waves([10, 12, 14, 16, 20, 24], WIND, 35, 0.08, 44, depth=LAGOON_DEPTH)
        self.surf = Surf(self.swell)
        self.caps = Whitecaps()
        self.wet = (
            SEA
            & (hp.land_y[None, :] - YY < 2.5 + 2.0 * vnoise(XX / 3.0, 0 * XX, 75))
            & (YY > 200)
            & (XX < 182)
        )
        self.wet_hi = self.wet & (vnoise(XX / 1.5, YY / 1.5, 76) > 0.6)
        self.lick = (
            SEA & ~self.wet & np.roll(self.wet, 1, 0) & (vnoise(XX / 2.0, 0 * XX, 77) > 0.35)
        )

    def draw(self, img, i):
        rough = self.rough(SEA_X, SEA_Z, i)
        # gust-roughened water scatters the bright horizon sky away → darker cat's paws
        tex = -0.5 * rough + SWELL_REFLECT * self.swell(i) + REFLECT * self.chop(i)
        paint(
            img, DEEP, self.deep_v + self.fade * tex + self.surf.face(i), PAL["deep"], dither=True
        )
        shim = REFLECT * self.chop_lagoon(i) - 0.25 * rough
        paint(img, LAGOON, self.lag_v + shim, PAL["lagoon"])
        paint(img, self.coral, self.coral_v + 0.6 * shim, PAL["coral"])
        paint(img, self.sand, 7 + shim, PAL["lagoon"])
        despeckle(img, SEA)
        self.caps.draw(img, i)
        self.surf.draw(img, i)
        img[self.wet] = PAL["rock"][1]
        img[self.wet_hi] = PAL["rock"][2]
        # small lagoon waves lapping the west shore
        lap = np.cos(0.9 * XX / 7.0 - tphase(10, i)) > -0.3
        img[self.lick & lap] = PAL["white"][5]


# ---------------------------------------------------------------- grass
TUFT_ZONES = (
    (2600, 7, LAND & ~hp.PATH & (hp.PATH_EDGE > 1.5) & ~((np.abs(XX - hp.LX) < 45) & (YY < 240))),
    (900, 8, LAND & (np.abs(hp.PATH_EDGE) < 3.5) & (YY > 245)),
)


class Blades:
    """Grass blades replayed from the still's random draws, re-bent every frame."""

    def __init__(self):
        px, bx, lean, lb, kk, tip, tid = [], [], [], [], [], [], []
        roots = []
        for n, seed, region in TUFT_ZONES:  # same draws as hp.draw_tufts
            rng = np.random.default_rng(seed)
            ys, xs = np.nonzero(region)
            for j in rng.choice(len(xs), n):
                x, y = int(xs[j]), int(ys[j])
                near = DEPTH[y, x]
                length = 1.5 + near * 8 * rng.uniform(0.6, 1.2)
                t = len(roots)
                roots.append((x, y))
                for _ in range(rng.integers(2, 5)):
                    b = x + rng.integers(-2, 3) * (0.5 + near)
                    le = rng.uniform(0.25, 0.75)
                    n_px = max(1, int(length * rng.uniform(0.55, 1.0)))
                    for k in range(n_px):
                        bx.append(b), lean.append(le), lb.append(n_px), kk.append(k)
                        tip.append(k == n_px - 1), tid.append(t)
                px.append(len(bx))  # the dark root pixel follows the tuft
        self.roots = np.array(roots)
        self.bx, self.lean, self.lb = np.array(bx), np.array(lean), np.array(lb, float)
        self.kk, self.tip, self.tid = np.array(kk, float), np.array(tip), np.array(tid)
        # interleave blade pixels and root pixels in the still's drawing order
        order_blade = np.arange(len(bx)) + np.searchsorted(
            np.array(px), np.arange(len(bx)), "right"
        )
        order_root = np.array(px) + np.arange(len(px))
        self.order = np.argsort(np.concatenate([order_blade, order_root]), kind="stable")

        # foreground blades (hp.layer_foreground)
        rng = np.random.default_rng(77)
        fx, fy, fl, fk, fc, fn = [], [], [], [], [], []
        for _ in range(460):
            x = int(rng.integers(-10, W + 10))
            if 300 < x < 380 and rng.random() < 0.85:
                continue
            y = int(H - 1 + rng.integers(0, 6))
            ln = int(rng.integers(8, 26))
            le = rng.uniform(0.3, 0.9)
            c = int(rng.integers(1, 4))
            for k in range(ln):
                fx.append(x), fy.append(y), fl.append(le), fk.append(k), fc.append(c), fn.append(ln)
        self.fx, self.fy, self.fl = np.array(fx), np.array(fy), np.array(fl)
        self.fk, self.fc, self.fn = np.array(fk, float), np.array(fc), np.array(fn, float)
        rx, ry = self.roots[:, 0], self.roots[:, 1]
        self.root_gx, self.root_gz = GX[ry, rx], GZ[ry, rx]
        cx = np.clip(self.fx, 0, W - 1)
        self.fg_gx, self.fg_gz = GX[H - 1, cx], GZ[H - 1, cx]

    @staticmethod
    def plot(img, xs, ys, cols):
        ok = (xs >= 0) & (xs < W) & (ys >= 0) & (ys < H)
        xs, ys, cols = xs[ok], ys[ok], cols[ok]
        lin = (ys * W + xs)[::-1]  # keep the last write per pixel
        _, first = np.unique(lin, return_index=True)
        keep = len(lin) - 1 - first
        img[ys[keep], xs[keep]] = cols[keep]

    def draw_tufts(self, img, gv, gust, flutter):
        gr = PAL["grass"]
        rx, ry = self.roots[:, 0], self.roots[:, 1]
        base = np.clip(np.round(gv[ry, rx]), 1, 6).astype(int)
        bend = np.clip(1 + 0.45 * gust + 0.25 * flutter, 0.05, 2.2)[self.tid]
        bx = np.round(self.bx + self.lean * bend * self.kk * self.kk / self.lb).astype(int)
        by = ry[self.tid] - self.kk.astype(int)
        bc = gr[np.minimum(base[self.tid] + 1 + self.tip, 8)]
        xs = np.concatenate([bx, rx])[self.order]
        ys = np.concatenate([by, ry + 1])[self.order]
        cols = np.concatenate([bc, gr[np.maximum(base - 2, 0)]])[self.order]
        self.plot(img, xs, ys, cols)

    def draw_foreground(self, img, gust, flutter):
        gr = PAL["grass"]
        bend = np.clip(1 + 0.5 * gust + 0.3 * flutter, 0.05, 2.2)
        px = np.round(self.fx + self.fl * bend * self.fk * self.fk / self.fn).astype(int)
        py = self.fy - self.fk.astype(int)
        top = gr[self.fc + 2 * (self.fk > self.fn - 3)]
        side = gr[np.maximum(self.fc - 1, 0)]
        xs = np.stack([px, px + 1], 1).ravel()
        ys = np.stack([py, py], 1).ravel()
        cols = np.stack([top, side], 1).reshape(-1, 3)
        self.plot(img, xs, ys, cols)


class Grass:
    def __init__(self, grass_v):
        self.gv0 = grass_v
        self.straw, self.straw_v = hp.straw_fields()
        self.gust = Advected(U_GRASS, [2, 3, 4, 5, 6, 8, 10, 13], 30, 0.7, 51, osc=(1.3, 0.3))
        self.flutter = Advected(U_GRASS, [29, 31, 34, 37], 50, 0.0, 52, osc=(1.3, 0.3))
        self.blades = Blades()

    def paint(self, img, i):
        d = self.gust(GX, GZ, i)
        gv = self.gv0 + SHEEN * d
        paint(img, LAND, gv, PAL["grass"])
        paint(img, self.straw, self.straw_v + SHEEN * d, PAL["straw"])
        despeckle(img, LAND)
        return gv

    def tufts(self, img, i, gv):
        b = self.blades
        self.blades.draw_tufts(
            img, gv, self.gust(b.root_gx, b.root_gz, i), self.flutter(b.root_gx, b.root_gz, i)
        )

    def foreground(self, img, i):
        b = self.blades
        b.draw_foreground(img, self.gust(b.fg_gx, b.fg_gz, i), self.flutter(b.fg_gx, b.fg_gz, i))


# ---------------------------------------------------------------- layer stack
class Physics:
    def __init__(self, st):
        self.st = st
        self.sky, self.sea, self.grass = Sky(), Sea(), Grass(st["grass_v"])

    def background(self, img, i):
        self.sky.draw(img, i)
        self.sea.draw(img, i)
        img[ISLE] = self.st["isle"]
        self.sea.surf.draw_island(img, i)

    def land(self, img, i):
        return self.grass.paint(img, i)

    def tufts(self, img, i, gv):
        self.grass.tufts(img, i, gv)

    def foreground(self, img, i):
        self.grass.foreground(img, i)


class StillDyn:
    """The still's own layer functions: frame 0 must reproduce hirakubo_640x360.png exactly."""

    def background(self, img, i):
        hp.layer_sky(img), hp.layer_clouds(img), hp.layer_sea(img), hp.layer_island(img)

    def land(self, img, i):
        hp.layer_land(img)
        return hp.GRASS_V

    def tufts(self, img, i, gv):
        for n, seed, region in TUFT_ZONES:
            hp.draw_tufts(img, n, seed, region)

    def foreground(self, img, i):
        hp.layer_foreground(img)


def post_shadow_pixels():
    x1, side = POST["x1"], POST["side"]
    pts = [(x1 + side + i, H - 1 - i // 2 - w) for i in range(1, 44) for w in range(6)]
    pts = [(x, y) for x, y in pts if 0 <= x < W and 0 <= y < H and LAND[y, x]]
    return np.array([p[0] for p in pts]), np.array([p[1] for p in pts])


def darken_grass(img, xs, ys, steps=2):
    gr = PAL["grass"].astype(int)
    c = img[ys, xs].astype(int)
    idx = np.abs(c[:, None, :] - gr[None, :, :]).sum(-1).argmin(1)
    img[ys, xs] = PAL["grass"][np.maximum(idx - steps, 0)]


def capture():
    """Run the still once and keep every static layer as (mask, colours) in drawing order."""
    img = np.zeros((H, W, 3), np.uint8)
    hp.layer_sky(img), hp.layer_clouds(img), hp.layer_sea(img), hp.layer_island(img)
    st = {"isle": img[ISLE].copy()}
    hp.layer_land(img)
    st["grass_v"] = hp.GRASS_V.copy()

    def cover(fn):
        probe = np.empty_like(img)
        probe[:] = SENTINEL
        fn(probe)
        before = img.copy()
        fn(img)
        m = np.any(probe != SENTINEL, -1) | np.any(img != before, -1)
        return m, img[m].copy()

    blobs, orig = [], hp.draw_blob

    def record(im, puffs, seed, **kw):
        m = orig(im, puffs, seed, **kw)
        sh = LAND & ~m & (np.roll(np.roll(m, 2, 0), 1, 1) | np.roll(m, 1, 0))
        blobs.append((sh if kw.get("shadow", True) else np.zeros_like(m), m))
        return m

    hp.draw_blob = record
    try:
        hp.layer_far_bushes(img)
        st["far"] = [(sh, m, img[m].copy()) for sh, m in blobs]
        blobs.clear()
        st["path"] = cover(hp.layer_path)
        StillDyn().tufts(img, 0, None)
        st["lighthouse"] = cover(hp.layer_lighthouse)
        st["fence"] = cover(hp.layer_fence)
        hp.layer_near(img)
        hp.layer_rocks(img)
        st["blobs"] = [(sh, m, img[m].copy()) for sh, m in blobs]
    finally:
        hp.draw_blob = orig
    st["post_shadow"] = post_shadow_pixels()
    sx, sy = st["post_shadow"]
    shadow = np.zeros((H, W), bool)
    shadow[sy, sx] = True
    m, _ = cover(hp.layer_post)
    m &= ~shadow
    st["post"] = (m, img[m].copy())
    return st


def compose(i, dyn, st):
    img = np.zeros((H, W, 3), np.uint8)
    dyn.background(img, i)
    gv = dyn.land(img, i)
    shade = quant(gv - 2.4, PAL["grass"])  # contact shadows follow the moving grass
    for sh, m, col in st["far"]:
        img[sh] = shade[sh]
        img[m] = col
    for key in ("path",):
        m, col = st[key]
        img[m] = col
    dyn.tufts(img, i, gv)
    for key in ("lighthouse", "fence"):
        m, col = st[key]
        img[m] = col
    for sh, m, col in st["blobs"]:
        img[sh] = shade[sh]
        img[m] = col
    darken_grass(img, *st["post_shadow"])
    m, col = st["post"]
    img[m] = col
    dyn.foreground(img, i)
    return img


# ---------------------------------------------------------------- runs
_W = {}


def _init(st):
    _W["st"], _W["dyn"] = st, Physics(st)


def _render(job):
    i, outdir = job
    Image.fromarray(compose(i, _W["dyn"], _W["st"])).save(Path(outdir) / f"f{i:04d}.png")
    return i


def gate():
    st = capture()
    still = np.asarray(Image.open(OUT / "hirakubo_640x360.png").convert("RGB"))
    frame = compose(0, StillDyn(), st)
    bad = np.any(frame != still, -1).sum()
    print(f"gate: {bad} pixels differ from the still")
    return bad == 0


def up(img, z):
    return np.repeat(np.repeat(img, z, 0), z, 1)


def preview(outdir):
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    st = capture()
    dyn = Physics(st)
    t0 = time.time()
    frames = {i: compose(i, dyn, st) for i in (0, N // 4, N // 2, 3 * N // 4, N - 1, N)}
    print(f"{(time.time() - t0) / len(frames):.2f} s/frame")
    print("frame N == frame 0:", np.array_equal(frames[N], frames[0]))
    for i, f in frames.items():
        Image.fromarray(up(f, 2)).save(outdir / f"key_{i:04d}.png")
    sheet = np.concatenate(
        [
            np.concatenate([frames[0], frames[N // 4]], 1),
            np.concatenate([frames[N // 2], frames[3 * N // 4]], 1),
        ],
        0,
    )
    Image.fromarray(sheet).save(outdir / "contact.png")


def render(outdir, jobs=10):
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    st = capture()
    t0 = time.time()
    with Pool(jobs, initializer=_init, initargs=(st,)) as pool:
        for k, _ in enumerate(
            pool.imap_unordered(_render, [(i, str(outdir)) for i in range(N)], 8)
        ):
            if k % 240 == 0:
                print(f"  {k}/{N} frames  {time.time() - t0:.0f}s", flush=True)
    print(f"rendered {N} frames in {time.time() - t0:.0f}s")
    for scale, name in ((3, "hirakubo_loop_1080p60.mp4"), (6, "hirakubo_loop_4k60.mp4")):
        encode(outdir, OUT / name, scale)


# H.264 level per output, with refs and VBV inside that level's DPB and bitrate limits, so
# hardware decoders that check the level (1080p60 needs 4.2, 2160p60 needs 5.2) accept it
LEVELS = {3: ("4.2", "4", "40M", "60M"), 6: ("5.2", "5", "80M", "120M")}


def encode(frames, out, scale):
    level, refs, maxrate, bufsize = LEVELS[scale]
    vf = (
        f"scale={W * scale}:{H * scale}:flags=neighbor,"
        "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,"
        "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv"
    )
    cmd = [
        "ffmpeg",
        "-v",
        "error",
        "-y",
        "-framerate",
        str(FPS),
        "-i",
        f"{frames}/f%04d.png",
        "-frames:v",
        str(N),
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-tune",
        "animation",
        # CRF 10, not 14: halves the coding-noise jump at each IDR, including the loop seam
        "-crf",
        "10",
        "-profile:v",
        "high",
        "-level:v",
        level,
        "-refs",
        refs,
        "-maxrate",
        maxrate,
        "-bufsize",
        bufsize,
        "-g",
        str(2 * FPS),
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        "-movflags",
        "+faststart",
        "-an",
        str(out),
    ]
    subprocess.run(cmd, check=True)
    print("wrote", out)


def check(frames):
    frames = Path(frames)

    def load(i):
        return np.asarray(Image.open(frames / f"f{i % N:04d}.png").convert("RGB")).astype(np.int16)

    def changed(a, b):
        return np.any(a != b, -1)

    regions = {"sky": SKY, "deep sea": DEEP, "lagoon": LAGOON & ~hp.ISLE, "land": LAND}
    # the seam must look like any other step in every region, not just on average: a pop
    # in the sky is invisible in a whole-frame figure dominated by swaying grass
    steps = [changed(load(i), load(i + 1)) for i in range(1, N - 1, 97)]
    wrap = changed(load(N - 1), load(0))
    head = changed(load(0), load(1))
    for name, m in regions.items():
        typ = [s[m].mean() for s in steps]
        print(
            f"  {name:9s} changed per step: typical {np.mean(typ):.4f} (max {np.max(typ):.4f})   "
            f"seam N-1→0 {wrap[m].mean():.4f}   0→1 {head[m].mean():.4f}"
        )
    # flicker map over 4 s: colour changes per second at every pixel, and one-frame
    # blips (A→B→A), which no physical motion in the scene is fast enough to produce
    toggles = np.zeros((H, W))
    blips = np.zeros((H, W))
    a, b = load(0), load(1)
    toggles += changed(a, b)
    for i in range(2, 4 * FPS + 1):
        c = load(i)
        toggles += changed(b, c)
        blips += changed(a, b) & ~changed(a, c)
        a, b = b, c
    rate = toggles / 4.0
    for name, m in regions.items():
        r = rate[m]
        share = blips[m].sum() / max(toggles[m].sum(), 1)
        print(
            f"  {name:9s} mean {r.mean():5.2f}/s   p99 {np.percentile(r, 99):5.2f}/s   "
            f">10/s {100 * (r > 10).mean():5.2f}%   blips {blips[m].mean() / 4:5.2f}/s "
            f"({100 * share:4.1f}% of changes)"
        )
    heat = np.clip(rate / 15.0, 0, 1)
    rgb = (np.stack([heat, heat**2, 0.2 + 0 * heat], -1) * 255).astype(np.uint8)
    Image.fromarray(up(rgb, 2)).save(frames.parent / "flicker_map.png")


if __name__ == "__main__":
    if "--gate" in sys.argv:
        sys.exit(0 if gate() else 1)
    if "--preview" in sys.argv:
        preview(sys.argv[sys.argv.index("--preview") + 1])
    if "--render" in sys.argv:
        render(sys.argv[sys.argv.index("--render") + 1])
    if "--check" in sys.argv:
        check(sys.argv[sys.argv.index("--check") + 1])
