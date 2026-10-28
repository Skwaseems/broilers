import { listDocuments, addDocument, getDocument, setDocument } from "./firestore.js";
import { verifyFirebaseIdToken } from "./verifyIdToken.js";
import { staffRoute, requireStaff } from "./staff.js";

const GRAPH = "https://graph.facebook.com/v21.0";
const MAX_CARDS_PER_CAROUSEL = 10; // Meta's hard limit for carousel templates
const MAX_CATALOGUE_ITEMS = 15;
const MAX_CARD_TEXT = 160; // Meta's limit for a carousel card body
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const SEND_BATCH_MAX = 10; // keeps each request under Cloudflare's free-plan subrequest cap

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function isAllowedEmail(env, email) {
  const allowed = (env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return !!email && allowed.includes(email.toLowerCase());
}

async function requireAuthorizedUser(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) throw new Error("Missing Authorization header");
  const payload = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
  // Admin ID + password sessions (staff.js): allowed while the account is on. Logs such as
  // sentBy / decidedBy show them as "Name (id)".
  if (payload.sb_user) {
    const staff = await requireStaff(env, payload);
    return { ...payload, staff, email: staff.name ? `${staff.name} (${staff.id})` : staff.id, email_verified: false };
  }
  if (!payload.email_verified || !isAllowedEmail(env, payload.email)) {
    throw new Error("Email not authorized");
  }
  return payload;
}

async function graph(env, path, init = {}) {
  const res = await fetch(`${GRAPH}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.META_ACCESS_TOKEN}`, ...(init.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && (data.error.error_user_msg || data.error.message)) || JSON.stringify(data));
  return data;
}

// ---- Credit approval (Admin → Payments & credit, stored in settings/credit) ----

// Cached per isolate for a minute, so repeated checks don't each cost a Firestore read.
let creditCache = { at: 0, set: new Set() };
async function creditMobiles(env) {
  if (Date.now() - creditCache.at < 60000) return creditCache.set;
  const doc = await getDocument(env, "settings", "credit").catch(() => null);
  const list = doc && Array.isArray(doc.customers) ? doc.customers : [];
  const set = new Set(list.map((c) => String((c && c.mobile) || "").replace(/\D/g, "").slice(-10)).filter((m) => m.length === 10));
  creditCache = { at: Date.now(), set };
  return set;
}

// ---- Credit applications: the customer uploads self-attested KYC photos from the order
// form; an admin checks them in Admin → Payments & credit and approves or rejects.
// Photos live in KV under kyc:<mobile>:<slot> and are only ever served to admins.
const KYC_SLOTS = ["aadhaar_front", "aadhaar_back", "pan", "business"];
const KYC_REQUIRED = ["aadhaar_front", "pan", "business"];
const KYC_MAX_BYTES = 1024 * 1024; // the form shrinks photos to ~300 KB before upload
const KYC_MAX_PENDING = 100; // stops a flood of fake applications filling the free KV store
const kycKey = (mobile, slot) => `kyc:${mobile}:${slot}`;

async function creditApply(env, request) {
  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: "Invalid form" }, 400);
  const text = (k, max) => String(form.get(k) || "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, max);
  const mobile = String(form.get("mobile") || "").replace(/\D/g, "").slice(-10);
  const app = {
    mobile,
    name: text("name", 100),
    owner: text("owner", 100),
    contact: text("contact", 100),
    location: text("location", 200),
    lang: text("lang", 5),
  };
  if (mobile.length !== 10 || !/^[6-9]/.test(mobile)) return json({ error: "mobile" }, 400);
  if (!app.name) return json({ error: "name" }, 400);
  if (form.get("consent") !== "yes") return json({ error: "consent" }, 400);
  if ((await creditMobiles(env)).has(mobile)) return json({ status: "approved" });

  const files = {};
  for (const slot of KYC_SLOTS) {
    const f = form.get(slot);
    if (!f || typeof f === "string" || !f.size) continue;
    const bytes = await f.arrayBuffer();
    const head = new Uint8Array(bytes.slice(0, 3));
    if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return json({ error: "type", slot }, 400);
    if (bytes.byteLength > KYC_MAX_BYTES) return json({ error: "size", slot }, 400);
    files[slot] = bytes;
  }
  const missing = KYC_REQUIRED.filter((s) => !files[s]);
  if (missing.length) return json({ error: "missing", slots: missing }, 400);

  const prev = await getDocument(env, "credit_applications", mobile).catch(() => null);
  if (!prev || prev.status !== "pending") {
    const pending = (await listDocuments(env, "credit_applications")).filter((a) => a.status === "pending").length;
    if (pending >= KYC_MAX_PENDING) return json({ error: "busy" }, 429);
  }
  for (const slot of KYC_SLOTS) {
    if (files[slot]) await env.CATALOGUE_IMAGES.put(kycKey(mobile, slot), files[slot]);
    else await env.CATALOGUE_IMAGES.delete(kycKey(mobile, slot)); // a re-application replaces the old set
  }
  const at = new Date().toISOString();
  await setDocument(env, "credit_applications", mobile, {
    ...app, docs: Object.keys(files), status: "pending", submittedAt: at, consentAt: at,
    reapplied: !!prev, previousStatus: prev ? prev.status || "" : "",
  });
  return json({ status: "pending" });
}

async function creditStatus(env, mobile) {
  if ((await creditMobiles(env)).has(mobile)) return { approved: true, application: "approved" };
  const app = await getDocument(env, "credit_applications", mobile).catch(() => null);
  return { approved: false, application: app ? app.status || "" : "" };
}

// ---- WhatsApp webhook (Meta -> us) ----

// "🛒 Order: 2 × curry-cut (₹350/kg), 1 × drumstick (₹320/kg)" + any note the customer typed.
function orderText(order) {
  if (!order || !Array.isArray(order.product_items)) return null;
  const lines = order.product_items.map((p) => `${p.quantity} × ${p.product_retailer_id}` + (p.item_price ? ` (₹${p.item_price}/kg)` : ""));
  return "🛒 Order: " + lines.join(", ") + (order.text ? ` — “${order.text}”` : "");
}

function extractIncomingMessages(payload) {
  const out = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const msg of value.messages || []) {
        const contact = (value.contacts || [])[0];
        out.push({
          from: msg.from,
          name: contact?.profile?.name || null,
          type: msg.type,
          text: msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || orderText(msg.order) || null,
          payload: msg.button?.payload || null, // e.g. the item id behind a catalogue card's "Enquire Now"
          order: msg.order || null, // cart sent from a product card's View screen
          waMessageId: msg.id,
          timestamp: new Date(parseInt(msg.timestamp, 10) * 1000).toISOString(),
          receivedAt: new Date().toISOString(),
        });
      }
    }
  }
  return out;
}

function extractStatuses(payload) {
  const out = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const st of value.statuses || []) {
        out.push({
          waMessageId: st.id,
          recipient: st.recipient_id,
          status: st.status,
          errors: st.errors || null,
          timestamp: new Date(parseInt(st.timestamp, 10) * 1000).toISOString(),
          receivedAt: new Date().toISOString(),
        });
      }
    }
  }
  return out;
}

// ---- Catalogue ----

function imageKey(slug) {
  return "img:" + slug;
}

function isValidSlug(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 60;
}

// Carousels need 2–10 cards, so 15 items go out as 10 + 5 (and 11 as 9 + 2).
function splitIntoCarousels(items) {
  const n = items.length;
  if (n <= MAX_CARDS_PER_CAROUSEL) return [items];
  const first = n - MAX_CARDS_PER_CAROUSEL < 2 ? n - 2 : MAX_CARDS_PER_CAROUSEL;
  return [items.slice(0, first), items.slice(first)];
}

async function sortedCatalogue(env) {
  const items = await listDocuments(env, "catalogue");
  return items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// Meta's template API wants an "upload handle" for each example header image,
// obtained through its resumable upload API.
async function uploadExampleImage(env, bytes) {
  const session = await graph(
    env,
    `${env.META_APP_ID}/uploads?file_length=${bytes.byteLength}&file_type=image/jpeg`,
    { method: "POST" }
  );
  const res = await fetch(`${GRAPH}/${session.id}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${env.META_ACCESS_TOKEN}`, file_offset: "0" },
    body: bytes,
  });
  const data = await res.json();
  if (!res.ok || !data.h) throw new Error("Image upload to Meta failed: " + JSON.stringify(data));
  return data.h;
}

const CAROUSEL_BODY = [
  "Fresh from the Sharhan Broilers floor. Tap any item below for details and to send us your requirement.",
  "More from Sharhan Broilers. Tap any item below for details and to send us your requirement.",
];

async function submitCatalogue(env, user, origin) {
  const items = await sortedCatalogue(env);
  if (items.length < 2) throw new Error("Add at least 2 items before submitting.");
  if (items.length > MAX_CATALOGUE_ITEMS) throw new Error(`The catalogue can have at most ${MAX_CATALOGUE_ITEMS} items.`);
  for (const it of items) {
    if (!it.name) throw new Error(`"${it.id}" needs a name.`);
    if ((it.spec || "").length > MAX_CARD_TEXT) throw new Error(`"${it.name}" card text is over ${MAX_CARD_TEXT} characters.`);
  }

  const meta = (await getDocument(env, "catalogue_meta", "whatsapp")) || {};
  const version = (meta.version || 1) + 1;
  const templates = [];
  const parts = splitIntoCarousels(items);

  for (let p = 0; p < parts.length; p++) {
    const cards = [];
    for (const it of parts[p]) {
      const bytes = await env.CATALOGUE_IMAGES.get(imageKey(it.id), "arrayBuffer");
      if (!bytes) throw new Error(`"${it.name}" has no photo yet.`);
      const handle = await uploadExampleImage(env, bytes);
      cards.push({
        components: [
          { type: "HEADER", format: "IMAGE", example: { header_handle: [handle] } },
          // Card text is optional in Admin; WhatsApp needs text on every card, so fall back to the name.
          { type: "BODY", text: (it.spec || "").trim() || it.name },
          {
            type: "BUTTONS",
            // Via the Worker's /go/ redirect, so a change of website address never
            // needs a re-approval (the v2 templates still link straight to Surge).
            buttons: [{ type: "URL", text: "Shop now", url: `${origin}/go/${it.id}` }],
          },
        ],
      });
    }
    const name = `sharhan_catalogue_v${version}_${"ab"[p]}`;
    const created = await graph(env, `${env.META_WABA_ID}/message_templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        language: env.TEMPLATE_LANGUAGE,
        category: "MARKETING",
        components: [
          { type: "BODY", text: CAROUSEL_BODY[p] || CAROUSEL_BODY[0] },
          { type: "CAROUSEL", cards },
        ],
      }),
    });
    templates.push({ name, id: created.id, status: created.status || "PENDING", slugs: parts[p].map((it) => it.id) });
  }

  const pending = { version, templates, submittedAt: new Date().toISOString(), submittedBy: user.email };
  await setDocument(env, "catalogue_meta", "whatsapp", { ...meta, version, pending });
  return pending;
}

// ---- Pick-any catalogue ----
// One approved template per card count (2–10) whose card text, photo and link are
// all send-time parameters, so any 2–10 ticked items can go out without a new
// approval — and editing names or text never needs one either.
const PICK_MIN = 2;
const PICK_CARD_PREFIX = "Sharhan Broilers · ";
const PICK_CARD_SUFFIX = "\nTap Shop now to send your requirement.";
const PICK_MAX_TEXT = MAX_CARD_TEXT - PICK_CARD_PREFIX.length - PICK_CARD_SUFFIX.length;
const PICK_BODY = "Fresh from the Sharhan Broilers floor. Tap any item below for details and to send us your requirement.";

const pickKey = (size) => "s" + size;

// The card's {{1}}: catalogue text without the WhatsApp call to action (the template
// adds its own), on one line (parameters can't contain newlines) and within length.
function pickCardText(it) {
  const t = String(it.spec || "")
    .replace(/\s*Tap to send us your requirement\.?/i, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim() || it.name || "";
  return t.length > PICK_MAX_TEXT ? t.slice(0, PICK_MAX_TEXT - 1).trimEnd() + "…" : t;
}

async function submitPickTemplate(env, size, origin) {
  if (!(size >= PICK_MIN && size <= MAX_CARDS_PER_CAROUSEL)) throw new Error("Size must be 2–10.");
  const items = (await sortedCatalogue(env)).filter((it) => it.image);
  if (items.length < size) throw new Error(`Need at least ${size} items with photos.`);
  const meta = (await getDocument(env, "catalogue_meta", "whatsapp")) || {};
  const pick = meta.pick || { templates: {} };
  const prev = pick.templates[pickKey(size)];
  if (prev && (prev.status === "APPROVED" || prev.status === "PENDING")) return pick;

  // Meta blocks reusing a rejected template's name for a while, so retries get a new one.
  const attempt = prev ? (prev.attempt || 1) + 1 : 1;
  const name = `sharhan_pick_${size}` + (attempt > 1 ? `_r${attempt}` : "");
  const cards = [];
  for (const it of items.slice(0, size)) {
    const bytes = await env.CATALOGUE_IMAGES.get(imageKey(it.id), "arrayBuffer");
    if (!bytes) throw new Error(`"${it.name}" has no photo yet.`);
    const handle = await uploadExampleImage(env, bytes);
    cards.push({
      components: [
        { type: "HEADER", format: "IMAGE", example: { header_handle: [handle] } },
        { type: "BODY", text: PICK_CARD_PREFIX + "{{1}}" + PICK_CARD_SUFFIX, example: { body_text: [[pickCardText(it)]] } },
        {
          type: "BUTTONS",
          buttons: [{ type: "URL", text: "Shop now", url: `${origin}/go/{{1}}`, example: [`${origin}/go/${it.id}`] }],
        },
      ],
    });
  }
  const created = await graph(env, `${env.META_WABA_ID}/message_templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      language: env.TEMPLATE_LANGUAGE,
      category: "MARKETING",
      components: [{ type: "BODY", text: PICK_BODY }, { type: "CAROUSEL", cards }],
    }),
  });
  pick.templates[pickKey(size)] = { name, id: created.id, status: created.status || "PENDING", attempt, size, submittedAt: new Date().toISOString() };
  await setDocument(env, "catalogue_meta", "whatsapp", { ...meta, pick });
  return pick;
}

async function refreshStatus(env) {
  const meta = (await getDocument(env, "catalogue_meta", "whatsapp")) || {};
  if (meta.photo && meta.photo.templates) {
    let changed = false;
    const check = async (t) => {
      const data = await graph(env, `${env.META_WABA_ID}/message_templates?name=${t.name}&fields=name,status,rejected_reason`);
      const found = (data.data || []).find((d) => d.name === t.name);
      t.status = found ? found.status : "NOT_FOUND";
      t.rejectedReason = found && found.rejected_reason && found.rejected_reason !== "NONE" ? found.rejected_reason : null;
      changed = true;
    };
    for (const t of Object.values(meta.photo.templates)) if (t.status !== "APPROVED") await check(t);
    if (meta.text && meta.text.templates) {
      for (const t of Object.values(meta.text.templates)) if (t.status !== "APPROVED") await check(t);
    }
    // A newer version that's been approved replaces the live one for that size.
    for (const [key, t] of Object.entries(meta.photo.next || {})) {
      if (t.status !== "APPROVED") await check(t);
      if (t.status === "APPROVED") { meta.photo.templates[key] = t; delete meta.photo.next[key]; changed = true; }
    }
    if (meta.text) {
      meta.text.templates = meta.text.templates || {};
      for (const [key, t] of Object.entries(meta.text.next || {})) {
        if (t.status !== "APPROVED") await check(t);
        if (t.status === "APPROVED") { meta.text.templates[key] = t; delete meta.text.next[key]; changed = true; }
      }
    }
    if (changed && !meta.pending) await setDocument(env, "catalogue_meta", "whatsapp", meta);
  }
  if (meta.products && meta.products.status !== "APPROVED") {
    const t = meta.products;
    const data = await graph(env, `${env.META_WABA_ID}/message_templates?name=${t.name}&fields=name,status,rejected_reason`);
    const found = (data.data || []).find((d) => d.name === t.name);
    t.status = found ? found.status : "NOT_FOUND";
    t.rejectedReason = found && found.rejected_reason && found.rejected_reason !== "NONE" ? found.rejected_reason : null;
    if (!meta.pending) await setDocument(env, "catalogue_meta", "whatsapp", meta);
  }
  if (meta.pick && meta.pick.templates) {
    let changed = false;
    for (const t of Object.values(meta.pick.templates)) {
      if (t.status === "APPROVED") continue;
      const data = await graph(env, `${env.META_WABA_ID}/message_templates?name=${t.name}&fields=name,status,rejected_reason`);
      const found = (data.data || []).find((d) => d.name === t.name);
      t.status = found ? found.status : "NOT_FOUND";
      t.rejectedReason = found && found.rejected_reason && found.rejected_reason !== "NONE" ? found.rejected_reason : null;
      changed = true;
    }
    if (changed && !meta.pending) await setDocument(env, "catalogue_meta", "whatsapp", meta);
  }
  if (!meta.pending) return meta;
  let allApproved = true;
  for (const t of meta.pending.templates) {
    const data = await graph(env, `${env.META_WABA_ID}/message_templates?name=${t.name}&fields=name,status,rejected_reason`);
    const found = (data.data || []).find((d) => d.name === t.name);
    t.status = found ? found.status : "NOT_FOUND";
    t.rejectedReason = found && found.rejected_reason && found.rejected_reason !== "NONE" ? found.rejected_reason : null;
    if (t.status !== "APPROVED") allApproved = false;
  }
  if (allApproved) {
    meta.live = { version: meta.pending.version, templates: meta.pending.templates, approvedAt: new Date().toISOString() };
    meta.pending = null;
  }
  await setDocument(env, "catalogue_meta", "whatsapp", meta);
  return meta;
}

function carouselMessage(env, template, imageBySlug) {
  return {
    name: template.name,
    language: { code: template.language || env.TEMPLATE_LANGUAGE },
    components: [
      {
        type: "carousel",
        cards: template.slugs.map((slug, i) => ({
          card_index: i,
          components: [{ type: "header", parameters: [{ type: "image", image: { link: imageBySlug[slug] } }] }],
        })),
      },
    ],
  };
}

// ---- Product catalogue (Zodiac-style product cards) ----
// Items with a price are mirrored into the Meta Commerce catalogue (META_CATALOG_ID).
// One "product card carousel" template, approved once with 2 cards, can then send any
// 2–10 of them: WhatsApp draws each card from the catalogue (big square photo, name,
// price) and its View button opens WhatsApp's own full-page product view.
const PRODUCTS_TEMPLATE = "sharhan_products";
const PRODUCTS_BODY = "Fresh from Sharhan Broilers today. Tap View on any item for details and the price per kg, or to send us your order.";

const hasPrice = (it) => typeof it.price === "number" && it.price > 0;

function productDescription(it) {
  const details = pickCardText(it).replace(/\s*Packs?\s*:.*$/i, "");
  const packs = (it.packs || []).length ? ` Packs: ${it.packs.join(" / ")}.` : "";
  return `${details && details !== it.name ? details + " " : ""}Price per kg.${packs}`.trim();
}

// Public product feed (CSV) that Commerce Manager fetches on a schedule — the app has no
// catalog_management permission, so Meta pulls the products instead of us pushing them.
// Items without a price or real photo are left out, and a scheduled feed removes them.
const inFeed = (it) => hasPrice(it) && it.image && !it.placeholder;

function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function catalogFeedCsv(env) {
  const items = (await sortedCatalogue(env)).filter(inFeed);
  const site = env.SITE_URL.replace(/\/$/, "");
  const cols = ["id", "title", "description", "availability", "condition", "price", "link", "image_link", "brand"];
  const rows = items.map((it) => [
    it.id, it.name, productDescription(it), "in stock", "new", `${it.price.toFixed(2)} INR`,
    `${site}/?item=${it.id}`, it.image, "Sharhan Broilers",
  ].map(csvCell).join(","));
  return [cols.join(",")].concat(rows).join("\n") + "\n";
}

async function syncCommerceCatalog(env) {
  if (!env.META_CATALOG_ID) throw new Error("The WhatsApp product catalogue isn't connected yet.");
  const items = await sortedCatalogue(env);
  const site = env.SITE_URL.replace(/\/$/, "");
  const requests = items.map((it) => (hasPrice(it) && it.image
    ? {
        method: "UPDATE", // creates the product if it doesn't exist yet (allow_upsert)
        data: {
          id: it.id,
          title: it.name,
          description: productDescription(it),
          availability: "in stock",
          condition: "new",
          price: `${it.price.toFixed(2)} INR`,
          link: `${site}/?item=${it.id}`,
          image_link: it.image,
          brand: "Sharhan Broilers",
        },
      }
    : { method: "DELETE", data: { id: it.id } }));
  const body = new URLSearchParams({ item_type: "PRODUCT_ITEM", requests: JSON.stringify(requests) });
  const res = await graph(env, `${env.META_CATALOG_ID}/items_batch`, { method: "POST", body });
  return { synced: requests.filter((r) => r.method === "UPDATE").length, removed: requests.filter((r) => r.method === "DELETE").length, handles: res.handles || [] };
}

async function submitProductsTemplate(env) {
  const meta = (await getDocument(env, "catalogue_meta", "whatsapp")) || {};
  const prev = meta.products;
  if (prev && (prev.status === "APPROVED" || prev.status === "PENDING")) return prev;
  const attempt = prev ? (prev.attempt || 1) + 1 : 1;
  const name = PRODUCTS_TEMPLATE + (attempt > 1 ? `_r${attempt}` : "");
  const card = { components: [{ type: "HEADER", format: "PRODUCT" }, { type: "BUTTONS", buttons: [{ type: "SPM", text: "View" }] }] };
  const created = await graph(env, `${env.META_WABA_ID}/message_templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      language: env.TEMPLATE_LANGUAGE,
      category: "MARKETING",
      components: [{ type: "BODY", text: PRODUCTS_BODY }, { type: "CAROUSEL", cards: [card, card] }],
    }),
  });
  const products = { name, id: created.id, status: created.status || "PENDING", attempt, submittedAt: new Date().toISOString() };
  await setDocument(env, "catalogue_meta", "whatsapp", { ...meta, products });
  return products;
}

// Off unless PRODUCT_CARDS = "on": the owner chose not to show prices, so the Commerce
// catalogue stays empty and product cards would fail (#131009, unknown product IDs).
function productsReady(env, meta) {
  return !!(env.PRODUCT_CARDS === "on" && env.META_CATALOG_ID && meta.products && meta.products.status === "APPROVED");
}

function productsMessage(env, meta, items) {
  const chosen = items.filter((it) => it.onWhatsApp && inFeed(it)); // must be in the catalogue feed
  const n = chosen.length;
  if (n < PICK_MIN || n > MAX_CARDS_PER_CAROUSEL) {
    throw new Error(`Tick 2–10 items for WhatsApp that have a price (${n} ticked with a price now).`);
  }
  return {
    name: meta.products.name,
    language: { code: env.TEMPLATE_LANGUAGE },
    components: [{
      type: "carousel",
      cards: chosen.map((it, i) => ({
        card_index: i,
        components: [{ type: "header", parameters: [{ type: "product", product: { product_retailer_id: it.id, catalog_id: env.META_CATALOG_ID } }] }],
      })),
    }],
  };
}

// ---- Big-photo slider (no prices) ----
// Cards with only a photo and a View button: no card text, which is what makes WhatsApp
// shrink carousel photos to a wide strip. The item name is printed on the photo itself
// (imageCard, made in the admin). One template per card count, like the pick templates.
// v1: "View" button via the Worker's /go/ link (WhatsApp previewed it as "Workers").
// v2: "Enquire Now" button linking to the website's /p/<item> page, whose og:title is
// the product name — WhatsApp shows that name and the site's domain under each photo.
// A new version waits in photo.next and replaces the live one when approved.
// v3: "Enquire Now" is a reply button (no link, so no "Pages" preview line under the
// photo). Each card carries its item id as the payload; a tap comes back through the
// webhook as an enquiry for that item and gets an instant reply (enquiryReply).
// v2: "Enquire Now" website button; v3: reply button (kept in meta.photo.alt, unused);
// v4: "Enroll Now" website button → /p/<item> → the order form opens with the item marked.
// v5: as v4, plus the message above the photos is editable in Admin (body variable,
// settings/whatsapp.intro) and ends with how to unsubscribe.
// v6 (current): as v5, plus a "Stop" reply button under every photo (second button,
// payload STOP); a tap comes back as a button message with text "Stop" → unsubscribed.
const PHOTO_VERSION = 6;
const PHOTO_BUTTON = "Enroll Now";
const PHOTO_BODY_V4 = "Fresh stock from Sharhan Broilers, Mumbai. Swipe through the photos and tap Enroll Now to place your order.";
const PHOTO_BODY_V5 = "Hello from Sharhan Broilers! {{1}}\n\nNot interested? Reply STOP and we won't send these again.";
// Fresh wording: Meta auto-rejects templates that echo an existing one.
const PHOTO_BODY_V6 = "Sharhan Broilers here! {{1}}\n\nTap Stop under any photo if you'd rather not get these offers.";
const STOP_BUTTON = "Stop";
// Formats submitted with the Stop button (entry.stop) need its payload at send time, at index 1.
const stopButton = (t) => (t.stop ? [{ type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "STOP" }] }] : []);
// Default for the editable part, and the example shown to Meta for approval.
const DEFAULT_INTRO = "Fresh stock from Mumbai. Swipe through the photos and tap Enroll Now to place your order.";
// WhatsApp rejects template values with line breaks, tabs or long runs of spaces.
function cleanIntro(t) {
  return String(t || "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 500) || DEFAULT_INTRO;
}
// Formats with an editable intro (photo v5, line-up v2) take it as the body's parameter.
const introParams = (t, intro) => (t.intro ? [{ type: "body", parameters: [{ type: "text", text: cleanIntro(intro) }] }] : []);
const photoButtons = (t, it) => [(t.version || 1) === 3
  ? { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: it.id }] }
  : { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: it.id }] }, ...stopButton(t)];
const PHOTO_BODY = "Sharhan Broilers — today's catalogue. Swipe to see every item and tap Enquire Now to send us your requirement.";
const photoKey = (size) => "s" + size;

async function submitPhotoTemplate(env, size) {
  if (!(size >= PICK_MIN && size <= MAX_CARDS_PER_CAROUSEL)) throw new Error("Size must be 2–10.");
  const items = (await sortedCatalogue(env)).filter((it) => it.image);
  if (items.length < size) throw new Error(`Need at least ${size} items with photos.`);
  const meta = (await getDocument(env, "catalogue_meta", "whatsapp")) || {};
  const photo = meta.photo || { templates: {} };
  photo.templates = photo.templates || {};
  photo.next = photo.next || {};
  const live = photo.templates[photoKey(size)];
  if (live && (live.version || 1) >= PHOTO_VERSION && live.status === "APPROVED") return photo;
  const prev = photo.next[photoKey(size)];
  if (prev && (prev.version || 1) >= PHOTO_VERSION && (prev.status === "APPROVED" || prev.status === "PENDING")) return photo;
  // An older version still waiting in "next" may have been approved since the last status
  // check: make it live before this submission takes its place.
  if (prev && (prev.version || 1) < PHOTO_VERSION && prev.status !== "APPROVED") {
    const data = await graph(env, `${env.META_WABA_ID}/message_templates?name=${prev.name}&fields=name,status`).catch(() => ({}));
    const found = (data.data || []).find((d) => d.name === prev.name);
    if (found && found.status === "APPROVED") photo.templates[photoKey(size)] = { ...prev, status: "APPROVED" };
  } else if (prev && prev.status === "APPROVED") {
    photo.templates[photoKey(size)] = prev;
  }
  // An older version waiting in "next" is replaced by this one (a new name each version).
  const attempt = prev && (prev.version || 1) === PHOTO_VERSION ? (prev.attempt || 1) + 1 : 1;
  const name = `sharhan_photo_v${PHOTO_VERSION}_${size}` + (attempt > 1 ? `_r${attempt}` : "");
  const site = env.SITE_URL.replace(/\/$/, "");
  // Example photos: ticked items first (their name-card versions), then any others.
  const examples = items.filter((it) => it.onWhatsApp).concat(items.filter((it) => !it.onWhatsApp)).slice(0, size);
  const cards = [];
  for (const it of examples) {
    const key = it.imageCard ? `${it.id.slice(0, 55)}-card` : it.id;
    const bytes = (await env.CATALOGUE_IMAGES.get(imageKey(key), "arrayBuffer")) || (await env.CATALOGUE_IMAGES.get(imageKey(it.id), "arrayBuffer"));
    if (!bytes) throw new Error(`"${it.name}" has no photo yet.`);
    const handle = await uploadExampleImage(env, bytes);
    cards.push({
      components: [
        { type: "HEADER", format: "IMAGE", example: { header_handle: [handle] } },
        { type: "BUTTONS", buttons: [
          { type: "URL", text: PHOTO_BUTTON, url: `${site}/p/{{1}}`, example: [`${site}/p/${it.id}`] },
          { type: "QUICK_REPLY", text: STOP_BUTTON },
        ] },
      ],
    });
  }
  const created = await graph(env, `${env.META_WABA_ID}/message_templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      language: env.TEMPLATE_LANGUAGE,
      category: "MARKETING",
      components: [{ type: "BODY", text: PHOTO_BODY_V6, example: { body_text: [[DEFAULT_INTRO]] } }, { type: "CAROUSEL", cards }],
    }),
  });
  const entry = { name, id: created.id, status: created.status || "PENDING", attempt, size, version: PHOTO_VERSION, intro: true, stop: true, submittedAt: new Date().toISOString() };
  if (entry.status === "APPROVED") photo.templates[photoKey(size)] = entry;
  else photo.next[photoKey(size)] = entry;
  await setDocument(env, "catalogue_meta", "whatsapp", { ...meta, photo });
  return photo;
}

// ---- "Photo + text" slider (the other card style the owner can pick in Admin) ----
// Card = wide photo + editable card text + "Enquire Now" reply button (no link preview
// line). WhatsApp shows photos with text as a wide strip, so it gets the imageWide crop.
// Wording must not echo the older formats: Meta's automatic check rejected near-copies
// as INVALID_FORMAT (2026-10-20), while this fresh wording passed.
// sharhan_cards_{n}: "Enquire Now" reply button (superseded). sharhan_lineup_{n} (current):
// "Enroll Now" website button → order form; each entry records its button kind.
const TEXT_PREFIX = "";
const TEXT_SUFFIX = "\nTap Enroll Now to order, delivered fresh across Mumbai.";
const TEXT_MAX = MAX_CARD_TEXT - TEXT_PREFIX.length - TEXT_SUFFIX.length;
const TEXT_BODY = "Our line-up for your kitchen this week. Swipe the cards and tap Enroll Now on any item to order it.";
// v2 (sharhan_lineup_v2_{n}): editable intro + unsubscribe line. v3 (current): plus a
// "Stop" reply button on every card. A new version waits in text.next until approved, so
// the approved older one keeps sending meanwhile.
const TEXT_VERSION = 3;
const TEXT_BODY_V2 = "This week at Sharhan Broilers: {{1}}\n\nReply STOP anytime to unsubscribe from these updates.";
const TEXT_BODY_V3 = "Today's pick from Sharhan Broilers, Mumbai: {{1}}\n\nTo stop these offers, tap Stop on any card.";

function textCardText(it) {
  const t = pickCardText(it); // one line, without the old call to action
  return t.length > TEXT_MAX ? t.slice(0, TEXT_MAX - 1).trimEnd() + "…" : t;
}

async function submitTextTemplate(env, size) {
  if (!(size >= PICK_MIN && size <= MAX_CARDS_PER_CAROUSEL)) throw new Error("Size must be 2–10.");
  const items = (await sortedCatalogue(env)).filter((it) => it.image && !it.placeholder);
  if (items.length < size) throw new Error(`Need at least ${size} items with photos.`);
  const meta = (await getDocument(env, "catalogue_meta", "whatsapp")) || {};
  const text = meta.text || { templates: {} };
  text.templates = text.templates || {};
  text.next = text.next || {};
  const live = text.templates[photoKey(size)];
  if (live && (live.version || 1) >= TEXT_VERSION && live.status === "APPROVED") return text;
  const prev = text.next[photoKey(size)];
  if (prev && (prev.version || 1) >= TEXT_VERSION && (prev.status === "APPROVED" || prev.status === "PENDING")) return text;
  // An older version waiting in "next" may have been approved since the last status check:
  // make it live before this submission takes its place.
  if (prev && (prev.version || 1) < TEXT_VERSION && prev.status !== "APPROVED") {
    const data = await graph(env, `${env.META_WABA_ID}/message_templates?name=${prev.name}&fields=name,status`).catch(() => ({}));
    const found = (data.data || []).find((d) => d.name === prev.name);
    if (found && found.status === "APPROVED") text.templates[photoKey(size)] = { ...prev, status: "APPROVED" };
  } else if (prev && (prev.version || 1) < TEXT_VERSION && prev.status === "APPROVED") {
    text.templates[photoKey(size)] = prev;
  }
  const attempt = prev && (prev.version || 1) === TEXT_VERSION ? (prev.attempt || 1) + 1 : 1;
  const name = `sharhan_lineup_v${TEXT_VERSION}_${size}` + (attempt > 1 ? `_r${attempt}` : "");
  const site = env.SITE_URL.replace(/\/$/, "");
  const examples = items.filter((it) => it.onWhatsApp).concat(items.filter((it) => !it.onWhatsApp)).slice(0, size);
  const cards = [];
  for (const it of examples) {
    const key = it.imageWide ? `${it.id.slice(0, 55)}-wide` : it.id;
    const bytes = (await env.CATALOGUE_IMAGES.get(imageKey(key), "arrayBuffer")) || (await env.CATALOGUE_IMAGES.get(imageKey(it.id), "arrayBuffer"));
    if (!bytes) throw new Error(`"${it.name}" has no photo yet.`);
    cards.push({
      components: [
        { type: "HEADER", format: "IMAGE", example: { header_handle: [await uploadExampleImage(env, bytes)] } },
        { type: "BODY", text: TEXT_PREFIX + "{{1}}" + TEXT_SUFFIX, example: { body_text: [[textCardText(it)]] } },
        { type: "BUTTONS", buttons: [
          { type: "URL", text: "Enroll Now", url: `${site}/p/{{1}}`, example: [`${site}/p/${it.id}`] },
          { type: "QUICK_REPLY", text: STOP_BUTTON },
        ] },
      ],
    });
  }
  const created = await graph(env, `${env.META_WABA_ID}/message_templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, language: env.TEMPLATE_LANGUAGE, category: "MARKETING", components: [{ type: "BODY", text: TEXT_BODY_V3, example: { body_text: [[DEFAULT_INTRO]] } }, { type: "CAROUSEL", cards }] }),
  });
  const entry = { name, id: created.id, status: created.status || "PENDING", attempt, size, button: "url", version: TEXT_VERSION, intro: true, stop: true, submittedAt: new Date().toISOString() };
  if (entry.status === "APPROVED") text.templates[photoKey(size)] = entry;
  else text.next[photoKey(size)] = entry;
  await setDocument(env, "catalogue_meta", "whatsapp", { ...meta, text });
  return text;
}

function textCards(t, list, intro) {
  return {
    name: t.name,
    language: { code: "en" },
    components: [...introParams(t, intro), {
      type: "carousel",
      cards: list.map((it, i) => ({
        card_index: i,
        components: [
          { type: "header", parameters: [{ type: "image", image: { link: it.imageWide || it.image } }] },
          { type: "body", parameters: [{ type: "text", text: textCardText(it) }] },
          t.button === "url"
            ? { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: it.id }] }
            : { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: it.id }] },
          ...stopButton(t),
        ],
      })),
    }],
  };
}

function textTemplate(meta, n) {
  const t = meta.text && meta.text.templates && meta.text.templates[photoKey(n)];
  return t && t.status === "APPROVED" ? t : null;
}

// Ticked items in the "photo + text" style, if that card count is approved; else null.
function textMessage(env, meta, items, intro) {
  const chosen = items.filter((it) => it.onWhatsApp && it.image);
  const t = textTemplate(meta, chosen.length);
  if (!t) return null;
  const msg = textCards(t, chosen, intro);
  msg.language.code = env.TEMPLATE_LANGUAGE;
  return msg;
}

// Ticked items as the big-photo slider, if WhatsApp has approved that card count; else null.
function photoMessage(env, meta, items, intro) {
  const chosen = items.filter((it) => it.onWhatsApp && it.image);
  const t = meta.photo && meta.photo.templates && meta.photo.templates[photoKey(chosen.length)];
  if (!t || t.status !== "APPROVED") return null;
  return {
    name: t.name,
    language: { code: env.TEMPLATE_LANGUAGE },
    components: [...introParams(t, intro), {
      type: "carousel",
      cards: chosen.map((it, i) => ({
        card_index: i,
        components: [
          { type: "header", parameters: [{ type: "image", image: { link: it.imageCard || it.image } }] },
          ...photoButtons(t, it),
        ],
      })),
    }],
  };
}

// Every item with a real photo, as sliders of up to 10 cards (15 items = 10 + 5), in the
// chosen card style. Uses the per-size formats, so no separate approval is needed.
function fullPhotoMessages(env, meta, items, style, intro) {
  const all = items.filter((it) => it.image && !it.placeholder);
  if (all.length < PICK_MIN) return null;
  const parts = splitIntoCarousels(all);
  if (style === "text") {
    const ts = parts.map((p) => textTemplate(meta, p.length));
    if (ts.every(Boolean)) {
      return parts.map((p, i) => { const m = textCards(ts[i], p, intro); m.language.code = env.TEMPLATE_LANGUAGE; return m; });
    }
  }
  const messages = [];
  for (const part of parts) {
    const t = meta.photo && meta.photo.templates && meta.photo.templates[photoKey(part.length)];
    if (!t || t.status !== "APPROVED") return null;
    messages.push({
      name: t.name,
      language: { code: env.TEMPLATE_LANGUAGE },
      components: [...introParams(t, intro), {
        type: "carousel",
        cards: part.map((it, i) => ({
          card_index: i,
          components: [
            { type: "header", parameters: [{ type: "image", image: { link: it.imageCard || it.image } }] },
            ...photoButtons(t, it),
          ],
        })),
      }],
    });
  }
  return messages;
}

// Best slider for the ticked items in the owner's chosen card style ("photo" = big photo
// with the name on it, "text" = photo + card text). Falls back to whatever is approved.
function sliderMessage(env, meta, items, style, intro) {
  if (productsReady(env, meta)) {
    try { return productsMessage(env, meta, items); } catch (e) { /* not enough priced items */ }
  }
  if (style === "text") return textMessage(env, meta, items, intro) || photoMessage(env, meta, items, intro) || pickMessage(env, meta, items);
  return photoMessage(env, meta, items, intro) || textMessage(env, meta, items, intro) || pickMessage(env, meta, items);
}

// Admin → card style + the editable message above the photos (settings/whatsapp).
async function sendSettings(env) {
  const s = (await getDocument(env, "settings", "whatsapp").catch(() => null)) || {};
  return { style: s.cardStyle === "text" ? "text" : "photo", intro: cleanIntro(s.intro) };
}

// The ticked items as one carousel, using the approved pick-any template of that size.
function pickMessage(env, meta, items) {
  const chosen = items.filter((it) => it.onWhatsApp && it.image);
  const n = chosen.length;
  if (n < PICK_MIN || n > MAX_CARDS_PER_CAROUSEL) throw new Error(`Tick 2–10 items for WhatsApp in the catalogue (${n} ticked now).`);
  const t = meta.pick && meta.pick.templates && meta.pick.templates[pickKey(n)];
  if (!t || t.status !== "APPROVED") {
    throw new Error(`WhatsApp hasn't approved the ${n}-item format yet` + (t ? ` (${t.status})` : " — submit the pick-any formats first") + ".");
  }
  return {
    name: t.name,
    language: { code: env.TEMPLATE_LANGUAGE },
    components: [{
      type: "carousel",
      cards: chosen.map((it, i) => ({
        card_index: i,
        components: [
          { type: "header", parameters: [{ type: "image", image: { link: it.image } }] },
          { type: "body", parameters: [{ type: "text", text: pickCardText(it) }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: it.id }] },
        ],
      })),
    }],
  };
}

async function sendCatalogueBatch(env, user, offset, limit, mode) {
  const meta = (await getDocument(env, "catalogue_meta", "whatsapp")) || {};
  const [allCustomers, items] = await Promise.all([listDocuments(env, "whatsapp_customers"), sortedCatalogue(env)]);
  if (!allCustomers.length) throw new Error("No customers saved yet");
  // Customers unticked in the admin ("send": false) are skipped, and anyone who replied STOP
  // never gets the catalogue again; older entries without the fields are included.
  const customers = allCustomers.filter((c) => c.send !== false && !c.unsubscribed);
  if (!customers.length) throw new Error("No customers are ticked to receive the catalogue.");

  const { style, intro } = await sendSettings(env);
  let messages;
  if (mode === "pick") {
    messages = [sliderMessage(env, meta, items, style, intro)];
  } else if ((messages = fullPhotoMessages(env, meta, items, style, intro))) {
    // all items as big-photo sliders
  } else {
    if (!meta.live || !meta.live.templates || !meta.live.templates.length) {
      throw new Error("No approved catalogue yet. Submit it for WhatsApp approval first.");
    }
    // Photos are a send-time parameter, so the latest uploaded photo is used even
    // though the card text stays as approved.
    const imageBySlug = {};
    for (const it of items) if (it.image) imageBySlug[it.id] = it.image;
    for (const t of meta.live.templates) {
      for (const slug of t.slugs) if (!imageBySlug[slug]) throw new Error(`No photo for "${slug}".`);
    }
    messages = meta.live.templates.map((t) => carouselMessage(env, t, imageBySlug));
  }

  customers.sort((a, b) => (a.id < b.id ? -1 : 1));
  const batch = customers.slice(offset, offset + limit);
  const results = [];
  for (const c of batch) {
    const to = (c.phone || "").replace(/\D/g, "");
    if (!to) continue;
    try {
      for (const template of messages) {
        await graph(env, `${env.META_PHONE_NUMBER_ID}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template }),
        });
      }
      results.push({ to, ok: true });
    } catch (e) {
      results.push({ to, ok: false, error: e.message });
    }
  }

  const done = offset + batch.length >= customers.length;
  if (done || offset === 0) {
    await addDocument(env, "whatsapp_send_log", {
      sentBy: user.email,
      sentAt: new Date().toISOString(),
      templates: messages.map((t) => t.name).join(", "),
      mode: mode === "pick" ? "pick" : "full",
      batchOffset: offset,
      batchSize: results.length,
      successCount: results.filter((r) => r.ok).length,
    });
  }
  return { total: customers.length, offset, nextOffset: done ? null : offset + batch.length, results };
}

// Meta signs every webhook call with the app secret (X-Hub-Signature-256). Without
// this check anyone who knows the Worker URL could fake "Catalogue" messages and make
// us send paid templates to any number.
async function verifyMetaSignature(env, rawBody, header) {
  if (!env.META_APP_SECRET || !header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.META_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7).toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// ---- Auto-reply ----
// A customer who messages first opens a 24-hour window in which marketing templates
// don't count towards WhatsApp's per-user marketing limit (error 131049), so a reply
// to "Catalogue" / "Hi" gets through where a cold send is often held back.
const AUTO_REPLY_KEYWORDS = /\b(catalogu?e?s?|menu|products?|price\s*list|rates?)\b/i;
const AUTO_REPLY_GREETING = /^\s*(hi+|hello+|hey+|namaste|salaa?m|assalamu?\s*alaikum)\b/i;
const AUTO_REPLY_GAP_MS = 12 * 3600 * 1000; // at most one automatic catalogue per customer per 12 hours

function wantsCatalogue(m) {
  return m.type === "text" && !!m.text && (AUTO_REPLY_KEYWORDS.test(m.text) || AUTO_REPLY_GREETING.test(m.text));
}

// Instant answer to "Enquire Now" on a catalogue card. The tap opened a customer-service
// window, so a normal (free) message is allowed: the item, its details and the website link.
async function enquiryReply(env, m, item) {
  const phone = String(m.from || "").replace(/\D/g, "");
  if (!phone) return;
  const site = env.SITE_URL.replace(/\/$/, "");
  const details = pickCardText(item);
  const packs = (item.packs || []).length ? `\nPacks: ${item.packs.join(" / ")}` : "";
  const body = `*${item.name}*` +
    (details && details !== item.name ? `\n${details.replace(/\s*Packs?\s*:.*$/i, "")}` : "") + packs +
    `\n\nThank you for your enquiry! Our team will contact you shortly with today's rate.` +
    `\nReply here with the quantity you need, or see details and order online:\n${site}/?item=${item.id}`;
  await graph(env, `${env.META_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "text", text: { body, preview_url: true } }),
  });
}

// They asked for the catalogue, so they join the customer list (ticked for future sends).
async function addCustomerIfNew(env, customers, phone, name, at) {
  const key = phone.slice(-10);
  if (customers.some((c) => String(c.phone || "").replace(/\D/g, "").slice(-10) === key)) return;
  await addDocument(env, "whatsapp_customers", { name: name || "", phone, send: true, source: "auto-reply", addedAt: at });
}

// ---- Unsubscribe ----
// "STOP" (and the usual variants, in English / Hindi / Marathi) marks the customer as
// unsubscribed: they are never sent the catalogue again, not even by the auto-reply,
// until they send "START". The admin sees them under Customers → Unsubscribed.
const STOP_WORDS = /^\s*(stop|stop\s+(all|promotions?|messages?|sending)|unsubscribe|opt\s*-?\s*out|band\s*karo|bandh?\s*kara|बंद\s*(करो|करें|करा)?)\s*[.!]*\s*$/i;
const START_WORDS = /^\s*(start|subscribe|unstop|resume|opt\s*-?\s*in|शुरू\s*करो?|सुरू\s*करा)\s*[.!]*\s*$/i;

const last10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);

async function setSubscription(env, phone, name, unsubscribed, how) {
  const customers = await listDocuments(env, "whatsapp_customers");
  const mine = customers.filter((c) => last10(c.phone) === last10(phone));
  const at = new Date().toISOString();
  const change = unsubscribed
    ? { unsubscribed: true, send: false, unsubscribedAt: at, unsubscribedVia: how }
    : { unsubscribed: false, send: true, resubscribedAt: at };
  if (!mine.length) {
    // Not on the list yet: keep a record anyway, so a later auto-reply can't add them back ticked.
    if (unsubscribed) await addDocument(env, "whatsapp_customers", { name: name || "", phone, source: "unsubscribe", addedAt: at, ...change });
    return;
  }
  for (const c of mine) {
    const { id, ...rest } = c;
    await setDocument(env, "whatsapp_customers", id, { ...rest, ...change });
  }
}

async function isUnsubscribed(env, phone) {
  const customers = await listDocuments(env, "whatsapp_customers");
  return customers.some((c) => last10(c.phone) === last10(phone) && c.unsubscribed);
}

async function subscriptionReply(env, m) {
  const phone = String(m.from || "").replace(/\D/g, "");
  // Typed, or a "Stop promotions" style button.
  if (!phone || (m.type !== "text" && m.type !== "button") || !m.text) return false;
  const stop = STOP_WORDS.test(m.text), start = !stop && START_WORDS.test(m.text);
  if (!stop && !start) return false;
  await setSubscription(env, phone, m.name, stop, "reply");
  const body = stop
    ? "You're unsubscribed. Sharhan Broilers won't send you the catalogue again.\nChanged your mind? Reply START."
    : "Welcome back! You'll receive the Sharhan Broilers catalogue again. Reply STOP anytime to unsubscribe.";
  await graph(env, `${env.META_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "text", text: { body } }),
  });
  return true;
}

// WhatsApp's own "stop marketing messages" setting shows up as error 131050 on a send:
// treat it like a STOP so we stop trying (and paying for failed attempts).
async function noteMarketingOptOut(env, status) {
  const errs = Array.isArray(status.errors) ? status.errors : [];
  if (status.status === "failed" && errs.some((e) => e && Number(e.code) === 131050) && status.recipient) {
    await setSubscription(env, status.recipient, "", true, "whatsapp-setting");
  }
}

async function autoReply(env, m, origin) {
  const phone = String(m.from || "").replace(/\D/g, "");
  if (!phone) return;
  if (await subscriptionReply(env, m)) return;
  if (!wantsCatalogue(m)) return;
  const settings = (await getDocument(env, "settings", "whatsapp")) || {};
  if (settings.autoReply === false) return;
  if (await isUnsubscribed(env, phone)) return; // they said STOP; "START" turns it back on
  const prev = await getDocument(env, "whatsapp_autoreply", phone);
  if (prev && prev.lastSentAt && Date.now() - new Date(prev.lastSentAt).getTime() < AUTO_REPLY_GAP_MS) return;

  const record = { phone, name: m.name || "", trigger: m.text.slice(0, 100), lastSentAt: new Date().toISOString(), ok: false, error: null };
  try {
    const [items, customers, meta] = await Promise.all([
      sortedCatalogue(env),
      listDocuments(env, "whatsapp_customers"),
      getDocument(env, "catalogue_meta", "whatsapp").then((x) => x || {}),
    ]);
    const send = (body) => graph(env, `${env.META_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: phone, ...body }),
    });

    // A swipeable slider (one message) is only possible as an approved template: the
    // product cards (Zodiac-style) once approved, otherwise the photo-card slider.
    let template = null;
    try {
      template = sliderMessage(env, meta, items, settings.cardStyle === "text" ? "text" : "photo", cleanIntro(settings.intro));
    } catch (e) {
      template = null; // not set up for this many items yet - fall back to photos below
    }
    if (template) {
      await send({ type: "template", template });
      record.ok = true;
      record.items = template.components[0].cards.length;
      record.format = template.name;
      await addDocument(env, "whatsapp_send_log", {
        sentBy: "auto-reply", sentAt: record.lastSentAt, templates: template.name, mode: "auto-reply",
        batchOffset: 0, batchSize: 1, successCount: 1, to: phone, items: record.items,
      });
      await addCustomerIfNew(env, customers, phone, m.name, record.lastSentAt);
      await setDocument(env, "whatsapp_autoreply", phone, record);
      return;
    }

    // Last resort: separate photo messages (allowed because the customer messaged first).
    const chosen = items.filter((it) => it.onWhatsApp && (it.imageTall || it.image)).slice(0, MAX_CARDS_PER_CAROUSEL);
    if (!chosen.length) throw new Error("No items are ticked for WhatsApp.");
    const goBase = `${origin}/go/`;
    await send({ type: "text", text: { body: `*Sharhan Broilers — today's catalogue* 🐔\nHere are our ${chosen.length} items. Tap a photo to see it full screen, or the link under it to order.` } });
    let sent = 0;
    for (const it of chosen) {
      const details = pickCardText(it);
      const packs = (it.packs || []).length ? `\nPacks: ${it.packs.join(" / ")}` : "";
      const caption = `*${it.name}*` + (details && details !== it.name ? `\n${details.replace(/\s*Packs?\s*:.*$/i, "")}` : "") + packs + `\nOrder: ${goBase}${it.id}`;
      await send({ type: "image", image: { link: it.imageTall || it.image, caption: caption.slice(0, 1024) } });
      sent++;
    }
    record.ok = true;
    record.items = sent;
    await addDocument(env, "whatsapp_send_log", {
      sentBy: "auto-reply", sentAt: record.lastSentAt, templates: "photo messages", mode: "auto-reply",
      batchOffset: 0, batchSize: 1, successCount: 1, to: phone, items: sent,
    });
    await addCustomerIfNew(env, customers, phone, m.name, record.lastSentAt);
  } catch (e) {
    record.error = e.message;
  }
  await setDocument(env, "whatsapp_autoreply", phone, record);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Meta calls this to verify the webhook URL when you configure it.
    if (path === "/webhook" && request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      if (mode === "subscribe" && token === env.WEBHOOK_VERIFY_TOKEN) {
        return new Response(url.searchParams.get("hub.challenge"), { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // Meta calls this whenever a customer sends a message or a delivery status changes.
    if (path === "/webhook" && request.method === "POST") {
      const raw = await request.text();
      const signed = await verifyMetaSignature(env, raw, request.headers.get("X-Hub-Signature-256"));
      // Once the app secret is configured, unsigned calls are rejected outright.
      if (env.META_APP_SECRET && !signed) return new Response("Forbidden", { status: 403 });
      const payload = JSON.parse(raw);
      for (const m of extractIncomingMessages(payload)) {
        // "Enquire Now" on a catalogue card: record which item, so the inbox reads clearly.
        let item = null;
        if (signed && m.type === "button" && m.payload && isValidSlug(m.payload)) {
          item = await getDocument(env, "catalogue", m.payload).catch(() => null);
          if (item) { item.id = m.payload; m.text = `🛒 Enquiry: ${item.name}`; m.enquiryItem = m.payload; }
        }
        await addDocument(env, "whatsapp_inbox", m);
        if (item) { ctx.waitUntil(enquiryReply(env, m, item).catch(() => {})); continue; }
        // Only for calls proven to come from Meta; after the response, so Meta gets its 200 straight away.
        if (signed) ctx.waitUntil(autoReply(env, m, url.origin).catch(() => {}));
      }
      for (const s of extractStatuses(payload)) {
        await addDocument(env, "whatsapp_status_log", s);
        if (signed) ctx.waitUntil(noteMarketingOptOut(env, s).catch(() => {}));
      }
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    // Public: catalogue photos (used by the website and fetched by Meta when sending).
    const imgMatch = path.match(/^\/catalogue-img\/([a-z0-9-]+)\.jpg$/);
    if (imgMatch && request.method === "GET") {
      const bytes = await env.CATALOGUE_IMAGES.get(imageKey(imgMatch[1]), "arrayBuffer");
      if (!bytes) return new Response("Not found", { status: 404, headers: CORS_HEADERS });
      return new Response(bytes, {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable", ...CORS_HEADERS },
      });
    }

    // Public: product feed read by Meta Commerce Manager (scheduled data source).
    if (path === "/catalog-feed.csv" && request.method === "GET") {
      return new Response(await catalogFeedCsv(env), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", ...CORS_HEADERS },
      });
    }

    // Public: "Shop now" links in pick-any catalogues point here, so the website's
    // address can change (e.g. to the custom domain) without re-approving templates.
    const goMatch = path.match(/^\/go\/([a-z0-9-]+)$/);
    if (goMatch && request.method === "GET" && isValidSlug(goMatch[1])) {
      return Response.redirect(`${env.SITE_URL.replace(/\/$/, "")}/?item=${goMatch[1]}`, 302);
    }

    // Public: the order form asks whether a mobile number may choose credit terms.
    // The approved list itself (settings/credit) stays private; only yes/no comes back.
    if (path === "/credit-check" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const mobile = String(body.mobile || "").replace(/\D/g, "").slice(-10);
      if (mobile.length !== 10) return json({ approved: false });
      return json(await creditStatus(env, mobile));
    }

    // Public: credit application with KYC photos (multipart form from the order form).
    if (path === "/credit-apply" && request.method === "POST") {
      return creditApply(env, request);
    }

    // Public: admin ID + password sign-in (wrong tries are counted and lock the ID).
    if (path === "/staff-login") return staffRoute(env, request, path, null, json);

    // Everything below is admin-only.
    let user;
    try {
      user = await requireAuthorizedUser(request, env);
    } catch (e) {
      if (["/inbox", "/send-catalogue", "/catalogue-submit", "/catalogue-status", "/pick-submit", "/commerce-sync", "/products-submit", "/photo-submit", "/text-submit", "/kyc-delete"].includes(path) || path.startsWith("/catalogue-image/") || path.startsWith("/kyc/") || path.startsWith("/staff-")) {
        return json({ error: e.message }, 401);
      }
      return new Response("Not found", { status: 404 });
    }

    // Admin: users and passwords (staff.js).
    if (path.startsWith("/staff-")) {
      const res = await staffRoute(env, request, path, user, json);
      if (res) return res;
    }

    // Admin: one KYC photo of a credit application.
    const kycMatch = path.match(/^\/kyc\/(\d{10})\/([a-z_]+)$/);
    if (kycMatch && request.method === "GET" && KYC_SLOTS.includes(kycMatch[2])) {
      const bytes = await env.CATALOGUE_IMAGES.get(kycKey(kycMatch[1], kycMatch[2]), "arrayBuffer");
      if (!bytes) return json({ error: "Not found" }, 404);
      return new Response(bytes, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", ...CORS_HEADERS } });
    }

    // Admin: delete an application's KYC photos (the decision and details are kept).
    if (path === "/kyc-delete" && request.method === "POST") {
      const { mobile } = await request.json().catch(() => ({}));
      const m = String(mobile || "").replace(/\D/g, "");
      if (m.length !== 10) return json({ error: "Invalid mobile" }, 400);
      for (const slot of KYC_SLOTS) await env.CATALOGUE_IMAGES.delete(kycKey(m, slot));
      const app = await getDocument(env, "credit_applications", m);
      if (app) await setDocument(env, "credit_applications", m, { ...app, docs: [], docsDeletedAt: new Date().toISOString(), docsDeletedBy: user.email });
      return json({ ok: true });
    }

    const uploadMatch = path.match(/^\/catalogue-image\/([a-z0-9-]+)$/);
    if (uploadMatch && request.method === "POST") {
      const slug = uploadMatch[1];
      if (!isValidSlug(slug)) return json({ error: "Invalid item id" }, 400);
      const bytes = await request.arrayBuffer();
      const head = new Uint8Array(bytes.slice(0, 3));
      if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return json({ error: "Photo must be a JPEG" }, 400);
      if (bytes.byteLength > MAX_IMAGE_BYTES) return json({ error: "Photo is larger than 2 MB" }, 400);
      await env.CATALOGUE_IMAGES.put(imageKey(slug), bytes);
      return json({ url: `${url.origin}/catalogue-img/${slug}.jpg?v=${Date.now()}` });
    }

    if (path === "/catalogue-submit" && request.method === "POST") {
      try {
        return json({ pending: await submitCatalogue(env, user, url.origin) });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    if (path === "/commerce-sync" && request.method === "POST") {
      try {
        return json(await syncCommerceCatalog(env));
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    if (path === "/products-submit" && request.method === "POST") {
      try {
        if (!env.META_CATALOG_ID) throw new Error("Connect the WhatsApp product catalogue first.");
        return json({ products: await submitProductsTemplate(env) });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    if (path === "/text-submit" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      try {
        return json({ text: await submitTextTemplate(env, parseInt(body.size, 10)) });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    if (path === "/photo-submit" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      try {
        return json({ photo: await submitPhotoTemplate(env, parseInt(body.size, 10)) });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    if (path === "/pick-submit" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      try {
        return json({ pick: await submitPickTemplate(env, parseInt(body.size, 10), url.origin) });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    if (path === "/catalogue-status" && request.method === "GET") {
      try {
        return json({ ...(await refreshStatus(env)), autoReplyReady: !!env.META_APP_SECRET, catalogConnected: !!env.META_CATALOG_ID });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (path === "/inbox" && request.method === "GET") {
      const docs = await listDocuments(env, "whatsapp_inbox");
      docs.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
      return json({ messages: docs });
    }

    if (path === "/send-catalogue" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const offset = Math.max(0, parseInt(body.offset, 10) || 0);
      const limit = Math.min(SEND_BATCH_MAX, Math.max(1, parseInt(body.limit, 10) || SEND_BATCH_MAX));
      try {
        return json(await sendCatalogueBatch(env, user, offset, limit, body.mode));
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
