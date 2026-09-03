/**
 * ENITOSIN STORE — Backend API
 * ------------------------------------------------------------
 * A small Express server that gives the storefront (index.html)
 * and the admin dashboard (admin.html) a shared source of truth:
 *   - one product catalog (products.json)
 *   - one order log (orders.json)
 *
 * Data is stored in flat JSON files under /data. That's intentional —
 * it means zero external database setup, but it also means this is a
 * DEMO backend, not a production one. See README.md for the notes on
 * what you'd want to change before going live (real DB, real auth,
 * input validation, HTTPS, etc).
 * ------------------------------------------------------------
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!ADMIN_KEY) {
  console.error('ERROR: ADMIN_KEY environment variable is required.');
  process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// ---------- email (Resend) notifications ----------
// The Resend API key and "from" address are read from environment
// variables — never stored on disk or entered in the admin UI, since the
// API key is a secret credential. What the admin CAN set from the
// dashboard is the notification email address that should RECEIVE the
// "new order" alerts (stored in settings.json).
//
// RESEND_FROM_EMAIL must be on a domain you've verified with Resend
// (https://resend.com/domains). Until you verify one, Resend lets you
// send test emails from "onboarding@resend.dev", so that's the default
// here — swap it once you've verified your own domain.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'ENITOSIN Store <onboarding@resend.dev>';

let resendClient = null;
if (RESEND_API_KEY) {
  resendClient = new Resend(RESEND_API_KEY);
} else {
  console.warn('WARNING: RESEND_API_KEY not set — order email notifications are disabled.');
}

function readSettings() {
  return readJSON(SETTINGS_FILE, { notificationEmail: '' });
}

async function sendOrderNotificationEmail(order) {
  if (!resendClient) return; // email not configured — silently skip

  const settings = readSettings();
  const recipient = String(settings.notificationEmail || '').trim();
  if (!recipient) return;

  const itemsList = order.items
    .map(item => `  • ${item.name}  x${item.qty}  —  ₦${(item.price * item.qty).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
    .join('\n');

  const textBody = [
    `New order received: ${order.id}`,
    '',
    `Customer: ${order.customer.name}`,
    `Email:    ${order.customer.email}`,
    `Address:  ${order.customer.address}`,
    '',
    'Items:',
    itemsList,
    '',
    `Total: ₦${order.total.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `Status: ${order.status}`,
    `Placed: ${new Date(order.createdAt).toLocaleString()}`,
  ].join('\n');

  const itemsHtml = order.items
    .map(item => `<tr><td style="padding:4px 8px;">${item.name}</td><td style="padding:4px 8px;">x${item.qty}</td><td style="padding:4px 8px;">₦${(item.price * item.qty).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td></tr>`)
    .join('');

  const htmlBody = `
    <div style="font-family:sans-serif; color:#222;">
      <h2 style="color:#aa7c11;">New Order — ${order.id}</h2>
      <p><strong>Customer:</strong> ${order.customer.name}<br>
         <strong>Email:</strong> ${order.customer.email}<br>
         <strong>Address:</strong> ${order.customer.address}</p>
      <table style="border-collapse:collapse; margin:12px 0;">
        <thead><tr><th style="text-align:left; padding:4px 8px;">Item</th><th style="text-align:left; padding:4px 8px;">Qty</th><th style="text-align:left; padding:4px 8px;">Subtotal</th></tr></thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      <p><strong>Total: ₦${order.total.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong><br>
         Status: ${order.status}<br>
         Placed: ${new Date(order.createdAt).toLocaleString()}</p>
    </div>`;

  try {
    const { error } = await resendClient.emails.send({
      from: RESEND_FROM_EMAIL,
      to: recipient,
      subject: `New Order ${order.id} — ₦${order.total.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      text: textBody,
      html: htmlBody,
    });
    if (error) throw new Error(error.message || 'Unknown Resend error');
    logActivity('email_sent', `Order notification emailed to ${recipient} for ${order.id}`, { orderId: order.id });
  } catch (err) {
    console.error('Failed to send order notification email:', err.message);
    logActivity('email_failed', `Failed to email order notification for ${order.id}: ${err.message}`, { orderId: order.id });
  }
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(cors());
app.use(express.json({ limit: '15mb' })); // admin product images arrive as base64 data URLs
app.use(express.static(path.join(__dirname, 'public')));

// ---------- tiny JSON "database" helpers ----------
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  fs.renameSync(tempFile, file);
}

// ---------- admin auth (simple shared-key check) ----------
function requireAdmin(req, res, next) {
  const key = req.header('x-admin-key');
  if (!key || key.length !== ADMIN_KEY.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY))) {
    logActivity('admin_login_fail', 'Rejected admin authentication attempt');
    return res.status(401).json({ error: 'Unauthorized: missing or invalid admin key.' });
  }
  next();
}

// ---------- logging helper (keeps a simple activity log admins can review) ----------
const LOG_FILE = path.join(DATA_DIR, 'activity.log.json');
function logActivity(type, message, meta = {}) {
  const logs = readJSON(LOG_FILE, []);
  logs.unshift({
    id: Date.now() + Math.random().toString(36).slice(2, 7),
    type,               // 'order' | 'product_add' | 'product_delete' | 'admin_login_fail'
    message,
    meta,
    timestamp: new Date().toISOString(),
  });
  // keep the log from growing forever
  writeJSON(LOG_FILE, logs.slice(0, 500));
}

// Health check (useful for Render and monitoring)
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// =====================================================================
// PRODUCTS
// =====================================================================

// Public: list all products (storefront + admin table both use this)
app.get('/api/products', (req, res) => {
  const products = readJSON(PRODUCTS_FILE, []);
  res.json(products);
});

// Public: get a single product
app.get('/api/products/:id', (req, res) => {
  const products = readJSON(PRODUCTS_FILE, []);
  const product = products.find(p => String(p.id) === String(req.params.id));
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  res.json(product);
});

// Admin only: add a new product
app.post('/api/products', requireAdmin, (req, res) => {
  const { name, category, price, image, badge, oldPrice, rating, desc, stock } = req.body;

  const cleanName = String(name || '').trim();
  const cleanCategory = String(category || '').trim();
  const cleanImage = String(image || '').trim();
  const numericPrice = Number(price);
  const numericOldPrice = oldPrice === undefined || oldPrice === null || oldPrice === '' ? null : Number(oldPrice);

  if (!cleanName || !cleanCategory || !cleanImage || !Number.isFinite(numericPrice) || numericPrice < 0) {
    return res.status(400).json({ error: 'Valid name, category, price and image are required.' });
  }
  if (numericOldPrice !== null && (!Number.isFinite(numericOldPrice) || numericOldPrice < 0)) {
    return res.status(400).json({ error: 'oldPrice must be a valid non-negative number.' });
  }

  const products = readJSON(PRODUCTS_FILE, []);
  const newProduct = {
    id: Date.now(),
    name: cleanName,
    category: cleanCategory,
    price: numericPrice,
    oldPrice: numericOldPrice,
    badge: badge ? String(badge).trim() : null,
    rating: rating ? String(rating).trim() : '5.0',
    desc: desc ? String(desc).trim() : '',
    image: cleanImage,
    stock: stock ? String(stock).trim() : 'In Stock',
  };

  products.push(newProduct);
  writeJSON(PRODUCTS_FILE, products);
  logActivity('product_add', `Added product "${newProduct.name}"`, { productId: newProduct.id });

  res.status(201).json(newProduct);
});

// Admin only: update a product (e.g. price, stock status)
app.put('/api/products/:id', requireAdmin, (req, res) => {
  const products = readJSON(PRODUCTS_FILE, []);
  const idx = products.findIndex(p => String(p.id) === String(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Product not found.' });

  const current = products[idx];
  const name = String(req.body.name ?? current.name).trim();
  const category = String(req.body.category ?? current.category).trim();
  const price = Number(req.body.price ?? current.price);
  const oldPrice = req.body.oldPrice === null || req.body.oldPrice === '' || req.body.oldPrice === undefined
    ? (req.body.oldPrice === undefined ? current.oldPrice : null)
    : Number(req.body.oldPrice);
  const stock = String(req.body.stock ?? current.stock).trim();
  const desc = String(req.body.desc ?? current.desc ?? '').trim();
  const image = req.body.image === undefined ? current.image : String(req.body.image || '').trim();

  if (!name || !category || !image || !Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: 'Valid name, category, price and image are required.' });
  }
  if (oldPrice !== null && (!Number.isFinite(oldPrice) || oldPrice < 0)) {
    return res.status(400).json({ error: 'oldPrice must be a valid non-negative number.' });
  }

  products[idx] = {
    ...current,
    name,
    category,
    price,
    oldPrice,
    stock: stock || 'In Stock',
    desc,
    image,
  };

  writeJSON(PRODUCTS_FILE, products);
  logActivity('product_update', `Updated product "${products[idx].name}"`, { productId: products[idx].id });

  res.json(products[idx]);
});

// Admin only: delete a product
app.delete('/api/products/:id', requireAdmin, (req, res) => {
  const products = readJSON(PRODUCTS_FILE, []);
  const target = products.find(p => String(p.id) === String(req.params.id));
  if (!target) return res.status(404).json({ error: 'Product not found.' });

  const updated = products.filter(p => String(p.id) !== String(req.params.id));
  writeJSON(PRODUCTS_FILE, updated);
  logActivity('product_delete', `Deleted product "${target.name}"`, { productId: target.id });

  res.json({ success: true });
});

// =====================================================================
// ORDERS  (this is the "log" link between storefront checkout -> admin)
// =====================================================================

// Public: customer places an order from the storefront checkout form
app.post('/api/orders', (req, res) => {
  const { customer, items } = req.body || {};

  const name = String(customer?.name || '').trim();
  const email = String(customer?.email || '').trim().toLowerCase();
  const address = String(customer?.address || '').trim();

  if (!name || !email || !address || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Customer name, email, address and at least one item are required.' });
  }

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailOk) return res.status(400).json({ error: 'Please provide a valid email address.' });
  if (items.length > 50) return res.status(400).json({ error: 'Too many items in one order.' });

  // Re-read prices from the server catalog. Never trust the total or prices sent by the browser.
  const products = readJSON(PRODUCTS_FILE, []);
  const normalizedItems = [];
  for (const item of items) {
    const product = products.find(p => String(p.id) === String(item.id));
    const qty = Number(item.qty);
    if (!product || !Number.isInteger(qty) || qty < 1 || qty > 99) {
      return res.status(400).json({ error: 'One or more order items are invalid or unavailable.' });
    }
    normalizedItems.push({ id: product.id, name: product.name, price: product.price, qty });
  }

  const total = normalizedItems.reduce((sum, item) => sum + item.price * item.qty, 0);
  const orders = readJSON(ORDERS_FILE, []);
  const newOrder = {
    id: 'EN-' + (9000 + orders.length + 1),
    customer: { name, email, address },
    items: normalizedItems,
    total: Number(total.toFixed(2)),
    status: 'Processing',
    createdAt: new Date().toISOString(),
  };
  orders.unshift(newOrder);
  writeJSON(ORDERS_FILE, orders);

  const customers = readJSON(CUSTOMERS_FILE, []);
  if (!customers.find(c => String(c.email).toLowerCase() === email)) {
    customers.push({ name, email, joinedAt: new Date().toISOString() });
    writeJSON(CUSTOMERS_FILE, customers);
  }

  logActivity('order', `New order ${newOrder.id} from ${name} — ₦${newOrder.total.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, { orderId: newOrder.id });

  // Fire off the email notification without delaying the customer's response.
  sendOrderNotificationEmail(newOrder);

  res.status(201).json(newOrder);
});

// Admin only: view the order log
app.get('/api/orders', requireAdmin, (req, res) => {
  const orders = readJSON(ORDERS_FILE, []);
  res.json(orders);
});

// Admin only: update order status (e.g. mark Shipped)
app.put('/api/orders/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  const allowedStatuses = ['Processing', 'Shipped', 'Delivered', 'Cancelled'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid order status.' });
  }
  const orders = readJSON(ORDERS_FILE, []);
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Order not found.' });

  orders[idx].status = status;
  writeJSON(ORDERS_FILE, orders);
  logActivity('order_status', `Order ${orders[idx].id} marked ${status}`, { orderId: orders[idx].id });

  res.json(orders[idx]);
});

// =====================================================================
// SETTINGS  (admin-configurable notification recipient)
// =====================================================================

// Admin only: read current settings (notification email + whether the
// server has Gmail credentials configured at all)
app.get('/api/settings', requireAdmin, (req, res) => {
  const settings = readSettings();
  res.json({
    notificationEmail: settings.notificationEmail || '',
    emailConfigured: Boolean(resendClient),
    fromEmail: resendClient ? RESEND_FROM_EMAIL : null,
  });
});

// Admin only: update the notification recipient email
app.put('/api/settings', requireAdmin, (req, res) => {
  const { notificationEmail } = req.body || {};
  const clean = String(notificationEmail || '').trim();

  if (clean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  const settings = readSettings();
  settings.notificationEmail = clean;
  writeJSON(SETTINGS_FILE, settings);
  logActivity('settings_update', clean ? `Order notifications set to ${clean}` : 'Order notification email cleared');

  res.json({ notificationEmail: clean });
});

// =====================================================================
// DASHBOARD STATS + ACTIVITY LOG  (what makes the admin dashboard "live")
// =====================================================================

app.get('/api/stats', requireAdmin, (req, res) => {
  const products = readJSON(PRODUCTS_FILE, []);
  const orders = readJSON(ORDERS_FILE, []);
  const customers = readJSON(CUSTOMERS_FILE, []);

  const totalRevenue = orders.reduce((sum, o) => sum + o.total, 0);

  res.json({
    totalRevenue,
    ordersCount: orders.length,
    activeProducts: products.length,
    registeredClients: customers.length,
    recentOrders: orders.slice(0, 5),
  });
});

// Admin only: the activity log (product changes + orders in one feed)
app.get('/api/logs', requireAdmin, (req, res) => {
  const logs = readJSON(LOG_FILE, []);
  res.json(logs);
});

// =====================================================================
// SEED DATA (first run only — keeps storefront + admin in sync from the start)
// =====================================================================
function seedIfEmpty() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

  if (!fs.existsSync(PRODUCTS_FILE)) {
    writeJSON(PRODUCTS_FILE, []);
  }
  if (!fs.existsSync(ORDERS_FILE)) writeJSON(ORDERS_FILE, []);
  if (!fs.existsSync(CUSTOMERS_FILE)) writeJSON(CUSTOMERS_FILE, []);
  if (!fs.existsSync(LOG_FILE)) writeJSON(LOG_FILE, []);
  if (!fs.existsSync(SETTINGS_FILE)) writeJSON(SETTINGS_FILE, { notificationEmail: '' });
}
seedIfEmpty();

app.listen(PORT, () => {
  console.log(`\n  ENITOSIN backend running → http://localhost:${PORT}`);
  console.log(`  Storefront:       http://localhost:${PORT}/index.html`);
  console.log(`  Admin dashboard:  http://localhost:${PORT}/admin.html`);
  console.log('  Admin key:        configured via environment variable');
  console.log(`  Order emails:     ${resendClient ? `enabled (sending as ${RESEND_FROM_EMAIL})` : 'disabled (set RESEND_API_KEY)'}\n`);
});
