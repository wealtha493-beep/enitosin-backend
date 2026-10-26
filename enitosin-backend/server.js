/**
 * ENITOSIN STORE — Backend API
 * Supabase-backed production-friendly version.
 *
 * Persistent data lives in Supabase PostgreSQL instead of Render's local
 * filesystem. The server keeps the Supabase secret key server-side only.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Resend } = require('resend');
const {
  escapeHtml, safeEqual, createRateLimiter, securityHeaders, isSafeImageUrl, HttpError,
} = require('./security');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!ADMIN_KEY) {
  console.error('ERROR: ADMIN_KEY environment variable is required.');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required.');
  process.exit(1);
}

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'ENITOSIN Store <onboarding@resend.dev>';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
if (!PAYSTACK_SECRET_KEY) {
  console.warn('WARNING: PAYSTACK_SECRET_KEY not set — checkout payments are disabled.');
}

let resendClient = null;
if (RESEND_API_KEY) resendClient = new Resend(RESEND_API_KEY);
else console.warn('WARNING: RESEND_API_KEY not set — order email notifications are disabled.');

app.disable('x-powered-by');

// Render (and most hosts) put a proxy in front of the app. Trusting exactly
// one proxy hop makes req.ip the REAL visitor IP (needed for rate limiting)
// without letting visitors fake it with their own X-Forwarded-For header.
const TRUST_PROXY = process.env.TRUST_PROXY !== undefined
  ? Number(process.env.TRUST_PROXY)
  : (process.env.RENDER ? 1 : false);
app.set('trust proxy', TRUST_PROXY);

const IS_PRODUCTION = process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
app.use(securityHeaders({ hsts: IS_PRODUCTION }));

// The storefront and admin pages are served by this same server, so
// normal use is same-origin and needs NO CORS at all. Only origins you list
// in ALLOWED_ORIGINS (comma-separated) may call the API from another site.
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({ origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false }));

// Product routes need a big body (admin uploads photos as base64). Every
// other route gets a tiny limit so nobody can exhaust memory with huge JSON.
app.use('/api/products', express.json({ limit: '15mb' }));
app.use(express.json({
  limit: '100kb',
  // Paystack signs the exact raw request body — keep a copy before it's
  // parsed into an object, so the webhook handler can verify it.
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Rate limiters (per visitor IP)
const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 300 });
const checkoutLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 20, message: 'Too many checkout attempts. Please wait a few minutes and try again.' });
const reviewLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 5, message: 'Too many review attempts. Please try again later.' });
const verifyLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const adminFailLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 10 });
app.use('/api', apiLimiter.middleware());
app.use(express.static(require('path').join(__dirname, 'public')));

// ---------------------------------------------------------------------
// Supabase REST helper — uses Node 18+'s built-in fetch, so no extra
// npm package is required just to talk to Supabase.
// ---------------------------------------------------------------------
async function supabaseRequest(table, { method = 'GET', query = {}, body, headers = {} } = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!response.ok) {
    const message = data?.message || data?.hint || data?.error || text || `Supabase request failed (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    throw err;
  }
  return data;
}

async function dbList(table, query = {}) {
  return supabaseRequest(table, { query });
}

async function dbInsert(table, rows, { select = '*' } = {}) {
  return supabaseRequest(table, {
    method: 'POST',
    query: { select },
    body: rows,
    headers: { Prefer: 'return=representation' },
  });
}

async function dbUpdate(table, filters, row, { select = '*' } = {}) {
  const query = { select, ...filters };
  return supabaseRequest(table, {
    method: 'PATCH',
    query,
    body: row,
    headers: { Prefer: 'return=representation' },
  });
}

async function dbDelete(table, filters) {
  return supabaseRequest(table, {
    method: 'DELETE',
    query: filters,
    headers: { Prefer: 'return=representation' },
  });
}

function handleDbError(res, err, fallback = 'Database operation failed.') {
  console.error(err);
  // Our own validation errors (HttpError) carry a customer-safe message.
  // Anything else (Supabase/Paystack internals) gets only the generic text,
  // so error output can't leak table names, SQL hints or keys.
  if (err && err.expose) return res.status(err.status || 400).json({ error: err.message });
  res.status(err && err.status >= 400 && err.status < 500 ? err.status : 500)
    .json({ error: fallback, details: IS_PRODUCTION ? undefined : err?.message });
}

// ---------- admin auth ----------
let lastFailLogAt = 0;
function requireAdmin(req, res, next) {
  // Already locked out? Refuse BEFORE checking the key, so even a lucky
  // correct guess can't get through while the lockout lasts.
  if (adminFailLimiter.isBlocked(req)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }
  const key = req.header('x-admin-key') || '';
  if (!safeEqual(key, ADMIN_KEY)) {
    // 10 wrong guesses in 15 minutes triggers the lockout above.
    adminFailLimiter.hit(req);
    // Write at most one audit-log row per minute so an attacker can't flood the database.
    if (Date.now() - lastFailLogAt > 60_000) {
      lastFailLogAt = Date.now();
      logActivity('admin_login_fail', 'Rejected admin authentication attempt').catch(console.error);
    }
    return res.status(401).json({ error: 'Unauthorized: missing or invalid admin key.' });
  }
  next();
}

// ---------- activity logging ----------
async function logActivity(type, message, meta = {}) {
  try {
    await dbInsert('activity_logs', [{
      type,
      message,
      meta,
      timestamp: new Date().toISOString(),
    }]);
  } catch (err) {
    console.error('Failed to write activity log:', err.message);
  }
}

async function readSettings() {
  const rows = await dbList('settings', { id: 'eq.1', select: 'id,notification_email' });
  return rows[0] || { id: 1, notification_email: '' };
}

async function sendOrderNotificationEmail(order) {
  if (!resendClient) return;

  try {
    const settings = await readSettings();
    const recipient = String(settings.notification_email || '').trim();
    if (!recipient) return;

    const money = n => `₦${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const sizeText = item => (item.size ? ` (Size ${item.size})` : '');
    const deliveryInfo = order.customer.delivery;
    const itemsList = order.items
      .map(item => `  • ${item.name}${sizeText(item)}  x${item.qty}  —  ${money(item.price * item.qty)}`)
      .join('\n');

    const textBody = [
      `New order received: ${order.id}`,
      `Type: ${order.orderType}`, '',
      `Customer: ${order.customer.name}`,
      `Phone:    ${order.customer.phone || 'not provided'}`,
      `Email:    ${order.customer.email}`,
      `Address:  ${order.customer.address}`,
      ...(deliveryInfo ? [`Area:     ${deliveryInfo.area}`] : []), '',
      'Items:', itemsList, '',
      ...(deliveryInfo ? [`Dispatch rider fee: ${money(deliveryInfo.fee)}`] : []),
      `Total: ${money(order.total)}`,
      `Status: ${order.status}`,
      `Placed: ${new Date(order.createdAt).toLocaleString('en-NG')}`,
    ].join('\n');

    const itemsHtml = order.items.map(item =>
      `<tr><td style="padding:4px 8px;">${escapeHtml(item.name)}${item.size ? ` (Size ${escapeHtml(item.size)})` : ''}</td><td style="padding:4px 8px;">x${Number(item.qty)}</td><td style="padding:4px 8px;">${money(item.price * item.qty)}</td></tr>`
    ).join('');

    const htmlBody = `<div style="font-family:sans-serif;color:#222;">
      <h2 style="color:#aa7c11;">ENITOSIN STORE — New Order ${escapeHtml(order.id)}</h2>
      <p><strong>Type:</strong> ${escapeHtml(order.orderType)}<br><strong>Customer:</strong> ${escapeHtml(order.customer.name)}<br><strong>Phone:</strong> ${escapeHtml(order.customer.phone || 'not provided')}<br><strong>Email:</strong> ${escapeHtml(order.customer.email)}<br><strong>Address:</strong> ${escapeHtml(order.customer.address)}${deliveryInfo ? `<br><strong>Area:</strong> ${escapeHtml(deliveryInfo.area)}` : ''}</p>
      <table style="border-collapse:collapse;margin:12px 0;"><thead><tr><th style="text-align:left;padding:4px 8px;">Item</th><th style="text-align:left;padding:4px 8px;">Qty</th><th style="text-align:left;padding:4px 8px;">Subtotal</th></tr></thead><tbody>${itemsHtml}</tbody></table>
      <p>${deliveryInfo ? `Dispatch rider fee: ${money(deliveryInfo.fee)}<br>` : ''}<strong>Total: ${money(order.total)}</strong><br>Status: ${escapeHtml(order.status)}<br>Placed: ${new Date(order.createdAt).toLocaleString('en-NG')}</p>
    </div>`;

    const { error } = await resendClient.emails.send({
      from: RESEND_FROM_EMAIL,
      to: recipient,
      subject: `New Order ${order.id} — ${money(order.total)}`,
      text: textBody,
      html: htmlBody,
    });
    if (error) throw new Error(error.message || 'Unknown Resend error');
    await logActivity('email_sent', `Order notification emailed to ${recipient} for ${order.id}`, { orderId: order.id });
  } catch (err) {
    console.error('Failed to send order notification email:', err.message);
    await logActivity('email_failed', `Failed to email order notification for ${order.id}: ${err.message}`, { orderId: order.id });
  }
}

// Emails the CUSTOMER (not the admin) when their order is Accepted or
// Rejected, so they aren't left wondering what happened after they paid.
async function sendOrderStatusEmail(order, status) {
  if (!resendClient) return;
  if (status !== 'Accepted' && status !== 'Rejected') return;

  try {
    const recipient = String(order.customer?.email || '').trim();
    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return;

    const money = n => `₦${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const isAccepted = status === 'Accepted';
    const subject = isAccepted
      ? `Your ENITOSIN order ${order.id} has been accepted`
      : `Update on your ENITOSIN order ${order.id}`;

    const introText = isAccepted
      ? `Good news — your order has been accepted and is now being prepared${order.orderType === 'Pickup' ? ' for pickup' : ' for delivery'}.`
      : `We're sorry — your order could not be accepted. If you were charged, our team will process a refund shortly. Please reach out if you have any questions.`;

    const feeInfo = order.customer?.delivery;
    const itemsList = (order.items || [])
      .map(item => `  • ${item.name}${item.size ? ` (Size ${item.size})` : ''}  x${item.qty}  —  ${money(item.price * item.qty)}`)
      .join('\n');

    const textBody = [
      introText, '',
      `Order: ${order.id}`,
      `Status: ${status}`, '',
      'Items:', itemsList, '',
      ...(feeInfo ? [`Dispatch rider fee (${feeInfo.area}): ${money(feeInfo.fee)}`] : []),
      `Total: ${money(order.total)}`,
    ].join('\n');

    const itemsHtml = (order.items || []).map(item =>
      `<tr><td style="padding:4px 8px;">${escapeHtml(item.name)}${item.size ? ` (Size ${escapeHtml(item.size)})` : ''}</td><td style="padding:4px 8px;">x${Number(item.qty)}</td><td style="padding:4px 8px;">${money(item.price * item.qty)}</td></tr>`
    ).join('');

    const badgeColor = isAccepted ? '#2e7d32' : '#c62828';
    const htmlBody = `<div style="font-family:sans-serif;color:#222;">
      <h2 style="color:#aa7c11;">ENITOSIN STORE</h2>
      <p>${introText}</p>
      <p><strong>Order:</strong> ${escapeHtml(order.id)}<br><strong>Status:</strong> <span style="color:${badgeColor}; font-weight:bold;">${escapeHtml(status)}</span></p>
      <table style="border-collapse:collapse;margin:12px 0;"><thead><tr><th style="text-align:left;padding:4px 8px;">Item</th><th style="text-align:left;padding:4px 8px;">Qty</th><th style="text-align:left;padding:4px 8px;">Subtotal</th></tr></thead><tbody>${itemsHtml}</tbody></table>
      <p>${feeInfo ? `Dispatch rider fee (${escapeHtml(feeInfo.area)}): ${money(feeInfo.fee)}<br>` : ''}<strong>Total: ${money(order.total)}</strong></p>
    </div>`;

    const { error } = await resendClient.emails.send({
      from: RESEND_FROM_EMAIL,
      to: recipient,
      subject,
      text: textBody,
      html: htmlBody,
    });
    if (error) throw new Error(error.message || 'Unknown Resend error');
    await logActivity('email_sent', `Order ${status.toLowerCase()} notice emailed to ${recipient} for ${order.id}`, { orderId: order.id });
  } catch (err) {
    console.error('Failed to send order status email:', err.message);
    await logActivity('email_failed', `Failed to email order ${status.toLowerCase()} notice for ${order.id}: ${err.message}`, { orderId: order.id });
  }
}

async function healthHandler(req, res) {
  try {
    await dbList('products', { select: 'id', limit: '1' });
    res.json({ status: 'ok', database: 'supabase', server: 'enitosin' });
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(503).json({
      status: 'error',
      database: 'unavailable',
      message: 'The Enitosin server is running, but it cannot reach Supabase.'
    });
  }
}

app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// =====================================================================
// PRODUCTS
// =====================================================================
app.get('/api/products', async (req, res) => {
  try {
    const products = await dbList('products', { select: '*', order: 'created_at.desc' });
    res.json(products.map(normalizeProduct));
  } catch (err) {
    handleDbError(res, err, 'Could not load products.');
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const rows = await dbList('products', { id: `eq.${req.params.id}`, select: '*' });
    if (!rows.length) return res.status(404).json({ error: 'Product not found.' });
    res.json(normalizeProduct(rows[0]));
  } catch (err) {
    handleDbError(res, err, 'Could not load product.');
  }
});

function normalizeProduct(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    subcategory: row.subcategory || '',
    price: Number(row.price),
    oldPrice: row.old_price === null || row.old_price === undefined ? null : Number(row.old_price),
    badge: row.badge || null,
    rating: row.rating || '5.0',
    desc: row.description || '',
    image: row.image || '',
    stock: row.stock || 'In Stock',
    sizes: Array.isArray(row.sizes) ? row.sizes : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function productPayload(body, existing = {}) {
  const name = String(body.name ?? existing.name ?? '').trim();
  const category = String(body.category ?? existing.category ?? '').trim();
  const subcategory = body.subcategory === undefined
    ? (existing.subcategory || '')
    : String(body.subcategory || '').trim();
  const image = String(body.image ?? existing.image ?? '').trim();
  const price = Number(body.price ?? existing.price);
  const hasOldPrice = Object.prototype.hasOwnProperty.call(body, 'oldPrice');
  const rawOld = hasOldPrice ? body.oldPrice : (existing.old_price ?? null);
  const oldPrice = rawOld === '' || rawOld === null || rawOld === undefined ? null : Number(rawOld);

  if (!name || !category || !image || !Number.isFinite(price) || price < 0) {
    throw new Error('Valid name, category, price and image are required.');
  }
  if (oldPrice !== null && (!Number.isFinite(oldPrice) || oldPrice < 0)) {
    throw new Error('oldPrice must be a valid non-negative number.');
  }
  // Only real image sources are accepted. A value like "javascript:..." or
  // "data:text/html,..." in an image field is a classic way to attack visitors.
  if (!isSafeImageUrl(image)) {
    throw new HttpError(400, 'Image must be an uploaded picture or an https:// image link.');
  }
  if (name.length > 200 || category.length > 50 || subcategory.length > 50) {
    throw new HttpError(400, 'Product name, category or subcategory is too long.');
  }

  return {
    name,
    category,
    subcategory,
    price,
    old_price: oldPrice,
    badge: body.badge === undefined ? (existing.badge || null) : (body.badge ? String(body.badge).trim() : null),
    rating: body.rating === undefined ? (existing.rating || '5.0') : (body.rating ? String(body.rating).trim() : '5.0'),
    description: (body.desc === undefined ? (existing.description || '') : String(body.desc || '').trim()).slice(0, 2000),
    image,
    stock: body.stock === undefined ? (existing.stock || 'In Stock') : (String(body.stock || '').trim() || 'In Stock'),
    sizes: body.sizes === undefined
      ? (Array.isArray(existing.sizes) ? existing.sizes : [])
      : [...new Set((Array.isArray(body.sizes) ? body.sizes : String(body.sizes || '').split(','))
          .map(size => String(size).trim().slice(0, 20)).filter(Boolean))].slice(0, 20),
  };
}

app.post('/api/products', requireAdmin, async (req, res) => {
  try {
    const payload = productPayload(req.body || {});
    const rows = await dbInsert('products', [payload]);
    const product = normalizeProduct(rows[0]);
    await logActivity('product_add', `Added product "${product.name}"`, { productId: product.id });
    res.status(201).json(product);
  } catch (err) {
    if (err.message.includes('Valid name') || err.message.includes('oldPrice')) return res.status(400).json({ error: err.message });
    handleDbError(res, err, 'Could not add product.');
  }
});

app.put('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const existingRows = await dbList('products', { id: `eq.${req.params.id}`, select: '*' });
    if (!existingRows.length) return res.status(404).json({ error: 'Product not found.' });
    const payload = productPayload(req.body || {}, existingRows[0]);
    const rows = await dbUpdate('products', { id: `eq.${req.params.id}` }, payload);
    if (!rows.length) return res.status(404).json({ error: 'Product not found.' });
    const product = normalizeProduct(rows[0]);
    await logActivity('product_update', `Updated product "${product.name}"`, { productId: product.id });
    res.json(product);
  } catch (err) {
    if (err.message.includes('Valid name') || err.message.includes('oldPrice')) return res.status(400).json({ error: err.message });
    handleDbError(res, err, 'Could not update product.');
  }
});

app.delete('/api/products/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await dbList('products', { id: `eq.${req.params.id}`, select: '*' });
    if (!existing.length) return res.status(404).json({ error: 'Product not found.' });
    await dbDelete('products', { id: `eq.${req.params.id}` });
    await logActivity('product_delete', `Deleted product "${existing[0].name}"`, { productId: existing[0].id });
    res.json({ success: true });
  } catch (err) {
    handleDbError(res, err, 'Could not delete product.');
  }
});

// =====================================================================
// ORDERS
// =====================================================================

// Validates cart items against the real product catalog and returns
// normalized {id, name, price, qty} rows plus the computed total.
// Shared by the payment-initialize step and the final order creation,
// so a customer can never pay based on stale/tampered prices.
// Cleans and length-limits the customer's details. Without limits, someone
// could submit megabytes of text as a "name" and bloat the database/emails.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function cleanCustomer(raw, { requireAddress = true } = {}) {
  const name = String(raw?.name || '').trim();
  const email = String(raw?.email || '').trim().toLowerCase();
  const phone = String(raw?.phone || '').trim();
  const address = String(raw?.address || '').trim();
  if (!name || !email || !phone || (requireAddress && !address)) {
    throw new HttpError(400, 'Customer name, email, phone number and address are required.');
  }
  if (name.length > 100 || email.length > 254 || phone.length > 30 || address.length > 300) {
    throw new HttpError(400, 'One of your details is too long. Please shorten it and try again.');
  }
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please provide a valid email address.');
  return { name, email, phone, address };
}

async function validateAndPriceItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(400, 'At least one item is required.');
  }
  if (items.length > 50) throw new HttpError(400, 'Too many items in one order.');

  const products = await dbList('products', { select: 'id,name,price,sizes' });
  const normalizedItems = [];
  for (const item of items) {
    const product = products.find(p => String(p.id) === String(item.id));
    const qty = Number(item.qty);
    if (!product || !Number.isInteger(qty) || qty < 1 || qty > 99) {
      throw new HttpError(400, 'One or more order items are invalid or unavailable.');
    }
    // If the product comes in sizes, the customer's chosen size must be one of
    // them, so the admin knows exactly which size to pack.
    const available = Array.isArray(product.sizes) ? product.sizes.map(String) : [];
    let size = '';
    if (available.length) {
      size = available.find(sz => sz.toLowerCase() === String(item.size || '').trim().toLowerCase()) || '';
      if (!size) throw new HttpError(400, `Please choose a size for ${product.name}.`);
    }
    normalizedItems.push({ id: product.id, name: product.name, price: Number(product.price), qty, size });
  }
  const total = normalizedItems.reduce((sum, item) => sum + item.price * item.qty, 0);
  return { normalizedItems, total: Number(total.toFixed(2)) };
}

// Works out the dispatch-rider fee for an order. The fee is ALWAYS read from
// the database here on the server, never taken from the browser — otherwise a
// customer could edit the request and pay ₦0 for delivery.
// Returns null for pickup orders, or when the admin hasn't added any areas yet.
async function resolveDelivery(orderType, zoneId) {
  if (orderType === 'Pickup') return null;
  let zones = [];
  try {
    zones = await dbList('delivery_zones', { select: 'id,name,fee' });
  } catch (err) {
    // 404 = the delivery_zones table hasn't been created yet (SQL not run).
    // Keep checkout working with no fee instead of breaking every order.
    if (err.status !== 404) throw err;
    console.warn('delivery_zones table not found — run the delivery SQL in supabase-schema.sql');
  }
  if (!zones.length) return null;
  const zone = zones.find(z => String(z.id) === String(zoneId));
  if (!zone) throw new HttpError(400, 'Please choose your delivery area.');
  return { zoneId: zone.id, area: zone.name, fee: Number(zone.fee) };
}

// Creates the actual order row in Supabase. Used both by the legacy
// direct-order endpoint and by the Paystack payment flow once a
// payment has been confirmed as successful.
async function createOrderRecord({ customer, normalizedItems, total, paymentStatus, paymentReference, orderType, delivery }) {
  const { name, email, phone, address } = customer;
  const orderId = `EN-${Date.now().toString().slice(-8)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const createdAt = new Date().toISOString();
  const orderRecord = {
    id: orderId,
    // Phone and delivery area/fee live inside the existing `customer` JSON
    // column, so the orders table needs no change.
    customer: { name, email, phone, address, ...(delivery ? { delivery: { area: delivery.area, fee: delivery.fee } } : {}) },
    items: normalizedItems,
    total,
    status: 'Pending',
    payment_status: paymentStatus || 'Unpaid',
    payment_reference: paymentReference || null,
    order_type: orderType === 'Pickup' ? 'Pickup' : 'Delivery',
    created_at: createdAt,
  };

  const inserted = await dbInsert('orders', [orderRecord]);
  const row = inserted[0];
  const newOrder = {
    id: row.id,
    customer: row.customer,
    items: row.items,
    total: Number(row.total),
    status: row.status,
    paymentStatus: row.payment_status,
    paymentReference: row.payment_reference,
    orderType: row.order_type || 'Delivery',
    createdAt: row.created_at,
  };

  // The order is already saved, so a problem recording the customer (e.g. two
  // orders at once hitting the unique-email rule) must never fail the order.
  try {
    const existingCustomer = await dbList('customers', { email: `eq.${email}`, select: 'id' });
    if (!existingCustomer.length) {
      await dbInsert('customers', [{ name, email, joined_at: createdAt }]);
    }
  } catch (err) {
    console.warn('Could not record customer:', err.message);
  }

  const money = n => `₦${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  await logActivity('order', `New order ${newOrder.id} from ${name} — ${money(newOrder.total)}`, { orderId: newOrder.id });
  sendOrderNotificationEmail(newOrder).catch(console.error);

  return newOrder;
}

// Legacy "create an order without paying" endpoint. The storefront does NOT
// use it (it uses /api/payments/initialize), and leaving it public meant
// anyone could create unlimited fake unpaid orders and spam the admin with
// emails. It now needs the admin key (e.g. for manually entering a phone order).
app.post('/api/orders', requireAdmin, async (req, res) => {
  try {
    const { customer, items, orderType, deliveryZoneId } = req.body || {};
    const clean = cleanCustomer(customer);
    const { normalizedItems, total: itemsTotal } = await validateAndPriceItems(items);
    const delivery = await resolveDelivery(orderType === 'Pickup' ? 'Pickup' : 'Delivery', deliveryZoneId);
    const total = Number((itemsTotal + (delivery?.fee || 0)).toFixed(2));
    const newOrder = await createOrderRecord({ customer: clean, normalizedItems, total, orderType, delivery });
    res.status(201).json(newOrder);
  } catch (err) {
    handleDbError(res, err, 'Could not place order.');
  }
});

// =====================================================================
// PAYMENTS (Paystack)
// =====================================================================
app.post('/api/payments/initialize', checkoutLimiter.middleware(), async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({ error: 'Payments are not configured yet. Please contact the store.' });
    }
    const { customer, items, orderType, deliveryZoneId } = req.body || {};
    const { name, email, phone, address } = cleanCustomer(customer);
    const resolvedOrderType = orderType === 'Pickup' ? 'Pickup' : 'Delivery';

    const { normalizedItems, total: itemsTotal } = await validateAndPriceItems(items);
    if (itemsTotal <= 0) return res.status(400).json({ error: 'Order total must be greater than zero.' });

    // Dispatch rider fee for the customer's chosen area (looked up server-side).
    const delivery = await resolveDelivery(resolvedOrderType, deliveryZoneId);
    const total = Number((itemsTotal + (delivery?.fee || 0)).toFixed(2));

    // Where Paystack sends the customer back. Prefer a fixed PUBLIC_URL so a
    // forged Host header can't make Paystack redirect buyers to another site.
    const origin = String(process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        amount: Math.round(total * 100), // Paystack expects kobo (₦1 = 100 kobo)
        currency: 'NGN',
        callback_url: `${origin}/index.html`,
        metadata: {
          customer: { name, email, phone, address },
          items: normalizedItems,
          orderType: resolvedOrderType,
          delivery, // { zoneId, area, fee } or null
        },
      }),
    });

    const data = await paystackRes.json();
    if (!paystackRes.ok || !data.status) {
      console.error('Paystack initialize failed:', data);
      return res.status(502).json({ error: 'Could not start payment. Please try again.' });
    }

    res.json({
      authorizationUrl: data.data.authorization_url,
      reference: data.data.reference,
    });
  } catch (err) {
    handleDbError(res, err, 'Could not start payment.');
  }
});

// Turns a database row into the order object used in this file.
function rowToOrder(row) {
  return {
    id: row.id, customer: row.customer, items: row.items, total: Number(row.total),
    status: row.status, paymentStatus: row.payment_status, paymentReference: row.payment_reference,
    orderType: row.order_type || 'Delivery', createdAt: row.created_at,
  };
}

// What we tell the BROWSER after payment. Deliberately minimal: the full
// order holds the customer's name, phone and address, and anyone who got hold
// of a payment reference would otherwise be able to read all of that.
function publicOrderSummary(order) {
  return { id: order.id, total: order.total, status: order.status, orderType: order.orderType };
}

// Shared by both the webhook and the verify endpoint — idempotent, so
// whichever one runs first "wins" and the other just returns the same order.
// `paid` is what Paystack says was really charged: { amountKobo, currency }.
async function fulfillPaidOrder(reference, metadata, paid = {}) {
  const findExisting = async () => {
    const rows = await dbList('orders', { payment_reference: `eq.${reference}`, select: '*' });
    return rows.length ? rowToOrder(rows[0]) : null;
  };

  const existing = await findExisting();
  if (existing) return existing;

  const customer = metadata?.customer || {};
  const items = metadata?.items || [];
  const { normalizedItems, total: itemsTotal } = await validateAndPriceItems(items.map(i => ({ id: i.id, qty: i.qty, size: i.size })));

  // The delivery fee was fixed by OUR server when payment started and Paystack
  // stored it in the transaction's metadata (the customer can't alter it).
  const metaFee = Number(metadata?.delivery?.fee);
  const delivery = metadata?.delivery && Number.isFinite(metaFee) && metaFee >= 0
    ? { zoneId: metadata.delivery.zoneId, area: String(metadata.delivery.area || '').slice(0, 100), fee: metaFee }
    : null;
  const total = Number((itemsTotal + (delivery?.fee || 0)).toFixed(2));

  // Check the money actually received matches the order total. If an admin
  // changed a price between "initialize" and "paid", or the amounts differ in
  // any way, we must not silently mark the order as fully Paid.
  const expectedKobo = Math.round(total * 100);
  const amountOk = paid.amountKobo === undefined || (Number(paid.amountKobo) === expectedKobo && (paid.currency || 'NGN') === 'NGN');
  if (!amountOk) {
    await logActivity('payment_mismatch',
      `Payment ${reference}: Paystack charged ${paid.amountKobo} kobo ${paid.currency || ''} but the order total is ${expectedKobo} kobo. Needs manual review.`,
      { reference });
  }

  try {
    return await createOrderRecord({
      customer: { name: customer.name, email: customer.email, phone: customer.phone, address: customer.address },
      normalizedItems,
      total,
      paymentStatus: amountOk ? 'Paid' : 'Check Payment',
      paymentReference: reference,
      orderType: metadata?.orderType,
      delivery,
    });
  } catch (err) {
    // The webhook and the browser-return can run at the same moment. The
    // database's unique index lets only one insert win; the loser (HTTP 409)
    // simply returns the order the winner created.
    if (err.status === 409) {
      const winner = await findExisting();
      if (winner) return winner;
    }
    throw err;
  }
}

// Paystack calls this directly, server-to-server, the moment a payment
// succeeds — this is the only place we actually trust that money moved.
app.post('/api/payments/webhook', async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) return res.sendStatus(503);

    const signature = String(req.headers['x-paystack-signature'] || '');
    const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.rawBody || Buffer.from('')).digest('hex');
    // constant-time compare (a plain !== can leak how much of a forged signature matched)
    if (!signature || !safeEqual(signature, expected)) {
      console.warn('Rejected webhook: invalid Paystack signature.');
      return res.sendStatus(401);
    }

    const event = req.body;
    // acknowledge immediately — Paystack retries if it doesn't get a fast 200
    res.sendStatus(200);

    if (event?.event === 'charge.success') {
      const reference = event.data?.reference;
      const metadata = event.data?.metadata;
      if (reference) {
        await fulfillPaidOrder(reference, metadata, {
          amountKobo: event.data?.amount, currency: event.data?.currency,
        }).catch(err => {
          console.error('Failed to fulfill order from webhook:', err);
        });
      }
    }
  } catch (err) {
    console.error('Webhook error:', err);
    if (!res.headersSent) res.sendStatus(500);
  }
});

// The customer's browser hits this after Paystack redirects back —
// confirms payment directly with Paystack's API as a safety net in case
// the webhook is delayed, and returns the finished order either way.
app.get('/api/payments/verify/:reference', verifyLimiter.middleware(), async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Payments are not configured.' });
    const reference = String(req.params.reference || '');
    if (!/^[A-Za-z0-9_.=-]{6,100}$/.test(reference)) return res.json({ status: 'failed' });

    const rows = await dbList('orders', { payment_reference: `eq.${reference}`, select: '*' });
    if (rows.length) {
      return res.json({ status: 'success', order: publicOrderSummary(rowToOrder(rows[0])) });
    }

    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    });
    const data = await verifyRes.json();

    if (!verifyRes.ok || !data.status || data.data?.status !== 'success') {
      return res.json({ status: 'failed' });
    }

    const order = await fulfillPaidOrder(reference, data.data.metadata, {
      amountKobo: data.data.amount, currency: data.data.currency,
    });
    res.json({ status: 'success', order: publicOrderSummary(order) });
  } catch (err) {
    handleDbError(res, err, 'Could not verify payment.');
  }
});

app.get('/api/orders', requireAdmin, async (req, res) => {
  try {
    const rows = await dbList('orders', { select: '*', order: 'created_at.desc' });
    res.json(rows.map(row => ({
      id: row.id,
      customer: row.customer,
      items: row.items,
      total: Number(row.total),
      status: row.status,
      paymentStatus: row.payment_status || 'Unpaid',
      paymentReference: row.payment_reference || null,
      orderType: row.order_type || 'Delivery',
      createdAt: row.created_at,
    })));
  } catch (err) {
    handleDbError(res, err, 'Could not load orders.');
  }
});

app.put('/api/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body || {};
    const allowedStatuses = ['Pending', 'Accepted', 'Rejected'];
    if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Invalid order status.' });
    const rows = await dbUpdate('orders', { id: `eq.${req.params.id}` }, { status });
    if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
    const row = rows[0];
    await logActivity('order_status', `Order ${row.id} marked ${status}`, { orderId: row.id });

    sendOrderStatusEmail({
      id: row.id,
      customer: row.customer,
      items: row.items,
      total: Number(row.total),
      orderType: row.order_type,
    }, status).catch(console.error);

    res.json({ ...row, total: Number(row.total), createdAt: row.created_at });
  } catch (err) {
    handleDbError(res, err, 'Could not update order status.');
  }
});

// =====================================================================
// DELIVERY AREAS (dispatch rider fee per location)
// The admin adds places and prices; customers pick one at checkout.
// =====================================================================
function cleanZone(body) {
  const name = String(body?.name || '').trim();
  const fee = Number(body?.fee);
  if (!name || name.length > 100) throw new HttpError(400, 'Enter an area name (up to 100 characters).');
  if (!Number.isFinite(fee) || fee < 0 || fee > 1_000_000) throw new HttpError(400, 'Enter a valid delivery fee (0 or more).');
  return { name, fee: Number(fee.toFixed(2)) };
}

// Public: the storefront needs this list to fill the checkout dropdown.
app.get('/api/delivery-zones', async (req, res) => {
  try {
    const rows = await dbList('delivery_zones', { select: 'id,name,fee', order: 'name.asc' });
    res.json(rows.map(z => ({ id: z.id, name: z.name, fee: Number(z.fee) })));
  } catch (err) {
    // table not created yet -> behave as "no areas" so the store still works
    if (err.status === 404) return res.json([]);
    handleDbError(res, err, 'Could not load delivery areas.');
  }
});

app.post('/api/delivery-zones', requireAdmin, async (req, res) => {
  try {
    const zone = cleanZone(req.body);
    const rows = await dbInsert('delivery_zones', [zone]);
    await logActivity('delivery_zone', `Delivery area added: ${zone.name} (₦${zone.fee})`, { zoneId: rows[0].id });
    res.status(201).json({ id: rows[0].id, name: rows[0].name, fee: Number(rows[0].fee) });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: 'That area already exists. Edit it instead.' });
    handleDbError(res, err, 'Could not add delivery area.');
  }
});

app.put('/api/delivery-zones/:id', requireAdmin, async (req, res) => {
  try {
    const zone = cleanZone(req.body);
    const rows = await dbUpdate('delivery_zones', { id: `eq.${req.params.id}` }, zone);
    if (!rows.length) return res.status(404).json({ error: 'Delivery area not found.' });
    await logActivity('delivery_zone', `Delivery area updated: ${zone.name} (₦${zone.fee})`, { zoneId: rows[0].id });
    res.json({ id: rows[0].id, name: rows[0].name, fee: Number(rows[0].fee) });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: 'Another area already uses that name.' });
    handleDbError(res, err, 'Could not update delivery area.');
  }
});

app.delete('/api/delivery-zones/:id', requireAdmin, async (req, res) => {
  try {
    const rows = await dbDelete('delivery_zones', { id: `eq.${req.params.id}` });
    if (!rows.length) return res.status(404).json({ error: 'Delivery area not found.' });
    await logActivity('delivery_zone', `Delivery area deleted: ${rows[0].name}`, { zoneId: rows[0].id });
    res.json({ success: true });
  } catch (err) {
    handleDbError(res, err, 'Could not delete delivery area.');
  }
});

// =====================================================================
// REVIEWS
// Only customers with a real, paid order can leave a review, and each
// order can review only once. Reviews wait for admin approval.
// =====================================================================

// Public: approved reviews only. An empty list makes the storefront show
// its default "Coming soon" card.
app.get('/api/reviews', async (req, res) => {
  try {
    const rows = await dbList('reviews', {
      select: 'id,name,rating,comment,created_at',
      approved: 'eq.true',
      order: 'created_at.desc',
      limit: '12',
    });
    res.json(rows.map(r => ({
      id: r.id, name: r.name, rating: r.rating, comment: r.comment, createdAt: r.created_at,
    })));
  } catch (err) {
    handleDbError(res, err, 'Could not load reviews.');
  }
});

// Customer submits a review after paying. The Paystack payment reference
// (random, known only to the buyer) proves they really purchased.
app.post('/api/reviews', reviewLimiter.middleware(), async (req, res) => {
  try {
    const reference = String(req.body?.reference || '').trim();
    const rating = Number(req.body?.rating);
    const comment = String(req.body?.comment || '').trim();

    if (!reference) return res.status(400).json({ error: 'Payment reference is required.' });
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Please choose a star rating from 1 to 5.' });
    }
    if (comment.length < 3 || comment.length > 500) {
      return res.status(400).json({ error: 'Please write a review between 3 and 500 characters.' });
    }

    const orders = await dbList('orders', {
      payment_reference: `eq.${reference}`,
      select: 'id,customer,payment_status',
    });
    if (!orders.length || orders[0].payment_status !== 'Paid') {
      return res.status(403).json({ error: 'Only customers with a paid order can leave a review.' });
    }
    const order = orders[0];

    const already = await dbList('reviews', { order_id: `eq.${order.id}`, select: 'id' });
    if (already.length) return res.status(409).json({ error: 'You have already reviewed this order. Thank you!' });

    // Show "Firstname L." publicly instead of the full name (privacy).
    const parts = String(order.customer?.name || 'Customer').trim().split(/\s+/);
    const displayName = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];

    await dbInsert('reviews', [{ order_id: order.id, name: displayName, rating, comment, approved: false }]);
    await logActivity('review', `New ${rating}-star review from ${displayName} (awaiting approval)`, { orderId: order.id });
    res.status(201).json({ success: true });
  } catch (err) {
    handleDbError(res, err, 'Could not save your review.');
  }
});

// Admin: see every review (approved or not) and moderate them.
app.get('/api/admin/reviews', requireAdmin, async (req, res) => {
  try {
    const rows = await dbList('reviews', { select: '*', order: 'created_at.desc' });
    res.json(rows.map(r => ({
      id: r.id, orderId: r.order_id, name: r.name, rating: r.rating,
      comment: r.comment, approved: r.approved, createdAt: r.created_at,
    })));
  } catch (err) {
    handleDbError(res, err, 'Could not load reviews.');
  }
});

app.put('/api/reviews/:id/approve', requireAdmin, async (req, res) => {
  try {
    const approved = Boolean(req.body?.approved);
    const rows = await dbUpdate('reviews', { id: `eq.${req.params.id}` }, { approved });
    if (!rows.length) return res.status(404).json({ error: 'Review not found.' });
    await logActivity('review_moderation', `Review ${rows[0].id} ${approved ? 'approved' : 'hidden'}`, { reviewId: rows[0].id });
    res.json({ success: true, approved });
  } catch (err) {
    handleDbError(res, err, 'Could not update review.');
  }
});

app.delete('/api/reviews/:id', requireAdmin, async (req, res) => {
  try {
    const rows = await dbDelete('reviews', { id: `eq.${req.params.id}` });
    if (!rows.length) return res.status(404).json({ error: 'Review not found.' });
    await logActivity('review_moderation', `Review ${rows[0].id} deleted`, { reviewId: rows[0].id });
    res.json({ success: true });
  } catch (err) {
    handleDbError(res, err, 'Could not delete review.');
  }
});

// =====================================================================
// SETTINGS
// =====================================================================
app.get('/api/settings', requireAdmin, async (req, res) => {
  try {
    const settings = await readSettings();
    res.json({
      notificationEmail: settings.notification_email || '',
      emailConfigured: Boolean(resendClient),
      fromEmail: resendClient ? RESEND_FROM_EMAIL : null,
    });
  } catch (err) {
    handleDbError(res, err, 'Could not load settings.');
  }
});

app.put('/api/settings', requireAdmin, async (req, res) => {
  try {
    const clean = String(req.body?.notificationEmail || '').trim();
    if (clean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return res.status(400).json({ error: 'Please provide a valid email address.' });

    await dbUpdate('settings', { id: 'eq.1' }, { notification_email: clean });
    await logActivity('settings_update', clean ? `Order notifications set to ${clean}` : 'Order notification email cleared');
    res.json({ notificationEmail: clean });
  } catch (err) {
    handleDbError(res, err, 'Could not save settings.');
  }
});

// =====================================================================
// DASHBOARD STATS + ACTIVITY LOG
// =====================================================================
app.get('/api/stats', requireAdmin, async (req, res) => {
  try {
    const [products, orders, customers] = await Promise.all([
      dbList('products', { select: 'id', order: 'created_at.desc' }),
      dbList('orders', { select: 'id,customer,total,status,items,created_at', order: 'created_at.desc' }),
      dbList('customers', { select: 'id' }),
    ]);
    const totalRevenue = orders.reduce((sum, o) => sum + Number(o.total || 0), 0);
    res.json({
      totalRevenue: Number(totalRevenue.toFixed(2)),
      ordersCount: orders.length,
      activeProducts: products.length,
      registeredClients: customers.length,
      recentOrders: orders.slice(0, 5).map(o => ({ ...o, total: Number(o.total), createdAt: o.created_at })),
    });
  } catch (err) {
    handleDbError(res, err, 'Could not load dashboard stats.');
  }
});

app.get('/api/logs', requireAdmin, async (req, res) => {
  try {
    const rows = await dbList('activity_logs', { select: '*', order: 'timestamp.desc', limit: '500' });
    res.json(rows.map(row => ({
      id: row.id,
      type: row.type,
      message: row.message,
      meta: row.meta || {},
      timestamp: row.timestamp,
    })));
  } catch (err) {
    handleDbError(res, err, 'Could not load activity logs.');
  }
});

app.listen(PORT, () => {
  console.log(`\n  ENITOSIN backend running → http://localhost:${PORT}`);
  console.log(`  Storefront:       http://localhost:${PORT}/index.html`);
  console.log(`  Admin dashboard:  http://localhost:${PORT}/admin.html`);
  console.log('  Admin key:        configured via environment variable');
  console.log(`  Database:         Supabase`);
  console.log(`  Order emails:     ${resendClient ? `enabled (sending as ${RESEND_FROM_EMAIL})` : 'disabled (set RESEND_API_KEY)'}`);
});
