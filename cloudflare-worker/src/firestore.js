// Minimal Firestore REST client for Cloudflare Workers, authenticated as a
// service account via a hand-signed JWT (the Node Admin SDK isn't Workers-compatible).

let cachedToken = null; // { accessToken, expiresAt }

export function base64url(bytes) {
  let str = typeof bytes === "string" ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function importPrivateKey(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function getAccessToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64url(sig)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Firestore auth failed: " + JSON.stringify(data));

  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === "object") return { mapValue: { fields: encodeFields(v) } };
  throw new Error("Unsupported Firestore value: " + typeof v);
}

function encodeFields(obj) {
  const fields = {};
  for (const [k, val] of Object.entries(obj)) fields[k] = encodeValue(val);
  return fields;
}

function decodeValue(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return parseInt(v.integerValue, 10);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

function baseUrl(env) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

export async function listDocuments(env, collection) {
  const token = await getAccessToken(env);
  const docs = [];
  let pageToken = "";
  do {
    const qs = "?pageSize=300" + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "");
    const res = await fetch(`${baseUrl(env)}/${collection}${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error("Firestore list failed: " + JSON.stringify(data));
    for (const doc of data.documents || []) {
      docs.push({ id: doc.name.split("/").pop(), ...decodeFields(doc.fields || {}) });
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return docs;
}

export async function getDocument(env, collection, id) {
  const token = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}/${collection}/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  const data = await res.json();
  if (!res.ok) throw new Error("Firestore get failed: " + JSON.stringify(data));
  return decodeFields(data.fields || {});
}

export async function setDocument(env, collection, id, fields) {
  const token = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}/${collection}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: encodeFields(fields) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Firestore set failed: " + JSON.stringify(data));
  return data;
}

export async function addDocument(env, collection, fields) {
  const token = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}/${collection}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: encodeFields(fields) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Firestore add failed: " + JSON.stringify(data));
  return data;
}

export async function deleteDocument(env, collection, id) {
  const token = await getAccessToken(env);
  const res = await fetch(`${baseUrl(env)}/${collection}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) throw new Error("Firestore delete failed: " + (await res.text()));
}
