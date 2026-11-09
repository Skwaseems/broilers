// /p/<item> — the "Enroll Now" / "Enquire Now" link on WhatsApp catalogue cards.
// The item's own page: full photo, short description, other products, and an Enroll Now
// button that opens only the order form (/?item=<item>&order=1). None of the homepage is
// underneath; the Home button is the way there. Also carries og: tags for link previews.
// (Pages Function.)
const FIRESTORE = "https://firestore.googleapis.com/v1/projects/sharhan-broilers/databases/(default)/documents/catalogue?pageSize=200";
const FONTS = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600&family=Jost:wght@400;500&display=swap";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const httpsOnly = (u) => (/^https:\/\//i.test(u) ? u : "");

function fromDoc(doc) {
  const f = doc.fields || {};
  const str = (k) => (f[k] && f[k].stringValue) || "";
  const bool = (k) => !!(f[k] && f[k].booleanValue);
  return {
    id: String(doc.name || "").split("/").pop(),
    name: str("name"),
    // The card text is written for WhatsApp; drop its call to action and pack list.
    desc: str("spec").replace(/\s*Tap to send us your requirement\.?/i, "").replace(/\s*Packs?\s*:.*$/i, "").trim(),
    photo: httpsOnly(str("imageTall") || str("image")),
    thumb: httpsOnly(str("imageCard") || str("image")),
    listed: !bool("placeholder") && (bool("onWhatsApp") || !(f.onWebsite && f.onWebsite.booleanValue === false)),
    order: Number((f.order && f.order.integerValue) || 0),
  };
}

// The photo sits on a white 9:16 canvas. Measures the white bands above and below and cuts
// them off, so the photo fills the width. If the image can't be read it just keeps the bands.
const TRIM_BANDS = `(function(){var i=document.getElementById("photo");if(!i)return;function t(){try{
var w=54,h=96,c=document.createElement("canvas");c.width=w;c.height=h;var x=c.getContext("2d");x.drawImage(i,0,0,w,h);
var d=x.getImageData(0,0,w,h).data,top=-1,end=-1;
for(var y=0;y<h;y++)for(var k=0;k<w;k++){var p=(y*w+k)*4;if(d[p]<238||d[p+1]<238||d[p+2]<238){if(top<0)top=y;end=y;break;}}
if(top<0)return;var r=w/(end-top+1);i.style.aspectRatio=String(r);i.style.width="min(100%,calc(70vh*"+r+"))";i.style.width="min(100%,calc(70svh*"+r+"))";i.style.objectFit="cover";
}catch(e){}}if(i.complete&&i.naturalWidth)t();else i.addEventListener("load",t);})();`;

function page(site, item, others) {
  const url = `/p/${item.id}`;
  const order = `/?item=${item.id}&order=1`;
  const name = esc(item.name);
  const ogDesc = item.desc || "Fresh poultry for hotels, restaurants and caterers across Mumbai.";
  const ogImage = item.thumb || item.photo || site + "/og-image.jpg";
  const cards = others.map((o) => `<a class="card" href="/p/${o.id}"><img src="${esc(o.thumb)}" alt="" loading="lazy" width="300" height="300"><span>${esc(o.name)}</span></a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${name} — Sharhan Broilers</title>
<meta name="description" content="${esc(ogDesc)}">
<meta property="og:title" content="${name}">
<meta property="og:description" content="${esc(ogDesc)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:site_name" content="Sharhan Broilers">
<meta property="og:type" content="product">
<meta property="og:url" content="${esc(site + url)}">
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#1c1c22;font-family:'Jost',sans-serif;padding-bottom:calc(84px + env(safe-area-inset-bottom))}
a{color:inherit;text-decoration:none}
.top{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;background:#fff;border-bottom:1px solid #eceae7}
.brand{font-family:'Cormorant Garamond',serif;font-weight:600;font-size:19px;letter-spacing:.06em}
.home{display:inline-flex;align-items:center;min-height:40px;padding:0 16px;border:1px solid #846e3e;border-radius:3px;color:#6e5b32;font-size:14px;font-weight:500}
main{max-width:640px;margin:0 auto}
#photo{display:block;width:100%;height:auto;margin:0 auto;background:#fff;object-fit:contain}
.about{padding:16px 16px 4px}
h1{margin:0;font-family:'Cormorant Garamond',serif;font-weight:600;font-size:28px;line-height:1.2}
.about p{margin:8px 0 0;font-size:16px;line-height:1.55;color:#4a4a53}
.more{padding:22px 16px 8px}
h2{margin:0 0 12px;font-family:'Cormorant Garamond',serif;font-weight:600;font-size:21px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 10px}
.card{display:block;font-size:13px;line-height:1.3;text-align:center}
.card img{display:block;width:100%;height:auto;aspect-ratio:1/1;object-fit:cover;background:#f6f5f3;border:1px solid #eceae7;border-radius:3px;margin-bottom:6px}
.order{position:fixed;left:0;right:0;bottom:0;z-index:2;padding:12px 16px calc(12px + env(safe-area-inset-bottom));background:#fff;border-top:1px solid #eceae7}
.order a{display:flex;align-items:center;justify-content:center;max-width:608px;min-height:50px;margin:0 auto;background:#846e3e;color:#fff;border-radius:3px;font-size:16px;font-weight:500;letter-spacing:.06em}
</style></head><body>
<header class="top"><a class="brand" href="/">Sharhan Broilers</a><a class="home" href="/">Home</a></header>
<main>
${item.photo ? `<img id="photo" src="${esc(item.photo)}" alt="${name}" crossorigin="anonymous">` : ""}
<div class="about"><h1>${name}</h1>${item.desc ? `<p>${esc(item.desc)}</p>` : ""}</div>
${cards ? `<section class="more"><h2>Other products</h2><div class="grid">${cards}</div></section>` : ""}
</main>
<div class="order"><a href="${esc(order)}">Enroll Now</a></div>
<script>${TRIM_BANDS}</script>
</body></html>`;
}

export async function onRequestGet({ params, request }) {
  const slug = String(params.slug || "").toLowerCase();
  const site = new URL(request.url).origin;
  if (!SLUG.test(slug) || slug.length > 60) return Response.redirect(site + "/", 302);

  let items;
  try {
    const res = await fetch(FIRESTORE, { cf: { cacheTtl: 300 } });
    if (!res.ok) throw new Error("catalogue " + res.status);
    items = ((await res.json()).documents || []).map(fromDoc).filter((it) => SLUG.test(it.id) && it.name);
  } catch (e) {
    // Catalogue unreadable: the customer can still order.
    return Response.redirect(`${site}/?item=${slug}&order=1`, 302);
  }

  const item = items.find((it) => it.id === slug);
  if (!item) return Response.redirect(site + "/", 302); // e.g. an old message's deleted item
  const others = items.filter((it) => it.id !== slug && it.listed && it.thumb).sort((a, b) => a.order - b.order);
  return new Response(page(site, item, others), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
