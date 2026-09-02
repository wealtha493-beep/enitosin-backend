# ENITOSIN STORE — Backend

This connects your two static pages, `index.html` (storefront) and `admin.html`
(admin dashboard), to one shared backend so they're no longer independent files
with their own hardcoded data:

- **One product catalog.** Add or delete a product in the admin dashboard →
  it appears (or disappears) on the storefront on next refresh.
- **One order log.** A customer checking out on the storefront creates an
  order that instantly shows up in the admin dashboard's "Recent Orders"
  table and dashboard metrics (revenue, order count, client count).
- **An activity log.** Every product added/edited/deleted and every order
  placed is recorded and shown in a new "Activity Log" panel on the admin
  dashboard — this is the "logs" feature you asked about.

## How it's built

- `server.js` — a small [Express](https://expressjs.com/) server exposing a
  JSON API (`/api/products`, `/api/orders`, `/api/stats`, `/api/logs`) and
  serving the two HTML files.
- `data/*.json` — flat-file storage (products, orders, customers, activity
  log). No database setup required. Files are created automatically the
  first time you run the server.
- `public/index.html` / `public/admin.html` — your original pages, with
  their JavaScript updated to `fetch()` from the API instead of using
  hardcoded arrays / localStorage-only data.

## Running it

```bash
npm install
npm start
```

Then open:
- Storefront: **http://localhost:3000/index.html**
- Admin dashboard: **http://localhost:3000/admin.html**

The admin dashboard will ask for an **admin key** the first time you open
it. The default key is:

```
enitosin-admin-2026
```

You can change it by setting the `ADMIN_KEY` environment variable before
starting the server, e.g. `ADMIN_KEY=my-secret npm start`. The key is
stored in the browser's `localStorage` after first entry, so you won't be
asked again on that browser.

## Try the connection yourself

1. Open the admin dashboard, enter the admin key, and add a new product
   with an image.
2. Open the storefront in another tab — refresh it — your new product is
   there.
3. On the storefront, add something to the bag and go through checkout
   with a name/email/address.
4. Switch back to the admin tab and click **Refresh** on the Activity Log
   (or just reload the page) — you'll see the order appear in **Recent
   Orders** and as an entry in the **Activity Log**, and the dashboard
   metrics (Total Revenue, Orders Processed, Registered Clients) update.

## Deploying to Render

This is a standard Node/Express app, so it deploys to Render like any other:

1. **Push this folder to a GitHub (or GitLab/Bitbucket) repository.** Render deploys
   from a connected Git repo — there isn't a "upload a zip" option for web services,
   so this step is required even though I've been sending you a zip.
2. In the Render dashboard, click **New → Web Service** and connect that repo.
   (There's also a `render.yaml` in this folder — if you use **New → Blueprint**
   instead, Render will read it and pre-fill most of the settings below.)
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free is fine to start.
4. Under **Environment Variables**, add `ADMIN_KEY` set to a real secret of your
   choosing (don't reuse `enitosin-admin-2026` publicly). Render automatically
   provides `PORT`, which `server.js` already reads.
5. Deploy. Render gives you a public URL — your storefront will be at
   `https://your-service.onrender.com/index.html` and the admin dashboard at
   `https://your-service.onrender.com/admin.html`.

### ⚠️ Important: data won't persist on the free tier

This backend stores products/orders/logs as JSON files on disk. Render's free
(and default) web services have an **ephemeral filesystem** — anything written
to disk is wiped every time the service restarts or redeploys (including the
automatic spin-down after 15 minutes of inactivity on the free tier). That
means any products or orders added after launch will disappear on the next
restart, and you'll be back to the seed data.

To fix this for a real launch, do one of:

- **Attach a persistent disk** (requires a paid instance type — free services
  can't have one). In the Render dashboard: your service → **Disks** → add a
  disk, mount it at e.g. `/var/data`, then set the `DATA_DIR` environment
  variable to `/var/data` so `server.js` writes there instead of the default
  `./data` folder (already supported — see `server.js`).
- **Move to a real database**, e.g. a Render Postgres instance, and swap out
  the `readJSON`/`writeJSON` helpers in `server.js` for real queries. This is
  the better long-term option and is worth doing before you rely on this for
  real customer orders.

## API reference

| Method | Endpoint                 | Auth        | Purpose                              |
|--------|---------------------------|-------------|----------------------------------------|
| GET    | `/api/products`           | public      | List all products                     |
| GET    | `/api/products/:id`       | public      | Get one product                       |
| POST   | `/api/products`           | admin key   | Add a product                         |
| PUT    | `/api/products/:id`       | admin key   | Update a product                      |
| DELETE | `/api/products/:id`       | admin key   | Delete a product                      |
| POST   | `/api/orders`             | public      | Place an order (storefront checkout)  |
| GET    | `/api/orders`             | admin key   | List all orders                       |
| PUT    | `/api/orders/:id/status`  | admin key   | Update order status                   |
| GET    | `/api/stats`              | admin key   | Dashboard metrics                     |
| GET    | `/api/logs`               | admin key   | Activity log feed                     |

Admin-only endpoints require an `x-admin-key` header matching `ADMIN_KEY`.

## Notes on taking this to production

This is a working demo backend, deliberately kept simple. Before using it
for a real store, you'd want to:

- **Swap the JSON files for a real database** (Postgres, MySQL, MongoDB…).
  Flat files aren't safe under concurrent writes at scale.
- **Replace the shared admin key with real authentication** (hashed
  passwords or an identity provider, sessions/JWTs, per-admin accounts).
- **Add input validation and rate limiting** on all endpoints.
- **Move image uploads off base64-in-JSON** and onto real file storage
  (S3, Cloudinary, etc.) — base64 data URLs get large fast.
- **Add HTTPS** and environment-based config/secrets management.
- **Add real payment processing** — `processOrder()` currently just logs
  the order; there's no payment gateway wired in.
