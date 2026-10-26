/**
 * ENITOSIN STORE — customer login helpers
 *
 * Built only on Node's built-in `crypto`, so customer accounts add NO new
 * npm packages (no bcrypt, no jsonwebtoken, no cookie-parser). Fewer packages
 * means less to keep patched, and every piece here is small enough to explain.
 *
 *  - Passwords are never stored. We store a salted scrypt hash (scrypt is a
 *    deliberately slow, memory-hungry hash, which makes password guessing
 *    expensive for an attacker who steals the database).
 *  - A login is remembered with a signed token in an HttpOnly cookie. The
 *    token is "payload.signature"; the signature is an HMAC with a secret that
 *    only the server knows, so a customer cannot edit it to become someone else.
 */

const crypto = require('crypto');

const SESSION_COOKIE = 'enitosin_session';
const SESSION_DAYS = 7;

// ---------------------------------------------------------------------
// 1. Password hashing (scrypt + random salt)
// ---------------------------------------------------------------------
function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16); // a different salt per user stops "rainbow table" attacks
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, saltB64, keyB64] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------
// 2. Signed session tokens
//    `pv` is a short fingerprint of the customer's current password hash, so
//    changing/resetting a password instantly logs out every older session.
// ---------------------------------------------------------------------
const b64url = buf => Buffer.from(buf).toString('base64url');

function passwordFingerprint(passwordHash) {
  return crypto.createHash('sha256').update(String(passwordHash || '')).digest('hex').slice(0, 16);
}

function signSession({ id, passwordHash }, secret, days = SESSION_DAYS) {
  const payload = b64url(JSON.stringify({
    id,
    pv: passwordFingerprint(passwordHash),
    exp: Date.now() + days * 24 * 60 * 60 * 1000,
  }));
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

// Returns the payload if the token is genuine and not expired, otherwise null.
function verifySession(token, secret) {
  if (typeof token !== 'string' || token.length > 600) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null; // forged or edited
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.id || !data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// 3. Cookies (parsed/written by hand — it is only a few lines)
//    HttpOnly  -> JavaScript on the page can never read the token (blocks theft via XSS)
//    SameSite=Lax -> the browser will not send it on cross-site form posts (blocks CSRF)
//    Secure    -> only sent over https (turned on in production)
// ---------------------------------------------------------------------
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function sessionCookie(token, { secure = false, clear = false } = {}) {
  const maxAge = clear ? 0 : SESSION_DAYS * 24 * 60 * 60;
  return [
    `${SESSION_COOKIE}=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

// ---------------------------------------------------------------------
// 4. Reset tokens: the emailed token is random; only its SHA-256 hash is
//    stored, so a leaked database can't be used to reset anyone's password.
// ---------------------------------------------------------------------
function newResetToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: hashResetToken(token) };
}
function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// ---------------------------------------------------------------------
// 5. Input checks
// ---------------------------------------------------------------------
function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 8) return 'Your password must be at least 8 characters.';
  if (p.length > 128) return 'Your password is too long (128 characters maximum).';
  return null;
}
const PHONE_RE = /^[0-9+][0-9\s-]{6,19}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = {
  SESSION_COOKIE, hashPassword, verifyPassword, signSession, verifySession,
  passwordFingerprint, parseCookies, sessionCookie, newResetToken, hashResetToken,
  passwordProblem, PHONE_RE, EMAIL_RE,
};
