# ENITOSIN STORE — Supabase Backend

This version uses **Supabase PostgreSQL** for persistent store data instead of Render's local filesystem.

## What is stored in Supabase?

- `products` — catalog products added/edited/deleted from the admin dashboard
- `orders` — customer orders and order status
- `customers` — customers who place orders
- `activity_logs` — admin/product/order activity
- `settings` — order-notification recipient email

## 1. Create the database

In your Supabase project, open **SQL Editor**, create a new query, paste the complete contents of `supabase-schema.sql`, and run it.

The catalog starts empty. No demo products are inserted by this script.

## 2. Render environment variables

Keep these values private:

```text
ADMIN_KEY=your-existing-admin-key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-Supabase-secret-key
```

Keep your existing Resend variables if you use order email notifications:

```text
RESEND_API_KEY=...
RESEND_FROM_EMAIL=ENITOSIN Store <your-verified-address>
```

**Never put `SUPABASE_SERVICE_ROLE_KEY` in `index.html`, `admin.html`, GitHub, or any browser-side JavaScript.** It belongs only in the server environment variables.

## 3. Local development

Node 18+ is required because the backend uses Node's built-in `fetch`.

```bash
npm install
npm start
```

## 4. Render

Keep the normal Node start command:

```text
npm start
```

No Render disk is required for products/orders/logs anymore. Supabase is the persistent data store.

## Notes

Product images are currently stored as data URLs in the `products.image` text column to keep the existing admin upload flow working. For a larger production catalog, moving images to Supabase Storage is recommended later.
