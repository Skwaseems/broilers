// /p/<item> — the "Enroll Now" / "Enquire Now" link on WhatsApp catalogue cards.
// The item's own page: full photo, short description, other products, and an Enroll Now
// button that opens only the order form (/?item=<item>&order=1). None of the homepage is
// underneath; the Home button is the way there. Also carries og: tags for link previews.
// (Pages Function.)
const FIRESTORE = "https://firestore.googleapis.com/v1/projects/sharhan-broilers/databases/(default)/documents/catalogue?pageSize=200";
const ORDER_TO = "https://firestore.googleapis.com/v1/projects/sharhan-broilers/databases/(default)/documents/site_content/orders";
const WHATSAPP_PATH = "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z";
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

// The first number in Admin → Order form → Order recipients.
async function enquiryNumber() {
  try {
    const res = await fetch(ORDER_TO, { cf: { cacheTtl: 300 } });
    const list = (await res.json()).fields.whatsapp.arrayValue.values;
    return String(list[0].stringValue).replace(/\D/g, "") || "919820132880";
  } catch (e) {
    return "919820132880";
  }
}

function page(site, item, others, whatsapp) {
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
.top-actions{display:flex;gap:8px}
.refresh{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;padding:0;border:1px solid #846e3e;border-radius:3px;background:none;color:#6e5b32;cursor:pointer}
.refresh svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
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
.wa{position:fixed;right:16px;bottom:calc(92px + env(safe-area-inset-bottom));z-index:3;display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:#25d366;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.3)}
.wa svg{width:31px;height:31px;fill:currentColor}
.order a{display:flex;align-items:center;justify-content:center;max-width:608px;min-height:50px;margin:0 auto;background:#846e3e;color:#fff;border-radius:3px;font-size:16px;font-weight:500;letter-spacing:.06em}
</style></head><body>
<header class="top"><a class="brand" href="/">Sharhan Broilers</a><span class="top-actions"><button type="button" class="refresh" aria-label="Refresh page" title="Refresh" onclick="location.reload()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg></button><a class="home" href="/">Home</a></span></header>
<main>
${item.photo ? `<img id="photo" src="${esc(item.photo)}" alt="${name}" crossorigin="anonymous">` : ""}
<div class="about"><h1>${name}</h1>${item.desc ? `<p>${esc(item.desc)}</p>` : ""}</div>
${cards ? `<section class="more"><h2>Other products</h2><div class="grid">${cards}</div></section>` : ""}
</main>
<a class="wa" href="https://wa.me/${whatsapp}?text=${encodeURIComponent("Hi Sharhan Broilers, I have an enquiry.")}" target="_blank" rel="noopener" aria-label="Chat with us on WhatsApp"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${WHATSAPP_PATH}"/></svg></a>
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
  return new Response(page(site, item, others, await enquiryNumber()), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
