# Greenline Buses backend

Node 20+ server with no dependencies. Tickets are paid with PayHero (FinoQ) M-PESA prompts.

## Set up
1. Supabase: SQL Editor > paste `supabase/schema.sql` > Run.
2. Render: New > Blueprint > pick the repo (uses `render.yaml`). Fill the environment values listed in `.env.example`.
3. PayHero: set the callback URL to `https://YOUR-SITE/api/webhooks/payhero?s=YOUR_CALLBACK_SECRET` (same secret as `PAYHERO_CALLBACK_SECRET`).
4. The website (`frontend/index.html`, served at `/`) and the admin page (`frontend/admin.html`, served at `/admin`) are included.

## Run and test on your computer
    npm test
    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... ADMIN_KEY=... node server.js

## API
Public: GET /api/config, GET /api/seats?to=&date=, POST /api/book, GET /api/book/status?id=, GET /api/ticket?ref=&phone=, POST /api/support, POST /api/webhooks/payhero?s=
Admin (header X-Admin-Key): GET /api/admin/summary, /payments, /payments.csv, /bookings, /manifest, /support, /settings; POST /payments/:id/recheck, /payments/:id/approve, /bookings/:id/cancel; PATCH /support/:id; PUT /settings

## Email tickets (Resend)
1. resend.com > Domains > add and verify your own domain (e.g. greenline.co.ke).
2. Resend > API Keys > create a key. On Render set `RESEND_API_KEY`, `MAIL_FROM` (e.g. `Greenline Buses <tickets@greenline.co.ke>`) and `SITE_URL`.
3. Run `supabase/schema.sql` again (it adds the `email` columns; safe to repeat).
Customers type their email when booking. The ticket is emailed once the payment is confirmed. If Resend is down, the server retries every minute for 24 hours. In Admin > Trips you can see who was emailed and send a ticket again to any address.
`onboarding@resend.dev` only delivers to the Resend account owner, so verify your domain before going live.

## Payment gateway check (do this before going live)
The default host is PayHero's published API, `https://backend.payhero.co.ke` (the same one your ComradeConnect example config uses). Set `PAYHERO_BASE_URL` only if PayHero gives you a different one. Make one real test payment of KES 10 and watch the booking turn paid and the email arrive. The re-check button tries PayHero's documented `GET /api/v2/transaction-status` first and falls back to the `POST /api/global/transaction-status` form.

## Customers
`/#ticket` lets a customer get their ticket back with the ticket code and the M-PESA number.
