import { listDocuments, addDocument, getDocument, setDocument } from "./firestore.js";
import { verifyFirebaseIdToken } from "./verifyIdToken.js";

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

// ---- WhatsApp webhook (Meta -> us) ----

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
          text: msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || null,
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

async function submitCatalogue(env, user) {
  const items = await sortedCatalogue(env);
  if (items.length < 2) throw new Error("Add at least 2 items before submitting.");
  if (items.length > MAX_CATALOGUE_ITEMS) throw new Error(`The catalogue can have at most ${MAX_CATALOGUE_ITEMS} items.`);
  for (const it of items) {
    if (!it.name || !it.spec) throw new Error(`"${it.name || it.id}" needs a name and card text.`);
    if (it.spec.length > MAX_CARD_TEXT) throw new Error(`"${it.name}" card text is over ${MAX_CARD_TEXT} characters.`);
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
          { type: "BODY", text: it.spec },
          {
            type: "BUTTONS",
            buttons: [{ type: "URL", text: "Shop now", url: `${env.SITE_URL.replace(/\/$/, "")}/?item=${it.id}` }],
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

async function refreshStatus(env) {
  const meta = (await getDocument(env, "catalogue_meta", "whatsapp")) || {};
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

async function sendCatalogueBatch(env, user, offset, limit) {
  const meta = (await getDocument(env, "catalogue_meta", "whatsapp")) || {};
  if (!meta.live || !meta.live.templates || !meta.live.templates.length) {
    throw new Error("No approved catalogue yet. Submit it for WhatsApp approval first.");
  }
  const [customers, items] = await Promise.all([listDocuments(env, "whatsapp_customers"), listDocuments(env, "catalogue")]);
  if (!customers.length) throw new Error("No customers saved yet");

  // Photos are a send-time parameter, so the latest uploaded photo is used even
  // though the card text stays as approved.
  const imageBySlug = {};
  for (const it of items) if (it.image) imageBySlug[it.id] = it.image;
  for (const t of meta.live.templates) {
    for (const slug of t.slugs) if (!imageBySlug[slug]) throw new Error(`No photo for "${slug}".`);
  }

  customers.sort((a, b) => (a.id < b.id ? -1 : 1));
  const batch = customers.slice(offset, offset + limit);
  const results = [];
  for (const c of batch) {
    const to = (c.phone || "").replace(/\D/g, "");
    if (!to) continue;
    try {
      for (const t of meta.live.templates) {
        await graph(env, `${env.META_PHONE_NUMBER_ID}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: carouselMessage(env, t, imageBySlug) }),
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
      templates: meta.live.templates.map((t) => t.name).join(", "),
      batchOffset: offset,
      batchSize: results.length,
      successCount: results.filter((r) => r.ok).length,
    });
  }
  return { total: customers.length, offset, nextOffset: done ? null : offset + batch.length, results };
}

export default {
  async fetch(request, env) {
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
      const payload = await request.json();
      for (const m of extractIncomingMessages(payload)) await addDocument(env, "whatsapp_inbox", m);
      for (const s of extractStatuses(payload)) await addDocument(env, "whatsapp_status_log", s);
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

    // Everything below is admin-only.
    let user;
    try {
      user = await requireAuthorizedUser(request, env);
    } catch (e) {
      if (["/inbox", "/send-catalogue", "/catalogue-submit", "/catalogue-status"].includes(path) || path.startsWith("/catalogue-image/")) {
        return json({ error: e.message }, 401);
      }
      return new Response("Not found", { status: 404 });
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
        return json({ pending: await submitCatalogue(env, user) });
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    if (path === "/catalogue-status" && request.method === "GET") {
      try {
        return json(await refreshStatus(env));
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
        return json(await sendCatalogueBatch(env, user, offset, limit));
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
