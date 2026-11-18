# Sharhan Broilers website

B2B poultry site for Sharhan Broilers, Mumbai. Plain static HTML (no build framework) plus a
Cloudflare Worker for WhatsApp and credit, Firestore for editable content.

## Where things are

- `index.html` — homepage + the order (requisition) form. The homepage is rendered by the
  dc-runtime (`<x-dc>` template: `{{ }}`, `sc-if`, `sc-for`; camelCase attributes need
  `sc-camel-*`). React renders after page scripts run, so attach behaviour with document-level
  event delegation.
  - A loader in `<head>` reads Firestore `site_content/{main,orders,form,payment}` + `catalogue`
    over REST into `window.__sbContent`, `__sbCatalogue`, `__sbOrderTo`, `__sbFormItems`,
    `__sbPayment`, then fires the `sb-content` event.
  - The order form is in English / Hindi / Marathi: every visible string goes through
    `sbT(key)` with entries in all three dictionaries (`DICT.en/hi/mr`); markup uses
    `data-i18n`, `data-i18n-html`, `data-i18n-ph`. The order message itself stays English.
- `admin.html` — admin panel (Google sign-in). Edits catalogue, website content, order
  recipients, form products, payments & credit, credit applications, WhatsApp sending.
- `cloudflare-worker/src/index.js` — Worker `sharhan-whatsapp`: WhatsApp webhook (auto-reply,
  STOP/START), template submit/send, catalogue images in KV, `/credit-check`, `/credit-apply`,
  admin-only `/kyc/...`.
- `functions/p/[slug].js` — Cloudflare Pages Function behind WhatsApp "Enroll Now" buttons: the item's own page
  (photo, description, other products, "Fill your approx. qty. weekly requirement"). That button goes to `/?item=<id>&order=1`, which shows only the form.
- `firestore.rules` — security rules.
- `tools/build_public.py` — copies the public files into `dist/` (an allowlist).

## Deploying

Pushing to `main` deploys automatically (`.github/workflows/deploy.yml`): website to Cloudflare
Pages **and** Firebase Hosting, the Worker when `cloudflare-worker/` changes, the rules when
`firestore.rules` changes. Check the Actions tab after pushing.

Manual (from the repo root, on the owner's PC): `python tools/build_public.py`, then
`npx wrangler pages deploy dist --project-name sharhan-broilers --branch main --commit-dirty=true`
and `npx firebase-tools deploy --only hosting`; Worker: `cd cloudflare-worker && npx wrangler deploy`;
rules: `npx firebase-tools deploy --only firestore:rules`. Never run `wrangler pages` from
`cloudflare-worker/`.

Live: https://sharhanbroilers.co.in (main address since 15 Nov 2026; Firebase Hosting custom domain, DNS at GoDaddy;
www redirects to it), also https://sharhan-broilers.pages.dev and https://sharhan-broilers.web.app (same site).
`/p/<slug>` item pages run only on pages.dev (firebase.json redirects there); the Worker's SITE_URL and WhatsApp links stay on pages.dev.

## Rules

- This repo is PUBLIC. Never commit secrets: `whatsapp/config.json` (Meta token) is gitignored;
  Worker secrets live only on Cloudflare (`wrangler secret put`).
- Admins normally sign in with an admin ID + password (Worker `src/staff.js`, accounts in Firestore
  `admin_users`, managed by the main admin in Admin → Users; 5 wrong tries lock an ID for 15 min).
  The owner (`OWNER_EMAIL` = waseemshaikh597@gmail.com) can always set up / reset the main admin,
  via Google sign-in or the "Forgot password?" email link. Never set passwords yourself.
- Google sign-in is the backup. A Google admin email must be in all three lists: `ALLOWED_EMAILS` in
  admin.html, `isAdmin()` in firestore.rules, `ALLOWED_EMAILS` in cloudflare-worker/wrangler.toml.
- Don't invent business facts (certifications, years, prices); only use what the owner gives.
- The owner prefers free options over paid services.
- WhatsApp template wording that echoes an existing template gets auto-rejected by Meta
  (INVALID_FORMAT); new templates need fresh wording.
- Never put a customer's or the owner's family's phone number in this repo. Admin → Users → "Remove a number from all
  records" clears a number; `hidden_numbers` keeps only its hash, and the webhook then ignores it.
- Each KYC document has "Take photo" (camera, `capture`) and "Choose file" buttons (`sbCaPickers`).
- KYC photos (Aadhaar/PAN/cheque/selfie/signature) are sensitive: they are only served to signed-in admins.
  Only the last 4 Aadhaar digits are collected as text; the order form's saved copy must never hold KYC fields.
- Homepage sections Categories, Cold Chain banner, Frequently Ordered Together, Portioned banner and Also From Our Floor
  are hidden with `display:none`. Keep the Categories cards in the page: the menu's product names open their photos.
- The order form has two steps: the weekly requirement, then, once that is sent (`weeklySent` in the saved form), only
  Enroll Now For Next Day Delivery. The customer's saved details and that flag are cleared together on sign-out.
- Customer item rates: Admin → Rates, only for the main admin, IDs `admin` and `hanif`, and the two Google emails listed in
  `RATE_ADMINS` (admin.html) and `canSetRates()` (firestore.rules): change both. It writes `customer_rates/{mobile}`; the form's Enroll Now step
  gets one number's rates from the Worker's `/customer-rates`, so anyone who types a number sees that number's rates.
- Daily market rate pricing (owner's diary rate sheet, built 18 Nov 2026): customers whose rate type is Daily get formula prices.
  Admin → Rates → Daily market rates: the paper rate and S.K. Patel lifting rate typed each day (`rate_settings/today`) and the formula
  lines (`rate_settings/formulas`: base paper/lifting/fixed, × and +/− ₹ for levels 1–3, linked to a form product). Each daily customer
  has a level (`customer_rates.level`). The Worker's `/customer-rates` works the prices out (`dailyPrice`, same arithmetic in admin.html)
  and overrides typed rates for products with a formula. The formulas and figures stay in Firestore (rate admins only), never in this repo.
  The owner's 21-line sheet is the Worker secret `RATE_SHEET` (`/rate-sheet`, rate admins only); Admin → Rates → "Set up rate sheet"
  (one tap, shown while there are no formulas) copies it to Firestore and splits the form products into the sheet's kinds
  (`SHEET_SPLIT` in admin.html: BBL/LBL UT/Partial/Full, curry cut, drumstick, wings; adds Chicken Supreme). W/S = With Skin.
- Each customer's rates can also have a remark per item, a rate type (daily/weekly/monthly) and From/To dates, stored in the same
  `customer_rates` doc and never sent to the public form. "Send on WhatsApp" opens the admin's own WhatsApp (wa.me) with the rates and saves them.
- Sending the weekly requirement records the customer in `form_customers/{mobile}` (via the Worker's `/form-customer`) so
  they appear in Customer rates, with their Rate Selection (`rateType`), which fills Rates -> Rate type unless an admin saved one later. It's kept apart from `whatsapp_customers`, the catalogue list, which needs their consent.
- After Send Catalogue Now, the customers WhatsApp accepted are unticked (`send: false`); failed ones stay ticked.
- Quantities must be multiples of the chosen pack (`SB_PACK_MULTIPLES = true` in index.html, back on since 15 Nov 2026); since 17 Nov
  other amounts are rounded UP to the next full pack when the customer leaves the box (owner's choice), with a green note. Set it to
  false to accept any quantity: the form then shows the packing breakdown (full packs + kg loose) and the pack discount applies only to kg in full packs.
- Admin → Credit → Bank QR & UPI holds up to two banks: bank 1 at the top of `site_content/payment`, bank 2 under `bank2`, each with a QR
  and an optional logo. The form and the homepage show a tile per bank (logo, or the bank name); tapping one (`data-sb-bank`) opens
  `sbOpenBank`'s popup with the QR and details. In `?order=1` mode the popup must stay outside the `body>*` hide rule.
- Homepage section headings are editable in Admin → Website content → Section headings (`site_content/main.headings`; empty = built-in text).
- Admin → Website content: each banner slide has an optional link (#section or https://; empty = tapping the banner opens the order
  form), each Photo grid photo its own caption, Visit us a "Locate Our Unit" map link. A sticky Enroll Now button (bottom centre, appears after the banner) opens the form, which opens with a circle-reveal animation from the tap.
- The order form shows 3 tappable steps (weekly requirement → next-day order → booking & rates confirmed; `sbGoStep(n)`, any step
  any time; step 2 never shows the Client Profile (owner, 17 Nov): sending it without name/mobile/location goes back to step 1 at the
  empty box; there's no Modify Weekly Requirement button, step 1 is opened by tapping it; step 3 is an info panel), a help line, a "we'll contact you
  within 24 hours" note and a "submitted successfully" box after sending. Microsoft Clarity is on (project ID zeotiyvqlh, in the loader at the end of index.html); the order form is masked (`data-clarity-mask`).
- The website's floating WhatsApp button goes to the first number in Admin → Order form → Order recipients.
- Admin → Send shows an approximate WhatsApp balance and a Recharge link. Meta has no API for the balance: an admin types Meta's figure
  (`settings/whatsapp_balance`) and the Worker's `/balance` subtracts Meta's charges since then plus 18% GST. It needs retyping after each recharge.
- WhatsApp usage (today / this month) and the payment alert in Admin → Send are hidden for now (`USAGE_ON` in admin.html).
- eKYC (KYC form, selfie, signature, terms, admin PDF and share) is ON since 17 Nov 2026 (owner approved): `SB_EKYC` in index.html,
  `EKYC_TOOLS` in admin.html and `EKYC = "on"` in wrangler.toml must all match (false/false/remove the line turns it off).
- The eKYC declaration and terms are in both index.html and the Worker (`KYC_DECLARATION`, `KYC_TERMS`): change both.
