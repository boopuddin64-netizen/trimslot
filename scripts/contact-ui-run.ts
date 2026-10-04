import { spawn } from 'child_process';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { startEmbeddedPostgres } from '../src/devdb';
const PORT = 4231, pgPort = 54931;
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-ui-pg-'));
  const pg = await startEmbeddedPostgres({ dir, port: pgPort, database: 'ui', persistent: false });
  const env = { ...process.env, PORT: String(PORT), DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${pgPort}/ui`, TRIMSLOT_FAKE_NOW: '2026-09-30T09:50:00+01:00', PAYSTACK_SECRET_KEY: '', NODE_ENV: 'development', SWEEP_EVERY_SECONDS: '0', BASE: `http://localhost:${PORT}` };
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: '/workspace/ts-ultron', env, stdio: ['ignore', 'ignore', 'inherit'] });
  let code = 1;
  try {
    for (let i = 0; i < 120; i++) { try { if ((await fetch(env.BASE + '/healthz?deep=1')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
    const ui = spawn(process.execPath, ['scripts/contact-ui.mjs'], { cwd: '/workspace/ts-ultron', env, stdio: 'inherit' });
    code = await new Promise<number>((r) => ui.on('exit', (c) => r(c ?? 1)));
  } finally { server.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 500)); await pg.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  process.exit(code);
})();
