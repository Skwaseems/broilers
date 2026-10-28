// Admin ID + password sign-in ("staff"), managed by the main admin in Admin → Users.
//
// Passwords never leave the Worker. admin_users/{uid} (no client access in firestore.rules)
// holds a salted PBKDF2 hash, peppered with a key derived from the service account's private
// key, so a copy of the database alone can't be cracked. Rotating that key therefore makes
// every password invalid: the owner then recovers with the email link and sets new ones.
//
// A correct password gets a Firebase custom token (claims sb_user, sb_role). firestore.rules
// and requireStaff() accept the session only while the account is active and it started after
// the account's last password change or switch-off (validAfter, epoch seconds).
import { getDocument, setDocument, deleteDocument, listDocuments, base64url, importPrivateKey } from "./firestore.js";

const COLLECTION = "admin_users";
const ITERATIONS = 10000; // the Workers free plan allows ~10 ms of CPU per request
const MAX_FAILS = 5; // wrong passwords in a row before the ID is locked
const LOCK_MS = 15 * 60 * 1000;
const IP_MAX_FAILS = 30; // wrong tries per hour from one connection, across all IDs
const ID_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MIN_PASSWORD = 8;

export const staffUid = (id) => "u_" + id;
const normId = (s) => String(s || "").trim().toLowerCase();
const nowSec = () => Math.floor(Date.now() / 1000);

class StaffError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function checkPassword(p) {
  if (typeof p !== "string" || p.length < MIN_PASSWORD) throw new StaffError(`Password must be at least ${MIN_PASSWORD} characters.`);
  if (p.length > 128) throw new StaffError("Password is too long.");
}

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let pepperKey = null;
async function pepper(env) {
  if (!pepperKey) {
    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("sharhan-staff:" + sa.private_key));
    pepperKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }
  return pepperKey;
}

async function hashPassword(env, password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(salt), iterations }, key, 256);
  return b64(await crypto.subtle.sign("HMAC", await pepper(env), bits));
}

async function newSecret(env, password) {
  checkPassword(password);
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, iterations: ITERATIONS, hash: await hashPassword(env, password, salt, ITERATIONS) };
}

async function passwordMatches(env, doc, password) {
  if (typeof password !== "string" || !doc.hash || !doc.salt) return false;
  const got = await hashPassword(env, password, doc.salt, doc.iterations || ITERATIONS);
  if (got.length !== doc.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ doc.hash.charCodeAt(i);
  return diff === 0;
}

// Firebase custom token, signed with the service account key (no extra setup needed).
async function customToken(env, doc) {
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const iat = nowSec();
  const claims = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat,
    exp: iat + 3600,
    uid: staffUid(doc.id),
    claims: { sb_user: doc.id, sb_role: doc.role },
  };
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importPrivateKey(sa.private_key), new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(sig)}`;
}

const publicUser = (d) => ({
  id: d.id, name: d.name || "", role: d.role, active: d.active !== false,
  lockedUntil: d.lockedUntil && d.lockedUntil > Date.now() ? d.lockedUntil : 0,
  lastLoginAt: d.lastLoginAt || "", createdAt: d.createdAt || "", createdBy: d.createdBy || "", updatedAt: d.updatedAt || "",
});

const save = (env, doc) => setDocument(env, COLLECTION, staffUid(doc.id), doc);

// A wrong password: counts towards the lock; returns the error to send.
async function wrongPassword(env, doc) {
  const fails = (doc.failCount || 0) + 1;
  if (fails >= MAX_FAILS) {
    doc.failCount = 0;
    doc.lockedUntil = Date.now() + LOCK_MS;
    await save(env, doc);
    return new StaffError("locked", 423, { until: doc.lockedUntil });
  }
  doc.failCount = fails;
  await save(env, doc);
  return new StaffError("wrong", 401, { left: MAX_FAILS - fails });
}

async function ipFails(env, ip, add) {
  if (!ip) return 0;
  const key = "loginfail:" + ip;
  const n = parseInt((await env.CATALOGUE_IMAGES.get(key)) || "0", 10) || 0;
  if (add) await env.CATALOGUE_IMAGES.put(key, String(n + 1), { expirationTtl: 3600 });
  return n + (add ? 1 : 0);
}

// POST /staff-login {id, password} → {token, user}
async function login(env, request, body) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if ((await ipFails(env, ip, false)) >= IP_MAX_FAILS) throw new StaffError("blocked", 429);
  const id = normId(body.id);
  const doc = ID_RE.test(id) ? await getDocument(env, COLLECTION, staffUid(id)) : null;
  if (!doc || doc.active === false) {
    await ipFails(env, ip, true);
    throw new StaffError("wrong", 401);
  }
  if (doc.lockedUntil && doc.lockedUntil > Date.now()) throw new StaffError("locked", 423, { until: doc.lockedUntil });
  if (!(await passwordMatches(env, doc, body.password))) {
    await ipFails(env, ip, true);
    throw await wrongPassword(env, doc);
  }
  doc.failCount = 0;
  doc.lockedUntil = 0;
  doc.lastLoginAt = new Date().toISOString();
  await save(env, doc);
  return { token: await customToken(env, doc), user: publicUser(doc) };
}

// The account behind a staff session, if it may still be used; throws otherwise.
export async function requireStaff(env, payload) {
  const doc = await getDocument(env, COLLECTION, staffUid(normId(payload.sb_user)));
  if (!doc || doc.active === false) throw new Error("This admin ID is switched off");
  if ((payload.auth_time || 0) < (doc.validAfter || 0)) throw new Error("Password changed - sign in again");
  return doc;
}

const isOwner = (env, user) => !!(user.email_verified && env.OWNER_EMAIL && String(user.email).toLowerCase() === env.OWNER_EMAIL.toLowerCase());
const isManager = (env, user) => (user.staff ? user.staff.role === "main" : isOwner(env, user));

// GET /staff-users (manager): every account, without password data.
async function list(env, user) {
  if (!isManager(env, user)) throw new StaffError("Only the main admin can manage users.", 403);
  const users = (await listDocuments(env, COLLECTION)).filter((d) => d.id && d.role).map(publicUser);
  users.sort((a, b) => (a.role === "main" ? -1 : b.role === "main" ? 1 : a.id.localeCompare(b.id)));
  return { users, owner: isOwner(env, user), hasMain: users.some((u) => u.role === "main") };
}

// POST /staff-users {action: add|edit|remove|setup-main, ...} (manager)
async function manage(env, user, body) {
  if (!isManager(env, user)) throw new StaffError("Only the main admin can manage users.", 403);
  const by = user.email;
  const at = new Date().toISOString();
  const id = normId(body.id);
  if (!ID_RE.test(id)) throw new StaffError("ID: 3-32 letters or numbers (dot, dash and underscore allowed), no spaces.");
  const name = String(body.name || "").replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, 60);
  const existing = await getDocument(env, COLLECTION, staffUid(id));

  if (body.action === "setup-main") {
    // The owner (signed in with the recovery email) creates the main admin, or sets its new password.
    if (!isOwner(env, user)) throw new StaffError("Only the owner's email can set up the main admin.", 403);
    const all = await listDocuments(env, COLLECTION);
    const main = all.find((d) => d.role === "main");
    if (existing && existing.role !== "main") throw new StaffError("That ID belongs to another user.");
    if (main && main.id !== id) await deleteDocument(env, COLLECTION, staffUid(main.id)); // renamed
    const doc = { ...(main || {}), id, role: "main", name: name || (main && main.name) || "Main admin", active: true,
      ...(await newSecret(env, body.password)), failCount: 0, lockedUntil: 0, validAfter: nowSec(),
      createdAt: (main && main.createdAt) || at, createdBy: (main && main.createdBy) || by, updatedAt: at };
    await save(env, doc);
    return { user: publicUser(doc) };
  }
  if (body.action === "add") {
    if (existing) throw new StaffError("That ID is already taken.");
    const doc = { id, role: "user", name, active: true, ...(await newSecret(env, body.password)), failCount: 0, lockedUntil: 0,
      validAfter: 0, createdAt: at, createdBy: by, updatedAt: at };
    await save(env, doc);
    return { user: publicUser(doc) };
  }
  if (!existing) throw new StaffError("No such user.", 404);
  if (body.action === "remove") {
    if (existing.role === "main") throw new StaffError("The main admin can't be removed.");
    await deleteDocument(env, COLLECTION, staffUid(id));
    return { removed: id };
  }
  if (body.action === "edit") {
    const doc = { ...existing, updatedAt: at };
    if ("name" in body) doc.name = name;
    if (body.password) Object.assign(doc, await newSecret(env, body.password), { validAfter: nowSec() });
    if (body.unlock || body.password) { doc.failCount = 0; doc.lockedUntil = 0; }
    if ("active" in body) {
      if (existing.role === "main" && body.active === false) throw new StaffError("The main admin can't be switched off.");
      doc.active = body.active !== false;
      if (!doc.active) doc.validAfter = nowSec(); // signs them out everywhere
    }
    await save(env, doc);
    return { user: publicUser(doc) };
  }
  throw new StaffError("Unknown action.");
}

// POST /staff-password {current, next} (the signed-in staff member) → fresh token
async function changeOwn(env, user, body) {
  if (!user.staff) throw new StaffError("You signed in with Google; there is no password to change.", 400);
  const doc = user.staff;
  if (doc.lockedUntil && doc.lockedUntil > Date.now()) throw new StaffError("locked", 423, { until: doc.lockedUntil });
  if (!(await passwordMatches(env, doc, body.current))) throw await wrongPassword(env, doc);
  Object.assign(doc, await newSecret(env, body.next), { failCount: 0, lockedUntil: 0, validAfter: nowSec(), updatedAt: new Date().toISOString() });
  await save(env, doc);
  return { token: await customToken(env, doc) };
}

// Routes. `user` is null for the public login route.
export async function staffRoute(env, request, path, user, json) {
  try {
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    if (path === "/staff-login" && request.method === "POST") return json(await login(env, request, body));
    if (!user) return null;
    if (path === "/staff-me") return json({ user: user.staff ? publicUser(user.staff) : null, manager: isManager(env, user), owner: isOwner(env, user) });
    if (path === "/staff-users" && request.method === "GET") return json(await list(env, user));
    if (path === "/staff-users" && request.method === "POST") return json(await manage(env, user, body));
    if (path === "/staff-password" && request.method === "POST") return json(await changeOwn(env, user, body));
    return null;
  } catch (e) {
    if (e instanceof StaffError) return json({ error: e.message, ...e.extra }, e.status);
    return json({ error: e.message }, 500);
  }
}
