/* `npm run e2e`: boots a fresh REAL PostgreSQL (embedded, no Docker), starts the server against it on :4101 with a fixed clock
   (Wed 2026-09-30 10:00 Lagos, inside opening hours) and CRON_SECRET set, runs scripts/e2e.ts, then tears everything down.
   To run e2e against an already-running server instead: BASE=http://localhost:4101 npx tsx scripts/e2e.ts */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startEmbeddedPostgres } from '../src/devdb';

const PORT = Number(process.env.E2E_PORT || 4101);
const CRON = 'e2e-cron-secret-0123456789abcdef';
async function waitHealthy(base: string) {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/healthz?deep=1')).ok) return; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('server did not become healthy');
}
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trimslot-e2e-pg-'));
  const pgPort = 54900 + Math.floor(Math.random() * 90);
  const pg = await startEmbeddedPostgres({ dir, port: pgPort, database: 'trimslot_e2e', persistent: false });
  const base = `http://localhost:${PORT}`;
  const env = { ...process.env, PORT: String(PORT), DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${pgPort}/trimslot_e2e`, TRIMSLOT_FAKE_NOW: '2026-09-30T10:00:00+01:00', CRON_SECRET: CRON, PAYSTACK_SECRET_KEY: '', NODE_ENV: 'development', BASE: base, SWEEP_EVERY_SECONDS: '0' };
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  let code = 1;
  try {
    await waitHealthy(base);
    const e2e = spawn(process.execPath, ['--import', 'tsx', 'scripts/e2e.ts'], { env, stdio: 'inherit' });
    code = await new Promise<number>((res) => e2e.on('exit', (c) => res(c ?? 1)));
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    await pg.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(code);
}
main().catch((e) => { console.error(e); process.exit(1); });
