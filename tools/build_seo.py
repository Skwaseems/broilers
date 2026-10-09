"""Generate every SEO/branding artefact from site.config.json.

    python tools/build_seo.py

Writes: the <head> SEO block of index.html and admin.html, 404.html, robots.txt,
sitemap.xml, llms.txt, site.webmanifest, favicon.ico, apple-touch-icon.png,
icon-192.png, icon-512.png and og-image.jpg. Change the domain or business
details in site.config.json and re-run; nothing else hardcodes them.
"""

import datetime
import html
import json
import os
import re

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(ROOT, "tools", ".fonts")
GREEN = (34, 53, 42)
GOLD = (180, 156, 108)
WHITE = (255, 255, 255)

CFG = json.load(open(os.path.join(ROOT, "site.config.json"), encoding="utf-8"))
URL = CFG["site_url"].rstrip("/")
BIZ = CFG["business"]
E = html.escape

PRODUCTS = [
    "Live Broiler", "Whole Chicken", "Chicken Tandoori", "Breast Boneless", "Leg Boneless",
    "Curry Cut", "Chicken Wings", "Drumstick", "Thigh Boneless", "Boneless Trimming",
    "Chicken Keema", "Soup Piece", "Chicken Liver", "Gizzard", "Chicken Skin",
]


def write(rel, content, mode="w"):
    path = os.path.join(ROOT, rel)
    if mode == "w":
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)
    else:
        with open(path, "wb") as f:
            f.write(content)
    print("wrote", rel)


def icon_links():
    return "\n".join([
        '<link rel="icon" href="/favicon.ico" sizes="any">',
        '<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">',
        '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
        '<link rel="manifest" href="/site.webmanifest">',
        f'<meta name="theme-color" content="{CFG["theme_color"]}">',
    ])


def structured_data():
    address = {
        "@type": "PostalAddress",
        "streetAddress": BIZ["street_address"],
        "addressLocality": BIZ["locality"],
        "addressRegion": BIZ["region"],
        "postalCode": BIZ["postal_code"],
        "addressCountry": BIZ["country"],
    }
    graph = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "WebSite",
                "@id": URL + "/#website",
                "url": URL + "/",
                "name": CFG["name"],
                "inLanguage": "en-IN",
                "publisher": {"@id": URL + "/#business"},
            },
            {
                "@type": BIZ["schema_type"],
                "@id": URL + "/#business",
                "name": CFG["name"],
                "url": URL + "/",
                "description": CFG["description"],
                "image": URL + CFG["og_image"],
                "logo": URL + "/icon-512.png",
                "telephone": BIZ["telephone"],
                "email": BIZ["email"],
                "address": address,
                "geo": {"@type": "GeoCoordinates", "latitude": BIZ["latitude"], "longitude": BIZ["longitude"]},
                "areaServed": {"@type": "City", "name": BIZ["area_served"]},
                "foundingDate": BIZ["founding_year"],
            },
            {
                "@type": "WebPage",
                "@id": URL + "/#webpage",
                "url": URL + "/",
                "name": CFG["title"],
                "description": CFG["description"],
                "isPartOf": {"@id": URL + "/#website"},
                "about": {"@id": URL + "/#business"},
                "primaryImageOfPage": URL + CFG["og_image"],
            },
        ],
    }
    body = json.dumps(graph, ensure_ascii=False, indent=2).replace("</", "<\\/")
    return f'<script type="application/ld+json">\n{body}\n</script>'


def index_head():
    og_img = URL + CFG["og_image"]
    return "\n".join([
        f'<title>{E(CFG["title"])}</title>',
        f'<meta name="description" content="{E(CFG["description"])}">',
        f'<link rel="canonical" href="{URL}/">',
        '<meta name="robots" content="index, follow, max-image-preview:large">',
        icon_links(),
        '<meta property="og:type" content="website">',
        f'<meta property="og:site_name" content="{E(CFG["name"])}">',
        f'<meta property="og:locale" content="{CFG["locale"]}">',
        f'<meta property="og:url" content="{URL}/">',
        f'<meta property="og:title" content="{E(CFG["title"])}">',
        f'<meta property="og:description" content="{E(CFG["description"])}">',
        f'<meta property="og:image" content="{og_img}">',
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        f'<meta property="og:image:alt" content="{E(CFG["og_image_alt"])}">',
        '<meta name="twitter:card" content="summary_large_image">',
        f'<meta name="twitter:title" content="{E(CFG["title"])}">',
        f'<meta name="twitter:description" content="{E(CFG["description"])}">',
        f'<meta name="twitter:image" content="{og_img}">',
        f'<meta name="twitter:image:alt" content="{E(CFG["og_image_alt"])}">',
        structured_data(),
    ])


def replace_block(rel, block, anchor_after):
    path = os.path.join(ROOT, rel)
    src = open(path, encoding="utf-8").read()
    new_block = f"<!-- SEO:START -->\n{block}\n<!-- SEO:END -->"
    if "<!-- SEO:START -->" in src:
        src = re.sub(r"<!-- SEO:START -->.*?<!-- SEO:END -->", lambda _: new_block, src, count=1, flags=re.S)
    else:
        i = src.index(anchor_after) + len(anchor_after)
        src = src[:i] + "\n" + new_block + src[i:]
    write(rel, src)


def page_404():
    maps = f"https://www.google.com/maps/search/?api=1&amp;query={BIZ['latitude']}%2C{BIZ['longitude']}"
    tel = "tel:" + re.sub(r"[^+\d]", "", BIZ["telephone"])
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found – {E(CFG["name"])}</title>
<meta name="description" content="The page you were looking for doesn't exist on the {E(CFG["name"])} website.">
<meta name="robots" content="noindex, follow">
{icon_links()}
<style>
@font-face{{font-family:'Cormorant Garamond';font-style:normal;font-weight:300 700;font-display:swap;src:url(/assets/fonts/873ddb05.woff2) format('woff2');}}
@font-face{{font-family:'Jost';font-style:normal;font-weight:100 900;font-display:swap;src:url(/assets/fonts/df547798.woff2) format('woff2');}}
*{{box-sizing:border-box;}}
html,body{{margin:0;}}
body{{min-height:100vh;display:flex;flex-direction:column;background:#f7f5f1;color:#1c1c22;font-family:'Jost',system-ui,sans-serif;}}
a{{color:inherit;}}
header{{background:#fff;border-bottom:1px solid #eceae7;padding:18px 16px;text-align:center;}}
.brand{{display:inline-block;text-decoration:none;}}
.brand b{{display:block;font-family:'Cormorant Garamond',Georgia,serif;font-weight:400;font-size:clamp(24px,3vw,38px);letter-spacing:.2em;padding-left:.2em;line-height:1;}}
.brand small{{display:block;margin-top:6px;font-size:10px;letter-spacing:.34em;padding-left:.34em;text-transform:uppercase;color:#54535c;}}
main{{flex:1;display:flex;align-items:center;justify-content:center;padding:56px 16px;}}
.card{{max-width:560px;width:100%;text-align:center;}}
.code{{font-size:12px;letter-spacing:.34em;padding-left:.34em;text-transform:uppercase;color:#846e3e;}}
.rule{{width:64px;height:2px;background:#b49c6c;margin:18px auto 22px;}}
h1{{margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-weight:500;font-size:clamp(30px,5vw,46px);line-height:1.1;}}
p{{margin:16px auto 0;max-width:44ch;font-size:15px;line-height:1.7;color:#4a4a53;}}
.actions{{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;margin-top:30px;}}
.btn{{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 28px;border-radius:999px;font-size:13px;font-weight:500;letter-spacing:.09em;text-transform:uppercase;text-decoration:none;transition:background .25s,color .25s,border-color .25s;}}
.btn-primary{{background:#846e3e;color:#fff;border:1px solid #846e3e;}}
.btn-primary:hover{{background:#6f5d34;border-color:#6f5d34;}}
.btn-ghost{{border:1px solid #d5d0c6;color:#1c1c22;}}
.btn-ghost:hover{{border-color:#1c1c22;}}
.btn:focus-visible,.links a:focus-visible,.brand:focus-visible{{outline:2px solid #1c1c22;outline-offset:3px;}}
nav.links{{margin-top:34px;display:flex;flex-wrap:wrap;gap:8px 22px;justify-content:center;font-size:14px;}}
nav.links a{{color:#54535c;text-decoration:underline;text-underline-offset:4px;text-decoration-color:#cfc8bb;}}
nav.links a:hover{{color:#1c1c22;}}
footer{{background:#b49c6c;color:#241d10;padding:22px 16px;text-align:center;font-size:13px;line-height:1.7;}}
footer address{{font-style:normal;}}
</style>
</head>
<body>
<header><a class="brand" href="/" aria-label="{E(CFG["name"])} home"><b>SHARHAN</b><small>Fresh Poultry Supply</small></a></header>
<main>
  <div class="card">
    <div class="code">Error 404</div>
    <div class="rule" aria-hidden="true"></div>
    <h1>We couldn&rsquo;t find that page</h1>
    <p>The link may be old or mistyped. Our full range of fresh and frozen chicken is on the homepage, and you can send us your weekly requirement from there.</p>
    <div class="actions">
      <a class="btn btn-primary" href="/">Go to homepage</a>
      <a class="btn btn-ghost" href="/#categories">Browse categories</a>
    </div>
    <nav class="links" aria-label="Helpful links">
      <a href="/#stock">Today&rsquo;s fresh stock</a>
      <a href="/#packs">Packs</a>
      <a href="{tel}">Call {E(BIZ["telephone_display"])}</a>
      <a href="{maps}" target="_blank" rel="noopener">Get directions</a>
    </nav>
  </div>
</main>
<footer>
  <address>{E(CFG["name"])} &middot; {E(BIZ["street_address"])}, {E(BIZ["locality"])} {E(BIZ["postal_code"])}</address>
</footer>
</body>
</html>
"""


def robots():
    lines = ["User-agent: *", "Allow: /"]
    lines += [f"Disallow: /{p}" for p in CFG["noindex_pages"]]
    lines += ["", f"Sitemap: {URL}/sitemap.xml", ""]
    return "\n".join(lines)


def sitemap():
    today = datetime.date.today().isoformat()
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>{URL}/</loc>
    <lastmod>{today}</lastmod>
  </url>
</urlset>
"""


def llms():
    products = "\n".join(f"- {n}" for n in PRODUCTS)
    addr = f"{BIZ['street_address']}, {BIZ['locality']}, {BIZ['region']} {BIZ['postal_code']}, India"
    return f"""# {CFG["name"]}

> {CFG["name"]} (established {BIZ["founding_year"]}) are suppliers and contractors of live and processed chicken broilers, supplying fresh and frozen chicken to hotels, restaurants, caterers and cloud kitchens across Mumbai.

## Products

Live broilers, and processed chicken supplied fresh or frozen:

{products}

## How to order

Business customers fill in their approximate weekly requirement on the website (kg per day for each product, fresh and/or frozen), and can book a specific delivery day: bookings made before 3:00 PM are delivered the next day. The form sends the order to {CFG["name"]} by WhatsApp or email. Rates follow the daily mandi rate and are confirmed at the time of order.

## Contact

- Phone / WhatsApp: {BIZ["telephone_display"]}
- Email: {BIZ["email"]}
- Office address: {addr}

## Pages

- [Home]({URL}/): Product categories, today's fresh stock, packs and the weekly order form
- [Product categories]({URL}/#categories)
- [Today's fresh stock]({URL}/#stock)
- [Packs]({URL}/#packs)
- [Visit us]({URL}/#visit)
- [Contact]({URL}/#contact)
"""


def manifest():
    return json.dumps({
        "name": CFG["name"],
        "short_name": "Sharhan",
        "description": CFG["description"],
        "start_url": "/",
        "display": "browser",
        "background_color": "#ffffff",
        "theme_color": CFG["theme_color"],
        "icons": [
            {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }, indent=2) + "\n"


def font(name, size, weight):
    f = ImageFont.truetype(os.path.join(FONT_DIR, name), size)
    try:
        f.set_variation_by_axes([weight])
    except (OSError, AttributeError):
        pass
    return f


def spaced_text(draw, xy_center, text, fnt, fill, tracking):
    widths = [draw.textlength(ch, font=fnt) for ch in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x = xy_center[0] - total / 2
    for ch, w in zip(text, widths):
        draw.text((x, xy_center[1]), ch, font=fnt, fill=fill, anchor="ls")
        x += w + tracking


def monogram(size):
    """Square brand mark: green field, thin gold rule, serif 'S' (or 'SB' when large)."""
    img = Image.new("RGB", (size, size), GREEN)
    d = ImageDraw.Draw(img)
    text = "SB" if size >= 128 else "S"
    fnt = font("CormorantGaramond.ttf", int(size * (0.44 if text == "SB" else 0.8)), 500)
    track = size * 0.03 if text == "SB" else 0
    baseline = size * (0.62 if text == "SB" else 0.74)
    spaced_text(d, (size / 2 + track / 2, baseline), text, fnt, WHITE, track)
    if size >= 128:
        w = size * 0.5
        d.rectangle([size / 2 - w / 2, size * 0.72, size / 2 + w / 2, size * 0.72 + max(2, size * 0.012)], fill=GOLD)
    return img


def og_image():
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), GREEN)
    photo = Image.open(os.path.join(ROOT, "assets", "img", "whole.webp")).convert("RGB")
    pw = 560
    scale = max(pw / photo.width, H / photo.height)
    photo = photo.resize((round(photo.width * scale), round(photo.height * scale)), Image.LANCZOS)
    left = (photo.width - pw) // 2
    top = (photo.height - H) // 2
    img.paste(photo.crop((left, top, left + pw, top + H)), (0, 0))
    d = ImageDraw.Draw(img)
    cx = pw + (W - pw) / 2
    d.rectangle([cx - 150, 214, cx + 150, 217], fill=GOLD)
    spaced_text(d, (cx + 7, 330), "SHARHAN", font("CormorantGaramond.ttf", 82, 400), WHITE, 16)
    spaced_text(d, (cx + 4, 382), "FRESH POULTRY SUPPLY", font("Jost.ttf", 22, 400), GOLD, 7)
    spaced_text(d, (cx, 470), "Wholesale chicken for Mumbai's kitchens", font("Jost.ttf", 25, 300), (231, 226, 216), 0)
    return img


def save_img(img, rel, **kw):
    img.save(os.path.join(ROOT, rel), **kw)
    print("wrote", rel)


def main():
    replace_block("index.html", index_head(), '<meta name="viewport" content="width=device-width, initial-scale=1">')
    admin_head = "\n".join(['<meta name="robots" content="noindex, nofollow">', icon_links()])
    replace_block("admin.html", admin_head, '<meta name="viewport" content="width=device-width, initial-scale=1.0">')

    write("404.html", page_404())
    write("robots.txt", robots())
    write("sitemap.xml", sitemap())
    write("llms.txt", llms())
    write("site.webmanifest", manifest())

    save_img(monogram(64), "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    save_img(monogram(180), "apple-touch-icon.png")
    save_img(monogram(192), "icon-192.png")
    save_img(monogram(512), "icon-512.png")
    save_img(og_image(), "og-image.jpg", quality=86, optimize=True, progressive=True)


if __name__ == "__main__":
    main()
