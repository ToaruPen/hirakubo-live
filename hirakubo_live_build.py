"""Build the real-time web wallpaper of the Hirakubo-zaki pixel art.

The browser runs the same physics as hirakubo_loop.py with nothing tied to a loop length:
wave and gust components take continuous frequencies, whitecaps are a Poisson process,
the swell arrives in wave groups, and clouds drift through 3-D space, recede toward the
horizon and form and dissipate. Everything random or hand-placed in the still (blades,
cloud puffs, reef noise, static layers) is exported from Python so the page draws the
same scene; the page never re-implements numpy's generator.

The page carries two input sets for one engine: "loop" (the exact components of
hirakubo_loop.py, used to check the port against its frames) and "live".

    python hirakubo_live_build.py            # verify the layer split, then write both pages
"""

import base64
import io
import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

import hirakubo_loop as hl
import hirakubo_pixel as hp
from hirakubo_pixel import (
    DEEP,
    F,
    HY,
    ISLAND,
    ISLE,
    LAGOON,
    LAND,
    PAL,
    POST,
    SKY,
    H,
    W,
    fbm,
    noise1,
    surf_y,
    land_y,
    vnoise,
)

ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT / "hirakubo_live.template.html"
ENV_JS = ROOT / "hirakubo_env.js"  # sun, moon, sky light and weather; inlined into the page
LIVE_JS = ROOT / "hirakubo_live.js"  # the engine; inlined into the page
OUT_FRAGMENT = ROOT / "hirakubo_live.html"  # Artifact page (the host adds <head>)
OUT_WE = ROOT / "hirakubo_live" / "index.html"  # full document for Wallpaper Engine
FIX = 2**18  # 24-bit fixed point for value fields
FIX_OFF = 16.0


# ---------------------------------------------------------------- encoding
def b64(a, dtype):
    return base64.b64encode(np.ascontiguousarray(a, dtype=dtype).tobytes()).decode()


def arr(a, dtype):
    a = np.asarray(a)
    return {
        "dtype": np.dtype(dtype).name,
        "shape": list(a.shape),
        "b64": b64(a, dtype),
        "sum": float(np.asarray(a, dtype=dtype).astype(np.float64).sum()),
    }


def png(rgb):
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(rgb, np.uint8), "RGB").save(
        buf, "PNG", optimize=True
    )
    return {
        "uri": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(),
        "sum": int(np.asarray(rgb, np.int64).sum()),
    }


def fixed(v):
    q = np.clip(np.round((v + FIX_OFF) * FIX), 0, 2**24 - 1).astype(np.int64)
    return np.stack([q >> 16, (q >> 8) & 255, q & 255], -1).astype(np.uint8)


# ---------------------------------------------------------------- static layers
def static_split(st):
    """The still's fixed overlays, replayed in drawing order and flattened per pixel.

    Two groups sandwich the grass tufts. Each pixel of a group ends as untouched (0),
    contact shadow on the moving grass (1) or a fixed colour (2)."""
    t1, c1 = np.zeros((H, W), np.uint8), np.zeros((H, W, 3), np.uint8)
    for sh, m, col in st["far"]:
        t1[sh] = 1
        t1[m], c1[m] = 2, col
    m, col = st["path"]
    t1[m], c1[m] = 2, col
    t2, c2 = np.zeros((H, W), np.uint8), np.zeros((H, W, 3), np.uint8)
    for key in ("lighthouse", "fence"):
        m, col = st[key]
        t2[m], c2[m] = 2, col
    for sh, m, col in st["blobs"]:
        t2[sh] = 1
        t2[m], c2[m] = 2, col
    pshadow = np.zeros((H, W), bool)
    sx, sy = st["post_shadow"]
    pshadow[sy, sx] = True
    pm, pcol = st["post"]
    post = np.zeros((H, W, 3), np.uint8)
    post[pm] = pcol
    isle = np.zeros((H, W, 3), np.uint8)
    isle[ISLE] = st["isle"]
    # for the weather only: the stone path; the built things (tower, hut, apron, fence), but not
    # the posts' shadows, which the fence paints on the grass; and the boulders, where the still
    # shows them in stone (not under a neighbour's shadow, which is the moving grass's)
    path = st["path"][0]
    fm, fcol = st["fence"]
    fence = fm.copy()
    fence[fm] = np.any(fcol != PAL["grass"][1], -1)
    built = st["lighthouse"][0] | fence
    blobs = np.zeros((H, W), bool)
    for sh, m, col in st["blobs"]:
        blobs |= m
    rock = blobs & (t2 == 2) & np.all(c2[..., None, :] == np.array(PAL["stone"]), -1).any(-1)
    return dict(
        t1=t1, c1=c1, t2=t2, c2=c2, pshadow=pshadow, pmask=pm, post=post, isle=isle,
        path=path, built=built, rock=rock,
    )


def compose_split(i, dyn, st, L):
    """hl.compose rebuilt from the flattened layers: must match it pixel for pixel."""
    img = np.zeros((H, W, 3), np.uint8)
    dyn.background(img, i)
    gv = dyn.land(img, i)
    shade = hp.quant(gv - 2.4, PAL["grass"])
    img[L["t1"] == 1] = shade[L["t1"] == 1]
    img[L["t1"] == 2] = L["c1"][L["t1"] == 2]
    dyn.tufts(img, i, gv)
    img[L["t2"] == 1] = shade[L["t2"] == 1]
    img[L["t2"] == 2] = L["c2"][L["t2"] == 2]
    hl.darken_grass(img, *st["post_shadow"])
    img[L["pmask"]] = L["post"][L["pmask"]]
    dyn.foreground(img, i)
    return img


# ---------------------------------------------------------------- components
def adv_rows(a):
    """hl.Advected → rows (kx, kz, A, phase, n, atten, sin); A has the variance norm folded in."""
    return [
        [k[0], k[1], amp / a.norm, ph, float(n), float(att is not None), 0.0]
        for k, n, amp, ph, att in a.comps
    ]


def wave_rows(wv):
    return [[k[0], k[1], s, ph, float(n), 1.0, 1.0] for k, n, s, ph, att in wv.comps]


def live_advected(
    speed, nlo, nhi, count, spread, slope, seed, osc=None, atten=False, evolve=0.1
):
    """Taylor turbulence without a loop: continuous frequencies, and eddies that also change
    shape as they drift (ω departs from k·U by up to ±evolve)."""
    rng = np.random.default_rng(seed)
    rows = []
    for n in np.exp(rng.uniform(np.log(nlo), np.log(nhi), count)):
        th = np.radians(rng.uniform(-spread, spread))
        k = 2 * np.pi * n / (hl.T * speed * np.cos(th)) * hl.rot(hl.WIND, th)
        amp, ph = n**-slope, rng.uniform(0, 2 * np.pi)
        nw = n * (1 + evolve * rng.uniform(-1, 1))
        if osc:
            f0, zeta = osc
            r = nw / hl.T / f0
            resp = 1 / complex(1 - r * r, 2 * zeta * r)
            amp, ph = amp * abs(resp), ph + np.angle(resp)
        rows.append([k[0], k[1], amp, ph, nw, float(atten), 0.0])
    norm = np.sqrt(0.5 * sum(r[2] ** 2 for r in rows))
    for r in rows:
        r[2] /= norm
    return rows


def live_waves(nlo, nhi, count, direction, spread, steep, seed, depth=None):
    rng = np.random.default_rng(seed)
    rows = []
    for n in np.exp(rng.uniform(np.log(nlo), np.log(nhi), count)):
        om = 2 * np.pi * n / hl.T
        kk = hl.k_deep(om) if depth is None else hl.k_finite(om, depth)
        d = hl.rot(direction, np.radians(rng.uniform(-spread, spread)))
        rows.append(
            [kk * d[0], kk * d[1], steep * d[1], rng.uniform(0, 2 * np.pi), n, 1.0, 1.0]
        )
    return rows


def live_swell(seed=142, count=5, spread=0.06, width=0.035, steep=0.035):
    """Narrow-band 8 s swell: neighbouring frequencies beat into wave groups (sets)."""
    rng = np.random.default_rng(seed)
    delta = np.linspace(-spread, spread, count) + rng.uniform(-0.006, 0.006, count)
    wgt = np.exp(-0.5 * (delta / width) ** 2)
    wgt /= np.sqrt((wgt**2).sum())
    rows = []
    for dl, wj in zip(delta, wgt):
        n = hl.SWELL_N * (1 - dl)  # period 8 s·(1 + δ)
        om = 2 * np.pi * n / hl.T
        kk = hl.k_deep(om)
        d = hl.rot(hl.SWELL_DIR, np.radians(rng.uniform(-6, 6)))
        rows.append(
            [
                kk * d[0],
                kk * d[1],
                steep * wj * d[1],
                rng.uniform(0, 2 * np.pi),
                n,
                1.0,
                1.0,
                wj,
            ]
        )
    return rows


def components(sea, grass):
    loop = dict(
        rough=adv_rows(sea.rough),
        swell=wave_rows(sea.swell),
        chop=wave_rows(sea.chop),
        chopL=wave_rows(sea.chop_lagoon),
        gust=adv_rows(grass.gust),
        flutter=adv_rows(grass.flutter),
    )
    live = dict(
        rough=live_advected(hl.U_SEA, 1, 8, 10, 40, 0.6, 141, atten=True),
        swell=live_swell(),
        chop=live_waves(8, 20, 8, hl.WIND, 35, 0.08 * np.sqrt(5 / 8), 143),
        chopL=live_waves(
            10, 24, 8, hl.WIND, 35, 0.08 * np.sqrt(6 / 8), 144, depth=hl.LAGOON_DEPTH
        ),
        gust=live_advected(hl.U_GRASS, 2, 13, 12, 30, 0.7, 151, osc=(1.3, 0.3)),
        flutter=live_advected(hl.U_GRASS, 28, 38, 6, 50, 0.0, 152, osc=(1.3, 0.3)),
    )
    return loop, live


# ---------------------------------------------------------------- CPU-side data
def blade_data(bl, gv0):
    first = bl.kk == 0
    tufts = dict(
        rx=bl.roots[:, 0],
        ry=bl.roots[:, 1],
        gx=bl.root_gx,
        gz=bl.root_gz,
        gv0=gv0[bl.roots[:, 1], bl.roots[:, 0]],
    )
    blades = dict(
        b=bl.bx[first], lean=bl.lean[first], n=bl.lb[first], tuft=bl.tid[first]
    )
    ffirst = bl.fk == 0
    fg = dict(
        x=bl.fx[ffirst],
        y=bl.fy[ffirst],
        le=bl.fl[ffirst],
        n=bl.fn[ffirst],
        c=bl.fc[ffirst],
        gx=bl.fg_gx[ffirst],
        gz=bl.fg_gz[ffirst],
    )
    out = {
        f"tuft_{k}": arr(v, "int16" if k in ("rx", "ry") else "float64")
        for k, v in tufts.items()
    }
    out.update(
        {
            f"blade_{k}": arr(v, "float64" if k in ("b", "lean") else "uint16")
            for k, v in blades.items()
        }
    )
    out.update(
        {
            f"fg_{k}": arr(v, "float64" if k in ("le", "gx", "gz") else "int16")
            for k, v in fg.items()
        }
    )
    return out


def cloud_data():
    """Each cloud of the still with its jitter noise and ragged-base noise on a local grid,
    so a moving, scaling cloud carries its own texture and t = 0 is the still exactly."""
    clouds = []
    for puffs, base, seed in hp.CLOUDS:
        p = np.array(puffs, float)
        x0 = max(int(np.floor((p[:, 0] - p[:, 2]).min())) - 12, 0)
        x1 = min(int(np.ceil((p[:, 0] + p[:, 2]).max())) + 13, W)
        y0 = max(int(np.floor((p[:, 1] - p[:, 2]).min())) - 12, 0)
        y1 = min(int(np.ceil((p[:, 1] + p[:, 2]).max())) + 13, H)
        gy, gx = np.mgrid[y0:y1, x0:x1]
        nz = fbm(gx / 5.0, gy / 5.0, seed, 3) - 0.5
        edge = vnoise(np.arange(x0, x1) / 7.0, np.zeros(x1 - x0), seed + 3)
        clouds.append(
            dict(
                puffs=p.tolist(),
                base=base,
                grid=[x0, y0, x1 - x0, y1 - y0],
                nz=arr(nz, "float32"),
                edge=arr(edge, "float64"),
            )
        )
    return clouds


def cirrus_rows():
    """Lattice rows the cirrus fbm reads (rows < 76, v = y/6·2^o), for seeds 31, 132, 233."""
    out = []
    for o, rows in enumerate((15, 28, 53)):
        g = np.random.default_rng(31 + 101 * o).random((512, 512))
        out.append(arr(g[:rows], "float32"))
    return out


def bank_bumps():
    rng = np.random.default_rng(207)
    bumps = []
    x = rng.uniform(0, 10)
    while x < W + 10:
        w = rng.uniform(6, 20)
        h = rng.uniform(1.5, 3.2) * (w / 10) ** 0.8
        bumps.append([x, w, h])
        x += w * rng.uniform(0.45, 0.8) + (
            rng.uniform(12, 50) if rng.random() < 0.28 else 0
        )
    top = np.zeros(W)
    for bx, bw, bh in bumps:
        xs = np.arange(W)
        top = np.maximum(
            top, bh * np.sqrt(np.clip(1 - ((xs - bx) / (bw / 2)) ** 2, 0, 1))
        )
    assert np.array_equal(top, hp.horizon_bank_profile()), (
        "bank bumps do not rebuild the profile"
    )
    return bumps


# ---------------------------------------------------------------- bundle
def bundle():
    st = hl.capture()
    phys = hl.Physics(st)
    sea, grass = phys.sea, phys.grass
    L = static_split(st)

    region = np.select([SKY, DEEP, LAGOON, LAND], [0, 1, 2, 3], 0).astype(np.uint8)
    straw, straw_v = hp.straw_fields()
    flags = (
        ISLE * 1
        | sea.coral * 2
        | sea.sand * 4
        | straw * 8
        | sea.wet * 16
        | sea.wet_hi * 32
        | sea.lick * 64
        | L["pshadow"] * 128
    ).astype(np.uint8)
    types = (region | (L["t1"] << 2) | (L["t2"] << 4) | (L["pmask"] << 6)).astype(
        np.uint8
    )
    kinds = (L["path"] * 1 | L["built"] * 2 | L["rock"] * 4).astype(np.uint8)
    masks = np.stack([types, flags, kinds], -1)

    field_a = np.where(LAND, st["grass_v"], np.where(LAGOON, sea.lag_v, 0.0))
    field_b = np.where(straw, straw_v, np.where(sea.coral, sea.coral_v, 0.0))

    surf = sea.surf
    cols = np.arange(W)
    zr = F * hl.CAM_H / (surf_y - HY)
    zi = F * hl.CAM_H / (ISLAND["base"] + 1 - HY)
    ix = np.arange(ISLAND["x0"] - 3, ISLAND["x1"] + 5)
    col_static = np.stack(
        [
            surf_y,
            land_y,
            surf.brk[0],
            surf.brk2[0],
            surf.reef,
            surf.kx_reef,
            surf.kx_isle,
            (cols - W / 2) * zr / F,
            zr,
            (cols - W / 2) * zi / F,
        ],
        0,
    )

    loop, live = components(sea, grass)
    caps = sea.caps
    data = {
        "const": dict(
            W=W,
            H=H,
            HY=HY,
            F=F,
            CAM_H=hl.CAM_H,
            EYE=hl.EYE_OVER_CAPE,
            LX=hp.LX,
            FPS=hl.FPS,
            T=hl.T,
            N=hl.N,
            G=hl.G,
            WIND=hl.WIND.tolist(),
            U_GRASS=hl.U_GRASS,
            U_SEA=hl.U_SEA,
            U_CLOUD=hl.U_CLOUD,
            U_CIRRUS=hl.U_CIRRUS,
            CLOUD_BASE=hl.CLOUD_BASE,
            CIRRUS_H=hl.CIRRUS_H,
            BANK_DIST=hl.BANK_DIST,
            SHEEN=hl.SHEEN,
            REFLECT=hl.REFLECT,
            SWELL_REFLECT=hl.SWELL_REFLECT,
            BORE=hl.BORE_SPEED,
            SET_AMP=hl.SET_AMP.tolist(),
            SWELL_N=hl.SWELL_N,
            ISLAND=ISLAND,
            POST=POST,
            FIX=FIX,
            FIX_OFF=FIX_OFF,
            trail_y=[surf.y0, surf.y1],
            isle_x0=int(ix[0]),
            isle_zi=zi,
        ),
        "pal": {k: v.tolist() for k, v in PAL.items()},
        "img": {
            "masks": png(masks),
            "fieldA": png(fixed(field_a)),
            "fieldB": png(fixed(field_b)),
            "isle": png(L["isle"]),
            "c1": png(L["c1"]),
            "c2": png(L["c2"]),
            "post": png(L["post"]),
        },
        "arr": {
            "col_static": arr(col_static, "float64"),
            "isle_noise": arr(noise1(ix / 2.0, 23), "float64"),
            "caps_z0": arr(caps.z0, "float64"),
            "caps_x0": arr(caps.x0, "float64"),
            "caps_size": arr(caps.size, "float64"),
            "caps_life": arr(caps.life, "float64"),
            "caps_birth": arr(caps.birth, "int32"),
            **blade_data(grass.blades, st["grass_v"]),
        },
        "cirrus": cirrus_rows(),
        "clouds": cloud_data(),
        "bank": bank_bumps(),
        "comps": {"loop": loop, "live": live},
    }
    return data, (phys, st, L)


def verify_split(phys, st, L, frames=(0, 360, 1100)):
    ok = True
    for i in frames:
        a, b = hl.compose(i, phys, st), compose_split(i, phys, st, L)
        bad = int(np.any(a != b, -1).sum())
        print(f"layer split, frame {i}: {bad} pixels differ")
        ok &= bad == 0
    return ok


def write_pages(data):
    tpl = TEMPLATE.read_text()
    parts = {
        "DATA": json.dumps(data, separators=(",", ":")),
        "ENV": ENV_JS.read_text(),
        "LIVE": LIVE_JS.read_text(),
    }
    for name, text in parts.items():
        assert tpl.count(f"/*__HK_{name}__*/") == 1, name
        assert "</script" not in text, name
    # one pass, so text put in for one placeholder is never searched for another
    frag = re.sub(r"/\*__HK_(\w+)__\*/", lambda m: parts[m.group(1)], tpl)
    OUT_FRAGMENT.write_text(frag)
    OUT_WE.parent.mkdir(exist_ok=True)
    OUT_WE.write_text(
        '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        "</head>\n<body>\n" + frag + "\n</body>\n</html>\n"
    )
    print(
        f"wrote {OUT_FRAGMENT.name} ({OUT_FRAGMENT.stat().st_size / 1e6:.2f} MB) and "
        f"{OUT_WE.parent.name}/{OUT_WE.name}"
    )


if __name__ == "__main__":
    data, (phys, st, L) = bundle()
    if not verify_split(phys, st, L):
        sys.exit(1)
    if "--data-only" in sys.argv:
        out = Path(sys.argv[sys.argv.index("--data-only") + 1])
        out.write_text(json.dumps(data, separators=(",", ":")))
        print("wrote", out)
    else:
        write_pages(data)
