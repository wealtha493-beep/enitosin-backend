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

## Security notes

- `security.js` holds the security helpers (header policy, rate limiter, constant-time key check, HTML escaping, image-URL check). It uses only Node's built-in `crypto`, so there are no extra packages.
- Set `ADMIN_KEY` to a long random value (30+ characters). After 10 wrong guesses an IP is locked out for 15 minutes.
- Set `PUBLIC_URL` (and `NODE_ENV=production`) on Render. Rotate any key that was ever pasted into chat, email, or GitHub.
- Run `npm audit` now and then, and `npm update` to pick up patched dependency versions.
- Orders whose Paystack amount does not match the order total are saved with payment status "Check Payment" and logged as `payment_mismatch` — review them manually before shipping.

## Delivery areas (dispatch rider fee)

- Run the "DELIVERY AREAS" block at the bottom of `supabase-schema.sql` in the Supabase SQL Editor (safe to run again).
- In `admin.html` open **Delivery Areas** to add places and prices. Customers pick their area at checkout and the fee is added to the total; Pick Up is always free.
- The fee is always looked up on the server, never trusted from the browser.
- Each order saves the customer's phone, area, fee and item sizes. Use **Copy Details** on an order to send the delivery info to your rider.

## Customer accounts (login required to order)

- Run the "CUSTOMER ACCOUNTS" block at the bottom of `supabase-schema.sql` (safe to run again).
- Customers sign up with name, email, phone and a password, and must agree to the Policies & Privacy Notice. They cannot check out without logging in.
- Order updates (accepted / rejected) are emailed to the email on the customer's account. To email real customers you must verify a domain in Resend and set `RESEND_FROM_EMAIL` (the default `onboarding@resend.dev` only delivers to your own Resend email).
- "Forgot password" emails a link that works for 30 minutes and only once.
- Passwords are stored as salted scrypt hashes (`customer-auth.js`); logins use a signed HttpOnly cookie. Set `SESSION_SECRET` on Render.
- The admin page shows each ordered item's picture (click to enlarge) and a Customers list with name, email and phone.
