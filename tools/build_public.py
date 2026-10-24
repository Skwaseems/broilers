"""Copy the public website into dist/ for Cloudflare Pages.

An allowlist, not an ignore list: only the files below are published, so tooling,
backups and secrets (whatsapp/config.json holds a permanent Meta token) can never
leak by accident.

    python tools/build_public.py
    npx wrangler pages deploy dist --project-name sharhan-broilers --branch main
"""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

FILES = [
    "index.html", "admin.html", "404.html",
    "favicon.ico", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "og-image.jpg",
    "robots.txt", "sitemap.xml", "llms.txt", "site.webmanifest",
]
DIRS = ["assets", "images"]
# Unreferenced legacy photos kept in the repo but not published.
SKIP = {"images/chicken-breast.jpg", "images/delivery.jpg", "images/whole-chicken.jpg", "images/hero.jpeg"}


def main():
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir()
    count = 0
    for name in FILES:
        shutil.copy2(ROOT / name, DIST / name)
        count += 1
    for d in DIRS:
        for src in (ROOT / d).rglob("*"):
            rel = src.relative_to(ROOT).as_posix()
            if src.is_dir() or rel in SKIP:
                continue
            dest = DIST / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            count += 1
    print(f"dist/: {count} files")


if __name__ == "__main__":
    main()
