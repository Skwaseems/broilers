"""Step 2: create the carousel marketing template and submit it for approval.

Each card = product image + short spec line + a "Shop now" button that opens
    <site_base_url>/?item=<slug>
which the website turns into a full-screen product landing.

    python3 whatsapp/create_template.py

Meta requires every card to have an identical component structure, which this
script guarantees by building all cards from the same shape.
"""

import json
import os
import sys

import wa_common as wa

MAX_CARDS = 10  # Meta's per-carousel limit


def build_components(cfg, products, handles):
    cards = []
    for card in products["cards"][:MAX_CARDS]:
        slug = card["slug"]
        handle = handles.get(slug)
        if not handle:
            sys.exit(f"No media handle for '{slug}'. Run upload_media.py first.")
        cards.append(
            {
                "components": [
                    {
                        "type": "HEADER",
                        "format": "IMAGE",
                        "example": {"header_handle": [handle]},
                    },
                    {"type": "BODY", "text": card["text"]},
                    {
                        "type": "BUTTONS",
                        "buttons": [
                            {
                                "type": "URL",
                                "text": products.get("button_text", "Shop now"),
                                "url": f"{cfg['site_base_url'].rstrip('/')}/?item={slug}",
                            }
                        ],
                    },
                ]
            }
        )
    return [
        {"type": "BODY", "text": products["body"]},
        {"type": "CAROUSEL", "cards": cards},
    ]


def main():
    cfg = wa.load_config()
    products = wa.load_products()

    if not os.path.exists(wa.HANDLES_PATH):
        sys.exit("media_handles.json not found - run upload_media.py first.")
    with open(wa.HANDLES_PATH, encoding="utf-8") as f:
        handles = json.load(f)

    payload = {
        "name": cfg["template_name"],
        "language": cfg["language"],
        "category": "MARKETING",
        "components": build_components(cfg, products, handles),
    }

    print(f"Submitting template '{cfg['template_name']}' with "
          f"{len(payload['components'][1]['cards'])} cards ...")
    result = wa.request(
        wa.graph_url(cfg, f"{cfg['waba_id']}/message_templates"),
        method="POST",
        token=cfg["access_token"],
        json_body=payload,
    )
    print(json.dumps(result, indent=2))
    print(
        "\nStatus starts as PENDING. Approval usually lands within minutes to a few hours.\n"
        "Track it in WhatsApp Manager > Message templates.\n"
        "Once APPROVED: python3 whatsapp/send_carousel.py <recipient numbers>"
    )


if __name__ == "__main__":
    main()
