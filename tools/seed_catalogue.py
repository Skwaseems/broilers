"""One-time seed of the admin-editable WhatsApp catalogue (15 items).

    python tools/seed_catalogue.py

- Uploads each item's photo to the Cloudflare KV namespace CATALOGUE_IMAGES
  (the 8 existing card photos; branded name tiles for the 7 new items, flagged
  as placeholders so the admin page asks for real photos).
- Writes tools/.seed/catalogue.json, which tools/seed_firestore.js loads into
  Firestore (catalogue/* and catalogue_meta/whatsapp).

Slugs for the 8 original items are new (e.g. breast-boneless); the website maps
the old slugs baked into the already-approved template (breast-fillet, wings...)
to these, so links in catalogues already sent keep working.
"""

import json
import os
import subprocess
import time

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tools", ".seed")
FONT_DIR = os.path.join(ROOT, "tools", ".fonts")
WORKER = "https://sharhan-whatsapp.waseemshaikh597.workers.dev"
KV_ID = "1a31e9cf8b02472ea6515f00c58094cd"
GREEN, GOLD, WHITE = (34, 53, 42), (180, 156, 108), (255, 255, 255)

# (slug, name, card text, packs, existing photo in images/products or None)
ITEMS = [
    ("live-broiler", "Live Broiler", "Live broilers supplied to order across Mumbai. Tap to send us your requirement.", [], None),
    ("whole-chicken", "Whole Chicken", "Whole Chicken - skinless, dressed 900 g to 1.2 kg. Packs: 5 / 20 / 50 kg.", ["5 kg", "20 kg", "50 kg"], "whole-chicken.jpg"),
    ("chicken-tandoori", "Chicken Tandoori", "Chicken Tandoori cut, supplied fresh or frozen. Tap to send us your requirement.", [], None),
    ("breast-boneless", "Breast Boneless", "Breast Boneless - trimmed, 140-180 g per piece. Packs: 2 / 10 / 25 kg.", ["2 kg", "10 kg", "25 kg"], "breast-fillet.jpg"),
    ("leg-boneless", "Leg Boneless", "Leg Boneless, supplied fresh or frozen. Tap to send us your requirement.", [], None),
    ("curry-cut", "Curry Cut", "Curry Cut Twelve Piece - uniform weight, skin off. Packs: 5 kg / 20 kg.", ["5 kg", "20 kg"], "curry-cut.jpg"),
    ("chicken-wings", "Chicken Wings", "Two Joint Wings - tip removed, 40-55 g each. Packs: 2 kg / 10 kg.", ["2 kg", "10 kg"], "wings.jpg"),
    ("drumstick", "Drumstick", "Drumsticks - skin on, graded 85-110 g per piece. Packs: 5 kg / 20 kg.", ["5 kg", "20 kg"], "drumsticks.jpg"),
    ("thigh-boneless", "Thigh Boneless", "Thigh Boneless - skinless, 90-120 g per piece. Packs: 2 kg / 10 kg.", ["2 kg", "10 kg"], "thigh-boneless.jpg"),
    ("boneless-trimming", "Boneless Trimming", "Boneless Trimming, supplied fresh or frozen. Tap to send us your requirement.", [], None),
    ("chicken-keema", "Chicken Keema", "Chicken Keema, supplied fresh or frozen. Tap to send us your requirement.", [], None),
    ("soup-piece", "Soup Piece", "Soup Pieces - backs, necks and frames for stock. Packs: 5 kg / 20 kg.", ["5 kg", "20 kg"], "soup-pieces.jpg"),
    ("chicken-liver", "Chicken Liver", "Chicken Liver - cleaned and chilled. Packs: 1 kg / 5 kg.", ["1 kg", "5 kg"], "liver-gizzard.jpg"),
    ("gizzard", "Gizzard", "Gizzard - cleaned and chilled. Tap to send us your requirement.", [], None),
    ("chicken-skin", "Chicken Skin", "Chicken Skin, supplied fresh or frozen. Tap to send us your requirement.", [], None),
]

# Card order of the template that is already approved and live (from whatsapp/products.json).
LIVE_TEMPLATE = {
    "name": "sharhan_weekly_catalogue",
    "id": "1748323049737272",
    "status": "APPROVED",
    "language": "en",
    "slugs": ["curry-cut", "breast-boneless", "whole-chicken", "drumstick", "thigh-boneless",
              "chicken-wings", "soup-piece", "chicken-liver"],
}


def font(name, size, weight):
    f = ImageFont.truetype(os.path.join(FONT_DIR, name), size)
    f.set_variation_by_axes([weight])
    return f


def name_tile(name, path):
    img = Image.new("RGB", (1080, 1080), GREEN)
    d = ImageDraw.Draw(img)
    d.rectangle([390, 400, 690, 404], fill=GOLD)
    words = name.upper().split()
    lines = [" ".join(words)] if len(name) <= 14 else [" ".join(words[:-1]), words[-1]]
    f = font("CormorantGaramond.ttf", 92, 500)
    y = 520
    for line in lines:
        d.text((540, y), line, font=f, fill=WHITE, anchor="ms")
        y += 104
    d.text((540, y + 20), "SHARHAN BROILERS", font=font("Jost.ttf", 30, 400), fill=GOLD, anchor="ms")
    img.save(path, "JPEG", quality=88, optimize=True)


def kv_put(slug, path):
    cmd = f'npx wrangler kv key put "img:{slug}" --path "{path}" --namespace-id {KV_ID} --remote'
    r = subprocess.run(cmd, shell=True, cwd=os.path.join(ROOT, "cloudflare-worker"), capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"KV upload failed for {slug}: {r.stderr or r.stdout}")


def main():
    os.makedirs(OUT, exist_ok=True)
    version = int(time.time() * 1000)
    docs = []
    for order, (slug, name, spec, packs, photo) in enumerate(ITEMS):
        assert len(spec) <= 160, (slug, len(spec))
        if photo:
            path = os.path.join(ROOT, "images", "products", photo)
        else:
            path = os.path.join(OUT, slug + ".jpg")
            name_tile(name, path)
        kv_put(slug, path)
        print("uploaded", slug)
        docs.append({
            "id": slug, "order": order, "name": name, "spec": spec, "packs": packs,
            "image": f"{WORKER}/catalogue-img/{slug}.jpg?v={version}",
            "placeholder": photo is None,
        })
    meta = {"version": 1, "live": {"version": 1, "templates": [LIVE_TEMPLATE], "approvedAt": "2026-09-28T00:00:00Z"}, "pending": None}
    with open(os.path.join(OUT, "catalogue.json"), "w", encoding="utf-8") as f:
        json.dump({"items": docs, "meta": meta}, f, indent=2)
    print("wrote tools/.seed/catalogue.json")


if __name__ == "__main__":
    main()
