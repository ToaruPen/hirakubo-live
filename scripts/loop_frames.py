"""Write frames of hirakubo_loop.py as PNGs: the reference the page's loop mode is checked against.

uv run python scripts/loop_frames.py OUT_DIR 0 360 1100
"""

import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import hirakubo_live_build as lb
import hirakubo_loop as hl

if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    _, (phys, st, _) = lb.bundle()
    for i in map(int, sys.argv[2:]):
        Image.fromarray(hl.compose(i, phys, st)).save(out / f"loop_{i}.png")
