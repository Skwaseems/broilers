// Set the catalogue order (and which items are ticked for WhatsApp) in Firestore,
// using the Firebase CLI's own login.   node tools/set_catalogue_order.js
// Items not listed keep their current relative order after the listed ones.
const path = require("path");
const FT = path.join(process.env.APPDATA, "npm/node_modules/firebase-tools/lib");
const auth = require(FT + "/auth");
const { requireAuth } = require(FT + "/requireAuth");
const apiv2 = require(FT + "/apiv2");

const PROJECT = "sharhan-broilers";
// Owner's arrangement, 2026-10-18. These are also the items sent on WhatsApp.
const ORDER = [
  "whole-chicken", "chicken-tandoori", "breast-boneless", "leg-boneless", "drumstick",
  "thigh-boneless", "chicken-wings", "curry-cut", "soup-piece",
];

async function main() {
  const account = auth.getGlobalDefaultAccount();
  await requireAuth({ project: PROJECT, user: account.user, tokens: account.tokens });
  const c = new apiv2.Client({ urlPrefix: "https://firestore.googleapis.com", apiVersion: "v1" });
  const base = `projects/${PROJECT}/databases/(default)/documents`;

  const docs = (await c.get(`${base}/catalogue?pageSize=50`)).body.documents || [];
  const current = docs
    .map((d) => ({ id: d.name.split("/").pop(), order: +(d.fields.order && d.fields.order.integerValue || 0) }))
    .sort((a, b) => a.order - b.order)
    .map((d) => d.id);
  const missing = ORDER.filter((id) => !current.includes(id));
  if (missing.length) throw new Error("Not in the catalogue: " + missing.join(", "));
  const final = ORDER.concat(current.filter((id) => !ORDER.includes(id)));

  for (let i = 0; i < final.length; i++) {
    const id = final[i];
    const mask = "updateMask.fieldPaths=order&updateMask.fieldPaths=onWhatsApp";
    await c.patch(`${base}/catalogue/${id}?${mask}`, {
      fields: { order: { integerValue: String(i) }, onWhatsApp: { booleanValue: ORDER.includes(id) } },
    });
    console.log(String(i + 1).padStart(2), id, ORDER.includes(id) ? "(WhatsApp)" : "");
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message, e.context && JSON.stringify(e.context.body));
  process.exit(1);
});
