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
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(cors());
app.use(express.json({
  limit: '15mb',
  // Paystack signs the exact raw request body — keep a copy before it's
  // parsed into an object, so the webhook handler can verify it.
  verify: (req, res, buf) => { req.rawBody = buf; },
}));
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
  res.status(err.status && err.status >= 400 && err.status < 500 ? err.status : 500)
    .json({ error: fallback, details: process.env.NODE_ENV === 'production' ? undefined : err.message });
}

// ---------- admin auth ----------
function requireAdmin(req, res, next) {
  const key = req.header('x-admin-key') || '';
  const valid = key.length === ADMIN_KEY.length &&
    crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY));
  if (!valid) {
    logActivity('admin_login_fail', 'Rejected admin authentication attempt').catch(console.error);
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
    const itemsList = order.items
      .map(item => `  • ${item.name}  x${item.qty}  —  ${money(item.price * item.qty)}`)
      .join('\n');

    const textBody = [
      `New order received: ${order.id}`, '',
      `Customer: ${order.customer.name}`,
      `Email:    ${order.customer.email}`,
      `Address:  ${order.customer.address}`, '',
      'Items:', itemsList, '',
      `Total: ${money(order.total)}`,
      `Status: ${order.status}`,
      `Placed: ${new Date(order.createdAt).toLocaleString('en-NG')}`,
    ].join('\n');

    const itemsHtml = order.items.map(item =>
      `<tr><td style="padding:4px 8px;">${item.name}</td><td style="padding:4px 8px;">x${item.qty}</td><td style="padding:4px 8px;">${money(item.price * item.qty)}</td></tr>`
    ).join('');

    const htmlBody = `<div style="font-family:sans-serif;color:#222;">
      <h2 style="color:#aa7c11;">ENITOSIN STORE — New Order ${order.id}</h2>
      <p><strong>Customer:</strong> ${order.customer.name}<br><strong>Email:</strong> ${order.customer.email}<br><strong>Address:</strong> ${order.customer.address}</p>
      <table style="border-collapse:collapse;margin:12px 0;"><thead><tr><th style="text-align:left;padding:4px 8px;">Item</th><th style="text-align:left;padding:4px 8px;">Qty</th><th style="text-align:left;padding:4px 8px;">Subtotal</th></tr></thead><tbody>${itemsHtml}</tbody></table>
      <p><strong>Total: ${money(order.total)}</strong><br>Status: ${order.status}<br>Placed: ${new Date(order.createdAt).toLocaleString('en-NG')}</p>
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

    const itemsList = (order.items || [])
      .map(item => `  • ${item.name}  x${item.qty}  —  ${money(item.price * item.qty)}`)
      .join('\n');

    const textBody = [
      introText, '',
      `Order: ${order.id}`,
      `Status: ${status}`, '',
      'Items:', itemsList, '',
      `Total: ${money(order.total)}`,
    ].join('\n');

    const itemsHtml = (order.items || []).map(item =>
      `<tr><td style="padding:4px 8px;">${item.name}</td><td style="padding:4px 8px;">x${item.qty}</td><td style="padding:4px 8px;">${money(item.price * item.qty)}</td></tr>`
    ).join('');

    const badgeColor = isAccepted ? '#2e7d32' : '#c62828';
    const htmlBody = `<div style="font-family:sans-serif;color:#222;">
      <h2 style="color:#aa7c11;">ENITOSIN STORE</h2>
      <p>${introText}</p>
      <p><strong>Order:</strong> ${order.id}<br><strong>Status:</strong> <span style="color:${badgeColor}; font-weight:bold;">${status}</span></p>
      <table style="border-collapse:collapse;margin:12px 0;"><thead><tr><th style="text-align:left;padding:4px 8px;">Item</th><th style="text-align:left;padding:4px 8px;">Qty</th><th style="text-align:left;padding:4px 8px;">Subtotal</th></tr></thead><tbody>${itemsHtml}</tbody></table>
      <p><strong>Total: ${money(order.total)}</strong></p>
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
    const rows = await dbList('products', { id: `eq.${encodeURIComponent(req.params.id)}`, select: '*' });
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

  return {
    name,
    category,
    subcategory,
    price,
    old_price: oldPrice,
    badge: body.badge === undefined ? (existing.badge || null) : (body.badge ? String(body.badge).trim() : null),
    rating: body.rating === undefined ? (existing.rating || '5.0') : (body.rating ? String(body.rating).trim() : '5.0'),
    description: body.desc === undefined ? (existing.description || '') : String(body.desc || '').trim(),
    image,
    stock: body.stock === undefined ? (existing.stock || 'In Stock') : (String(body.stock || '').trim() || 'In Stock'),
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
    const existingRows = await dbList('products', { id: `eq.${encodeURIComponent(req.params.id)}`, select: '*' });
    if (!existingRows.length) return res.status(404).json({ error: 'Product not found.' });
    const payload = productPayload(req.body || {}, existingRows[0]);
    const rows = await dbUpdate('products', { id: `eq.${encodeURIComponent(req.params.id)}` }, payload);
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
    const existing = await dbList('products', { id: `eq.${encodeURIComponent(req.params.id)}`, select: '*' });
    if (!existing.length) return res.status(404).json({ error: 'Product not found.' });
    await dbDelete('products', { id: `eq.${encodeURIComponent(req.params.id)}` });
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
async function validateAndPriceItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('At least one item is required.');
  }
  if (items.length > 50) throw new Error('Too many items in one order.');

  const products = await dbList('products', { select: 'id,name,price' });
  const normalizedItems = [];
  for (const item of items) {
    const product = products.find(p => String(p.id) === String(item.id));
    const qty = Number(item.qty);
    if (!product || !Number.isInteger(qty) || qty < 1 || qty > 99) {
      throw new Error('One or more order items are invalid or unavailable.');
    }
    normalizedItems.push({ id: product.id, name: product.name, price: Number(product.price), qty });
  }
  const total = normalizedItems.reduce((sum, item) => sum + item.price * item.qty, 0);
  return { normalizedItems, total: Number(total.toFixed(2)) };
}

// Creates the actual order row in Supabase. Used both by the legacy
// direct-order endpoint and by the Paystack payment flow once a
// payment has been confirmed as successful.
async function createOrderRecord({ customer, normalizedItems, total, paymentStatus, paymentReference, orderType }) {
  const { name, email, address } = customer;
  const orderId = `EN-${Date.now().toString().slice(-8)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  const createdAt = new Date().toISOString();
  const orderRecord = {
    id: orderId,
    customer: { name, email, address },
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

  const existingCustomer = await dbList('customers', { email: `eq.${encodeURIComponent(email)}`, select: 'id' });
  if (!existingCustomer.length) {
    await dbInsert('customers', [{ name, email, joined_at: createdAt }]);
  }

  const money = n => `₦${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  await logActivity('order', `New order ${newOrder.id} from ${name} — ${money(newOrder.total)}`, { orderId: newOrder.id });
  sendOrderNotificationEmail(newOrder).catch(console.error);

  return newOrder;
}

app.post('/api/orders', async (req, res) => {
  try {
    const { customer, items, orderType } = req.body || {};
    const name = String(customer?.name || '').trim();
    const email = String(customer?.email || '').trim().toLowerCase();
    const phone = String(customer?.phone || '').trim();
    const address = String(customer?.address || '').trim();

    if (!name || !email || !phone || !address) {
      return res.status(400).json({ error: 'Customer name, email, phone number and address are required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please provide a valid email address.' });

    const { normalizedItems, total } = await validateAndPriceItems(items);
    const newOrder = await createOrderRecord({ customer: { name, email, phone, address }, normalizedItems, total, orderType });

    res.status(201).json(newOrder);
  } catch (err) {
    handleDbError(res, err, err.message || 'Could not place order.');
  }
});

// =====================================================================
// PAYMENTS (Paystack)
// =====================================================================
app.post('/api/payments/initialize', async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(503).json({ error: 'Payments are not configured yet. Please contact the store.' });
    }
    const { customer, items, orderType } = req.body || {};
    const name = String(customer?.name || '').trim();
    const email = String(customer?.email || '').trim().toLowerCase();
    const phone = String(customer?.phone || '').trim();
    const address = String(customer?.address || '').trim();
    const resolvedOrderType = orderType === 'Pickup' ? 'Pickup' : 'Delivery';

    if (!name || !email || !phone || !address) {
      return res.status(400).json({ error: 'Customer name, email, phone number and address are required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    const { normalizedItems, total } = await validateAndPriceItems(items);
    if (total <= 0) return res.status(400).json({ error: 'Order total must be greater than zero.' });

    const origin = `${req.protocol}://${req.get('host')}`;
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
    handleDbError(res, err, err.message || 'Could not start payment.');
  }
});

// Shared by both the webhook and the verify endpoint — idempotent, so
// whichever one runs first "wins" and the other just returns the same order.
async function fulfillPaidOrder(reference, metadata) {
  const existing = await dbList('orders', { payment_reference: `eq.${encodeURIComponent(reference)}`, select: '*' });
  if (existing.length) {
    const row = existing[0];
    return {
      id: row.id, customer: row.customer, items: row.items, total: Number(row.total),
      status: row.status, paymentStatus: row.payment_status, paymentReference: row.payment_reference,
      orderType: row.order_type || 'Delivery',
      createdAt: row.created_at,
    };
  }

  const customer = metadata?.customer || {};
  const items = metadata?.items || [];
  const { normalizedItems, total } = await validateAndPriceItems(items.map(i => ({ id: i.id, qty: i.qty })));

  return createOrderRecord({
    customer: { name: customer.name, email: customer.email, phone: customer.phone, address: customer.address },
    normalizedItems,
    total,
    paymentStatus: 'Paid',
    paymentReference: reference,
    orderType: metadata?.orderType,
  });
}

// Paystack calls this directly, server-to-server, the moment a payment
// succeeds — this is the only place we actually trust that money moved.
app.post('/api/payments/webhook', async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) return res.sendStatus(503);

    const signature = req.headers['x-paystack-signature'];
    const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.rawBody || Buffer.from('')).digest('hex');
    if (!signature || signature !== expected) {
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
        await fulfillPaidOrder(reference, metadata).catch(err => {
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
app.get('/api/payments/verify/:reference', async (req, res) => {
  try {
    if (!PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Payments are not configured.' });
    const { reference } = req.params;

    const existing = await dbList('orders', { payment_reference: `eq.${encodeURIComponent(reference)}`, select: '*' });
    if (existing.length) {
      const row = existing[0];
      return res.json({
        status: 'success',
        order: {
          id: row.id, customer: row.customer, items: row.items, total: Number(row.total),
          status: row.status, paymentStatus: row.payment_status, paymentReference: row.payment_reference,
          orderType: row.order_type || 'Delivery',
          createdAt: row.created_at,
        },
      });
    }

    const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
    });
    const data = await verifyRes.json();

    if (!verifyRes.ok || !data.status || data.data?.status !== 'success') {
      return res.json({ status: 'failed' });
    }

    const order = await fulfillPaidOrder(reference, data.data.metadata);
    res.json({ status: 'success', order });
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
    const rows = await dbUpdate('orders', { id: `eq.${encodeURIComponent(req.params.id)}` }, { status });
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
