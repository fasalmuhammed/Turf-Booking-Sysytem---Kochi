# ⚽ Turf Booking on WhatsApp

A complete WhatsApp-based turf booking system. Customers book football/cricket turfs entirely inside WhatsApp — pick a turf, date and slot, see prices and offers, pay via UPI, get confirmations and reminders, and cancel or reschedule. Admins manage everything from a web dashboard.

**Stack:** Node.js 22.13+ (tested on 24) · TypeScript · Express 5 · SQLite (built-in `node:sqlite`, no native builds) · official **WhatsApp Cloud API**.

---

## Features

**Customer (WhatsApp)**
- Friendly welcome + main menu (buttons), works with taps *or* typed replies (`1`, `book`, `my bookings`, `agent`, a booking ID…)
- Location → turf → date → time-of-day → slot → duration (1–3 slots) → name → mobile → summary → confirm
- Hourly prices, peak pricing and automatic offers shown in the slot list
- Advance or full payment, UPI deep link + QR page, or Razorpay payment link (auto-verified)
- Unique booking ID, confirmation with location/map/rules, automatic reminders
- View bookings, pay, cancel (policy-based refunds), reschedule (policy-limited)
- FAQs, location/timings, prices/offers, rules/policies; free-text questions matched to FAQs
- Hand-off to a human (bot pauses; staff reply from the dashboard)
- Graceful handling of unknown text, media, expired sessions and duplicate webhook deliveries

**Admin dashboard (`/admin`)**
- Dashboard: today/week/month collections, booked value, today's & tomorrow's schedule, alerts
- Bookings: search/filter, details, record payments (cash/UPI/card), cancel with refund, reschedule, mark completed/no-show, create walk-in/phone bookings, CSV export
- Payments: verify or reject customers' UPI claims (UTR / screenshot), refund tracking
- Schedule grid per turf/day; block slots for maintenance or private events (per turf or whole venue)
- Turfs & locations: hours (incl. past midnight), slot length, prices, advance %, closed days, peak pricing rules
- Offers (percent/flat, dates, weekdays, time window, minimum slots), FAQs, customers, inbox
- Revenue reports (daily/weekly/monthly, by turf), settings & policies, admin accounts, activity log
- **WhatsApp simulator** to test the full bot locally without Meta credentials

**Reliability & security**
- Atomic availability checks (`BEGIN IMMEDIATE` transactions) — double bookings are impossible
- Unpaid holds expire automatically (default 15 min); held while a payment is being verified
- Late payments for a lost slot are flagged for refund automatically
- Webhook signature verification (Meta `X-Hub-Signature-256`, Razorpay `X-Razorpay-Signature`)
- Admin auth: scrypt-hashed passwords, httpOnly session cookies, CSRF tokens on every form, login rate limiting/lockout, strict security headers (CSP, frame-deny), audit log
- Signed payment-page links; customers can only act on their own bookings

---

## Quick start (local, no WhatsApp account needed)

```bash
npm install
```

```bash
cp .env.example .env
```

Edit `.env`: set `APP_SECRET` to a long random string and `ADMIN_PASSWORD` (10+ characters, letters and numbers). Keep `WHATSAPP_MODE=mock`.

```bash
npm run dev
```

Open http://localhost:3000/admin, sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`, then open **WhatsApp simulator** in the sidebar and say “hi”. Demo turfs, offers and FAQs are loaded on first start (`SEED_DEMO_DATA=true`).

```bash
npm test
```

---

## Connecting real WhatsApp (Meta Cloud API)

1. **Create a Meta app** at https://developers.facebook.com → *Create app* → type *Business* → add the **WhatsApp** product.
2. In **WhatsApp → API Setup**, note the **Phone number ID** and generate an access token.
   For production create a **System User** in Business Settings with `whatsapp_business_messaging` permission and generate a **permanent token**.
3. Copy the **App secret** (App settings → Basic).
4. Expose your server over HTTPS. For local testing:
   ```bash
   ngrok http 3000
   ```
5. Update `.env`:
   ```ini
   WHATSAPP_MODE=cloud
   WHATSAPP_TOKEN=EAAG...
   WHATSAPP_PHONE_NUMBER_ID=1234567890
   WHATSAPP_APP_SECRET=abc123...
   WHATSAPP_VERIFY_TOKEN=any-random-string-you-choose
   PUBLIC_BASE_URL=https://your-subdomain.ngrok-free.app
   ADMIN_WHATSAPP_NUMBERS=919876543210
   ```
6. In **WhatsApp → Configuration → Webhook**: callback URL `https://<your-domain>/webhooks/whatsapp`, verify token = `WHATSAPP_VERIFY_TOKEN`. Click *Verify and save*, then **subscribe to the `messages` field**.
7. Restart (`npm run dev`) and message your WhatsApp business number “hi”.

> **24-hour rule:** WhatsApp only allows free-form messages within 24 hours of the customer's last message. Confirmations are normally inside that window. For reminders sent later, create an approved **utility template** with body params `{{1}}` name, `{{2}}` turf, `{{3}}` date, `{{4}}` time and set `WHATSAPP_REMINDER_TEMPLATE=<template_name>`.

---

## Payments

**UPI (default, no gateway fees).** Set your UPI ID in *Settings → Payments*. Customers get the UPI ID, amount and booking ID as the note, plus (when `PUBLIC_BASE_URL` is HTTPS) a payment page with a “Pay with UPI app” button and QR code. After paying they tap **I’ve paid** and send the UTR or a screenshot; you verify it on the **Payments** page and the customer is confirmed instantly on WhatsApp.

**Razorpay (optional, automatic verification).** Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, and add a webhook in the Razorpay dashboard to `https://<your-domain>/webhooks/razorpay` for the `payment_link.paid` event. Customers then get a payment link and are confirmed automatically.

Advance payment uses each turf's *Advance %* (0 or 100 = full payment only); the balance is collected at the venue and can be recorded from the booking page.

---

## Configuration reference

Business settings (editable in the dashboard): business name, welcome message, UPI ID/name, support phone, booking window (days ahead), minimum notice, hold time, advance payments on/off, cancellation policy (full-refund window, late refund %, cut-off), reschedule cut-off and limit, reminder lead time, turf rules, hand-off message.

Turf settings: location, sports, opening/closing time (a closing time earlier than the opening time means *after midnight*, e.g. 6:00 → 01:00), slot length, standard hourly price, peak pricing rules, advance %, max slots per booking, closed weekdays.

Environment variables: see [.env.example](.env.example).

---

## Production deployment

```bash
npm ci
```

```bash
npm run build
```

```bash
NODE_ENV=production npm start
```

- In production the server **refuses to start** with a weak `APP_SECRET` or missing WhatsApp credentials/app secret.
- Run behind HTTPS (nginx/Caddy, or a platform like Railway/Render/Fly.io with a persistent volume for `DATABASE_PATH`).
- Run a **single instance** (SQLite + in-process scheduler). This comfortably handles many venues; for horizontal scaling, move to Postgres and a shared job queue.
- Back up the SQLite file regularly (e.g. `sqlite3 data/turf.db ".backup backup.db"` or Litestream).
- Remove `ADMIN_PASSWORD` from `.env` after the first admin is created; manage admins under *Settings*, or reset a password with:
  ```bash
  npm run create-admin -- admin 'NewStrongPassw0rd'
  ```

---

## Project structure

```
src/
  index.ts              boot: DB, first admin, seed, HTTP server, scheduler
  app.ts                Express app (webhooks, public pages, admin)
  config.ts             environment configuration
  db/                   SQLite connection, migrations, demo seed
  services/             business logic — availability, pricing, bookings,
                        payments, reports, settings, scheduler (holds/reminders)
  whatsapp/             Cloud API client, mock transport, webhook parser
  bot/                  conversation engine + flows (booking, manage, support)
  admin/                dashboard: auth, layout, pages
  routes/public.ts      UPI payment page, Razorpay webhook, health check
public/                 dashboard CSS + simulator JS
test/                   node:test suites (engine, bot conversations, HTTP/security)
```

Multiple locations are supported now: add a location and its turfs, and the bot automatically asks customers to pick a location first.
