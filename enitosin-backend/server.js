/**
 * ENITOSIN STORE — Backend API
 * Supabase-backed production-friendly version.
 *
 * Persistent data lives in Supabase PostgreSQL instead of Render's local
 * filesystem. The server keeps the Supabase secret key server-side only.
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;
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
app.use(express.json({ limit: '15mb' }));
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

app.get('/health', async (req, res) => {
  try {
    await dbList('products', { select: 'id', limit: '1' });
    res.json({ status: 'ok', database: 'supabase' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

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
app.post('/api/orders', async (req, res) => {
  try {
    const { customer, items } = req.body || {};
    const name = String(customer?.name || '').trim();
    const email = String(customer?.email || '').trim().toLowerCase();
    const address = String(customer?.address || '').trim();

    if (!name || !email || !address || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Customer name, email, address and at least one item are required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please provide a valid email address.' });
    if (items.length > 50) return res.status(400).json({ error: 'Too many items in one order.' });

    const products = await dbList('products', { select: 'id,name,price' });
    const normalizedItems = [];
    for (const item of items) {
      const product = products.find(p => String(p.id) === String(item.id));
      const qty = Number(item.qty);
      if (!product || !Number.isInteger(qty) || qty < 1 || qty > 99) {
        return res.status(400).json({ error: 'One or more order items are invalid or unavailable.' });
      }
      normalizedItems.push({ id: product.id, name: product.name, price: Number(product.price), qty });
    }

    const total = normalizedItems.reduce((sum, item) => sum + item.price * item.qty, 0);
    const orderId = `EN-${Date.now().toString().slice(-8)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const createdAt = new Date().toISOString();
    const orderRecord = {
      id: orderId,
      customer: { name, email, address },
      items: normalizedItems,
      total: Number(total.toFixed(2)),
      status: 'Processing',
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
      createdAt: row.created_at,
    };

    const existingCustomer = await dbList('customers', { email: `eq.${encodeURIComponent(email)}`, select: 'id' });
    if (!existingCustomer.length) {
      await dbInsert('customers', [{ name, email, joined_at: createdAt }]);
    }

    const money = n => `₦${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    await logActivity('order', `New order ${newOrder.id} from ${name} — ${money(newOrder.total)}`, { orderId: newOrder.id });
    sendOrderNotificationEmail(newOrder).catch(console.error);

    res.status(201).json(newOrder);
  } catch (err) {
    handleDbError(res, err, 'Could not place order.');
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
      createdAt: row.created_at,
    })));
  } catch (err) {
    handleDbError(res, err, 'Could not load orders.');
  }
});

app.put('/api/orders/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body || {};
    const allowedStatuses = ['Processing', 'Shipped', 'Delivered', 'Cancelled'];
    if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Invalid order status.' });
    const rows = await dbUpdate('orders', { id: `eq.${encodeURIComponent(req.params.id)}` }, { status });
    if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
    await logActivity('order_status', `Order ${rows[0].id} marked ${status}`, { orderId: rows[0].id });
    res.json({ ...rows[0], total: Number(rows[0].total), createdAt: rows[0].created_at });
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
