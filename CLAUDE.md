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
- `functions/p/[slug].js` — Cloudflare Pages Function behind WhatsApp "Enroll Now" buttons.
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

Live: https://sharhan-broilers.pages.dev and https://sharhan-broilers.web.app (same site).

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
- KYC photos (Aadhaar/PAN) are sensitive: they are only served to signed-in admins.
