/* `npm test`: boots a REAL PostgreSQL 17 (embedded-postgres, no Docker), migrates a template database once, then runs node:test.
   Each test gets its own database cloned from the template (CREATE DATABASE … TEMPLATE) → full isolation, real constraints/locks. */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from 'pg';
import { startEmbeddedPostgres } from '../src/devdb';
import { createDb, migrate } from '../src/db';

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trimslot-pg-'));
  const port = 54000 + Math.floor(Math.random() * 900);
  const pg = await startEmbeddedPostgres({ dir, port, database: 'template_trimslot', persistent: false });
  const tmpl = createDb(`postgres://postgres:postgres@127.0.0.1:${port}/template_trimslot`);
  await migrate(tmpl);
  await tmpl.close();
  const files = process.argv.slice(2);
  const args = ['--test', '--test-concurrency=1', ...(files.length ? files : fs.readdirSync('tests').filter((f) => f.endsWith('.test.ts')).map((f) => path.join('tests', f)))];
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test', TEST_PG_PORT: String(port), DATABASE_URL: '', PAYSTACK_SECRET_KEY: '' },
  });
  const code: number = await new Promise((res) => child.on('exit', (c) => res(c ?? 1)));
  const admin = new Client({ connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/postgres` });
  await admin.connect().catch(() => {});
  await admin.end().catch(() => {});
  await pg.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
main().catch((e) => { console.error(e); process.exit(1); });
