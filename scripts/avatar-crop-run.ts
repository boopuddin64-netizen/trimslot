/* `npm run avatar-ui`: boots a throw-away PostgreSQL + the server on :4103 (mock payments, no real data), runs scripts/avatar-crop-ui.mjs, tears everything down. */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startEmbeddedPostgres } from '../src/devdb';

const PORT = Number(process.env.UI_PORT || 4103);
const CRON = 'e2e-cron-secret-0123456789abcdef';
async function waitHealthy(base: string) {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/healthz?deep=1')).ok) return; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('server did not become healthy');
}
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trimslot-avui-pg-'));
  const pgPort = 54700 + Math.floor(Math.random() * 90);
  const pg = await startEmbeddedPostgres({ dir, port: pgPort, database: 'trimslot_avui', persistent: false });
  const base = `http://localhost:${PORT}`;
  const env = { ...process.env, PORT: String(PORT), DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${pgPort}/trimslot_avui`, TRIMSLOT_FAKE_NOW: '2026-09-30T10:00:00+01:00', CRON_SECRET: CRON, PAYSTACK_SECRET_KEY: '', NODE_ENV: 'development', BASE: base, SWEEP_EVERY_SECONDS: '0' };
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  let code = 1;
  try {
    await waitHealthy(base);
    const e2e = spawn(process.execPath, ['--import', 'tsx', 'scripts/avatar-crop-ui.mjs'], { env, stdio: 'inherit' });
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
