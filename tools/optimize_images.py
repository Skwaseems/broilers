"""Re-encode the site photos as WebP from the original bundle (not from the
already-compressed JPEGs) and point index.html at them.

    python tools/optimize_images.py _backup/index.bundled.html
"""

import base64
import io
import json
import os
import re
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from debundle import ROOT, script_json  # noqa: E402

MAX_W = 1600
QUALITY = 74


def main():
    src = sys.argv[1]
    lines = open(src, encoding="utf-8").readlines()
    manifest = script_json(lines, "__bundler/manifest")
    ext_res = script_json(lines, "__bundler/ext_resources")
    template = script_json(lines, "__bundler/template")

    p_block = template[template.find("const P = {"):]
    p_block = p_block[: p_block.find("};")]
    photo_key = {}
    for key, pid in re.findall(r"(\w+):\s*'([0-9]+)-[0-9a-f]+'", p_block):
        photo_key.setdefault("ph" + pid, key)
    ext_by_uuid = {e["uuid"]: e["id"] for e in ext_res}

    page_path = os.path.join(ROOT, "index.html")
    page = open(page_path, encoding="utf-8").read()
    img_dir = os.path.join(ROOT, "assets", "img")
    before = after = 0

    for uuid, entry in manifest.items():
        if entry["mime"] != "image/jpeg":
            continue
        name = photo_key.get(ext_by_uuid.get(uuid, ""), uuid[:8])
        img = Image.open(io.BytesIO(base64.b64decode(entry["data"]))).convert("RGB")
        if img.width > MAX_W:
            img = img.resize((MAX_W, round(img.height * MAX_W / img.width)), Image.LANCZOS)
        img.save(os.path.join(img_dir, name + ".webp"), "WEBP", quality=QUALITY, method=6)

        jpg = os.path.join(img_dir, name + ".jpg")
        if os.path.exists(jpg):
            before += os.path.getsize(jpg)
            os.remove(jpg)
        after += os.path.getsize(os.path.join(img_dir, name + ".webp"))
        page = page.replace(f"/assets/img/{name}.jpg", f"/assets/img/{name}.webp")

    with open(page_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(page)
    leftover = re.findall(r"/assets/img/[\w-]+\.jpg", page)
    print(f"images: {before/1048576:.2f} MB jpg -> {after/1048576:.2f} MB webp; jpg refs left in index.html: {len(leftover)}")


if __name__ == "__main__":
    main()
