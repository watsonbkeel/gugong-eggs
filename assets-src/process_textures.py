"""把 AI 原图处理成游戏用贴图。

输入：assets-src/ai/raw/*.png
输出：public/textures/hd/、public/textures/sd/ 下的 WebP 颜色贴图、法线贴图和 manifest.json

处理步骤：
- repeat 类：去除大尺度明暗（避免平铺时出现重复斑块），双向交叉淡化成无缝贴图
- band 类：裁掉留白，仅横向无缝
- clamp 类：只缩放
- skyline：天空转透明，横向无缝
- 法线贴图：由亮度高频分量推算高度，Sobel 求梯度（OpenGL 约定，绿色朝上）

用法：python process_textures.py [name ...]
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "ai" / "raw"
OUT = ROOT.parent / "public" / "textures"

# wrap: repeat | band | clamp | skyline；tile: 一张贴图对应米数；normal: 法线强度（0 不生成）
SPECS = {
    "wall_red":      dict(wrap="repeat", tile=4,   normal=1.2, flatten=0.85),
    "wall_brick":    dict(wrap="repeat", tile=2,   normal=3.0, flatten=0.8),
    "roof_tile":     dict(wrap="repeat", tile=3,   normal=4.0, flatten=0.6),
    "ground_brick":  dict(wrap="repeat", tile=4,   normal=2.5, flatten=0.8),
    "stone_slab":    dict(wrap="repeat", tile=6,   normal=2.0, flatten=0.8),
    "marble":        dict(wrap="repeat", tile=2,   normal=0.8, flatten=0.85),
    "sumeru_band":   dict(wrap="band",   tile=3,   normal=4.0, crop_white=True),
    "wood_column":   dict(wrap="repeat", tile=1.5, normal=1.0, flatten=0.8),
    "door_studded":  dict(wrap="clamp",  tile=1,   normal=3.0),
    "lattice_doors": dict(wrap="band",   tile=6,   normal=2.5),
    "caihua_beam":   dict(wrap="band",   tile=4,   normal=0.8),
    "dougong_band":  dict(wrap="band",   tile=4,   normal=3.0),
    "rafters":       dict(wrap="repeat", tile=3,   normal=2.5, flatten=0.5),
    "balustrade":    dict(wrap="band",   tile=3,   normal=4.0, crop_white=True, red_alpha=True),
    "yulu":          dict(wrap="clamp",  tile=1,   normal=5.0),
    "pebble_path":   dict(wrap="repeat", tile=3,   normal=3.0, flatten=0.8),
    "bark":          dict(wrap="repeat", tile=1.5, normal=4.0, flatten=0.7),
    "foliage":       dict(wrap="repeat", tile=3,   normal=3.0, flatten=0.6),
    "rock":          dict(wrap="repeat", tile=3,   normal=5.0, flatten=0.6),
    "grass":         dict(wrap="repeat", tile=4,   normal=2.0, flatten=0.8),
    "water":         dict(wrap="repeat", tile=8,   normal=3.0, flatten=0.9),
    "skyline":       dict(wrap="skyline", tile=1,  normal=0),
}

SIZES = {"hd": 1024, "sd": 512}
BAND_MAX_W = {"hd": 2048, "sd": 1024}


def to_np(im):
    return np.asarray(im, dtype=np.float32) / 255.0


def to_im(a, mode="RGB"):
    return Image.fromarray(np.clip(a * 255.0 + 0.5, 0, 255).astype(np.uint8), mode)


def luminance(a):
    return a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722


def _blur_axis(a, sigma, axis):
    """沿指定轴做环绕（周期）高斯模糊，FFT 实现。"""
    n = a.shape[axis]
    freq = np.fft.rfftfreq(n)
    kernel = np.exp(-2 * (np.pi * freq * sigma) ** 2)
    shape = [1] * a.ndim
    shape[axis] = kernel.size
    spec = np.fft.rfft(a, axis=axis) * kernel.reshape(shape)
    return np.fft.irfft(spec, n=n, axis=axis).astype(np.float32)


def blur(a, radius):
    """对 HxW 或 HxWxC 浮点数组做环绕高斯模糊（周期边界，保证无缝）。radius 视作 sigma。"""
    a = np.asarray(a, dtype=np.float32)
    return _blur_axis(_blur_axis(a, radius, 0), radius, 1)


def flatten_lighting(a, strength):
    """去除大尺度明暗起伏：除以大半径模糊后的亮度，再乘回均值。strength 0..1。"""
    lum = luminance(a)
    low = blur(lum, max(a.shape[0], a.shape[1]) / 8)
    ratio = np.clip(lum.mean() / np.maximum(low, 1e-3), 0.7, 1.45)
    ratio = 1 + (ratio - 1) * strength
    return np.clip(a * ratio[..., None], 0, 1)


def crossfade_x(a, frac=0.1):
    """横向交叉淡化：输出宽度缩短 b 像素，左右边缘连续。"""
    h, w = a.shape[:2]
    b = max(8, int(w * frac))
    m = w - b
    out = a[:, :m].copy()
    t = (np.arange(b, dtype=np.float32) / b)
    t = t * t * (3 - 2 * t)
    t = t.reshape(1, b, *([1] * (a.ndim - 2)))
    out[:, :b] = a[:, m:m + b] * (1 - t) + a[:, :b] * t
    return out


def crossfade_y(a, frac=0.1):
    return np.swapaxes(crossfade_x(np.swapaxes(a, 0, 1), frac), 0, 1)


def edge_mismatch(a):
    """左右/上下边缘差异，用于记录无缝处理前后的效果。"""
    return float(np.abs(a[:, 0] - a[:, -1]).mean() + np.abs(a[0] - a[-1]).mean()) / 2


def crop_white(a, thresh=0.93):
    """裁掉上下近白色留白（带状贴图常见）。"""
    lum = luminance(a)
    rows = np.where((lum < thresh).mean(axis=1) > 0.35)[0]
    cols = np.where((lum < thresh).mean(axis=0) > 0.35)[0]
    if len(rows) and len(cols):
        a = a[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]
    return a


def normal_from(a, strength, wrap_y=True):
    """由颜色推算法线贴图。高度 = 亮度的中高频分量。"""
    lum = luminance(a)
    h = lum - blur(lum, max(lum.shape) / 32)
    h = h + 0.5 * (blur(lum, 1.2) - blur(lum, max(lum.shape) / 32))
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5
    if wrap_y:
        drow = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5
    else:
        drow = np.gradient(h, axis=0)
    s = strength * 4.0
    nx = -dx * s
    ny = drow * s  # 图像行向下 = v 减小，故 dh/dv = -dh/drow，ny = -dh/dv
    nz = np.ones_like(nx)
    n = np.stack([nx, ny, nz], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def skyline_alpha(a):
    """把接近天空色（顶部区域平均色）的像素变透明，并保证天际线以上全部透明。"""
    h, w = a.shape[:2]
    sky = a[: max(4, h // 12)].reshape(-1, 3).mean(axis=0)
    dist = np.linalg.norm(a - sky, axis=-1)
    alpha = np.clip((dist - 0.06) / 0.10, 0, 1)
    # 每列从上往下，出现第一个明显不透明像素之前全部透明
    solid = alpha > 0.6
    first = np.where(solid.any(axis=0), solid.argmax(axis=0), h)
    rows = np.arange(h)[:, None]
    alpha = np.where(rows < first[None, :] - 2, 0.0, alpha)
    # 天际线以下视为实心，避免树缝透光
    alpha = np.where(rows > first[None, :] + 6, 1.0, alpha)
    alpha = np.asarray(Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8)),
                       dtype=np.float32) / 255
    return alpha


def save_webp(arr, path, quality, mode="RGB"):
    to_im(arr, mode).save(path, "WEBP", quality=quality, method=6)


def process(name, spec, manifest):
    src = RAW / f"{name}.png"
    if not src.exists():
        return f"{name}: 缺原图，跳过"
    im = Image.open(src).convert("RGB")
    a = to_np(im)
    wrap = spec["wrap"]
    before = after = None
    alpha = None
    if wrap == "repeat":
        side = min(a.shape[:2])
        y0 = (a.shape[0] - side) // 2
        x0 = (a.shape[1] - side) // 2
        a = a[y0:y0 + side, x0:x0 + side]
        a = flatten_lighting(a, spec.get("flatten", 0.8))
        before = edge_mismatch(a)
        a = crossfade_y(crossfade_x(a, 0.12), 0.12)
        after = edge_mismatch(a)
    elif wrap == "band":
        if spec.get("crop_white"):
            a = crop_white(a)
        if spec.get("red_alpha"):
            # 栏板镂空处原图露出背后的红墙：红色（高饱和、R 远大于 G/B）转为透明，配合 alphaTest 使用
            redness = a[..., 0] - np.maximum(a[..., 1], a[..., 2])
            alpha = 1.0 - np.clip((redness - 0.18) / 0.12, 0, 1)
            alpha = np.asarray(Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))
                               .filter(ImageFilter.GaussianBlur(0.7)), dtype=np.float32) / 255
            # 透明区域颜色替换为邻近石材色，避免 mipmap 后边缘泛红
            stone = a[alpha > 0.9].mean(axis=0) if (alpha > 0.9).any() else np.array([0.85, 0.83, 0.8])
            a = np.where(alpha[..., None] < 0.5, stone, a)
        before = float(np.abs(a[:, 0] - a[:, -1]).mean())
        if alpha is not None:
            rgba = crossfade_x(np.concatenate([a, alpha[..., None]], axis=-1), 0.08)
            a, alpha = rgba[..., :3], rgba[..., 3]
        else:
            a = crossfade_x(a, 0.08)
        after = float(np.abs(a[:, 0] - a[:, -1]).mean())
    elif wrap == "skyline":
        alpha = skyline_alpha(a)
        # 裁掉上方全透明的天空，只保留天际线条带（上方留 4% 余量）
        rows = np.where((alpha > 0.5).mean(axis=1) > 0.02)[0]
        if len(rows):
            top = max(0, rows[0] - int(a.shape[0] * 0.04))
            a, alpha = a[top:], alpha[top:]
        rgba = np.concatenate([a, alpha[..., None]], axis=-1)
        rgba = crossfade_x(rgba, 0.12)
        a, alpha = rgba[..., :3], rgba[..., 3]

    entry = {"wrap": wrap, "tileSize": spec["tile"]}
    for q, size in SIZES.items():
        d = OUT / q
        d.mkdir(parents=True, exist_ok=True)
        h, w = a.shape[:2]
        if wrap == "repeat":
            tw = th = size
        elif wrap in ("band", "skyline"):
            tw = min(BAND_MAX_W[q], w)
            th = max(16, round(h * tw / w))
            if th > size:
                th = size
                tw = round(w * th / h)
        else:
            scale = size / max(h, w)
            tw, th = max(16, round(w * scale)), max(16, round(h * scale))
        if alpha is not None:
            rgba = np.concatenate([a, alpha[..., None]], axis=-1)
            res = to_np(to_im(rgba, "RGBA").resize((tw, th), Image.LANCZOS))
            save_webp(res, d / f"{name}.webp", 88, "RGBA")
        else:
            res = to_np(to_im(a).resize((tw, th), Image.LANCZOS))
            save_webp(res, d / f"{name}.webp", 86 if q == "hd" else 82)
        if spec["normal"] > 0:
            # 法线贴图用颜色贴图一半分辨率：细节主要来自颜色，法线负责中尺度起伏，体积减半以上
            half = to_np(to_im(res).resize((max(16, tw // 2), max(16, th // 2)), Image.LANCZOS))
            n = normal_from(half, spec["normal"] * (size / 2048) ** 0.5, wrap_y=(wrap == "repeat"))
            save_webp(n, d / f"{name}_n.webp", 85)
        entry[q] = {"width": tw, "height": th}
    entry["color"] = f"{name}.webp"
    if spec["normal"] > 0:
        entry["normal"] = f"{name}_n.webp"
    manifest["textures"][name] = entry
    msg = f"{name}: {wrap} -> hd {entry['hd']['width']}x{entry['hd']['height']}"
    if before is not None:
        msg += f"  边缘差 {before:.3f} -> {after:.3f}"
    return msg


def main():
    only = set(sys.argv[1:])
    manifests = {}
    for q in SIZES:
        p = OUT / q / "manifest.json"
        manifests[q] = json.loads(p.read_text()) if p.exists() else {"version": 1, "textures": {}}
    shared = {"version": 1, "textures": {}}
    for q in SIZES:
        shared["textures"].update(manifests[q]["textures"])
    for name, spec in SPECS.items():
        if only and name not in only:
            continue
        print(process(name, spec, shared), flush=True)
    for q in SIZES:
        (OUT / q).mkdir(parents=True, exist_ok=True)
        (OUT / q / "manifest.json").write_text(json.dumps(shared, ensure_ascii=False, indent=1))
    total = {q: sum(f.stat().st_size for f in (OUT / q).glob("*.webp")) for q in SIZES}
    print("TOTAL_BYTES", total, "COUNT", len(shared["textures"]))


if __name__ == "__main__":
    main()
