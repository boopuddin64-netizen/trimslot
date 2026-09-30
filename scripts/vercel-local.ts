/* Serverless-like local check of the Vercel entrypoint (NOT a substitute for a real deployment).
   Boots a real embedded Postgres, then loads the function exactly as Vercel would - the compiled bundle from
   `vercel build` (.vercel/output/functions/api/index.func/api/index.js) if present, otherwise api/index.ts - in a bare http server
   with NODE_ENV=production + VERCEL=1, so the production config checks run for real. It also simulates Vercel's body "helpers"
   (which pre-consume the request stream) to prove the Paystack webhook HMAC still sees the raw bytes.
   Run:  npm run vercel:local          (after `npx vercel build --yes` for the built-bundle variant) */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { startEmbeddedPostgres } from '../src/devdb';

let n = 0, bad = 0;
const check = (name: string, ok: boolean, extra?: unknown) => { n++; if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(extra)}`); };

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trimslot-vl-pg-'));
  const pgPort = 54800 + Math.floor(Math.random() * 90);
  const pg = await startEmbeddedPostgres({ dir, port: pgPort, database: 'vl', persistent: false });
  const SK = 'sk_test_localvalidation123';
  Object.assign(process.env, {
    NODE_ENV: 'production', VERCEL: '1', DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${pgPort}/vl`, DATABASE_SSL: 'false',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'), PAYSTACK_SECRET_KEY: SK, CRON_SECRET: crypto.randomBytes(24).toString('hex'),
    APP_BASE_URL: 'https://trimslot-local.vercel.app', PG_POOL_MAX: '2', BCRYPT_ROUNDS: '10',
  });
  const { migrate, getDb, closeDb } = await import('../src/db');
  await migrate(getDb());

  const built = path.resolve('.vercel/output/functions/api/index.func/api/index.js');
  const useBuilt = fs.existsSync(built) && !process.env.USE_SOURCE;
  const mod = useBuilt ? require(built) : await import('../api/index');
  const handler = (mod.default || mod) as (req: http.IncomingMessage, res: http.ServerResponse) => unknown;
  console.log(`Handler under test: ${useBuilt ? 'compiled vercel build output' : 'api/index.ts (source)'}`);

  // Faithful simulation of Vercel's Node "helpers" (see @vercel/node addHelpers/restoreBody): the platform reads the whole body, then REPLAYS the
  // bytes through a PassThrough (req.read/req.on('data') are re-pointed at it) and exposes a lazily JSON-parsed req.body getter.
  // SIMULATE_HELPERS=0 skips it (= NODEJS_HELPERS=0 behaviour).
  const { PassThrough } = await import('stream');
  const server = http.createServer(async (req, res) => {
    if (process.env.SIMULATE_HELPERS !== '0' && req.headers['content-type'] !== undefined) {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const rep = new PassThrough(); const on = rep.on.bind(rep); const orig = req.on.bind(req);
      (req as any).read = rep.read.bind(rep);
      (req as any).on = (req as any).addListener = (name: string, cb: any) => (name === 'data' || name === 'end' ? on(name, cb) : orig(name, cb));
      rep.write(body); rep.end();
      Object.defineProperty(req, 'body', { configurable: true, enumerable: true, get: () => { try { return JSON.parse(body.toString()); } catch { return body.toString(); } }, set(v) { Object.defineProperty(req, 'body', { value: v, writable: true, configurable: true, enumerable: true }); } });
    }
    return handler(req, res);
  }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const j = async (p: string, init?: RequestInit) => { const r = await fetch(base + p, init); let b: any = null; try { b = await r.clone().json(); } catch { /* html */ } return { r, b }; };

  try {
    let { r, b } = await j('/healthz?deep=1');
    check('GET /healthz?deep=1 -> 200, db ok, runtime=vercel', r.status === 200 && b.db === 'ok' && b.runtime === 'vercel', b);
    ({ r, b } = await j('/api/config'));
    check('GET /api/config -> 200, payments not mock', r.status === 200 && b.mock === false, b);
    check('security headers present on API', /default-src 'self'/.test(r.headers.get('content-security-policy') || ''));
    const signup = await j('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://trimslot-local.vercel.app' }, body: JSON.stringify({ role: 'barber', name: 'Local Barber', email: 'lb@example.com', password: 'Password123', shop_name: 'LB', location: 'Yaba' }) });
    check('signup works through the handler (JSON body parsed by Express)', signup.r.status === 201, signup.b);
    const blocked = await j('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    check('cross-origin POST blocked (APP_BASE_URL origin check)', blocked.r.status === 403);
    // Webhook: body with odd whitespace; signature = HMAC-SHA512 over the exact bytes
    const raw = `{ "event" : "charge.success",\n "data":{"reference":"TS-BOOKING-1-abcdef1234"} }`;
    const sig = crypto.createHmac('sha512', SK).update(raw).digest('hex');
    const w1 = await j('/api/payments/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': sig }, body: raw });
    check('webhook with VALID signature over raw bytes passes HMAC (reaches business logic: unknown_reference)', w1.r.status === 200 && w1.b.result === 'unknown_reference', w1.b);
    const w2 = await j('/api/payments/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': '0'.repeat(128) }, body: raw });
    check('webhook with bad signature -> 401', w2.r.status === 401, w2.b);
    const w3 = await j('/api/payments/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': sig }, body: raw.replace('charge', 'chargX') });
    check('webhook with tampered body -> 401', w3.r.status === 401, w3.b);
    const c0 = await j('/api/cron/sweep');
    check('cron without Bearer -> 401', c0.r.status === 401);
    const c1 = await j('/api/cron/sweep', { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
    check('cron with Bearer CRON_SECRET -> 200', c1.r.status === 200 && c1.b.ok === true, c1.b);
    const h = await j('/api/nope');
    check('unknown API route -> 404 JSON', h.r.status === 404, h.b);
    const html = await fetch(base + '/');
    check('static files are NOT served by the function on Vercel (CDN serves /public)', html.status === 404);
    // misconfiguration: refuse to run
  } finally {
    server.close(); await closeDb(); await pg.stop(); fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${n - bad}/${n} checks passed`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
