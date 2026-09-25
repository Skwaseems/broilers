"""Step 3: send the approved carousel template to one or more customers.

    python3 whatsapp/send_carousel.py 919876543210 919812345678
    python3 whatsapp/send_carousel.py --file recipients.txt

Numbers are in international format, digits only, no '+'.

Card images are pulled by Meta from image_base_url at send time, so those files
must already be deployed and publicly reachable.

Reminder: marketing templates may only go to customers who opted in, and a new
number is capped (around 250 unique recipients / 24h) until its quality rating
raises the limit.
"""

import sys
import time

import wa_common as wa


def build_template(cfg, products):
    base = cfg["image_base_url"].rstrip("/")
    cards = []
    for i, card in enumerate(products["cards"][:10]):
        cards.append(
            {
                "card_index": i,
                "components": [
                    {
                        "type": "header",
                        "parameters": [
                            {
                                "type": "image",
                                "image": {"link": f"{base}/{card['slug']}.jpg"},
                            }
                        ],
                    }
                ],
            }
        )
    return {
        "name": cfg["template_name"],
        "language": {"code": cfg["language"]},
        "components": [{"type": "carousel", "cards": cards}],
    }


def read_recipients(argv):
    if not argv:
        sys.exit(__doc__)
    if argv[0] == "--file":
        if len(argv) < 2:
            sys.exit("--file needs a path")
        with open(argv[1], encoding="utf-8") as f:
            return [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
    return argv


def main():
    cfg = wa.load_config()
    products = wa.load_products()
    recipients = read_recipients(sys.argv[1:])
    template = build_template(cfg, products)

    sent = failed = 0
    for number in recipients:
        digits = "".join(ch for ch in number if ch.isdigit())
        if not digits:
            print(f"  skipping '{number}' - no digits")
            continue
        print(f"  -> {digits} ...", end=" ", flush=True)
        result = wa.request(
            wa.graph_url(cfg, f"{cfg['phone_number_id']}/messages"),
            method="POST",
            token=cfg["access_token"],
            json_body={
                "messaging_product": "whatsapp",
                "to": digits,
                "type": "template",
                "template": template,
            },
            fatal=False,
        )
        if result is None:
            failed += 1
        else:
            print((result.get("messages") or [{}])[0].get("id", "sent"))
            sent += 1
        time.sleep(0.4)  # stay well under the rate limit

    print(f"\nSent {sent}, failed {failed}.")


if __name__ == "__main__":
    main()
