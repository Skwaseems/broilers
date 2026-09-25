"""Step 1: upload the card images to Meta and save their handles.

Template creation needs an example image "handle" per carousel card. Handles come
from Meta's resumable upload API and are written to media_handles.json for
create_template.py to pick up.

    python3 whatsapp/upload_media.py
"""

import json
import os
import urllib.parse

import wa_common as wa


def upload_one(cfg, path):
    size = os.path.getsize(path)
    name = os.path.basename(path)

    # 1. open an upload session
    query = urllib.parse.urlencode(
        {"file_name": name, "file_length": size, "file_type": "image/jpeg"}
    )
    session = wa.request(
        wa.graph_url(cfg, f"{cfg['app_id']}/uploads?{query}"),
        method="POST",
        token=cfg["access_token"],
    )
    session_id = session["id"]

    # 2. push the bytes; the response carries the handle
    with open(path, "rb") as f:
        payload = f.read()
    result = wa.request(
        wa.graph_url(cfg, session_id),
        method="POST",
        raw_body=payload,
        headers={
            "Authorization": "OAuth " + cfg["access_token"],
            "file_offset": "0",
            "Content-Type": "application/octet-stream",
        },
    )
    return result["h"]


def main():
    cfg = wa.load_config()
    products = wa.load_products()

    handles = {}
    for card in products["cards"]:
        slug = card["slug"]
        path = os.path.join(wa.IMG_DIR, slug + ".jpg")
        if not os.path.exists(path):
            print(f"  !! {slug}: {path} missing - run export_images.py first")
            continue
        print(f"  uploading {slug}.jpg ...", end=" ", flush=True)
        handles[slug] = upload_one(cfg, path)
        print("ok")

    with open(wa.HANDLES_PATH, "w", encoding="utf-8") as f:
        json.dump(handles, f, indent=2)
    print(f"\nSaved {len(handles)} handle(s) to media_handles.json")
    print("Next: python3 whatsapp/create_template.py")


if __name__ == "__main__":
    main()
