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
| _(retired)_ `PLATFORM_FEE_*` | Fees are admin settings now (fee split, Paystack rates, TrimSlot charge); the env vars are ignored |
| `PAYMENT_HOLD_MINUTES` | How long an unpaid pay-now attempt stays open before it becomes "Incomplete" (default 15; admin setting `payment_hold_min` wins). It does **not** reserve the slot: the first confirmed payment wins |
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
npm test          # 145+ tests (node:test via tsx) against a REAL PostgreSQL 17 (embedded-postgres, booted by scripts/test.ts;
                  # each test gets its own database cloned from a migrated template). Includes real concurrency tests
                  # (15 parallel bookings for one slot, 12 parallel webhook/callback deliveries), constraint tests, lazy expiry of unpaid tries,
                  # cron auth, DB-backed rate limiter, migrations, production config checks.
npm run e2e       # 52 HTTP end-to-end checks: boots a fresh Postgres + the server on :4101 with a fixed clock, then runs scripts/e2e.ts
npm run typecheck
npm run vercel:local   # loads the Vercel function (compiled `vercel build` output if present) in a bare http server with VERCEL=1 + production config
```
What the tests do **not** prove: behaviour against Supabase's Supavisor pooler, TLS/network latency, Vercel's real runtime, or live Paystack. See DEPLOY.md.
`scripts/ui-flow.mjs` drives the UI in headless Chrome at phone size and writes `screenshots/*.png` (needs `playwright-core`).

## Architecture notes
- **Backend-enforced roles**: every request loads the user from the DB (`src/auth.ts`); `/api/barber/*` needs role barber and is always scoped to that barber's id; customers are always scoped to `customer_id`. Other people's bookings return 404.
- **State machine** (`src/stateMachine.ts`): `PENDING_PAYMENT→CONFIRMED→ARRIVED→IN_SERVICE→COMPLETED`; `CONFIRMED/ARRIVED→CANCELLED | NO_SHOW | NOT_SERVED`; `PENDING_PAYMENT→CANCELLED` (customer cancel / the try timing out; it never reserved the slot). All status writes go through `assertTransition` + a compare-and-set `UPDATE … WHERE status=?`. Illegal → HTTP 409 `ILLEGAL_TRANSITION`.
- **No double booking**: booking creation runs in a Postgres transaction that locks the barber row (`FOR UPDATE`) and recomputes availability; a partial UNIQUE index on `(barber_id, scheduled_at)` for live statuses and a `btree_gist` exclusion constraint on the time range are the database backstops. Slots step every 15 min; a slot needs the whole service to fit in working hours, outside the break, with no overlap.
- **Price snapshot**: `service_name`, `price_kobo`, `duration_min` are copied onto the booking; the client cannot send a price (ignored/validated server-side). Money is stored in kobo.
- **Schema is extensible**: `bookings.family_member_id` (nullable) and `bookings.entitlement_type` (default `'NONE'`).
- **Times**: all instants are `timestamptz`. `scheduled_at` (never rewritten), `arrival_time`, `service_start`, `service_complete` stored separately; `date`/`start_min`/`end_min` are generated columns derived in Africa/Lagos (fixed UTC+1). Early arrivals can be started immediately.
- **Serverless**: an unpaid pay-now attempt reserves no slot (ignored in availability); when it times out it is closed lazily (at booking/auth time) and by `/api/cron/sweep` (Bearer `CRON_SECRET`), so correctness never depends on cron. **Sweeper schedule:** Vercel's free plan runs the sweep **once a day** (`0 3 * * *` in `vercel.json`); the minute-level behaviour (auto-approving refunds on time, reminders, tidy statuses) needs the external one-minute timer in DEPLOY.md section 7. A payment that arrives after a try closed confirms the booking if the time is still free, otherwise it is flagged `NEEDS_REFUND` and refunded automatically. **Verify before void:** before a try is closed, Paystack is asked about its INITIATED payments (`verifyBeforeClosing`), and the sweep re-checks INITIATED payments of the last 48 h (`reconcileRecentPayments`), so a missed webhook plus a closed browser does not leave a charge without a booking; "You were not charged" is said only when that was verified. Starting to pay extends the try (capped at 4 x the hold) and re-uses the open checkout (concurrent clicks make one checkout); a mismatched amount or a non-NGN currency is not confirmed and raises the `PAYMENT_MISMATCH` admin alert.
- **Midnight**: nothing is ever deleted; "today" is just `WHERE date = <Lagos today>`. Stale unpaid tries are cancelled (not deleted).
- **Queue order** for a barber today: IN_SERVICE, then ARRIVED, then not-yet-arrived, each by scheduled time (skipped customers go to the back of their group). "Ahead" counts everyone in front, including the person in the chair. Barber **Wait** flags a customer as being waited for; **Skip** moves them back.
- **Audit log** for every critical action (BOOKED, PAYMENT_CONFIRMED, CHECKED_IN, MARKED_PRESENT, STARTED, PAYMENT_RECORDED, COMPLETED, CANCELLED, NO_SHOW, NOT_SERVED, SKIPPED…) with actor + timestamp; the barber sees it as a timeline on the booking page.

## Paystack
- `POST /api/bookings/:id/pay` → initializes a transaction: reference `TS-BOOKING-<id>-<random>`, amount = price + booking fee in **kobo** (snapshotted on the booking), `subaccount` = the barber's `paystack_subaccount`, `bearer: 'account'`, and `transaction_charge` = total − barber payout (see `src/fees.ts`).
- `GET /api/payments/callback` (Paystack `callback_url`) and `POST /api/payments/webhook` both call the same server-side `processReference()` which calls Paystack `GET /transaction/verify/:reference`, checks `status=success` and that the amount equals what we asked for, then atomically (row-locked transaction, conditional `UPDATE … WHERE status<>'SUCCESS'`) flips the payment INITIATED→SUCCESS and the booking PENDING_PAYMENT→CONFIRMED/PAID. Already-processed references do nothing (idempotent, race-safe).
- Webhook: HMAC-SHA512 of the **raw body** with `PAYSTACK_SECRET_KEY` vs `x-paystack-signature` (timing-safe). Every webhook (valid or not) is stored in `payment_events`. Point Paystack's dashboard webhook URL at `https://<your-host>/api/payments/webhook`.
- **MOCK mode** (no `PAYSTACK_SECRET_KEY`): a fake checkout page marks the reference as "paid at the mock gateway"; the app still verifies through the same code path, and webhooks are signed with a fixed, public mock key. Do not run MOCK mode in production.
- ⚠ The live Paystack HTTP calls were **not exercised** in this build (no test key available) — only the mock gateway and unit tests for signature/idempotency. Try it with a `sk_test_…` key before launch.

## Policies / TODOs for the owner
- **Refunds vs credit** (decided): a paid online booking cancelled inside the window, or marked NOT_SERVED, is **refunded** (never turned into a credit): it waits for TrimSlot staff to approve or reject (with a reason), and is **auto-approved** after `refund_auto_approve_hours` by the next sweep run (within a minute with the external timer, otherwise by the daily run) (`src/refundFlow.ts`). A **late payment** after a try closed confirms the booking if the time is still free; if not, or if it is a duplicate or the time was taken first, it is flagged `NEEDS_REFUND` and a refund is requested from Paystack automatically (the customer is notified in each case). Legacy `CREDIT_PENDING` rows stay for TrimSlot staff to decide under *Refund decisions* (a credit or a refund, never both). Missed (no-show) bookings give a credit immediately, worth the booking's service price. Nothing in the app takes refunds or chargebacks back from a barber's balance.
- Customers can cancel until exactly 30 min before the appointment (`CANCEL_CUTOFF_MIN` in `src/config.ts`); after that only the barber can No-show/Skip. No-show is only allowed after the scheduled time has passed.

## Notifications (real Web Push + in-app)
Every notification row (`notify()` in `src/helpers.ts`) is also an outbox entry: `flushPush()` (`src/push.ts`) claims unpushed rows (`FOR UPDATE SKIP LOCKED`) and sends a Web Push to each of the user's subscriptions (`push_subscriptions`). Dead endpoints (HTTP 404/410) are deleted at once; other failures are counted and the subscription is dropped after 8. Push runs after responses (`waitUntil` on Vercel), from the sweep, and after payment webhooks.
- **In the app:** bell with unread badge, live banner (8 s poll), optional sound and vibration (Profile, default on), tab title `(n)`, notification centre (`#/notifications`) with unread state and tap-through to the booking.
- **Keys:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (env vars; the private key is never exposed). The public key is served by `/api/config` (`vapid_public_key`). Generate with `npx web-push generate-vapid-keys`. Without them push is simply unavailable and the in-app bell keeps working. Changing the keys invalidates existing subscriptions (they re-subscribe on next open).
- **iOS:** Web Push works only for the installed app (iOS/iPadOS 16.4+): Share, Add to Home Screen, then open it from the Home Screen and tap *Enable notifications*. The app shows this hint on iOS Safari.
- **Not exact-time:** Vercel Cron is daily on the free plan, so reminders (2 h, 30 min, "leave now") and waitlist alerts are triggered lazily by app activity and the sweep (`/api/cron/sweep`, also callable every minute from cron-job.org, see DEPLOY.md §7).
- **Toggles (admin, Controls):** `feature_push`, `reminders`, `favourites`, `rebook`, `waitlist`, `reviews`, `booking_note`, `barber_notes`, `reliability`, `quick_actions`, `daily_summary` (all on by default) and `loyalty` (off by default; every Nth completed visit earns a credit). Turning one off hides it and rejects its API instantly.

## Payments fix, barber payouts, admin PIN and deletes (migration 009)
- **Paystack fee pass-through.** Paystack can add its processing fee on top of the price, so the webhook/verify `amount` is higher than what TrimSlot asked for (`requested_amount` still equals our price). Verification now compares the **requested** amount to the payment row (price + booking fee) and allows only a small, capped extra on top (at most the larger of ₦200 and 8%), never an underpayment, stores `payments.paid_kobo` / `gateway_fee_kobo`, and confirms the booking. Before this fix every real payment ended as `amount_mismatch` and the booking never confirmed. The customer return page now **verifies by reference** (retries for ~12 s) instead of waiting for the webhook; admins can press **Re-verify with Paystack** on a stuck `INITIATED` payment (`POST /api/admin/payments/:reference/reverify`).
- **Barber payouts** (`src/payouts.ts`, app route `#/payouts`): bank list (Paystack `/bank`, cached), 10-digit account number, name lookup (`/bank/resolve`), then a Paystack **subaccount** is created and its code saved (only the last 4 digits and account name are stored). The free-text subaccount field is gone. Online payment (booking and plan purchase) is **refused with 409 `PAYOUT_NOT_SETUP`** until the barber has an active subaccount (`REQUIRE_PAYOUT=1` forces this in mock mode; it is always on with a real Paystack key). The customer wizard shows "Pay now" as unavailable with the reason; pay on arrival is unaffected.
- **Admin PIN** (`src/adminPin.ts`): 4 digits, set once in Admin → *Admin PIN* (scrypt + per-PIN salt in `admin_pin`), sent per action as `X-Admin-Pin`, 5 wrong tries lock it for 15 minutes, changing it needs the old PIN. Required for: deleting anything, permanent bans, refunds/mark-refunded, ledger waive/adjust, revoking credits, cancelling a plan purchase with refund, the test-data purge. Every action is audited.
- **Deletes** (`src/adminDelete.ts`, admin → *Recently deleted* / *Test data*): customers, barbers, plans, reviews and reports are **soft-deleted** (hidden everywhere, restorable for 30 days without a PIN). "Delete forever" and booking deletes need the PIN and are refused when successful payments exist. The test-data purge only matches `smoketest+…@example.com` and `perf…@perf.test`, shows a preview first and needs the typed phrase plus the PIN.
- **UI**: one compact system (14px body, 16–20px headings, 8px radii, hairline borders, no shadows or gradients, slim header + full-width bottom nav). Primary buttons are flat solid accent, neutral/disabled until the form is valid (`public/forms.js`), with a subtle pressed state. The slot grid uses fixed-height auto-fill cells.

## Smart features (migration 008)
Customers: favourites, "Book again" (usual barber/service/time), waitlist for full days, live queue ETA and "leave now" nudge, note to barber, ratings and reviews. Barbers: private customer notes with the customer's usual service, reliability badge (New / Reliable / Mostly reliable / Often misses), running-late delay and one-tap queue messages (rate limited), daily summary, review replies. All in-app; no paid SMS or email.

## Admin v3 (redesign)
Home with "needs attention" cards; grouped left navigation (People, Bookings, Money, Growth, Settings); every list is server-side keyset (cursor) paginated with search, filters, sorting, saved views (browser), skeleton and empty states; row click opens a right-hand drawer; bulk actions with a confirm dialog and a required reason (audited once per batch, max 200 ids); Ctrl/Cmd+K command palette; dark mode. API: `GET /api/admin/l/:list`, `/home`, `/palette`, `/counts/:what`, `/bulk/*` (`src/admin3.ts`). Local benchmark script: `scripts/perf-seed.mjs` + `scripts/perf-time.mjs` (local DB only).

## Not in MVP / next steps
- Family accounts (`family_member_id` is reserved) · Paid turns / entitlements (`entitlement_type` is reserved) · Subscriptions
- Reviews & ratings · Admin panel (barber onboarding, disputes, refunds/credits) · Push/SMS notifications
- Booking change / reschedule (currently cancel + rebook) · Multi-barber shops/staff · Barber photo upload (URL only)
- Barber payouts reporting, Paystack subaccount creation via API (currently paste an `ACCT_…` code)
- Admin web panel (today: CLI `npm run admin`) · Email/phone verification and password reset · Redis-grade rate limiting for the general API

## Plans, session credits and platform rules (migration 004)

- **Slots.** Only *complete* bookings occupy a slot: paid online, pay-on-arrival, or paid with a plan session / credit. An unpaid Pay-now attempt reserves nothing (customer-only, shown "Not confirmed"/"Incomplete"). At payment time the slot is re-checked under the barber row lock; if someone else got it first the booking is not confirmed, the payment is flagged `NEEDS_REFUND` (gateway refund is requested automatically, retried by the sweeper) and the customer is told. A booked slot stays taken until cancelled; customers cancel up to 30 min before (slot reopens at once).
- **Plans.** Barbers create plans in Settings → *Plans & credits* (name, ₦ price, sessions, included services, validity days) within the platform limits. Customers buy through the normal Paystack flow (subaccount + the same fee split as bookings, with the booking fee charged once at purchase). Sessions are spent at booking (`payment_option=PLAN`) and end with the plan.
- **Missed paid session** (no-show, or a paid session that was not cancelled in time): no refund; one **same-barber** credit, expires after `credit_expiry_days` (default 30), not cashable, auto-applied on the next booking with that barber (`payment_option=CREDIT`). In-time cancel of a plan/credit booking returns the session/credit.
- **Admin rules** (`platform_settings`): `npm run admin -- settings`, `npm run admin -- set credit_expiry_days 30 max_plan_price_naira 200000`, `npm run admin -- refunds`; API `GET/PUT /api/admin/settings`.
- **Admin portal** at `/admin.html`: Overview, Barbers (verify / suspend), Bookings (filters), Payments (refund retry / mark refunded), Refund decisions (pending refunds approve/reject + legacy `CREDIT_PENDING`), Alerts (admin notifications + preferences + push), Published numbers (Controls), Plans, Credits, Platform rules and an Audit log. Sign in with the admin key: `ADMIN_KEY` if set, otherwise (or additionally) `CRON_SECRET`. It is typed once and kept only in that tab's `sessionStorage`; the page itself holds no secret. All `/api/admin/*` routes need `Authorization: Bearer <key>`, compare it in constant time, and lock an IP out for 15 minutes after 8 wrong keys. Every action writes an `ADMIN_*` audit row. Migration `005_admin_portal.sql` allows `refund_status = 'REFUNDED'`.
- **Barber review workflow** (migration `006_barber_review.sql`): `barbers.review_status` is `PENDING` (new signup) → `VERIFIED` (approved, the only state that is listed/bookable) · `NEEDS_INFO` (admin message) · `REJECTED` (required reason; the barber can fix things and **resubmit**) · `SUSPENDED` (required reason, reversible with **Reinstate**). Admin actions: Approve, Request info, Reject, Suspend, Reinstate, plus a details sheet (owner, contact, services, hours, Paystack subaccount, bookings, review history). Suspending a shop with upcoming bookings returns 409 with the count until the admin picks *keep* (customers are told, nothing is cancelled) or *cancel* (customers told, paid bookings refunded/credit returned). Barbers see the status and reason in their app and get notifications. A trigger keeps the old `verified` boolean in sync, so the CLI and older queries keep working. Audit actions: `ADMIN_BARBER_VERIFIED/REJECTED/INFO_REQUESTED/SUSPENDED/REINSTATED`, `ADMIN_BOOKING_CANCELLED_SUSPENSION`, `BARBER_RESUBMITTED`. The CLI (`npm run admin`) still works.
- **Admin power tools** (migration `007_admin_power.sql`, `src/admin2.ts`, `public/admin2.js`): *Customers* (search, profile with history, warn / suspend / ban / reinstate with a required reason, message; suspended and banned customers cannot log in or book), *booking control* (cancel with refund / credit / none, reschedule with conflict checks, force-complete, no-show; both sides are notified with the reason), credits (issue / revoke), plans (hide / restore a plan, adjust sessions or expiry, cancel a purchase with optional refund), *Earnings* per barber (gross, fee, netted commission, barber share, off-app volume) and CSV exports (bookings, payments, barbers; admin-only, audited, formula-injection safe), payment dispute flags, *Broadcast* (all customers, all barbers or one user), a *Reports* inbox (customers and barbers file `POST /api/reports` from a booking; admin resolves with a note), *Analytics* (7/30-day bookings and revenue, top barbers, no-show / cancellation / incomplete-payment rates), global search in the top bar, and an audit log with action / text / actor / date filters. *Controls*: maintenance mode (pauses all new bookings and plan purchases; banner for customers), feature switches (plans, credits, pay on arrival), a per-barber booking pause and a per-barber fee override.
- **Off-app commission ledger** (same migration, `src/ledger.ts`): when a barber completes a booking paid **outside the app** (pay on arrival: cash / transfer), TrimSlot accrues `commission_factor` (default **0.5**) x TrimSlot's charge an in-app payment of the same price would carry (`charge_percent` + flat, minimum `charge_min`, or the barber's override) as a debt in `commission_ledger` (one row per booking, `ACCRUED` / `SETTLED` / `WAIVED`). At the barber's **next in-app checkout** (booking payment or plan purchase) the debt is added to Paystack's `transaction_charge` (platform fee + netted debt), capped at the outstanding debt and so the barber keeps at least `min_barber_payout_percent` (default 50%) of that payment. Entries are applied (`SETTLED`) **only once the payment is confirmed**, exactly once per payment, oldest first; the remainder carries forward. A refunded payment gives its netted amount back to the ledger. Two open checkouts never net the same debt. If the debt is settled while a checkout is open, that payment still carries the netted amount (an audit row `LEDGER_OVERNETTED`; nothing is paid back automatically). Admin can settle (paid by transfer), waive or adjust with a reason, set a **max debt** and/or **max age** that switches pay on arrival off for that barber until settled, and send reminders (the sweep also reminds barbers over a limit or owing for 7+ days, at most every 3 days). Barbers see **Platform balance owed** (Profile) with every entry. Off-app accrual happens on the barber's *Complete* (or an admin force-complete with "paid"); customer confirmation in the app is not built. Settings (`/api/admin/settings` or *Controls* / *Platform rules*): `charge_percent`, `charge_flat_naira`, `charge_min_naira`, `commission_factor`, `commission_enabled`, `min_barber_payout_percent`, `ledger_max_debt_naira`, `ledger_max_age_days`, `maintenance_mode`, `maintenance_message`, `feature_plans|credits|pay_on_arrival`.


## UI v3 (profile, barber page first, calmer look)
- Customer tabs: Home · Bookings · Plans · Profile. Barber tabs: Today · Upcoming · Customers · Plans · Profile (`#/plans` manages plans; `#/profile` is the shop/account hub).
- Opening a barber (`#/barber/:id`) shows photo, about, services, **Plans** (buyable), hours and today's queue first; the booking wizard (`#/book/:id`) starts only from the **Book a session** button.
- `PATCH /api/me` edits name/email/phone (unique; one contact must remain). Dark mode lives in Profile.
- Buttons are compact (42px, 14.5px text); only one primary CTA per screen is full width (`.btn.block`). Body reserves space for the floating tab bar + safe area.
- `node scripts/ui-check.mjs` screenshots every screen at 390px and 360px and fails on horizontal overflow, controls under the tab bar, or out-of-range button sizes. `npm run flow` runs the 10-account concurrency flow (`scripts/flow-multi.ts`); `scripts/flow-cleanup.sql` removes its throwaway data.

## Accounts, consent, data rights, retention (migration 011)
- **Sign-up** requires ticking the Terms/Privacy (and, for barbers, the Barber agreement); each acceptance is logged in `consents` (document, version, time, IP/user-agent; the latter nulled on anonymisation). Bump `terms_version` / `privacy_version` / `barber_agreement_version` in admin Controls to make everyone re-accept on next login.
- **Data export / delete** are self-service in Profile (`src/accountData.ts`). Deletion is blocked by upcoming bookings; plans/credits need a forfeit acknowledgement; barbers with blockers become an admin-handled request with an alert.
- **Retention clean-up** runs in the sweeper (`src/retention.ts`); periods are admin settings (`retention_*_days`); admin has a *Run data clean-up now* button.
- **Profile pictures**: customers and barbers can upload a round avatar (`src/avatars.ts`); admin can remove one.
- **Policy numbers** the public legal pages quote (cancel cut-off, payment hold, credit expiry, the liability cap, retention periods and document versions) are edited in admin Controls and read live by the legal pages through `GET /api/public-settings`. That endpoint serves **only** those numbers (a test pins the exact list): plan limits, the plan refund setting, loyalty numbers, fees, the processing-fee split, charges, commission, payout floors, debt limits and the refund auto-approve time are business settings, are never published (a build check in `legal/build.py` refuses such a token on a public page) and are shown only to the barber on their own earnings screen and to admin. Legal files 00, 07 and 08 and the legal pack are internal and are never published as pages. Legal sources are `legal/*.md` with `{{setting}}` tokens; rebuild pages with `legal/build.sh`.
- **Admin alerts** (`src/adminNotify.ts`): in-app list with per-type preferences, quiet hours, optional web push (needs VAPID keys).
- `npm run account-ui` is the browser smoke test for sign-up tick-boxes, avatars, export/delete and the new admin pages.

## Fee model (migration 012)
Paystack's fee is split three ways by admin settings that add to 100% (default thirds): the customer (a labelled **booking fee** added at checkout), the barber (taken from the payout) and TrimSlot. TrimSlot also takes its own **charge** (percent + flat, with a minimum; default 2%, ₦50). **Payout = price − barber's fee share − TrimSlot's charge.** Pay-on-arrival bookings carry only the TrimSlot charge (through the cash commission ledger). The estimate is frozen on each booking; the real fee from Paystack verify is stored too. See `src/fees.ts`, `tests/fees.test.ts`, and the live preview in Admin > Controls.

## Profile picture crop (customers)
- After a customer picks or takes a photo, a small dialog (`public/avatar-crop.js`) shows a round preview: drag (mouse or finger), pinch, mouse wheel, or the labelled **Zoom** slider (keyboard: arrows/Home/End; on the preview itself arrows move and +/- zoom). **Save** is enabled only once the image has loaded; **Cancel**/Esc saves nothing; a failed upload keeps the dialog open with the message.
- The result is a square JPEG, at most 512×512 (never upscaled), compressed on the device to ≤100 KB (server limit 120 KB), uploaded to the existing `PUT /api/me/avatar`. **No server, schema or env change.** All avatars already render round (`.av` in `avatars.css`).
- Crop maths is pure and unit-tested: `public/cropmath.js` + `tests/cropmath.test.ts` (runs in `npm test`). UI test: `npm run avatar-ui` (throw-away Postgres + server on :4103; mouse + real touch/pinch, light + dark contrast, small phones, Cancel/Esc/failed upload/bad file, size + content of the stored picture). Screenshots in `screenshots/avatar-crop/`.
