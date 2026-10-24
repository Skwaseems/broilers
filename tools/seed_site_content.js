// Seeds the editable homepage content (site_content/main) with what the site
// showed before the editor existed, and adds website fields to catalogue items.
// Uses the Firebase CLI's own login.   node tools/seed_site_content.js
const path = require("path");
const FT = path.join(process.env.APPDATA, "npm/node_modules/firebase-tools/lib");
const auth = require(FT + "/auth");
const { requireAuth } = require(FT + "/requireAuth");
const apiv2 = require(FT + "/apiv2");

const PROJECT = "sharhan-broilers";
const img = (k) => `/assets/img/${k}.webp`;

const CONTENT = {
  slides: [
    { script: "Sharhan", sub: "Fresh Poultry For Kitchens", left: img("board"), right: img("chefChop") },
    { script: "Portioned", sub: "Curry Cut · Boneless · Tandoori", left: img("pieces"), right: img("plating") },
    { script: "Daily", sub: "Hotels · Restaurants · Cloud Kitchens", left: img("pot"), right: img("kitchen") },
  ],
  about: {
    heading: "Suppliers & Contractors Of Live And Processed Chicken Broilers",
    p1: "Established in 1990, Sharhan Broilers has grown into a trusted poultry supplier for Mumbai’s professional kitchens.",
    p2: "Three decades on, the work is unchanged: dress the birds before dawn, portion them to each kitchen’s spec, and deliver them cold. Hotels, restaurants, caterers and cloud kitchens across the city order on a standing daily schedule.",
  },
  categories: [
    { name: "Whole Chicken", image: img("platter") },
    { name: "Curry Cut", image: img("pieces") },
    { name: "Boneless", image: img("breasts") },
    { name: "Wings", image: img("rawTable") },
    { name: "Drumsticks", image: img("seasoned") },
    { name: "Thigh", image: img("piece") },
    { name: "Liver & Gizzard", image: img("bowl") },
  ],
  packs: [
    { name: "Hotel Bulk Pack", image: img("kitchen") },
    { name: "Restaurant Daily Pack", image: img("diningRoom") },
    { name: "Cloud Kitchen Pack", image: img("prepMan") },
    { name: "Caterer Pack", image: img("plating") },
    { name: "Sample Crate", image: img("rack") },
  ],
  cuts: [
    { label: "Biryani Cut", image: img("whole") },
    { label: "Tandoori Cut", image: img("pieces") },
    { label: "Tikka Dice", image: img("piece") },
  ],
  bundle: [
    { fit: "Bone-In", name: "Curry Cut Twelve Piece · Twenty Kilo Crate", image: img("pieces") },
    { fit: "Boneless", name: "Thigh Boneless · Ten Kilo Pack", image: img("piece") },
    { fit: "Bone-In", name: "Soup Pieces · Ten Kilo Pack", image: img("pot") },
    { fit: "Boneless", name: "Breast Fillet · Ten Kilo Pack", image: img("breasts") },
  ],
  extras: [
    { name: "Chicken Mince", image: img("seasoned") },
    { name: "Lollipop", image: img("tray") },
    { name: "Skinless Breast", image: img("breasts") },
    { name: "Whole Legs", image: img("herbs") },
    { name: "Trimmings", image: img("rawTable") },
    { name: "Frames & Bones", image: img("pot") },
    { name: "Soup Pieces", image: img("garlic") },
  ],
  gallery: [{ image: img("garnish") }, { image: img("utensils") }, { image: img("chefChop") }, { image: img("potStove") }],
  visit: {
    text: "Sharhan Broilers supplies hotels, restaurants and cloud kitchens across Mumbai. Our office is on Nagdevi Street, opposite Crawford Market.",
    image: img("cc1ae4f6"),
  },
};

// Website fields for the shared product list. fit/tag/groups for the original 8
// come from the site's previous Fresh Stock data; new items only get a label
// where the name itself says it (Boneless, Offal, Live).
const WEB = {
  "live-broiler": { fit: "Live", tag: "", groups: ["bulk"] },
  "whole-chicken": { fit: "Bone-In", tag: "Daily", groups: ["bulk"] },
  "chicken-tandoori": { fit: "", tag: "", groups: ["daily"] },
  "breast-boneless": { fit: "Boneless", tag: "Best Seller", groups: ["daily"] },
  "leg-boneless": { fit: "Boneless", tag: "", groups: ["daily"] },
  "curry-cut": { fit: "Bone-In", tag: "Best Seller", groups: ["daily"] },
  "chicken-wings": { fit: "Bone-In", tag: "", groups: ["daily"] },
  "drumstick": { fit: "Bone-In", tag: "Daily", groups: ["daily"] },
  "thigh-boneless": { fit: "Boneless", tag: "Best Seller", groups: ["daily"] },
  "boneless-trimming": { fit: "Boneless", tag: "", groups: ["bulk"] },
  "chicken-keema": { fit: "Boneless", tag: "", groups: ["daily"] },
  "soup-piece": { fit: "Bone-In", tag: "", groups: [] },
  "chicken-liver": { fit: "Offal", tag: "Limited", groups: [] },
  "gizzard": { fit: "Offal", tag: "", groups: [] },
  "chicken-skin": { fit: "", tag: "", groups: [] },
};

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

  await client.patch(`${base}/site_content/main`, { fields: encFields(CONTENT) });
  console.log("site_content/main");

  for (const [slug, web] of Object.entries(WEB)) {
    const fields = { ...web, onWebsite: true };
    const mask = Object.keys(fields).map((k) => "updateMask.fieldPaths=" + k).join("&");
    await client.patch(`${base}/catalogue/${slug}?${mask}`, { fields: encFields(fields) });
    console.log("catalogue/" + slug, "+ website fields");
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message, e.context && JSON.stringify(e.context.body));
  process.exit(1);
});
