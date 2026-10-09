// Loads tools/.seed/catalogue.json into Firestore using the Firebase CLI's own
// logged-in session (same account as `firebase login`), so no service-account
// key is needed.   node tools/seed_firestore.js
const path = require("path");
const fs = require("fs");
const FT = path.join(process.env.APPDATA, "npm/node_modules/firebase-tools/lib");
const auth = require(FT + "/auth");
const { requireAuth } = require(FT + "/requireAuth");
const apiv2 = require(FT + "/apiv2");

const PROJECT = "sharhan-broilers";
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, ".seed", "catalogue.json"), "utf8"));

function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  return { mapValue: { fields: encFields(v) } };
}
function encFields(o) {
  const f = {};
  for (const [k, v] of Object.entries(o)) f[k] = enc(v);
  return f;
}

async function main() {
  const account = auth.getGlobalDefaultAccount();
  await requireAuth({ project: PROJECT, user: account.user, tokens: account.tokens });
  const client = new apiv2.Client({ urlPrefix: "https://firestore.googleapis.com", apiVersion: "v1" });
  const base = `projects/${PROJECT}/databases/(default)/documents`;

  for (const item of seed.items) {
    const { id, ...fields } = item;
    await client.patch(`${base}/catalogue/${id}`, { fields: encFields(fields) });
    console.log("catalogue/" + id);
  }
  await client.patch(`${base}/catalogue_meta/whatsapp`, { fields: encFields(seed.meta) });
  console.log("catalogue_meta/whatsapp");
}

main().catch((e) => {
  console.error("FAILED:", e.message, e.context && JSON.stringify(e.context.body));
  process.exit(1);
});
