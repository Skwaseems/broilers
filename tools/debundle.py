"""One-time conversion: the exported single-file bundle -> a normal static site.

The original index.html shipped every image/font/script base64-encoded inside
one ~12 MB HTML file and only produced real markup after client-side unpacking,
so crawlers and link-preview bots saw an empty "Bundled Page". This extracts the
assets to /assets and writes the page template out as plain HTML, providing the
same window.__resources map the dc-runtime reads, so rendering is unchanged.

    python tools/debundle.py _backup/index.bundled.html
"""

import base64
import gzip
import io
import json
import os
import re
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "index.html")
OUT_HTML = os.path.join(ROOT, "index.html")
MAX_W = 1600
JPEG_Q = 80

EXT = {"image/jpeg": "jpg", "font/woff2": "woff2", "text/javascript": "js"}
JS_NAMES = {
    "https://unpkg.com/react@18.3.1/umd/react.production.min.js": "react.production.min.js",
    "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js": "react-dom.production.min.js",
}


def script_json(lines, type_):
    for i, line in enumerate(lines):
        if line.strip().startswith(f'<script type="{type_}"'):
            return json.loads(lines[i + 1])
    raise SystemExit(f"missing {type_}")


def optimise_jpeg(raw):
    img = Image.open(io.BytesIO(raw))
    img = img.convert("RGB")
    if img.width > MAX_W:
        img = img.resize((MAX_W, round(img.height * MAX_W / img.width)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=JPEG_Q, optimize=True, progressive=True)
    out = buf.getvalue()
    return out if len(out) < len(raw) else raw


def main():
    lines = open(SRC, encoding="utf-8").readlines()
    manifest = script_json(lines, "__bundler/manifest")
    ext_res = script_json(lines, "__bundler/ext_resources")
    template = script_json(lines, "__bundler/template")

    # Human-readable image names from the page's own photo map (P = { key: 'id' }).
    p_block = template[template.find("const P = {"):]
    p_block = p_block[: p_block.find("};")]
    photo_key = {}
    for key, pid in re.findall(r"(\w+):\s*'([0-9]+)-[0-9a-f]+'", p_block):
        photo_key.setdefault("ph" + pid, key)

    uuid_to_path = {}
    ext_by_uuid = {e["uuid"]: e["id"] for e in ext_res}
    for uuid, entry in manifest.items():
        ext = EXT[entry["mime"]]
        rid = ext_by_uuid.get(uuid, "")
        if uuid.startswith("a3503bc7"):
            rel = "assets/js/dc-runtime.js"
        elif rid in JS_NAMES:
            rel = "assets/js/" + JS_NAMES[rid]
        elif ext == "woff2":
            rel = f"assets/fonts/{uuid[:8]}.woff2"
        else:
            rel = f"assets/img/{photo_key.get(rid, uuid[:8])}.jpg"
        uuid_to_path[uuid] = rel

    before = after = 0
    for uuid, entry in manifest.items():
        raw = base64.b64decode(entry["data"])
        if entry["compressed"]:
            raw = gzip.decompress(raw)
        before += len(raw)
        if entry["mime"] == "image/jpeg":
            raw = optimise_jpeg(raw)
        after += len(raw)
        dest = os.path.join(ROOT, uuid_to_path[uuid])
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(raw)

    for uuid, rel in uuid_to_path.items():
        template = template.replace(uuid, "/" + rel)

    resources = {e["id"]: "/" + uuid_to_path[e["uuid"]] for e in ext_res if e["uuid"] in uuid_to_path}
    res_script = "<script>window.__resources = " + json.dumps(resources).replace("</", "<\\/") + ";</script>"
    head = re.search(r"<head[^>]*>", template)
    template = template[: head.end()] + res_script + template[head.end():]

    with open(OUT_HTML, "w", encoding="utf-8", newline="\n") as f:
        f.write(template)

    print(f"assets: {len(manifest)}  decoded {before/1048576:.2f} MB -> written {after/1048576:.2f} MB")
    print(f"index.html: {len(template.encode())/1024:.0f} KB (was {os.path.getsize(SRC)/1048576:.1f} MB)")


if __name__ == "__main__":
    main()
