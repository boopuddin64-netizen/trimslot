/* `npm run flow`: boots embedded Postgres + the server (REAL clock, MOCK payments, CRON_SECRET set) and runs scripts/flow-multi.ts against it.
   The barber is verified here (the same UPDATE `npm run admin -- verify-barber` performs). Takes ~6 minutes (waits ~3 min for a real no-show). */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from 'pg';
import { startEmbeddedPostgres } from '../src/devdb';

const PORT = Number(process.env.FLOW_PORT || 4103);
async function waitHealthy(base: string) {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + '/healthz?deep=1')).ok) return; } catch { /* not up */ } await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('server did not become healthy');
}
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trimslot-flow-pg-'));
  const pgPort = 54800 + Math.floor(Math.random() * 90);
  const pg = await startEmbeddedPostgres({ dir, port: pgPort, database: 'trimslot_flow', persistent: false });
  const url = `postgres://postgres:postgres@127.0.0.1:${pgPort}/trimslot_flow`;
  const base = `http://localhost:${PORT}`;
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(PORT), DATABASE_URL: url, CRON_SECRET: 'flow-cron-secret-0123456789abcdef', PAYSTACK_SECRET_KEY: '', NODE_ENV: 'development', BASE: base, SWEEP_EVERY_SECONDS: '0' };
  delete env.TRIMSLOT_FAKE_NOW;
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  const admin = new Client({ connectionString: url });
  let code = 1;
  try {
    await waitHealthy(base);
    await admin.connect();
    const verifier = setInterval(() => { admin.query(`UPDATE barbers SET verified=TRUE, verified_at=now() WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'smoketest+flow%')`).catch(() => {}); }, 1500);
    const t = spawn(process.execPath, ['--import', 'tsx', 'scripts/flow-multi.ts'], { env, stdio: 'inherit' });
    code = await new Promise<number>((res) => t.on('exit', (c) => res(c ?? 1)));
    clearInterval(verifier);
  } finally {
    await admin.end().catch(() => {});
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    await pg.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(code);
}
main().catch((e) => { console.error(e); process.exit(1); });
