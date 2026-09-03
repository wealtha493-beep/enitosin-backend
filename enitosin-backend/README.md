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
- **Order email notifications (via Resend).** When a customer checks out,
  the server emails the full order (customer name/email/address, items,
  total) to an address you set from the admin dashboard's **Settings** panel.

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
it. The `ADMIN_KEY` environment variable is required; there is no hardcoded
default admin key. Set it locally before starting the server, for example:

```
ADMIN_KEY=my-secret npm start
```

The browser stores the entered key in `localStorage` so you won't be asked
again on that browser.

## Setting up order email notifications (Resend)

There are two separate email settings, and they're configured in two
different places on purpose (the API key is a secret; the recipient isn't):

1. **The Resend API key + sending address** — set once on the server via
   environment variables. Never entered in the admin UI or written to disk.
2. **The recipient address** — the address that should receive the alerts.
   Set from the admin dashboard's **Settings** panel, and can be changed
   any time without touching the server config.

### Step 1 — get a Resend API key

1. Sign up at <https://resend.com> (free tier is enough for this).
2. In the Resend dashboard, go to **API Keys** → **Create API Key**, and
   copy the key (starts with `re_`) — you'll only see it once.
3. Optional but recommended: go to **Domains** and verify a domain you
   own, so you can send as `orders@yourdomain.com` instead of Resend's
   shared test address. This isn't required to get started — see Step 2.

### Step 2 — set environment variables on the server

Locally:

```
ADMIN_KEY=my-secret RESEND_API_KEY=re_your_key_here npm start
```

`RESEND_FROM_EMAIL` is optional. If you skip it, emails send from
Resend's shared test address (`onboarding@resend.dev`) — fine for trying
things out, but **only deliverable to the email address you signed up to
Resend with** until you verify your own domain. Once you've verified a
domain, set it explicitly:

```
RESEND_FROM_EMAIL="ENITOSIN Store <orders@yourdomain.com>"
```

On Render: **your service → Environment**, add `RESEND_API_KEY` (and
optionally `RESEND_FROM_EMAIL`), then redeploy. `render.yaml` already
lists both as variables you fill in yourself.

### Step 3 — set the recipient address in the admin dashboard

Open the admin dashboard → **Settings** (bottom of the page, or the
"Settings" link in the sidebar) → enter the address that should receive
new-order alerts → **Save**. Any email address works here, not just Gmail
or the address tied to your Resend account.

If you skip Step 3, no notification email is sent (there's no default
recipient). If you skip Steps 1–2, the Settings panel will show a warning
that email sending isn't configured, and orders will still be placed
normally — they just won't trigger an email until `RESEND_API_KEY` is set.

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
4. Set **Root Directory** to `enitosin-backend` if your GitHub repository has
   the application inside an `enitosin-backend/` subfolder. Set **Build Command**
   to `npm install` and **Start Command** to `npm start`.
5. Under **Environment Variables**, add `ADMIN_KEY` and set it to a strong secret
   of your choosing, plus `RESEND_API_KEY` (and optionally `RESEND_FROM_EMAIL`) if
   you want order email notifications (see "Setting up order email notifications"
   above). Render automatically provides `PORT`, which `server.js` reads.
6. Deploy. Render gives you a public URL — your storefront will be at
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
| GET    | `/api/settings`           | admin key   | Read notification email + email status|
| PUT    | `/api/settings`           | admin key   | Set the order-notification recipient  |

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
