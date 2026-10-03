import 'dotenv/config';
import fs from 'fs';
import path from 'path';

export const CANCEL_CUTOFF_MIN = 30;
export const SLOT_STEP_MIN = 15;
export const MAX_ADVANCE_DAYS = 30;
export const TIMEZONE = 'Africa/Lagos';
export const MOCK_SECRET = 'mock_secret_key_not_for_real_use';

export const config = {
  get port() { return Number(process.env.PORT || 4100); },
  get isProd() { return process.env.NODE_ENV === 'production'; },
  get logLevel() { return (process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info')).toLowerCase(); },
  /** Express "trust proxy" value. Default: 1 hop in production (Caddy/Fly/Railway edge), 1 in dev (harmless). */
  get trustProxy(): boolean | number | string {
    const v = (process.env.TRUST_PROXY ?? '1').trim();
    if (v === 'true') return true;
    if (v === 'false' || v === '0') return false;
    if (/^\d+$/.test(v)) return Number(v);
    return v; // e.g. "loopback, 10.0.0.0/8"
  },
  /** Extra origins allowed for cross-origin API calls (default none: same-origin only). */
  get corsOrigins(): string[] { return (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean); },
  /** Demo data + demo-login hints. Always on outside production; in production only when SEED_DEMO=true. */
  get demoEnabled() { return this.isProd ? process.env.SEED_DEMO === 'true' : process.env.SEED_DEMO !== 'false'; },
  /** bcryptjs is pure JS: cost 12 ≈ 0.3-0.6 s of CPU per hash on a small serverless CPU. BCRYPT_ROUNDS may lower it (min 10 in production). */
  get bcryptRounds() { const n = Number(process.env.BCRYPT_ROUNDS); return Number.isFinite(n) && n >= (this.isProd ? 10 : 4) && n <= 14 ? Math.floor(n) : this.isProd ? 12 : 10; },
  /** Only the long-running server (Docker/VPS/dev) uses an in-process sweeper; on Vercel use /api/cron/sweep. */
  get sweepEverySeconds() { return Math.max(0, Number(process.env.SWEEP_EVERY_SECONDS ?? 60)); },
  get publicDir() {
    if (process.env.PUBLIC_DIR) return process.env.PUBLIC_DIR;
    const cands = [path.resolve(__dirname, '..', 'public'), path.resolve(__dirname, '..', '..', 'public'), path.resolve(process.cwd(), 'public')];
    return cands.find((c) => fs.existsSync(path.join(c, 'index.html'))) || cands[0];
  },
  get isVercel() { return !!process.env.VERCEL; },
  /** Postgres connection string. In development it falls back to the embedded dev Postgres (see src/devdb.ts). */
  get databaseUrl(): string { return process.env.DATABASE_URL || (this.isProd ? '' : devDatabaseUrl()); },
  get usesEmbeddedDevDb() { return !process.env.DATABASE_URL && !this.isProd; },
  get poolMax() { return Math.max(1, Number(process.env.PG_POOL_MAX || 3)); },
  get cronSecret() { return process.env.CRON_SECRET || ''; },
  /** Optional separate admin key for /admin.html and /api/admin/*. Ignored unless >= 16 chars. CRON_SECRET keeps working as a fallback. */
  get adminKey() { const k = process.env.ADMIN_KEY || ''; return k.length >= 16 ? k : ''; },
  get appBaseUrl() {
    const v = process.env.APP_BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '') || `http://localhost:${this.port}`;
    return v.replace(/\/$/, '');
  },
  get jwtSecret() {
    const s = process.env.JWT_SECRET;
    if (s) return s;
    if (this.isProd) throw new Error('JWT_SECRET must be set in production');
    return DEV_JWT_DEFAULT;
  },
  get paystackKey() { return process.env.PAYSTACK_SECRET_KEY || ''; },
  /** MOCK payments: only ever possible outside production, and only when no Paystack key is set. */
  get mockMode() { return !this.isProd && !process.env.PAYSTACK_SECRET_KEY; },
  get paystackMode(): 'MOCK' | 'TEST' | 'LIVE' {
    const k = this.paystackKey;
    if (this.mockMode) return 'MOCK';
    return k.startsWith('sk_live') ? 'LIVE' : 'TEST';
  },
  // key used to verify webhook signatures
  get webhookSecret() { return this.mockMode ? MOCK_SECRET : this.paystackKey; },
  get platformFeeKobo() { return Math.max(0, Math.round(Number(process.env.PLATFORM_FEE_KOBO || 0))); },
  get platformFeePercent() { return Math.max(0, Number(process.env.PLATFORM_FEE_PERCENT || 0)); },
  /** Online payment needs a barber payout (Paystack subaccount). Always on in real modes; in MOCK dev mode it is opt-in (REQUIRE_PAYOUT=1) so demos keep working. */
  get requirePayout() { return !this.mockMode || process.env.REQUIRE_PAYOUT === '1'; },
  get paymentHoldMin() { return Math.max(1, Number(process.env.PAYMENT_HOLD_MINUTES || 15)); },
};

export const DEV_DB_PORT = Number(process.env.DEV_PG_PORT || 54320);
export function devDatabaseUrl() { return `postgres://postgres:postgres@127.0.0.1:${DEV_DB_PORT}/trimslot`; }

export const DEV_JWT_DEFAULT = 'dev-insecure-secret-change-me';

/**
 * Called once at boot. In production we REFUSE to start with unsafe/missing config
 * (instead of silently degrading to insecure defaults or mock payments).
 * `env` is injectable so this is unit-testable.
 */
export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): { warnings: string[] } {
  const warnings: string[] = [];
  if (env.NODE_ENV !== 'production') return { warnings };
  const errors: string[] = [];
  const jwt = env.JWT_SECRET || '';
  if (!jwt) errors.push('JWT_SECRET is not set (generate one: openssl rand -hex 32)');
  else if (jwt === DEV_JWT_DEFAULT || /change[-_ ]?me|^secret$|^password$/i.test(jwt)) errors.push('JWT_SECRET is a default/placeholder value');
  else if (jwt.length < 32) errors.push('JWT_SECRET must be at least 32 characters');
  const key = env.PAYSTACK_SECRET_KEY || '';
  if (!key) errors.push('PAYSTACK_SECRET_KEY is not set - mock payments are disabled in production');
  else if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(key)) errors.push('PAYSTACK_SECRET_KEY does not look like a Paystack secret key (sk_test_… / sk_live_…)');
  else if (key.startsWith('sk_test_')) warnings.push('Paystack TEST key in production: payments are NOT real. Switch to sk_live_… before charging customers.');
  const db = env.DATABASE_URL || '';
  if (!db) errors.push('DATABASE_URL is not set (Supabase: Project → Connect → Transaction pooler string, port 6543)');
  else if (!/^postgres(ql)?:\/\/[^/]+\/[^/]+/.test(db)) errors.push('DATABASE_URL must look like postgresql://user:password@host:port/database');
  else {
    if (env.VERCEL && /@db\.[a-z0-9]+\.supabase\.co/.test(db)) warnings.push('DATABASE_URL points at the Supabase DIRECT host (IPv6-only, not pooled). On Vercel use the pooler host (…pooler.supabase.com:6543).');
    if (env.VERCEL && /pooler\.supabase\.com:5432/.test(db)) warnings.push('DATABASE_URL uses the pooler in SESSION mode (5432): serverless functions can exhaust connections. Use transaction mode (6543).');
  }
  if (!env.CRON_SECRET) warnings.push('CRON_SECRET is not set: /api/cron/sweep is disabled (expired payment holds are still enforced lazily on every request).');
  else if (env.CRON_SECRET.length < 16) errors.push('CRON_SECRET must be at least 16 characters (generate: openssl rand -hex 24)');
  if (env.ADMIN_KEY && env.ADMIN_KEY.length < 16) warnings.push('ADMIN_KEY is shorter than 16 characters and is IGNORED (admin login falls back to CRON_SECRET). Generate one: openssl rand -hex 24');
  const base = env.APP_BASE_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  if (!/^https:\/\/[^/]+/.test(base)) errors.push('APP_BASE_URL must be set to your public https:// URL (used for Paystack callbacks and CSRF origin checks)');
  if (env.TRIMSLOT_FAKE_NOW) errors.push('TRIMSLOT_FAKE_NOW must not be set in production');
  if (env.SEED_DEMO === 'true') warnings.push('SEED_DEMO=true: demo accounts with PUBLIC passwords exist. Never use this on a real launch.');
  for (const o of (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (o === '*' || !/^https?:\/\/[^/*]+$/.test(o)) errors.push(`CORS_ORIGINS entry "${o}" is invalid (use exact origins like https://app.example.com; wildcards are not allowed)`);
  }
  if (errors.length) throw new Error('Refusing to start in production:\n - ' + errors.join('\n - '));
  return { warnings };
}
