// Emails (19 Nov 2026; Admin shows them only to EMAIL_ADMINS in wrangler.toml for now):
//  - the catalogue by email to the contacts in email_contacts (Admin → Send → Catalogue by email),
//  - a copy of the order form to the customer, when site_content/orders.emailCopy is on and they typed an email.
// The Worker only queues them in Firestore email_queue. A Google Apps Script in the business Gmail
// (tools/email-sender/) sends them from that account every minute (free: Gmail allows ~100 a day).
// No mail password or API key is stored anywhere.
import { getDocument, setDocument, commitWrites, listDocuments } from "./firestore.js";

const EMAIL_RE = /^[^\s@<>"',;:()]+@[^\s@<>"',;:()]+\.[a-z]{2,}$/i;
export const validEmail = (e) => typeof e === "string" && e.length <= 80 && EMAIL_RE.test(e);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const newId = () => crypto.randomUUID().replace(/-/g, "");
// Links in emails use the main address: spam filters distrust workers.dev / pages.dev links in mail from a
// gmail.com sender. /p/<slug> there redirects to the item page (firebase.json); unsubscribe.html calls /email-unsub.
const MAIN_SITE = "https://sharhanbroilers.co.in";
const ORDER_COPIES_PER_DAY = 60; // leaves room in Gmail's ~100 a day for catalogues
const CATALOGUE_MAX = 300;

export function isEmailAdmin(env, user) {
  if (!user || user.sb_user || !user.email_verified) return false;
  const list = String(env.EMAIL_ADMINS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(String(user.email || "").toLowerCase());
}

async function sha(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Counters in KV (rate limits); returns the new count.
async function bump(env, key, ttl) {
  const n = (parseInt((await env.CATALOGUE_IMAGES.get(key)) || "0", 10) || 0) + 1;
  await env.CATALOGUE_IMAGES.put(key, String(n), { expirationTtl: ttl });
  return n;
}

// Unsubscribe links are signed with a key derived from the service account (nothing extra to set up).
let unsubKey = null;
async function unsubToken(env, email) {
  if (!unsubKey) {
    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("sharhan-unsub:" + sa.private_key));
    unsubKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", unsubKey, new TextEncoder().encode(email.toLowerCase())));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The help line under the order form (Admin → Order form → Help line).
async function contactLine(env) {
  const orders = (await getDocument(env, "site_content", "orders").catch(() => null)) || {};
  const help = orders.help || {};
  const phones = (Array.isArray(help.phones) && help.phones.length ? help.phones : help.email ? [] : ["919820132880"])
    .map((p) => String(p).replace(/\D/g, "")).filter((p) => p.length >= 10).slice(0, 2);
  const email = help.email || (help.phones ? "" : "sharhanbroilerplant@gmail.com");
  const parts = phones.map((p) => {
    const l = p.length === 12 && p.startsWith("91") ? p.slice(2) : p;
    return `<a href="tel:+91${esc(l)}" style="color:#846e3e;font-weight:bold;text-decoration:none;">${esc(l.slice(0, 5) + " " + l.slice(5))}</a>`;
  });
  if (validEmail(email)) parts.push(`<a href="mailto:${esc(email)}" style="color:#846e3e;font-weight:bold;text-decoration:none;">${esc(email)}</a>`);
  return { html: parts.join(" &nbsp;·&nbsp; "), orders };
}

function layout(title, inner, footer) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#1c1b19;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea;"><tr><td align="center" style="padding:16px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:6px;">
<tr><td style="background:#1c1b19;color:#ffffff;padding:18px 20px;border-radius:6px 6px 0 0;">
<div style="font-size:20px;font-weight:bold;letter-spacing:1px;">SHARHAN BROILERS</div>
<div style="font-size:13px;color:#d9c89f;margin-top:3px;">${esc(title)}</div></td></tr>
<tr><td style="padding:18px 20px;font-size:15px;line-height:1.55;">${inner}</td></tr>
<tr><td style="padding:14px 20px;background:#faf8f3;font-size:12px;color:#6b6860;line-height:1.6;border-radius:0 0 6px 6px;">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

const button = (href, text) => `<a href="${esc(href)}" style="display:inline-block;background:#846e3e;color:#ffffff;padding:10px 16px;border-radius:4px;text-decoration:none;font-weight:bold;font-size:14px;">${esc(text)}</a>`;

// ---- Order copy (public POST /order-copy from the order form) ----
// Only a fixed layout around the order text; web links other than map links are removed, and
// sends are limited per connection, per address and per day, so it can't be used to send spam.
export async function queueOrderCopy(env, request) {
  const body = await request.json().catch(() => ({}));
  const to = String(body.email || "").trim();
  const kind = body.kind === "order" ? "order" : "weekly";
  const text = String(body.text || "").slice(0, 8000);
  if (!validEmail(to) || !text) return { ok: false, error: "bad request" };
  const { html: contact, orders } = await contactLine(env);
  if (orders.emailCopy !== true) return { ok: false, error: "off" };

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const day = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  if (ip && (await bump(env, "oc-ip:" + ip, 3600)) > 6) return { ok: false, error: "too many" };
  if ((await bump(env, "oc-to:" + (await sha(to.toLowerCase())) + ":" + day, 86400)) > 4) return { ok: false, error: "too many" };
  if ((await bump(env, "oc-day:" + day, 90000)) > ORDER_COPIES_PER_DAY) return { ok: false, error: "daily limit" };

  const isMap = (u) => /^(https?:\/\/)?(maps\.app\.goo\.gl|goo\.gl\/maps|(www\.)?google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)\//i.test(u);
  const clean = text
    .replace(/\*/g, "")
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"]+/gi, (u) => (isMap(u) ? u : "[link removed]"));
  const name = String(body.name || "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 80);
  const what = kind === "order" ? "your order for next day delivery" : "your weekly requirement";
  const inner = `<p style="margin:0 0 12px;">${name ? "Dear " + esc(name) + "," : "Hello,"}</p>
<p style="margin:0 0 12px;">Thank you. We have received ${what}. Our team will contact you within 24 hours to confirm.</p>
<p style="margin:0 0 6px;font-weight:bold;">Your copy:</p>
<div style="background:#faf8f3;border:1px solid #e6dfcf;border-radius:4px;padding:12px;font-size:14px;line-height:1.55;word-break:break-word;">${esc(clean).replace(/\n/g, "<br>")}</div>`;
  const footer = `Questions? ${contact}<br>You got this email because this address was typed in the order form on our website. If that wasn't you, please ignore it.`;
  const subject = kind === "order" ? "Sharhan Broilers: copy of your order" : "Sharhan Broilers: copy of your weekly requirement";
  const plain = `${name ? "Dear " + name + "," : "Hello,"}\n\nThank you. We have received ${what}. Our team will contact you within 24 hours to confirm.\n\nYour copy:\n\n${clean}\n\nSharhan Broilers\n${MAIN_SITE}`;
  await setDocument(env, "email_queue", newId(), {
    to, subject, text: plain, html: layout(kind === "order" ? "Order for next day delivery" : "Weekly requirement", inner, footer),
    kind: "order-copy", priority: 0, status: "queued", createdAt: new Date().toISOString(),
  });
  return { ok: true };
}

// ---- Catalogue by email (POST /email-catalogue, EMAIL_ADMINS only) ----
// Built once per send; each recipient's greeting and unsubscribe link replace {{GREETING}} and {{UNSUB}}.
// Returns { html, text } (a plain-text copy too: mail with only HTML and pictures looks like spam).
async function catalogueMail(env, items, subjectLine) {
  const site = MAIN_SITE;
  const settings = (await getDocument(env, "settings", "whatsapp").catch(() => null)) || {};
  const { html: contact, orders } = await contactLine(env);
  // Photos too through the main address (/catalogue-img/ redirects to the Worker, firebase.json).
  const ownImage = (u) => String(u || "").replace(/^https:\/\/[^/]+\.workers\.dev(\/catalogue-img\/)/, MAIN_SITE + "$1");
  const cell = (it) => {
    const link = `${site}/p/${encodeURIComponent(it.id)}`;
    const img = it.image && !it.placeholder
      ? `<a href="${esc(link)}"><img src="${esc(ownImage(it.image))}" alt="${esc(it.name)}" width="260" style="display:block;width:100%;max-width:260px;height:auto;border-radius:4px;border:0;"></a>` : "";
    return `<td valign="top" width="50%" style="padding:8px;">${img}
<div style="font-size:15px;font-weight:bold;margin:8px 0 4px;">${esc(it.name)}</div>
${it.spec ? `<div style="font-size:13px;color:#54535c;margin:0 0 8px;">${esc(it.spec)}</div>` : ""}
${button(link, "Enroll Now")}</td>`;
  };
  let rows = "";
  for (let i = 0; i < items.length; i += 2) rows += `<tr>${cell(items[i])}${items[i + 1] ? cell(items[i + 1]) : '<td width="50%"></td>'}</tr>`;
  const intro = String(settings.intro || "").trim();
  const inner = `<p style="margin:0 0 12px;">{{GREETING}}</p>
${intro ? `<p style="margin:0 0 14px;">${esc(intro)}</p>` : ""}
<p style="margin:0 0 16px;">${button(site + "/?order=1&utm_source=email", "Fill your weekly requirement")}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
  const footer = `Questions or orders: ${contact}<br>You get this email as a customer of Sharhan Broilers. <a href="{{UNSUB}}" style="color:#6b6860;">Unsubscribe</a>`;
  const help = (orders && orders.help) || {};
  const phones = (Array.isArray(help.phones) ? help.phones : ["919820132880"]).map((p) => String(p).replace(/\D/g, "").slice(-10)).filter(Boolean);
  const text = ["{{GREETING}}", "", intro, intro ? "" : null, "Fill your weekly requirement: " + site + "/?order=1", "", "Our products:",
    ...items.map((it) => "- " + it.name + (it.spec ? ": " + it.spec : "") + "\n  " + site + "/p/" + encodeURIComponent(it.id)),
    "", "Questions or orders: " + [...phones, help.email || ""].filter(Boolean).join(", "), "", "Sharhan Broilers", site, "",
    "To stop these emails: {{UNSUB}}"].filter((l) => l !== null).join("\n");
  return { html: layout(subjectLine, inner, footer), text };
}

export async function queueCatalogue(env, user, body, allItems, workerUrl) {
  const subject = String(body.subject || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120) || "Sharhan Broilers: our products";
  let items = allItems.filter((it) => it.onWhatsApp && it.image && !it.placeholder);
  if (!items.length) items = allItems.filter((it) => it.onWebsite !== false && it.image && !it.placeholder);
  if (!items.length) throw new Error("No products with photos to show.");
  items = items.slice(0, 30);
  let to; // [{ email, name }]
  if (body.mode === "test") to = [{ email: String(user.email), name: "" }];
  else {
    const contacts = await listDocuments(env, "email_contacts");
    const seen = new Set();
    to = contacts.filter((c) => !c.unsubscribed && validEmail(c.email))
      .map((c) => ({ email: c.email.toLowerCase(), name: String(c.name || "").trim() }))
      .filter((c) => !seen.has(c.email) && seen.add(c.email)).slice(0, CATALOGUE_MAX);
  }
  if (!to.length) throw new Error("No email addresses to send to.");
  const at = new Date().toISOString();
  const mail = await catalogueMail(env, items, "Our products");
  const writes = [];
  for (const { email: addr, name } of to) {
    const unsub = `${MAIN_SITE}/unsubscribe.html?e=${encodeURIComponent(addr)}&t=${await unsubToken(env, addr)}`;
    const greeting = name ? "Dear " + name + "," : "Hello,";
    writes.push({ set: ["email_queue", newId(), {
      to: addr, subject,
      html: mail.html.replace("{{GREETING}}", () => esc(greeting)).replace("{{UNSUB}}", () => esc(unsub)),
      text: mail.text.replace("{{GREETING}}", () => greeting).replace("{{UNSUB}}", () => unsub),
      kind: body.mode === "test" ? "catalogue-test" : "catalogue", priority: 1, status: "queued", createdAt: at, by: String(user.email),
    }] });
  }
  await commitWrites(env, writes);
  return { queued: writes.length };
}

// ---- Unsubscribe link (public GET /email-unsub) ----
export async function emailUnsubscribe(env, url) {
  const email = String(url.searchParams.get("e") || "").trim().toLowerCase();
  const t = String(url.searchParams.get("t") || "");
  const page = (msg) => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sharhan Broilers</title>
<body style="font-family:Arial,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#1c1b19;"><h2>Sharhan Broilers</h2><p>${esc(msg)}</p></body>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
  // ?json=1: from unsubscribe.html on the main site.
  const asJson = url.searchParams.get("json") === "1";
  const reply = (ok, msg) => (asJson
    ? new Response(JSON.stringify({ ok }), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } })
    : page(msg));
  if (!validEmail(email) || t !== (await unsubToken(env, email))) return reply(false, "This link isn't valid.");
  const doc = (await getDocument(env, "email_contacts", email).catch(() => null)) || { email };
  await setDocument(env, "email_contacts", email, { ...doc, email, unsubscribed: true, unsubscribedAt: new Date().toISOString() });
  return reply(true, "Done. You won't get our catalogue emails any more.");
}
