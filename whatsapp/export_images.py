"""Export product photos from the bundled index.html into plain .jpg files.

The website itself reuses the images already inside the bundle at runtime, but
Meta needs real image files uploaded before a carousel template can be created.
Run this whenever the product list or artwork changes:

    python3 whatsapp/export_images.py
"""

import base64
import gzip
import json
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, "index.html")
# Public web asset, NOT inside whatsapp/ - that whole folder is excluded from
# deploys so a real config.json can never leak its access token.
OUT_DIR = os.path.join(ROOT, "images", "products")

# slug -> the resource id the site's own bg() helper resolves (window.__resources['ph'+id])
PRODUCT_IMAGE_IDS = {
    "whole-chicken": "1672787153655",
    "breast-fillet": "1633096013004",
    "curry-cut": "1759493321741",
    "wings": "1604503468506",
    "drumsticks": "1638439430466",
    "liver-gizzard": "1600180786608",
    "soup-pieces": "1672787380739",
    "thigh-boneless": "1682991136736",
}


def load_bundle():
    with open(INDEX, "r", encoding="utf-8", newline="") as f:
        lines = f.readlines()
    manifest = ext = None
    for i, line in enumerate(lines):
        # Only real opening tags - the loader script also mentions these type
        # strings inside querySelector() calls.
        if not line.lstrip().startswith("<script"):
            continue
        if 'type="__bundler/manifest"' in line:
            manifest = json.loads(lines[i + 1].strip())
        elif 'type="__bundler/ext_resources"' in line:
            ext = json.loads(lines[i + 1].strip())
    if manifest is None or ext is None:
        sys.exit("Could not find the bundler manifest/ext_resources in index.html")
    return manifest, {e["id"]: e["uuid"] for e in ext}


def decode_asset(entry):
    raw = base64.b64decode(entry["data"])
    return gzip.decompress(raw) if entry.get("compressed") else raw


def jpeg_size(data):
    """Read width/height straight from the JPEG SOF marker (no Pillow needed)."""
    i = 2
    while i < len(data) - 9:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        length = struct.unpack(">H", data[i + 2 : i + 4])[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", data[i + 5 : i + 9])
            return w, h
        i += 2 + length
    return None, None


def square_crop(path):
    """Centre-crop to 1:1 so every carousel card matches. Needs Pillow."""
    from PIL import Image

    with Image.open(path) as im:
        im = im.convert("RGB")
        w, h = im.size
        side = min(w, h)
        left, top = (w - side) // 2, (h - side) // 2
        im = im.crop((left, top, left + side, top + side))
        if side > 1080:
            im = im.resize((1080, 1080), Image.LANCZOS)
        im.save(path, "JPEG", quality=88, optimize=True)
    return os.path.getsize(path)


def main():
    manifest, id_to_uuid = load_bundle()
    os.makedirs(OUT_DIR, exist_ok=True)

    try:
        import PIL  # noqa: F401

        can_crop = True
    except ImportError:
        can_crop = False

    ratios = set()
    for slug, image_id in PRODUCT_IMAGE_IDS.items():
        uuid = id_to_uuid.get("ph" + image_id)
        if not uuid or uuid not in manifest:
            print(f"  !! {slug}: no asset for ph{image_id}")
            continue
        data = decode_asset(manifest[uuid])
        path = os.path.join(OUT_DIR, slug + ".jpg")
        with open(path, "wb") as f:
            f.write(data)
        w, h = jpeg_size(data)
        if can_crop:
            size = square_crop(path)
            print(f"  {slug}.jpg  {size // 1024}KB  1080x1080 (cropped from {w}x{h})")
        else:
            ratios.add(round(w / h, 2) if w and h else 0)
            print(f"  {slug}.jpg  {len(data) // 1024}KB  {w}x{h}")

    print()
    if can_crop:
        print("All images centre-cropped to 1:1 - ready to upload as carousel cards.")
    else:
        print(f"Mixed aspect ratios {sorted(ratios)}. Meta requires every carousel card to use")
        print("the same ratio, so install Pillow and re-run to auto-crop them to 1:1:")
        print("    pip install Pillow && python3 whatsapp/export_images.py")


if __name__ == "__main__":
    main()
