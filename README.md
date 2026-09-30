# ✂ TrimSlot — Book. Arrive. Get Trimmed.

Barber booking + live queue MVP for Nigeria (₦ NGN, timezone **Africa/Lagos**).
Node.js + TypeScript + Express + **PostgreSQL** (`pg`), vanilla-JS mobile-first frontend (no build step). Runs on **Vercel (serverless) + Supabase Postgres**, or as a normal Node server.

> **Deploying for real users?** See **[DEPLOY.md](DEPLOY.md)**: primary walkthrough = **Vercel + Supabase (free)**; Docker/VPS/Fly/Railway are kept as a legacy path. Also Paystack webhook/subaccount setup, backups, pre-launch checklist.

## Quick start

```bash
npm install
npm run dev        # or: npm start      -> http://localhost:4100
```

With no `DATABASE_URL`, development starts a **throw-away real PostgreSQL 17** (the `embedded-postgres` devDependency, data in `./data/pg`, no Docker needed), applies `migrations/*.sql` and loads the demo data. To use your own Postgres instead: `DATABASE_URL=postgresql://… npm run migrate && DATABASE_URL=… npm start`.
Re-seed from scratch: `npm run seed -- --reset` (refused in production). Requires Node 18+ (tested on Node 20).

Copy `.env.example` to `.env` to configure (never commit `.env`).

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (Supabase: **transaction pooler**, port 6543). **Required in production** |
| `PG_POOL_MAX` | Connections per instance (default 3 — small, for serverless) |
| `JWT_SECRET` | Signs the auth cookie. **Required (≥32 chars) when `NODE_ENV=production`** |
| `CRON_SECRET` | Bearer secret for `/api/cron/sweep` (≥16 chars; unset = endpoint disabled). Also works as the admin key (fallback) |
| `ADMIN_KEY` | Optional separate admin key for `/admin.html` and `/api/admin/*` (≥16 chars, else ignored). Does not open the cron endpoint |
| `APP_BASE_URL` | Public URL, used for the Paystack `callback_url` and origin checks |
| `PAYSTACK_SECRET_KEY` | Paystack **test** secret key. **Empty => MOCK mode** (banner shown on every page + fake checkout) |
| `PLATFORM_FEE_KOBO`, `PLATFORM_FEE_PERCENT` | Optional platform fee, sent as `transaction_charge` when the barber has a subaccount |
| `PAYMENT_HOLD_MINUTES` | How long an unpaid pay-now booking holds its slot (default 15) |
| `TRUST_PROXY`, `CORS_ORIGINS`, `SEED_DEMO`, `LOG_LEVEL`, `SWEEP_EVERY_SECONDS`, `AUTO_MIGRATE`, `BCRYPT_ROUNDS` | See `.env.example` and DEPLOY.md |
| `TRIMSLOT_FAKE_NOW` | Demo/test only (refused in production): pretend "now" is e.g. `2026-09-30T10:00:00+01:00` |

Scripts: `npm run migrate` · `npm run seed` · `npm run admin -- list-barbers|verify-barber <email>` · `npm test` · `npm run e2e` · `npm run typecheck` · `npm run build` · `npm run vercel:local`.

## Production mode (summary)
`NODE_ENV=production` **refuses to boot** without `DATABASE_URL`, `JWT_SECRET` (≥32 chars), `PAYSTACK_SECRET_KEY` (`sk_test_`/`sk_live_`) and an `https://` `APP_BASE_URL`; mock payments and demo data are disabled (demo only with `SEED_DEMO=true`).
Adds helmet/CSP/HSTS, DB-backed sign-up/login/payment rate limits (+ per-account failed-login lock), CORS off by default (`CORS_ORIGINS`), structured JSON logs without secrets, `/healthz` (`?deep=1` checks the DB) and `npm run admin -- verify-barber <email>`.
New barbers stay **unverified** (hidden from customers, not bookable) until an admin verifies them.

## Demo logins (seeded, development only)

| Role | Login | Password |
|---|---|---|
| Barber (Mike, "Mike's Barbershop") | `mike@trimslot.demo` or `08031234567` | `Barber123!` |
| Customer — Chidi Okafor | `chidi@trimslot.demo` or `08055550001` | `Customer123!` |
| Customer — Tunde Bakare | `tunde@trimslot.demo` or `08055550002` | `Customer123!` |

Mike: Regular Haircut ₦3,000/30m · Haircut + Beard ₦4,500/45m · Kids Haircut ₦2,500/25m · Full Grooming ₦6,000/60m.
Mon–Sat 09:00–18:00, break 13:00–14:00, Sunday off. Change these at **Settings** (barber).

## Demo walkthrough (MOCK mode)
1. Sign up as a customer (or use Chidi) → pick Mike → service → date → time → **Pay now**.
2. You land on the *Mock Paystack* page → "Simulate successful payment". The server then verifies the reference (never trusts the browser) and the booking becomes CONFIRMED / PAID.
3. On the day of the booking tap **I'm Here** (booking screen). Log in as Mike in another browser: **Today** shows NOW SERVING / NEXT / WAITING. Press **START**, then **COMPLETE** (pay-on-arrival bookings must have Cash/Transfer recorded first).
4. The customer's booking page shows the live queue ("You're #2 in line", "You're next", "Your barber is ready") and refreshes every 10 s.

## Tests

```bash
npm test          # 50 tests (node:test via tsx) against a REAL PostgreSQL 17 (embedded-postgres, booted by scripts/test.ts;
                  # each test gets its own database cloned from a migrated template). Includes real concurrency tests
                  # (15 parallel bookings for one slot, 12 parallel webhook/callback deliveries), constraint tests, lazy hold expiry,
                  # cron auth, DB-backed rate limiter, migrations, production config checks.
npm run e2e       # 52 HTTP end-to-end checks: boots a fresh Postgres + the server on :4101 with a fixed clock, then runs scripts/e2e.ts
npm run typecheck
npm run vercel:local   # loads the Vercel function (compiled `vercel build` output if present) in a bare http server with VERCEL=1 + production config
```
What the tests do **not** prove: behaviour against Supabase's Supavisor pooler, TLS/network latency, Vercel's real runtime, or live Paystack. See DEPLOY.md.
`scripts/ui-flow.mjs` drives the UI in headless Chrome at phone size and writes `screenshots/*.png` (needs `playwright-core`).

## Architecture notes
- **Backend-enforced roles**: every request loads the user from the DB (`src/auth.ts`); `/api/barber/*` needs role barber and is always scoped to that barber's id; customers are always scoped to `customer_id`. Other people's bookings return 404.
- **State machine** (`src/stateMachine.ts`): `PENDING_PAYMENT→CONFIRMED→ARRIVED→IN_SERVICE→COMPLETED`; `CONFIRMED/ARRIVED→CANCELLED | NO_SHOW | NOT_SERVED`; `PENDING_PAYMENT→CANCELLED` (customer cancel / hold expiry). All status writes go through `assertTransition` + a compare-and-set `UPDATE … WHERE status=?`. Illegal → HTTP 409 `ILLEGAL_TRANSITION`.
- **No double booking**: booking creation runs in a Postgres transaction that locks the barber row (`FOR UPDATE`) and recomputes availability; a partial UNIQUE index on `(barber_id, scheduled_at)` for live statuses and a `btree_gist` exclusion constraint on the time range are the database backstops. Slots step every 15 min; a slot needs the whole service to fit in working hours, outside the break, with no overlap.
- **Price snapshot**: `service_name`, `price_kobo`, `duration_min` are copied onto the booking; the client cannot send a price (ignored/validated server-side). Money is stored in kobo.
- **Schema is extensible**: `bookings.family_member_id` (nullable) and `bookings.entitlement_type` (default `'NONE'`).
- **Times**: all instants are `timestamptz`. `scheduled_at` (never rewritten), `arrival_time`, `service_start`, `service_complete` stored separately; `date`/`start_min`/`end_min` are generated columns derived in Africa/Lagos (fixed UTC+1). Early arrivals can be started immediately.
- **Serverless**: expired pay-now holds are enforced lazily (ignored in availability, released at booking/auth time) and swept by `/api/cron/sweep` (Bearer `CRON_SECRET`) — correctness never depends on cron.
- **Midnight**: nothing is ever deleted; "today" is just `WHERE date = <Lagos today>`. Stale unpaid holds are cancelled (not deleted).
- **Queue order** for a barber today: IN_SERVICE, then ARRIVED, then not-yet-arrived, each by scheduled time (skipped customers go to the back of their group). "Ahead" counts everyone in front, including the person in the chair. Barber **Wait** flags a customer as being waited for; **Skip** moves them back.
- **Audit log** for every critical action (BOOKED, PAYMENT_CONFIRMED, CHECKED_IN, MARKED_PRESENT, STARTED, PAYMENT_RECORDED, COMPLETED, CANCELLED, NO_SHOW, NOT_SERVED, SKIPPED…) with actor + timestamp; the barber sees it as a timeline on the booking page.

## Paystack
- `POST /api/bookings/:id/pay` → initializes a transaction: reference `TS-BOOKING-<id>-<random>`, amount = the booking's snapshotted price in **kobo**, `subaccount` = the barber's `paystack_subaccount` (set in Settings, e.g. `ACCT_xxxx`), optional `transaction_charge` from `PLATFORM_FEE_*`.
- `GET /api/payments/callback` (Paystack `callback_url`) and `POST /api/payments/webhook` both call the same server-side `processReference()` which calls Paystack `GET /transaction/verify/:reference`, checks `status=success` and that the amount equals what we asked for, then atomically (row-locked transaction, conditional `UPDATE … WHERE status<>'SUCCESS'`) flips the payment INITIATED→SUCCESS and the booking PENDING_PAYMENT→CONFIRMED/PAID. Already-processed references do nothing (idempotent, race-safe).
- Webhook: HMAC-SHA512 of the **raw body** with `PAYSTACK_SECRET_KEY` vs `x-paystack-signature` (timing-safe). Every webhook (valid or not) is stored in `payment_events`. Point Paystack's dashboard webhook URL at `https://<your-host>/api/payments/webhook`.
- **MOCK mode** (no `PAYSTACK_SECRET_KEY`): a fake checkout page marks the reference as "paid at the mock gateway"; the app still verifies through the same code path, and webhooks are signed with a fixed, public mock key. Do not run MOCK mode in production.
- ⚠ The live Paystack HTTP calls were **not exercised** in this build (no test key available) — only the mock gateway and unit tests for signature/idempotency. Try it with a `sk_test_…` key before launch.

## Policies / TODOs for the owner
- **Refunds are undecided.** A paid online booking cancelled by the customer inside the window (or marked NOT_SERVED) is **not refunded automatically**; `payment_status` becomes `CREDIT_PENDING` and the audit log carries a `TODO(owner)` note. A payment that arrives after a hold expired is also flagged `CREDIT_PENDING`. Prepaid no-shows stay `PAID`. Decide policy, then build the refund/credit flow.
- Customers can cancel until exactly 30 min before the appointment (`CANCEL_CUTOFF_MIN` in `src/config.ts`); after that only the barber can No-show/Skip. No-show is only allowed after the scheduled time has passed.

## Notifications
In-app only (`notifications` table + 🔔 list, polled). **Real push / SMS / WhatsApp is not implemented** — a later step is to fan out from `notify()` in `src/helpers.ts`.

## Not in MVP / next steps
- Family accounts (`family_member_id` is reserved) · Paid turns / entitlements (`entitlement_type` is reserved) · Subscriptions
- Reviews & ratings · Admin panel (barber onboarding, disputes, refunds/credits) · Push/SMS notifications
- Booking change / reschedule (currently cancel + rebook) · Multi-barber shops/staff · Barber photo upload (URL only)
- Barber payouts reporting, Paystack subaccount creation via API (currently paste an `ACCT_…` code)
- Admin web panel (today: CLI `npm run admin`) · Email/phone verification and password reset · Redis-grade rate limiting for the general API

## Plans, session credits and platform rules (migration 004)

- **Slots.** Only *complete* bookings occupy a slot: paid online, pay-on-arrival, or paid with a plan session / credit. An unpaid Pay-now attempt reserves nothing (customer-only, shown "Not confirmed"/"Incomplete"). At payment time the slot is re-checked under the barber row lock; if someone else got it first the booking is not confirmed, the payment is flagged `NEEDS_REFUND` (gateway refund is requested automatically, retried by the sweeper) and the customer is told. A booked slot stays taken until cancelled; customers cancel up to 30 min before (slot reopens at once).
- **Plans.** Barbers create plans in Settings → *Plans & credits* (name, ₦ price, sessions, included services, validity days) within the platform limits. Customers buy through the normal Paystack flow (subaccount + platform fee split). Sessions are spent at booking (`payment_option=PLAN`) and end with the plan.
- **Missed paid session** (no-show, or a paid session that was not cancelled in time): no refund; one **same-barber** credit, expires after `credit_expiry_days` (default 30), not cashable, auto-applied on the next booking with that barber (`payment_option=CREDIT`). In-time cancel of a plan/credit booking returns the session/credit.
- **Admin rules** (`platform_settings`): `npm run admin -- settings`, `npm run admin -- set credit_expiry_days 30 max_plan_price_naira 200000`, `npm run admin -- refunds`; API `GET/PUT /api/admin/settings`.
- **Admin portal** at `/admin.html`: Overview, Barbers (verify / suspend), Bookings (filters), Payments (refund retry / mark refunded), Refund decisions (`CREDIT_PENDING` → credit or refund), Plans, Credits, Platform rules and an Audit log. Sign in with the admin key: `ADMIN_KEY` if set, otherwise (or additionally) `CRON_SECRET`. It is typed once and kept only in that tab's `sessionStorage`; the page itself holds no secret. All `/api/admin/*` routes need `Authorization: Bearer <key>`, compare it in constant time, and lock an IP out for 15 minutes after 8 wrong keys. Every action writes an `ADMIN_*` audit row. Migration `005_admin_portal.sql` allows `refund_status = 'REFUNDED'`. The CLI (`npm run admin`) still works.


## UI v3 (profile, barber page first, calmer look)
- Customer tabs: Home · Bookings · Plans · Profile. Barber tabs: Today · Upcoming · Customers · Plans · Profile (`#/plans` manages plans; `#/profile` is the shop/account hub).
- Opening a barber (`#/barber/:id`) shows photo, about, services, **Plans** (buyable), hours and today's queue first; the booking wizard (`#/book/:id`) starts only from the **Book a session** button.
- `PATCH /api/me` edits name/email/phone (unique; one contact must remain). Dark mode lives in Profile.
- Buttons are compact (42px, 14.5px text); only one primary CTA per screen is full width (`.btn.block`). Body reserves space for the floating tab bar + safe area.
- `node scripts/ui-check.mjs` screenshots every screen at 390px and 360px and fails on horizontal overflow, controls under the tab bar, or out-of-range button sizes. `npm run flow` runs the 10-account concurrency flow (`scripts/flow-multi.ts`); `scripts/flow-cleanup.sql` removes its throwaway data.
