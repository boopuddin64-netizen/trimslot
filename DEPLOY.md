# Deploying TrimSlot

**Primary path: Vercel (serverless, free `*.vercel.app`) + Supabase Postgres (free).** The Docker/VPS/Fly/Railway material further down is kept as a
[LEGACY / alternative path](#legacy--alternative-docker--vps--fly--railway) (it still works, against any Postgres).

Contents: [Architecture](#how-it-runs-on-vercel) · [1. Supabase](#1-create-the-supabase-project-and-get-the-pooled-connection-string) · [2. Migrate](#2-run-the-migrations) ·
[3. Env vars](#3-vercel-environment-variables) · [4. Deploy](#4-deploy-to-vercel) · [5. Paystack webhook](#5-set-the-paystack-webhook) · [6. Verify barbers](#6-verify-barbers-admin-script) ·
[7. cron-job.org sweeper](#7-minute-level-sweeper-with-cron-joborg) · [8. Raw body / HMAC](#8-why-nodejs_helpers0-and-the-raw-body) · [9. Custom domain](#9-custom-domain-optional) ·
[Test → Live](#switching-from-paystack-test-to-live) · [Backups](#backups--restore) · [Free-tier limits & risks](#free-tier-limits--risks) · [Checklist](#pre-launch-checklist) · [Legacy](#legacy--alternative-docker--vps--fly--railway)

> **Production refuses to serve** unless `DATABASE_URL`, `JWT_SECRET` (≥32 random chars), `PAYSTACK_SECRET_KEY` (`sk_test_…`/`sk_live_…`) and an `https://` `APP_BASE_URL` (Vercel also accepts its own `VERCEL_PROJECT_PRODUCTION_URL`) are set;
> every request then returns `500 MISCONFIGURED` and the Vercel function log says what is missing. There is **no mock payment mode and no demo data** in production.

## How it runs on Vercel
- `public/` (HTML/JS/CSS) is served by Vercel's CDN. `vercel.json` rewrites `/api/*` and `/healthz` to **one serverless function**, `api/index.ts`, which wraps the same Express app used everywhere else.
- State lives **only in Postgres** (no local disk). Each function instance holds a tiny `pg` pool (default 3 connections, `PG_POOL_MAX`) through **Supabase's transaction pooler (port 6543)**, so many instances don't exhaust Postgres connections.
- **Bookings are concurrency-safe in the database**: booking creation runs in a transaction that locks the barber row (`SELECT … FOR UPDATE`); a partial unique index and a `btree_gist` exclusion constraint are the backstop; payment confirmation claims the `payments` row and locks the booking row, so a webhook + browser callback race confirms exactly once.
- **Unpaid tries don't depend on cron**: an unpaid pay-now attempt reserves **no slot** (it is ignored when computing availability, and the first confirmed payment wins). After `PAYMENT_HOLD_MINUTES` it is closed lazily (at booking time and on every authenticated request of its owner) or by the sweep. A payment that arrives after it closed confirms the booking if the time is still free; otherwise it is flagged `NEEDS_REFUND` and refunded automatically. The cron sweeper is housekeeping (tidy statuses/notifications, auto-approve due refunds, reminders, retention clean-up). **On Vercel's free plan it runs once a day** (`0 3 * * *`); **the external one-minute timer (section 7) is REQUIRED before launch**: refund auto-approval, the 48-hour payment re-check, reminders and tidy-up all rely on it (the Docker/VPS server runs the hold close and the payment re-check by itself every `SWEEP_EVERY_SECONDS`). The sweep also asks Paystack about unpaid checkouts of the last 48 hours (a missed webhook), and a try is checked with Paystack before it is closed, so these need the live `PAYSTACK_SECRET_KEY`. Payments that are not in NGN or not the right amount are not confirmed and raise the `PAYMENT_MISMATCH` admin alert.
- All timestamps are `timestamptz` (UTC on disk); the calendar date and minute-of-day used for slots are derived in **Africa/Lagos** (generated columns use `AT TIME ZONE 'Africa/Lagos'`).
- **Migration `011_refund_approval_consent_retention_avatars.sql`** must be applied by hand BEFORE deploying this code: `npm run migrate` against production (additive; rewrites no rows; it is NOT run automatically on Vercel). It adds refund approval, consent log, admin alerts, avatars, retention settings.
- **Cron heartbeat (migration 013)**: every authorised hit on `/api/cron/sweep` stamps `platform_settings.cron_last_run_at` (and `cron_last_ok_at` / `cron_last_error`). Admin → Controls shows "Cron last ran X ago" and turns amber when it is older than 3 minutes or has never run. Apply `013_cron_heartbeat.sql` before relying on it (the endpoint works without it).
- **Cron frequency matters now**: refund auto-approval (`refund_auto_approve_hours`), the retention clean-up and admin push alerts run inside `/api/cron/sweep`. Use the minute-level cron-job.org job (section 7); the daily Vercel cron would only act once a day.
- Background timers don't exist on serverless: the old in-process sweeper/backup timers are replaced by `GET|POST /api/cron/sweep` (`Authorization: Bearer $CRON_SECRET`) and by Supabase/`pg_dump` backups.

## 1. Create the Supabase project and get the pooled connection string
1. supabase.com → **New project** (free plan). Choose the region **closest to your Vercel functions** (Vercel default function region is `iad1`/Washington; for Nigerian users a Vercel region such as `fra1`/`cdg1`/`lhr1` and a Supabase region in the same area — e.g. Frankfurt/Paris/London — is usually better; set the function region in Vercel → Settings → Functions). Save the **database password** (URL-encode special characters like `@`, `:`, `/`, `#` when placing it in a URL — or choose an alphanumeric password).
2. Dashboard → **Connect** (top bar) → **Transaction pooler** → copy the URI. It looks like:
   ```
   postgresql://postgres.<project-ref>:<YOUR-PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```
   - Use the **transaction pooler (6543)** for Vercel. Do **not** use the direct `db.<ref>.supabase.co:5432` host on Vercel (IPv6-only on the free tier, not pooled) — the app logs a warning if you do; and prefer 6543 over the session pooler (5432) for serverless.
   - Transaction mode doesn't support session state or named prepared statements; the app uses neither (node-postgres only uses unnamed statements, and locks/transactions are held within a single transaction). TLS is on for remote hosts. Supabase's pooler certificate chain isn't in Node's default trust store, so by default the connection is **encrypted but the server certificate is not verified**; to verify it, download the CA from *Project Settings → Database → SSL Configuration* and set `DATABASE_SSL_CA` (PEM text) in Vercel.
3. Keep this string secret — it is a full-access database credential. Never commit it.

## 2. Run the migrations
Migrations are plain SQL in `migrations/*.sql`, applied in order, once each, recorded in `schema_migrations`, protected by an advisory lock (safe to run twice).
From your own machine (Node 18+; `npm install` first):
```bash
export DATABASE_URL='postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres'
npm run migrate            # -> Applied: 001_init.sql, 002_no_overlap_constraint.sql
```
- The transaction pooler works for migrations here. If you'd rather use the **session pooler** or the **direct** connection (e.g. from an IPv6-capable network), use that string for this one command only.
- `002` needs the `btree_gist` extension (available on Supabase; created by the migration). On a Postgres that forbids it the migration logs a NOTICE and skips; the unique slot index still prevents *same-start* double bookings, and the application-level checks (under a row lock) prevent overlaps.
- **Every schema change ships as a new numbered file**; re-run `npm run migrate` against production *before* deploying code that needs it. Migrations are forward-only: back up first.
- Do **not** set `AUTO_MIGRATE` on Vercel (cold starts must not race schema changes).

## 3. Vercel environment variables
Vercel → Project → Settings → **Environment Variables** (apply to *Production* and *Preview*; secrets marked "Sensitive"):

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | Supabase **transaction pooler** URI (6543) | required |
| `JWT_SECRET` | `openssl rand -hex 32` | required, ≥32 chars; changing it logs everyone out |
| `APP_BASE_URL` | `https://<project>.vercel.app` | required, https, no trailing slash. Paystack callback + CSRF origin check use it. Must equal the URL customers use (change it when you add a custom domain) |
| `PAYSTACK_SECRET_KEY` | `sk_test_…` first, `sk_live_…` later | required; also verifies webhook signatures |
| `ADMIN_KEY` (optional) | `openssl rand -hex 24` | ≥16 chars; login key for `/admin.html` and `/api/admin/*`. `CRON_SECRET` also works there |
| `CRON_SECRET` | `openssl rand -hex 24` | ≥16 chars; secures `/api/cron/sweep`. Vercel Cron sends it automatically as `Authorization: Bearer …` |
| `NODEJS_HELPERS` | `0` | keeps the raw request body for Paystack HMAC (§8). Also set in `vercel.json` |
| `CORS_ORIGINS` | *(empty)* | Default = same-origin only, which is what you want when the frontend and API share the `*.vercel.app` domain. Only set exact origins (`https://app.example.com`) if a *different* site calls the API. No wildcards |
| `EMAIL_VERIFICATION_REQUIRED` | `false` (default, also when unset) | **Email verification is PAUSED by default.** When off: no email check is required anywhere (barbers are bookable without a verified email, first-time customers can book, the emergency action works), the verify-email banner/screen and the sign-up redirect to the code screen are hidden, and no email is ever sent (`/api/auth/email/send` and `/verify` answer 409 `EMAIL_VERIFICATION_OFF`). The OTP code and its migration stay in place. To switch it on later set it to `true` (also `1`/`yes`/`on`), set `RESEND_API_KEY` + `MAIL_FROM` first, and redeploy; no data change is needed |
| `RESEND_API_KEY`, `MAIL_FROM` | Resend dashboard (API key = Sensitive); `MAIL_FROM` like `TrimSlot <no-reply@your-domain>` on a verified domain | sends the 6-digit email codes (sign-up, first booking, emergency help). **Only needed when `EMAIL_VERIFICATION_REQUIRED=true`** (not needed while verification is paused). Without a key, production refuses to send (users see "We cannot send emails right now") and the app logs a start-up warning. Outside production the code is the fixed `123456` and mail is only logged |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | `npx web-push generate-vapid-keys`; subject = your https URL or `mailto:` | enables Web Push. Private key = Sensitive. Optional: without them the app still works with in-app notifications |
| `PG_POOL_MAX` | `3` (default) | keep 1–3 per instance |
| `DATABASE_SSL_CA` | *(optional)* PEM | to verify Supabase's certificate |
| `PAYMENT_HOLD_MINUTES`, `LOG_LEVEL`, `BCRYPT_ROUNDS` | optional | see `.env.example` |
| `SEED_DEMO`, `TRIMSLOT_FAKE_NOW` | **never set** | the second is refused in production |

`TRUST_PROXY` needs no setting on Vercel. Generate secrets locally and paste them into Vercel; don't reuse them elsewhere. Env var changes only take effect on the **next deployment** (Redeploy).

CLI equivalent: `vercel env add DATABASE_URL production` (repeat per variable).

> Migration `008_push_and_smart.sql` adds push subscriptions, the smart-feature tables, feature toggles and the admin indexes (trigram search needs the `pg_trgm` extension, which Supabase allows; if unavailable it is skipped and search still works, just slower). Apply it before deploying.

> Migration `009_payouts_pin_softdelete.sql` adds `payments.paid_kobo/gateway_fee_kobo`, the barber payout columns, soft-delete columns (+ `DELETED` account status) and the `admin_pin` table. Apply it **before** deploying. After deploying: each barber sets up payouts in the app (Profile → Payouts) before customers can pay them online, and you set your admin PIN once in the admin portal (Settings → Admin PIN). Payments stuck as `INITIATED` from before the fee fix can be recovered with *Re-verify with Paystack* in the payment sheet.

## 4. Deploy to Vercel
**Option A — GitHub import (recommended):** push this repo to *your* GitHub → vercel.com → **Add New → Project → Import** the repo. Framework Preset: **Other**; leave Build/Output/Install commands at defaults (`vercel.json` supplies them; there is no build step — Vercel compiles `api/index.ts` itself). Add the env vars from §3 *before* the first deploy (or redeploy afterwards). Every push to the main branch redeploys.
**Option B — CLI:**
```bash
npm i -g vercel
vercel login
vercel link                       # create/link the project
vercel env add DATABASE_URL production      # …and the others from §3
vercel --prod
```
Then check: `curl https://<project>.vercel.app/healthz?deep=1` → `{"status":"ok","db":"ok","payments":"TEST","runtime":"vercel"}`, open the site, and sign up.
- Node version: `engines` says `>=18`, so Vercel picks its current default Node major; the code runs on Node 18/20/22/24 (tested locally on 20; `vercel build` bundled it for Node 24).
- Function timeout is set to 30 s (`vercel.json`); Hobby's limits apply (see below).

## 5. Set the Paystack webhook
Paystack Dashboard → **Settings → API Keys & Webhooks** → **Test Webhook URL** (and later **Live Webhook URL**):
```
https://<project>.vercel.app/api/payments/webhook
```
Full Paystack instructions (subaccounts, splits) are in [Paystack setup](#paystack-setup). Do a test-card payment and confirm the webhook log shows **200** — this is the check that the raw-body signature verification works on the real platform.

## 6. Verify barbers (admin portal, or script)

Open `https://<your-domain>/admin.html` and enter the admin key (the `ADMIN_KEY` env var if you set one, else `CRON_SECRET`; it is kept only in that browser tab's sessionStorage). **Barbers** → filter tabs (Pending / Needs info / Verified / Suspended / Rejected) → *Details*, *Approve*, *Request info*, *Reject* (reason), *Suspend* (reason; warns about upcoming bookings) and *Reinstate*. Migrations `006_barber_review.sql` and `007_admin_power.sql` must be applied before deploying this version (007 adds customer restrictions, booking pause, fee override, platform switches, the commission ledger, broadcasts and reports). The same page handles refunds (*Payments*, *Refund decisions*), plans, credits and platform rules, and keeps an audit log. Set `ADMIN_KEY` (Production, `openssl rand -hex 24`, ≥16 chars) to use a key you can see/choose; `CRON_SECRET` keeps working as a fallback and is the only key the cron endpoint accepts. Env var changes on Vercel only apply to new deployments, so redeploy after adding `ADMIN_KEY`. Migration `005_admin_portal.sql` must be applied. The CLI below still works.
New barbers are hidden and unbookable until verified. Run from your machine, pointing at the same database:
```bash
export DATABASE_URL='postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres'
npm run admin -- list-barbers --pending
npm run admin -- verify-barber mike@example.com      # email or phone
npm run admin -- unverify-barber mike@example.com    # hides the shop again (existing bookings kept)
```
Or inline: `DATABASE_URL='…' npm run admin -- verify-barber <email>`. (Or in Supabase's SQL editor: `UPDATE barbers SET verified=TRUE, verified_at=now() WHERE id=…;` — the script also writes an audit row and notifies the barber.)

## 7. Minute-level sweeper with cron-job.org
**Why**: Vercel **Hobby** crons may run **at most once per day** (a more frequent expression fails the deploy). `vercel.json` therefore contains only a daily housekeeping cron (`0 3 * * *` → `/api/cron/sweep`; Vercel sends `Authorization: Bearer $CRON_SECRET` automatically).
Because timed-out tries are enforced lazily, **correctness does not depend on this job**; the minute-level sweep just makes statuses/notifications tidy quickly and approves due refunds on time (the daily Vercel run does it up to a day late) (e.g. an abandoned pay-now booking flips to CANCELLED within a minute even if nobody browses that barber). To run it every minute for free:
1. Create a free account at **cron-job.org** → *Create cronjob*.
2. **URL**: `https://<project>.vercel.app/api/cron/sweep` · **Schedule**: every 1 minute.
3. **Advanced → Request method**: `GET` (or POST). **Headers**: add `Authorization` = `Bearer <your CRON_SECRET>`.
4. Save, enable *notify on failure*, and confirm the job history shows **200** and a body like `{"ok":true,"holds_released":0,…}`.
- `401` = wrong/missing header; `503` = `CRON_SECRET` isn't set on Vercel (or you didn't redeploy after setting it). The secret is only accepted in the `Authorization` header, never in the URL.
- On a Pro plan you can instead edit the `crons` schedule in `vercel.json` to `* * * * *`.
- GitHub Actions scheduled workflows or any uptime monitor that can send a header work too.

## 8. Why `NODEJS_HELPERS=0` and the raw body
Paystack signs the **exact bytes** of the webhook body. Vercel's Node runtime normally adds "helpers" that read and re-serialise the body (`req.body`), which can break HMAC verification or make Express's own body parser fail. TrimSlot defends in two layers: (1) `NODEJS_HELPERS=0` (in `vercel.json` `build.env` **and** as a project env var) turns the helpers off; (2) `api/index.ts` reads the body stream itself, keeps the raw bytes for the webhook route, and hands JSON routes their parsed body. Both were exercised locally with a simulation of the helpers (`npm run vercel:local`), but only your first real Paystack test webhook proves it on Vercel itself.

## 9. Custom domain (optional)
Vercel → Settings → Domains → add the domain + DNS records. Then update `APP_BASE_URL`, **redeploy**, update the Paystack webhook URLs, and the cron-job.org URL. (`*.vercel.app` is fine for a pilot.)

---

## Paystack setup

### 1. Webhook URL (do this for BOTH test and live modes — they are configured separately)
Paystack Dashboard → **Settings → API Keys & Webhooks** → set **Test Webhook URL** (and later **Live Webhook URL**) to:

```
https://<project>.vercel.app/api/payments/webhook
```
- This is the real path in this app (`POST /api/payments/webhook`). It verifies the `x-paystack-signature` HMAC-SHA512 of the **raw body bytes** (kept intact on Vercel, see §8) with your secret key, re-verifies the transaction with Paystack, and is idempotent.
- The browser return URL (`callback_url`) is sent per-transaction as `https://<your-domain>/api/payments/callback` automatically — you don't need to set it in the dashboard.
- Check delivery in the dashboard's webhook log; every received event (valid or not) is also stored in the `payment_events` table.

### 2. Barber subaccount (split payments — barber gets paid directly)
Each barber needs a Paystack **subaccount code** (`ACCT_xxxxxxxx`), created under **your** Paystack account:
- **Dashboard**: *Settings → Subaccounts → Create*; **or**
- **API** (test or live key, matching the mode you're in):
  ```bash
  curl https://api.paystack.co/subaccount \
    -H "Authorization: Bearer $PAYSTACK_SECRET_KEY" -H "Content-Type: application/json" \
    -d '{"business_name":"Mikes Barbershop","settlement_bank":"058","account_number":"0123456789","percentage_charge":0}' 
  # bank codes: GET https://api.paystack.co/bank?country=nigeria   → response.data.subaccount_code = "ACCT_..."
  ```
- **Store it**: barber logs in → **Settings → Paystack subaccount code** → paste `ACCT_…` → Save (or `UPDATE barbers SET paystack_subaccount='ACCT_...' WHERE id=…`).
- **How the split works in this app**: the customer is charged price + booking fee. `subaccount` is sent with `bearer: 'account'` and a `transaction_charge` equal to (total − barber payout), so the barber's subaccount settles exactly the payout (price − barber's fee share − TrimSlot charge) and the main account keeps the rest and bears Paystack's real fee. The fee split, Paystack rate, and TrimSlot charge are admin settings (Controls > Published numbers). The real fee from the verify call is stored for reporting.
- A barber **without** a subaccount **cannot take online payments**: with a real Paystack key the app refuses pay-now and plan purchases for them (`409 PAYOUT_NOT_SETUP`), so customers can only choose pay on arrival until the barber sets up a payout account. (Only MOCK mode lets demos skip this.)
- **Test-mode subaccounts don't exist in live mode** — you must create them again in live mode and update each barber's code.

## Switching from Paystack test to live
1. Complete Paystack **business activation / KYC** (required to go live; can take days).
2. Dashboard → toggle **Live mode** → copy the **live secret key** (`sk_live_…`).
3. Set the **Live Webhook URL** (same URL as above).
4. Re-create every barber's subaccount in live mode and update it in each barber's Settings.
5. Vercel → Project → Settings → Environment Variables → edit `PAYSTACK_SECRET_KEY` to `sk_live_…` → **Redeploy** (env changes only apply to new deployments). The startup warning about a test key disappears (`/healthz` reports `"payments":"LIVE"`). Docker/VPS: edit `.env` and `docker compose up -d`.
6. Do one real small payment (e.g. a ₦100 service) end-to-end with your own card, confirm the booking flips to CONFIRMED/PAID, the webhook log shows 200, and settlement reaches the barber's bank account. Then refund/void your test as per your policy.
7. Keep test keys out of production afterwards; bookings created in test mode do not carry over meaningfully into live.

---

## Onboarding the first barber
1. The barber signs up on the site (choose **"I'm a barber"**). Their shop is **unverified**: not listed to customers and not bookable; they see an "awaiting verification" banner but can set up services, hours and the Paystack subaccount.
2. You review them (call them, check the shop), then run `npm run admin -- verify-barber <email>` with `DATABASE_URL` set (§6). The barber gets an in-app notification; the shop appears in customer browse immediately.

## Backups & restore
Nothing is stored on Vercel; **the Supabase database is the only copy of your data.**
- **Supabase free plan: no downloadable/managed backups or point-in-time recovery** (paid plans add daily backups/PITR — check the current plan page). So take your own logical dumps, and copy them off-platform (encrypted — they contain customer data):
  ```bash
  # use the DIRECT or SESSION-pooler string (port 5432) for pg_dump, not the 6543 transaction pooler
  pg_dump "postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres" \
      --no-owner --format=custom --file "trimslot-$(date +%F).dump"
  ```
  Schedule it daily from any machine you control (cron/launchd/Task Scheduler) or a GitHub Actions scheduled workflow (store the connection string as a repo *secret*; upload the dump as an encrypted artifact/private storage). `pg_dump` version must be ≥ the server's major version (Supabase currently runs PostgreSQL 15–17).
- **Restore** into an empty database (a new Supabase project, or any Postgres): `pg_restore --no-owner --dbname "<new connection string>" trimslot-YYYY-MM-DD.dump`, then point `DATABASE_URL` at it and redeploy. **Rehearse a restore before launch.**
- Supabase also pauses free projects after a period of inactivity (see limits) — a paused project is restorable from the dashboard, but the site is down until you do.

## Free-tier limits & risks
- **Vercel Hobby is for non-commercial, personal use.** Vercel's terms restrict commercial use of Hobby; a business taking payments should be on Pro. Fine for a demo/pilot; decide before you launch for real.
- **Hobby cron = once/day** (hence cron-job.org above). Hobby functions: limited duration/invocations/bandwidth — check Vercel's current limits.
- **Supabase free**: 500 MB database, shared CPU, **auto-pause after ~1 week of inactivity**, no managed backups, limited connections (that's why the pooler is mandatory). Region choice affects latency from Lagos.
- **Cold starts** add ~0.5–1.5 s to the first request after idle; **bcrypt cost 12** costs ~0.3 s CPU per login/signup on a fast CPU (more on a small serverless CPU). `BCRYPT_ROUNDS=10` (minimum in production) roughly triples the speed.
- **Rate limiting**: sign-up, login (per IP and per account: 8 failures/15 min) and payment-initiation limits are stored in Postgres, so they are shared by all instances. The general `/api` flood brake and the webhook limiter are **in-memory per instance** (best effort: they reset on cold start and don't add across instances). If the limiter's DB query fails it fails open (logged).
- **No disk**: nothing writes files; barber photos are URL-only.
- **Live Paystack calls were not exercised** in development (only the mock gateway) — test with `sk_test_…` first.

## Pre-launch checklist

**Technical**
- [ ] `JWT_SECRET` random 64 hex; no `.env` in git; `APP_BASE_URL` is the final https domain (and the Paystack webhook URL uses the same domain).
- [ ] HTTPS works, `/healthz?deep=1` returns `{"status":"ok","db":"ok"}`, HSTS header present (`curl -I`).
- [ ] Paystack **live** key set; live webhook URL saved; one real payment tested end to end (see above); webhook events visible in dashboard as 200.
- [ ] Every barber has a **live** subaccount code saved, or you have agreed to pay them out manually.
- [ ] Backups: Supabase backup plan understood (free tier has **no** downloadable backups/PITR) **and** the `pg_dump` routine below is scheduled and copied off-platform; a restore has been rehearsed.
- [ ] **Cron-job.org sweeper** created and its last runs show HTTP 200 (§7). `CRON_SECRET` set.
- [ ] `NODEJS_HELPERS=0` is set as a Vercel env var and a **real** Paystack test payment was confirmed through the webhook (checks the raw-body HMAC on the real platform).
- [ ] Supabase project is **not** going to auto-pause (free projects pause after ~1 week of inactivity: an uptime monitor pinging `/healthz?deep=1` every 5 min prevents it — or use a paid plan).
- [ ] You have read Vercel's Hobby terms: **Hobby is for non-commercial / personal use**; taking payments for a real business requires the Pro plan (see Risks).
- [ ] Uptime monitor on `https://<domain>/healthz` (UptimeRobot/Better Stack) alerting to your phone.
- [ ] Demo data absent (`/api/config` → `"demo":false`, no demo logins work).
- [ ] Legal pages `/privacy.html` and `/terms.html` replaced with lawyer-reviewed text (currently clearly-marked templates with `[BRACKETS]`).

**Business / legal — needs the owner and Nigerian counsel (not legal advice)**
- [ ] **Refund / credit policy**: a paid booking cancelled in time, or a barber-side "not served", becomes a **refund pending**: TrimSlot staff approve or reject it (rejecting needs a reason) in the admin portal (*Refund decisions*), and it is **auto-approved** after `refund_auto_approve_hours` by the next sweep (so run the one-minute timer, section 7, or approval waits for the daily run). Payments that are duplicate, late (time no longer free) or for a time someone else booked first are flagged `NEEDS_REFUND` and refunded automatically; a late payment for a time that is still free confirms the booking. Old `CREDIT_PENDING` rows from before this rule are decided by TrimSlot staff one by one. The app does not take refunds or chargebacks back from a barber's balance. Before taking real money, decide and publish: refund timeline, rejection grounds, how customers complain; have counsel review against the **Federal Competition and Consumer Protection Act 2018 (FCCPC)** and Paystack's merchant/dispute terms (see `legal/00-open-questions-for-lawyer.md`). Also decide the prepaid **no-show** rule. If the Paystack refund API fails, refund from the Paystack dashboard and press *Mark refunded*.
- [ ] **Privacy policy & NDPR/NDPA**: the operative law is now the **Nigeria Data Protection Act 2023** (NDPR's successor) with the NDPC's **GAID 2025** implementing directive. Have counsel confirm: your role as *data controller*; lawful bases; whether you must **register with the NDPC** as a data controller/processor of major importance (depends on volume/category — designation is by the Commission); appoint/name a **DPO** (or contact); a compliance audit timeline (GAID: within 15 months of starting business and yearly after); **72-hour breach notification** to the NDPC; cross-border transfer safeguards (your host may be outside Nigeria, and Paystack is a processor/recipient); retention periods; data-subject request handling (access/correction/deletion — self-service **Download my data** and **Delete my account** exist in Profile; define the process and SLA for requests that arrive by e-mail and for barber deletion requests); consent wording for any marketing (none is sent today).
- [ ] **Terms of service**: marketplace role (barbers are independent), liability limits lawful under consumer law, dispute forum, support contact.
- [ ] Register the business / obtain any licences you need; make sure Paystack's business verification matches your legal entity.
- [ ] Barber agreement: settlement schedule, charge, fee split and booking fee (admin settings), how the Paystack fee is split (customer booking fee / barber / TrimSlot), refunds and chargebacks of split payments (nothing is taken back from a barber's balance by the app), no-show/late rules.
- [ ] Support channel (WhatsApp/phone/email) published; an owner process for verifying barbers (`admin verify-barber`).

**Known MVP limits to accept for a pilot**: in-app notifications only (no push/SMS/email); no password reset or email/phone verification; no self-service account deletion; admin portal uses one shared key (no per-admin accounts or 2FA); the general-API and webhook rate limits are in-memory per serverless instance (sign-up, login and payment limits are DB-backed and shared).

---

## Legacy / alternative: Docker / VPS / Fly / Railway
> **LEGACY path.** Kept working because the app is a normal Node server too (`npm start` / `node dist/src/index.js`), but it is no longer the primary target and gets less testing than the Vercel path (verified by running the compiled build against a local Postgres; the Dockerfile itself could not be built on the dev box — no Docker).
> Differences from Vercel: it is a **long-running process**, so it runs the hold sweeper in-process (`SWEEP_EVERY_SECONDS`, default 60), serves `public/` itself, applies migrations at boot when `AUTO_MIGRATE=true`, and needs a **Postgres** (`DATABASE_URL`). The SQLite volume, `DB_PATH` and `BACKUP_*` settings are **gone**. Existing SQLite data is **not** migrated automatically (there was only demo data).

### A. VPS with Docker + Caddy (HTTPS) — includes its own Postgres 17
```bash
git clone <your-repo> trimslot && cd trimslot
cp .env.example .env && chmod 600 .env
#   JWT_SECRET=$(openssl rand -hex 32)   APP_BASE_URL=https://book.example.com   DOMAIN=book.example.com
#   PAYSTACK_SECRET_KEY=sk_test_...      POSTGRES_PASSWORD=$(openssl rand -hex 24)
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d --build
curl https://book.example.com/healthz?deep=1
docker compose exec app node dist/scripts/admin.js verify-barber <email>
```
- `docker-compose.yml`: `db` (postgres:17-alpine, named volume `trimslot-pg`) + `app` (read-only root FS, non-root, `AUTO_MIGRATE=true`, in-process sweeper). Caddy (`docker-compose.caddy.yml`, `Caddyfile`) terminates TLS. `TRUST_PROXY=1` matches the single Caddy hop.
- To use Supabase (or another managed Postgres) instead of the bundled `db`, remove the `db` service/`depends_on`, and set `DATABASE_URL` (+ drop `DATABASE_SSL: "false"`).
- **Backups**: `docker compose exec -T db pg_dump -U trimslot -Fc trimslot > trimslot-$(date +%F).dump`, then copy off the server (cron + rsync/rclone). Restore: `docker compose exec -T db pg_restore -U trimslot -d trimslot --clean --if-exists < file.dump`.
- Updates: `git pull && docker compose … up -d --build` (migrations run at boot; back up first).
- Firewall/DNS/VPS prep: ports 80/443 open, `A` record → server IP; any small VPS (1 vCPU/1 GB) is plenty.

### B. Fly.io (`fly.toml`, legacy)
The app is stateless now (no volume). Provide a Postgres (Supabase pooler or Fly Postgres) via `fly secrets set DATABASE_URL=…`, plus `JWT_SECRET`, `PAYSTACK_SECRET_KEY`, `APP_BASE_URL`. `fly deploy`. The in-process sweeper runs on the machine (`auto_stop_machines="off"`). Region note: `jnb` is Fly's only African region; European regions are often better peered from Nigeria — test with real phones. Admin CLI: `fly ssh console -C "node /app/dist/scripts/admin.js verify-barber <email>"`.

### B2. Railway (`railway.json`, legacy)
Deploy from GitHub (Dockerfile build), add a Railway Postgres (or use Supabase) and set `DATABASE_URL`, `AUTO_MIGRATE=true`, `NODE_ENV=production`, `JWT_SECRET`, `PAYSTACK_SECRET_KEY`, `APP_BASE_URL`, `TRUST_PROXY=1`. No volume is needed. Admin CLI via `railway ssh`.

### Environment variables (all deployments)
See `.env.example` (every variable is documented there). Required in production: `DATABASE_URL`, `JWT_SECRET`, `PAYSTACK_SECRET_KEY`, `APP_BASE_URL`. Recommended: `CRON_SECRET`. Long-running server only: `SWEEP_EVERY_SECONDS`, `AUTO_MIGRATE`, `TRUST_PROXY`, `PORT`, `DOMAIN`, `HOST_PORT`, `POSTGRES_PASSWORD`.

## Admin power tools and the off-app commission ledger
- Apply `migrations/007_admin_power.sql` (after 006) before deploying; then add its name to `schema_migrations` if you applied it by hand.
- Defaults: commission factor 0.5, commission on, barber keeps at least 50% of any payment the debt is netted against, no debt/age limit. Change them under *Controls*. TrimSlot's charge (*Published numbers*: percent, flat, minimum) is the base the commission is computed from; set it, or the commission is 0.
- Netting uses Paystack `transaction_charge` on the initialize call, which needs a **subaccount on the barber**. A barber without a subaccount cannot take online payments at all (see *Paystack setup* below), so there is nothing to net against; their debt carries forward until they set up a payout account or staff settle it.
- The cron sweep (`/api/cron/sweep`) also sends ledger reminders.
- Maintenance mode only pauses *new* bookings and plan purchases; it does not block admin tools, barbers' tools or payment confirmation.
