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

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'enitosin-admin-2026';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');

app.use(cors());
app.use(express.json({ limit: '15mb' })); // generous limit: admin product images arrive as base64 data URLs
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
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------- admin auth (simple shared-key check) ----------
function requireAdmin(req, res, next) {
  const key = req.header('x-admin-key');
  if (key !== ADMIN_KEY) {
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

  if (!name || !category || price === undefined || !image) {
    return res.status(400).json({ error: 'name, category, price and image are required.' });
  }

  const products = readJSON(PRODUCTS_FILE, []);
  const newProduct = {
    id: Date.now(),
    name,
    category,
    price: parseFloat(price),
    oldPrice: oldPrice ? parseFloat(oldPrice) : null,
    badge: badge || null,
    rating: rating || '5.0',
    desc: desc || '',
    image,
    stock: stock || 'In Stock',
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

  products[idx] = { ...products[idx], ...req.body, id: products[idx].id };
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
  const { customer, items, total } = req.body;

  if (!customer || !customer.name || !customer.email || !items || !items.length) {
    return res.status(400).json({ error: 'customer (name, email) and items are required.' });
  }

  const orders = readJSON(ORDERS_FILE, []);
  const newOrder = {
    id: 'EN-' + (9000 + orders.length + 1),
    customer,
    items,
    total: parseFloat(total) || items.reduce((sum, i) => sum + i.price * i.qty, 0),
    status: 'Processing',
    createdAt: new Date().toISOString(),
  };
  orders.unshift(newOrder);
  writeJSON(ORDERS_FILE, orders);

  // track distinct customers (feeds the "Registered Clients" metric)
  const customers = readJSON(CUSTOMERS_FILE, []);
  if (!customers.find(c => c.email === customer.email)) {
    customers.push({ name: customer.name, email: customer.email, joinedAt: new Date().toISOString() });
    writeJSON(CUSTOMERS_FILE, customers);
  }

  logActivity('order', `New order ${newOrder.id} from ${customer.name} — $${newOrder.total.toFixed(2)}`, { orderId: newOrder.id });

  res.status(201).json(newOrder);
});

// Admin only: view the order log
app.get('/api/orders', requireAdmin, (req, res) => {
  const orders = readJSON(ORDERS_FILE, []);
  res.json(orders);
});

// Admin only: update order status (e.g. mark Shipped)
app.put('/api/orders/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  const orders = readJSON(ORDERS_FILE, []);
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Order not found.' });

  orders[idx].status = status;
  writeJSON(ORDERS_FILE, orders);
  logActivity('order_status', `Order ${orders[idx].id} marked ${status}`, { orderId: orders[idx].id });

  res.json(orders[idx]);
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
    writeJSON(PRODUCTS_FILE, [
      { id: 1, name: "Royal Gold Velvet Loafers", category: "shoes", price: 450, oldPrice: 520, badge: "Best Seller", rating: "5.0", stock: "In Stock", image: "https://images.unsplash.com/photo-1533867617858-e7b97e060509?auto=format&fit=crop&w=600&q=80", desc: "Hand-finished gold embroidered loafers featuring plush interior cushioning." },
      { id: 2, name: "Empress Calfskin Handbag", category: "bags", price: 890, oldPrice: 990, badge: "Limited", rating: "4.9", stock: "In Stock", image: "https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&w=600&q=80", desc: "Italian calfskin tote handbag featuring custom solid gold alloy hardware." },
      { id: 3, name: "Monarch Leather Oxford Shoes", category: "shoes", price: 380, oldPrice: null, badge: "New", rating: "4.8", stock: "Low Stock", image: "https://images.unsplash.com/photo-1614252235316-8c857d38b5f4?auto=format&fit=crop&w=600&q=80", desc: "Classically styled Goodyear-welted leather Oxford dress shoes." },
      { id: 4, name: "Couture Leather Travel Duffle", category: "bags", price: 650, oldPrice: 750, badge: "Sale", rating: "5.0", stock: "In Stock", image: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=600&q=80", desc: "Spacious weekender travel bag crafted from full-grain vegetable-tanned leather." },
      { id: 5, name: "Imperial Stiletto Heels", category: "shoes", price: 520, oldPrice: 600, badge: "Exclusive", rating: "4.9", stock: "In Stock", image: "https://images.unsplash.com/photo-1543163521-1bf539c55dd2?auto=format&fit=crop&w=600&q=80", desc: "Sleek stiletto pumps with brushed gold metallic heels and soft lining." },
      { id: 6, name: "Sovereign Crossbody Clutch", category: "bags", price: 310, oldPrice: null, badge: "New", rating: "4.7", stock: "In Stock", image: "https://images.unsplash.com/photo-1566150905458-1bf1fc113f0d?auto=format&fit=crop&w=600&q=80", desc: "Versatile evening clutch with detachable chain strap and magnetic gold clasp." }
    ]);
  }
  if (!fs.existsSync(ORDERS_FILE)) writeJSON(ORDERS_FILE, []);
  if (!fs.existsSync(CUSTOMERS_FILE)) writeJSON(CUSTOMERS_FILE, []);
  if (!fs.existsSync(LOG_FILE)) writeJSON(LOG_FILE, []);
}
seedIfEmpty();

app.listen(PORT, () => {
  console.log(`\n  ENITOSIN backend running → http://localhost:${PORT}`);
  console.log(`  Storefront:       http://localhost:${PORT}/index.html`);
  console.log(`  Admin dashboard:  http://localhost:${PORT}/admin.html`);
  console.log(`  Admin key:        ${ADMIN_KEY}  (change via ADMIN_KEY env var)\n`);
});
