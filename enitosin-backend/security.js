/**
 * ENITOSIN STORE — security helpers
 *
 * Everything here uses only Node's built-in `crypto`, so it adds no new
 * npm dependencies (fewer packages = a smaller attack surface and nothing
 * extra to keep patched). Kept in its own file so it can be tested alone.
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------
// 1. Escape text before putting it inside an HTML email.
//    Without this, a customer typing <img src=x onerror=...> as their
//    name would inject HTML into the email the store owner opens.
// ---------------------------------------------------------------------
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// ---------------------------------------------------------------------
// 2. Constant-time string comparison.
//    Hashing both sides first gives equal-length buffers, so
//    timingSafeEqual never throws and the comparison time does not leak
//    how many leading characters of a guess were correct (or its length).
// ---------------------------------------------------------------------
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------
// 3. Small in-memory rate limiter (per IP).
//    Stops brute-forcing the admin key, spamming fake checkouts/reviews,
//    and flooding the database or the admin's inbox.
//    limiter.hit(req)  -> true if the request is allowed, false if blocked
//    limiter.middleware() -> Express middleware that answers 429 when blocked
//    NOTE: memory is per server process. That is fine for one Render
//    instance; with several instances you would move this to Redis.
// ---------------------------------------------------------------------
function createRateLimiter({ windowMs, max, message = 'Too many requests. Please slow down and try again shortly.' }) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Periodically drop expired entries so the Map cannot grow forever.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
  }, Math.max(windowMs, 60_000));
  if (sweeper.unref) sweeper.unref(); // don't keep the process alive just for this

  function hit(req) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;
    return entry.count <= max;
  }

  // Has this visitor already used up all `max` allowed hits? (does NOT count as a hit)
  function isBlocked(req) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const entry = hits.get(ip);
    return Boolean(entry && entry.resetAt > Date.now() && entry.count >= max);
  }

  function middleware() {
    return (req, res, next) => {
      if (hit(req)) return next();
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      res.status(429).json({ error: message });
    };
  }

  return { hit, isBlocked, middleware, _hits: hits };
}

// ---------------------------------------------------------------------
// 4. Security headers.
//    - frame-ancestors / X-Frame-Options: stops other sites embedding the
//      admin page in an invisible frame (clickjacking).
//    - connect-src 'self': even if a script were injected, it could not
//      send data (e.g. the admin key) to another website.
//    - base-uri / form-action / object-src: close off other injection tricks.
//    - 'unsafe-inline' scripts are still allowed because the pages use
//      inline <script> and onclick="..." handlers; moving them to separate
//      files would let that be removed later.
// ---------------------------------------------------------------------
function securityHeaders({ hsts = false } = {}) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  };
}

// ---------------------------------------------------------------------
// 5. Only allow safe image sources for products.
//    Accepts: https:// URLs, data:image/... uploads, and plain relative
//    file names like "bag.jfif". Rejects javascript:, data:text/html, etc.
// ---------------------------------------------------------------------
function isSafeImageUrl(value) {
  const v = String(value || '').trim();
  if (!v || v.length > 8_000_000) return false;
  if (/^data:image\/(png|jpe?g|webp|gif|avif);base64,[a-z0-9+/=\s]+$/i.test(v)) return true;
  if (/^https:\/\/[^\s"'<>]+$/i.test(v)) return true;
  // relative path: no scheme (no "xxx:"), no quotes/angle brackets
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^\/\//.test(v) && !/["'<>\\]/.test(v)) return true;
  return false;
}

// ---------------------------------------------------------------------
// 6. An error whose message is SAFE to show to the customer
//    (e.g. "Please provide a valid email address."). Any other error
//    (database/Paystack internals) is replaced by a generic message.
// ---------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

module.exports = { escapeHtml, safeEqual, createRateLimiter, securityHeaders, isSafeImageUrl, HttpError };
