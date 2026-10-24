// /p/<item> — the "Enroll Now" / "Enquire Now" link on WhatsApp catalogue cards.
// Sends people on to the order form, opened straight away with that item marked
// (/?item=<item>&order=1). Also carries og: tags for link previews.  (Pages Function.)
const FIRESTORE = "https://firestore.googleapis.com/v1/projects/sharhan-broilers/databases/(default)/documents/catalogue/";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export async function onRequestGet({ params, request }) {
  const slug = String(params.slug || "").toLowerCase();
  const site = new URL(request.url).origin;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 60) return Response.redirect(site + "/", 302);

  let name = "Sharhan Broilers", desc = "Fresh poultry for hotels, restaurants and caterers across Mumbai.", image = site + "/og-image.jpg";
  try {
    const res = await fetch(FIRESTORE + slug, { cf: { cacheTtl: 300 } });
    if (res.ok) {
      const f = (await res.json()).fields || {};
      const str = (k) => (f[k] && f[k].stringValue) || "";
      if (str("name")) name = str("name");
      const spec = str("spec").replace(/\s*Tap to send us your requirement\.?/i, "").replace(/\s*Packs?\s*:.*$/i, "").trim();
      if (spec) desc = spec;
      image = str("imageCard") || str("image") || image;
    }
  } catch (e) { /* fall back to the generic title */ }

  // order=1: the homepage opens the order form straight away with this item marked.
  const target = `${site}/?item=${slug}&order=1`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} — Sharhan Broilers</title>
<meta property="og:title" content="${esc(name)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:site_name" content="Sharhan Broilers">
<meta property="og:type" content="product">
<meta property="og:url" content="${esc(site + "/p/" + slug)}">
<meta name="robots" content="noindex">
<link rel="canonical" href="${esc(target)}">
<meta http-equiv="refresh" content="0; url=${esc(target)}">
</head><body><script>location.replace(${JSON.stringify(target)});</script>
<p><a href="${esc(target)}">${esc(name)} — Sharhan Broilers</a></p></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
