/* Boots a throw-away PostgreSQL (embedded, temp dir) + the app on a free local port (mock payments, demo data, NEVER production),
   runs one script against it (BASE is set for the script), then tears everything down.
   Usage: tsx scripts/with-server.ts <script.mjs|.ts> [args…]     env: UI_PORT (default: any free port), FAKE_NOW=off to use the real clock
   Used by: npm run speed (timing table) and npm run offline-ui (service worker + offline cache browser test). */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import { startEmbeddedPostgres } from '../src/devdb';

const freePort = () => new Promise<number>((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const CRON = 'e2e-cron-secret-0123456789abcdef';
async function waitHealthy(base: string) {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/healthz?deep=1')).ok) return; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('server did not become healthy');
}
async function main() {
  const script = process.argv[2];
  if (!script) throw new Error('usage: tsx scripts/with-server.ts <script> [args]');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trimslot-ws-pg-'));
  const PORT = process.env.UI_PORT ? Number(process.env.UI_PORT) : await freePort();
  const pgPort = await freePort();
  const pg = await startEmbeddedPostgres({ dir, port: pgPort, database: 'trimslot_ws', persistent: false });
  const base = `http://localhost:${PORT}`;
  const env: any = { ...process.env, PORT: String(PORT), DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${pgPort}/trimslot_ws`, CRON_SECRET: CRON, PAYSTACK_SECRET_KEY: '', NODE_ENV: 'development', BASE: base, SWEEP_EVERY_SECONDS: '0', ADMIN_KEY: process.env.ADMIN_KEY || 'local-admin-key-xyz' };
  if (process.env.FAKE_NOW !== 'off') env.TRIMSLOT_FAKE_NOW = '2026-09-30T10:00:00+01:00';
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  let code = 1;
  try {
    await waitHealthy(base);
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...process.argv.slice(3)], { env, stdio: 'inherit' });
    code = await new Promise<number>((res) => child.on('exit', (c) => res(c ?? 1)));
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    await pg.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(code);
}
main().catch((e) => { console.error(e); process.exit(1); });
