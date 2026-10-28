const assert = require('assert');
const { escapeHtml, safeEqual, createRateLimiter, securityHeaders, isSafeImageUrl, HttpError } = require('../security.js');

// escapeHtml
assert.strictEqual(escapeHtml('<img src=x onerror="a()">'), '&lt;img src=x onerror=&quot;a()&quot;&gt;');
assert.strictEqual(escapeHtml(null), '');

// safeEqual (incl. multibyte/different length must not throw)
assert.strictEqual(safeEqual('secret', 'secret'), true);
assert.strictEqual(safeEqual('secret', 'secreT'), false);
assert.strictEqual(safeEqual('é', 'e'), false);
assert.strictEqual(safeEqual('', undefined), true);

// rate limiter
const rl = createRateLimiter({ windowMs: 1000, max: 3 });
const req = { ip: '1.2.3.4' };
assert.deepStrictEqual([rl.hit(req), rl.hit(req), rl.hit(req), rl.hit(req)], [true, true, true, false]);
assert.strictEqual(rl.isBlocked(req), true);
assert.strictEqual(rl.isBlocked({ ip: '9.9.9.9' }), false);
let status, body, headers = {};
const res = { setHeader: (k, v) => headers[k] = v, status(c) { status = c; return this; }, json(b) { body = b; } };
rl.middleware()(req, res, () => assert.fail('should be blocked'));
assert.strictEqual(status, 429);

// headers
const h = {}; let nextCalled = false;
securityHeaders({ hsts: true })({}, { setHeader: (k, v) => h[k] = v }, () => nextCalled = true);
assert(nextCalled && h['X-Frame-Options'] === 'DENY' && /frame-ancestors 'none'/.test(h['Content-Security-Policy']) && h['Strict-Transport-Security']);

// image url
for (const ok of ['https://x.com/a.jpg', 'bag.jfif', 'public/shoes.jfif', 'data:image/png;base64,iVBORw0KGgo=']) assert.strictEqual(isSafeImageUrl(ok), true, ok);
for (const bad of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'http://x.com/a.jpg', '//evil.com/a.jpg', '" onerror="x', '', '<svg onload=1>']) assert.strictEqual(isSafeImageUrl(bad), false, bad);

// HttpError
const e = new HttpError(400, 'msg'); assert(e.expose && e.status === 400 && e instanceof Error);
console.log('ALL SECURITY TESTS PASSED');
process.exit(0);
