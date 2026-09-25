# WhatsApp catalogue ads

Sends a carousel message — product photo, spec line, and a **Shop now** button that
opens `sharhan.co.in/?item=<slug>`, which shows that product full-width at the top
of the site with the rest of the catalogue below.

Everything here is standard-library Python 3. Nothing to install.

---

## One-time setup in Meta (must be done by the account owner)

1. **Meta Business Manager** → complete **business verification**.
2. Create an app at [developers.facebook.com](https://developers.facebook.com) → add the **WhatsApp** product.
3. Create a **WhatsApp Business Account (WABA)** and register the **sending number**.

   > ⚠️ A number registered on the Cloud API **stops working in the normal WhatsApp
   > and WhatsApp Business apps**. Use a separate number — keep 7709183214 as the
   > human number that receives requisitions.

4. Create a **System User** with admin access to the WABA and generate a
   **permanent access token** (scopes: `whatsapp_business_messaging`,
   `whatsapp_business_management`).
5. Collect four values: **access token**, **app ID**, **WABA ID**, **phone number ID**.

Then locally:

```bash
cp whatsapp/config.example.json whatsapp/config.json
```

and fill those four values in. `config.json` is gitignored — never commit the token.

> **Get the domain live first.** The `Shop now` URL is baked into the template when
> Meta approves it. Creating the template while `site_base_url` still points at a
> domain that isn't live means the buttons go nowhere, and changing it later needs a
> brand-new template and a fresh approval.

---

## Running it

```bash
python3 whatsapp/export_images.py     # bundle photos -> images/products/*.jpg (1:1)
python3 whatsapp/upload_media.py      # upload to Meta -> media_handles.json
python3 whatsapp/create_template.py   # submit the carousel template for approval
```

Wait for the template to show **APPROVED** in WhatsApp Manager → Message templates
(usually minutes, sometimes a few hours). Then:

```bash
python3 whatsapp/send_carousel.py 919876543210
python3 whatsapp/send_carousel.py --file recipients.txt
```

Numbers are international format, digits only, no `+`.

---

## Before you send to real customers

- **Opt-in is mandatory.** Marketing templates may only go to people who agreed to
  receive them. Meta enforces this through quality ratings and can restrict the number.
- **New numbers are capped** at roughly 250 unique recipients per 24 hours; the limit
  rises automatically as quality stays good.
- **Card images are fetched by Meta from `image_base_url` at send time**, so
  `images/products/` must already be deployed and publicly reachable.
  Check with: `curl -I https://sharhan.co.in/images/products/curry-cut.jpg`

> This `whatsapp/` folder is listed in `.surgeignore` and is **never deployed** —
> otherwise `config.json` would be downloadable at a public URL, exposing the access
> token. The card images live in `images/products/` for exactly that reason. Don't
> move them back in here.

## Editing the catalogue

`products.json` holds the opening message, the button label, and each card's slug +
spec line (max 10 cards). Slugs must match the ones the website understands —
`curry-cut`, `breast-fillet`, `whole-chicken`, `drumsticks`, `thigh-boneless`,
`wings`, `soup-pieces`, `liver-gizzard`.

Changing card text or the button URL means **creating a new template** (approved
templates are immutable) — bump `template_name` in `config.json` and re-run
`create_template.py`.

## Files

| file | purpose |
|---|---|
| `export_images.py` | pulls product photos out of `index.html` into `images/products/`, cropped 1:1 |
| `upload_media.py` | resumable upload → `media_handles.json` |
| `create_template.py` | submits the carousel template |
| `send_carousel.py` | sends the approved template |
| `wa_common.py` | config loading + Graph API helper |
| `products.json` | catalogue copy and card order |
