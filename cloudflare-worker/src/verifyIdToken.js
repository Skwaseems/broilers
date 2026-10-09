// Verifies a Firebase Auth ID token's signature and claims without the Admin SDK
// (which isn't Workers-compatible). Checks against Google's public JWK signing keys.

const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

let cachedKeys = null; // { keys, expiresAt }

function base64urlToUint8Array(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function getJwks() {
  if (cachedKeys && cachedKeys.expiresAt > Date.now()) return cachedKeys.keys;
  const res = await fetch(JWKS_URL);
  const data = await res.json();
  cachedKeys = { keys: data.keys, expiresAt: Date.now() + 3600_000 };
  return cachedKeys.keys;
}

export async function verifyFirebaseIdToken(idToken, projectId) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(new TextDecoder().decode(base64urlToUint8Array(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(base64urlToUint8Array(payloadB64)));

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error("Wrong audience");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("Wrong issuer");
  if (payload.exp < now) throw new Error("Token expired");
  if (!payload.sub) throw new Error("Missing subject");

  const jwks = await getJwks();
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64urlToUint8Array(sigB64);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedData);
  if (!ok) throw new Error("Bad signature");

  return payload; // includes email, email_verified, sub (uid), etc.
}
