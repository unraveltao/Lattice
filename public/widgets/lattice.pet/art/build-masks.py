"""从 rig 的静止姿势算出窗口轮廓表（`art/rig-masks.json`）。

为什么可以在 Python 里做：rest 姿势下每个部件的网格就是它的 `box`（没有任何形变），
所以"画一遍"退化成"按 box 把 alpha 贴上去"。会动的部分（弹簧、走路）由组件在运行时
算，这一层只回答"她大概占多宽多高" —— 那是窗口区域和点击命中的依据。

用法（Pillow）：
    python art/build-masks.py
    python art/build-masks.py <rig 目录> [输出的 js]

输入目录里要有 `model.json`、`tex/`、`feat/`、`outfits/`。
输出 `art/rig-data.js`（**不是 json**：沙箱 iframe 是不透明源，`fetch` 自己的 JSON
也会被当成跨域，所以数据和轮廓表都用一段 classic script 带进来）：
    window.__PET_RIG_DATA = { model: {...}, masks: { "<outfit>": { view, box, runs } } }

坐标是 **rig 单位**（1 unit 在 view 里就是 1 px），组件按自己的缩放乘一下。
"""

import json
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
RIG = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "whale"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "rig-data.js"

SCALE = 2          # 合成分辨率：1 rig 单位 = SCALE 像素
GRID = 6           # 区域块的行高（rig 单位）
ALPHA = 8          # 算"有内容"的 alpha 阈值
# 轮廓四周留多少（rig 单位）。弹簧会把头发 / 裙摆推到静止姿势之外 —— 推到区域外面
# 的像素会被系统切掉（`SetWindowRgn` 之外不存在），所以要留一圈余量。
MARGIN = 6
OUTFITS = ["maid", "cape", "crew"]


def box_of(value):
    if isinstance(value, str):
        return [float(v) for v in value.replace(",", " ").split()]
    return [float(v) for v in value]


def parts_for(model, outfit_id):
    if outfit_id == "maid":
        return model["parts"]
    for outfit in model["outfits"]:
        if outfit["id"] == outfit_id:
            return outfit["parts"]
    raise SystemExit("unknown outfit: " + outfit_id)


def compose(model, outfit_id):
    vx, vy, vw, vh = model["view"]
    canvas = Image.new("RGBA", (int(vw * SCALE), int(vh * SCALE)), (0, 0, 0, 0))
    for part in sorted(parts_for(model, outfit_id), key=lambda p: float(p["z"])):
        x, y, w, h = box_of(part["box"])
        src = part.get("src") or f"tex/{part['tex']}.png"
        path = RIG / src
        if not path.exists():
            raise SystemExit("missing texture: " + str(path))
        target = (max(1, int(round(w * SCALE))), max(1, int(round(h * SCALE))))
        scaled = Image.open(path).convert("RGBA").resize(target, Image.LANCZOS)
        canvas.alpha_composite(scaled, (int(round((x - vx) * SCALE)), int(round((y - vy) * SCALE))))
    return canvas


def mask_of(canvas, model):
    vx, vy = model["view"][0], model["view"][1]
    alpha = canvas.getchannel("A")
    bbox = alpha.point(lambda v: 255 if v > ALPHA else 0).getbbox()
    if bbox is None:
        raise SystemExit("empty compose")
    runs = []
    band_height = GRID * SCALE
    start_band = int(bbox[1] / band_height) * band_height
    for band in range(start_band, bbox[3], band_height):
        height = min(band_height, alpha.height - band)
        row = alpha.crop((0, band, alpha.width, band + height)).tobytes()
        covered = [False] * alpha.width
        for y in range(height):
            offset = y * alpha.width
            for x in range(alpha.width):
                if row[offset + x] > ALPHA:
                    covered[x] = True
        start = None
        for x, on in enumerate(covered + [False]):
            if on and start is None:
                start = x
            elif not on and start is not None:
                runs.append([start, band, x - start, height])
                start = None
    unit = [
        # MARGIN 往外撑一圈；相邻块重叠没关系（Rust 侧是 `CombineRgn` 的并集）
        [round(r[0] / SCALE + vx - MARGIN, 2), round(r[1] / SCALE + vy - MARGIN, 2),
         round(r[2] / SCALE + MARGIN * 2, 2), round(r[3] / SCALE + MARGIN * 2, 2)]
        for r in runs
    ]
    unit_box = [
        round(bbox[0] / SCALE + vx, 2), round(bbox[1] / SCALE + vy, 2),
        round((bbox[2] - bbox[0]) / SCALE, 2), round((bbox[3] - bbox[1]) / SCALE, 2),
    ]
    return unit, unit_box


def main():
    model = json.loads((RIG / "model.json").read_text(encoding="utf-8"))
    masks = {}
    for outfit in OUTFITS:
        canvas = compose(model, outfit)
        runs, bbox = mask_of(canvas, model)
        masks[outfit] = {"view": model["view"], "box": bbox, "runs": runs}
        print(f"{outfit}: {len(runs)} runs, box={bbox}")
    payload = {"model": model, "masks": masks}
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    OUT.write_text(
        "/* 生成物：art/build-masks.py —— 别手改。\n"
        " * model.json + 三种服装的静止轮廓。用 classic script 带进来是因为沙箱 iframe\n"
        " * 的源是 opaque，`fetch` 自己的 JSON 也会被当成跨域。 */\n"
        f"window.__PET_RIG_DATA={text};\n",
        encoding="utf-8",
    )
    print("wrote", OUT, f"({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
