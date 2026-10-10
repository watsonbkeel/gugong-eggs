"""故宫材质 AI 生成脚本（异步接口 + 断点续传）。

- 密钥从环境变量 BKEEL_IMAGE_KEY 读取，不写入仓库。
- 每个素材只在 manifest 中没有成功记录时才提交，重复运行不会重复计费。
- 用法：python gen_textures.py [--only id1,id2] [--limit N]
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = "https://api.bkeel.com"
MODEL = "og-image2-low"
KEY = os.environ.get("BKEEL_IMAGE_KEY", "")
ROOT = Path(__file__).resolve().parent
RAW_DIR = ROOT / "ai" / "raw"
MANIFEST = ROOT / "ai" / "manifest.json"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

TILE = ("Seamless tileable texture, perfectly flat orthographic view, even soft diffuse lighting, "
        "no cast shadows, no perspective, no vignette, photorealistic PBR material scan, high detail, "
        "no text, no watermark. Subject: ")
FRONT = ("Perfectly frontal orthographic elevation, flat even lighting, no perspective distortion, "
         "subject fills the entire frame edge to edge, photorealistic, high detail, no text, no watermark. Subject: ")

ASSETS = [
    ("wall_red", "1024x1024", TILE + "weathered vermilion red lime plaster wall of the Forbidden City in Beijing, "
     "imperial cinnabar red, subtle hairline cracks, gentle color variation and faded patches, slight dust."),
    ("wall_brick", "1024x1024", TILE + "grey Chinese fired clay brick wall, running bond, thin light lime mortar joints, "
     "slightly worn brick edges, Ming dynasty palace masonry, frontal view."),
    ("roof_tile", "1024x1024", TILE + "Chinese imperial yellow glazed roof tiles seen from above, straight parallel rows of "
     "semi-cylindrical barrel tiles running vertically from top edge to bottom edge, concave pan tiles between the rows, "
     "glossy golden yellow glaze with slight weathering and dust in the gaps."),
    ("ground_brick", "1024x1024", TILE + "old grey square clay floor bricks paving of a Forbidden City courtyard seen from "
     "directly above, staggered rows, worn rounded edges, fine joints, subtle stains."),
    ("stone_slab", "1024x1024", TILE + "large rectangular weathered light grey granite slabs paving of an imperial road seen "
     "from directly above, tight joints, gentle wear."),
    ("marble", "1024x1024", TILE + "white Hanbaiyu marble stone surface, slightly weathered, faint grey veins, subtle "
     "rain stains, fine grain."),
    ("sumeru_band", "1536x1024", FRONT + "horizontal band of a white marble Sumeru pedestal (xumizuo) of Chinese imperial "
     "architecture, stacked horizontal moldings with carved upward and downward lotus petals and a recessed waist with "
     "carved panels, pattern repeating horizontally across the whole image."),
    ("wood_column", "1024x1024", TILE + "red lacquered wooden column surface of a Chinese palace, deep cinnabar red paint "
     "with fine crackle pattern and wear, faint vertical wood grain."),
    ("door_studded", "1024x1536", FRONT + "a single leaf of a Chinese imperial palace gate door, vermilion red lacquer, "
     "nine rows by nine columns of large round golden door nails, a golden lion-head knocker with ring, gilded edge "
     "bands, door leaf fills the whole frame."),
    ("lattice_doors", "1536x1024", FRONT + "four tall Chinese imperial palace lattice door panels (geshan) side by side, "
     "red lacquer frames, golden-brown hexagonal triple-cross lattice in the upper two thirds, carved gilded lower "
     "panels, gilded corner fittings, panels fill the whole frame."),
    ("caihua_beam", "1536x1024", FRONT + "Chinese Hexi caihua imperial painting on a wooden architrave beam, rich blue and "
     "green with gold dragons in elongated cartouches and gold outlines, horizontal design repeating across the whole "
     "image, flat painted surface."),
    ("dougong_band", "1536x1024", FRONT + "a continuous row of Chinese timber bracket sets (dougong) under palace eaves, "
     "interlocking blocks and arms painted blue and green with gold edges, regularly repeating horizontally, dark "
     "shadowed gaps between bracket sets."),
    ("rafters", "1024x1024", TILE + "underside of Chinese palace eaves seen from below: dense parallel rows of rafters "
     "painted green and blue with small gold patterns on the rafter ends, wooden roof boards between them."),
    ("balustrade", "1536x1024", FRONT + "a white marble balustrade of the Forbidden City: two carved posts with cloud "
     "and dragon capitals and a carved balustrade panel between them with a vase-shaped relief, weathered white stone."),
    ("yulu", "1024x1536", "Top-down orthographic photo of a long carved white marble imperial ramp slab (yulu) from the "
     "Forbidden City, dragons chasing pearls among clouds above sea waves and mountains in deep relief, slab fills the "
     "entire frame, even lighting, no text, no watermark."),
    ("pebble_path", "1024x1024", TILE + "Chinese imperial garden pebble mosaic path seen from directly above, small "
     "smooth grey, ochre and white pebbles set in mortar forming geometric flower patterns."),
    ("bark", "1024x1024", TILE + "ancient Chinese cypress tree bark, deeply twisted fibrous grey-brown strips, closeup."),
    ("foliage", "1024x1024", TILE + "dense dark green cypress and pine foliage closeup, overlapping needle clusters, "
     "depth variation, no sky visible."),
    ("rock", "1024x1024", TILE + "grey Taihu limestone rock surface with eroded holes, ridges and pits, closeup."),
    ("grass", "1024x1024", TILE + "short garden grass mixed with moss and a few fallen yellow leaves seen from directly above."),
    ("water", "1024x1024", TILE + "calm imperial moat water seen from directly above, dark jade green, gentle small ripples, "
     "faint reflections of sky."),
    ("skyline", "1536x1024", "Wide panoramic distant view of old Beijing from ground level on a hazy clear morning: a low "
     "band of grey tiled hutong roofs, rows of green trees and faint distant hills along the bottom third of the image, "
     "everything above them is a plain pure white empty sky, soft atmospheric haze, horizontally continuous composition, "
     "photorealistic, no text, no watermark."),
]


def request(method, path, body=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={
        "Authorization": f"Bearer {KEY}",
        "Content-Type": "application/json",
        "User-Agent": UA,
        "Accept": "application/json, image/*, */*",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read(), resp.headers.get("Content-Type", "")


def load_manifest():
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text())
    return {"submissions": 0, "items": {}}


def save_manifest(m):
    MANIFEST.write_text(json.dumps(m, ensure_ascii=False, indent=2))


def run_one(asset, manifest, lock_save):
    aid, size, prompt = asset
    out = RAW_DIR / f"{aid}.png"
    item = manifest["items"].setdefault(aid, {})
    if item.get("status") == "downloaded" and out.exists():
        return aid, "skip"
    task_id = item.get("task_id")
    if item.get("status") in ("failed", "submit_failed") and "--retry-failed" in sys.argv:
        # 失败任务（如旧密钥 401）没有出图，仅在显式要求时重提；旧记录保留到 history
        item.setdefault("history", []).append({k: item.get(k) for k in ("task_id", "status")})
        for k in ("task_id", "status", "error"):
            item.pop(k, None)
        task_id = None
    elif item.get("status") in ("failed", "submit_failed"):
        return aid, "skip_failed"
    if not task_id:
        try:
            status, raw, _ = request("POST", "/v1/images/generations",
                                     {"model": MODEL, "prompt": prompt, "size": size, "n": 1}, timeout=120)
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except Exception as e:  # 网络超时等：不自动重提，避免重复计费
            manifest["submissions"] += 1
            item.update({"status": "submit_failed", "error": repr(e), "submitted_at": time.time()})
            lock_save()
            return aid, f"submit_error {e!r}"
        manifest["submissions"] += 1
        try:
            resp = json.loads(raw)
        except Exception:
            resp = {"raw": raw[:300].decode("utf-8", "replace")}
        task_id = resp.get("task_id")
        item.update({"task_id": task_id, "size": size, "submitted_at": time.time(), "submit_http": status})
        if not task_id and resp.get("data"):
            item["direct"] = resp["data"][0]
        lock_save()
        if not task_id:
            item["status"] = "submit_failed"
            item["error"] = resp
            lock_save()
            return aid, f"submit_failed {str(resp)[:200]}"
    deadline = time.time() + 600
    while time.time() < deadline:
        time.sleep(6)
        try:
            _, raw, _ = request("GET", f"/v1/async-images/{task_id}", timeout=30)
        except urllib.error.HTTPError as e:
            raw = e.read()
        except Exception:
            continue
        try:
            info = json.loads(raw)
        except Exception:
            continue
        st = info.get("status") or info.get("data", {}).get("status")
        if st in ("succeeded", "success", "completed", "done"):
            candidates = [u for u in (info.get("image_url"), info.get("download_url"),
                                      f"/v1/async-images/{task_id}/image") if u]
            data, last_err = None, None
            for url in candidates:
                try:
                    if url.startswith("http") and "api.bkeel.com" not in url:
                        # 外部临时直链（对象存储签名 URL）不能带 Authorization 头
                        req = urllib.request.Request(url, headers={"User-Agent": UA})
                        with urllib.request.urlopen(req, timeout=120) as r:
                            data = r.read()
                    else:
                        path = url.split("api.bkeel.com", 1)[1] if url.startswith("http") else url
                        _, data, _ = request("GET", path, timeout=120)
                    if data and len(data) > 1000:
                        break
                except Exception as e:
                    last_err = repr(e)
                    data = None
            if not data:
                item.update({"status": "download_failed", "error": last_err})
                lock_save()
                return aid, f"download_failed {last_err}"
            out.write_bytes(data)
            item.update({"status": "downloaded", "bytes": len(data), "finished_at": time.time()})
            lock_save()
            return aid, f"ok {len(data)}B"
        if st in ("failed", "error", "cancelled"):
            info.get("data", {}).pop("prompt", None)
            item.update({"status": "failed", "error": info})
            lock_save()
            return aid, f"failed {str(info.get('error'))[:200]}"
    item["status"] = "timeout"
    lock_save()
    return aid, "timeout"


def main():
    if not KEY:
        sys.exit("BKEEL_IMAGE_KEY 未设置")
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    only = None
    limit = None
    for i, a in enumerate(sys.argv):
        if a == "--only":
            only = set(sys.argv[i + 1].split(","))
        if a == "--limit":
            limit = int(sys.argv[i + 1])
    manifest = load_manifest()
    todo = [a for a in ASSETS if (only is None or a[0] in only)]
    if limit:
        todo = todo[:limit]
    import threading
    lock = threading.Lock()

    def lock_save():
        with lock:
            save_manifest(manifest)

    with ThreadPoolExecutor(max_workers=5) as pool:
        for aid, result in pool.map(lambda a: run_one(a, manifest, lock_save), todo):
            print(aid, result, flush=True)
    print("TOTAL_SUBMISSIONS", manifest["submissions"])


if __name__ == "__main__":
    main()
