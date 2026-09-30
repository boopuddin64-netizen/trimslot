/**
 * DEVELOPMENT ONLY: a real PostgreSQL 17 running as a child process (npm package `embedded-postgres`, a devDependency),
 * so `npm run dev` works with zero setup and no Docker. Never used when DATABASE_URL is set or NODE_ENV=production.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import { DEV_DB_PORT } from './config';

const portOpen = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect({ port, host: '127.0.0.1' }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});

export async function startEmbeddedPostgres(opts: { dir?: string; port?: number; database?: string; persistent?: boolean; quiet?: boolean } = {}) {
  const port = opts.port ?? DEV_DB_PORT;
  const database = opts.database ?? 'trimslot';
  if (await portOpen(port)) return { url: `postgres://postgres:postgres@127.0.0.1:${port}/${database}`, stop: async () => {}, reused: true };
  // @ts-ignore  embedded-postgres is ESM-only with its own typings; it is a devDependency, only ever loaded in development/tests (through tsx)
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = path.resolve(opts.dir ?? './data/pg');
  const pg = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: opts.persistent ?? true,
    onLog: opts.quiet === false ? (m: any) => console.log(String(m).trim()) : () => {},
    onError: () => {},
    postgresFlags: ['-c', 'timezone=UTC', '-c', 'max_connections=100', '-c', 'fsync=off'],
  } as any);
  if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  try { await pg.createDatabase(database); } catch { /* already exists */ }
  return { url: `postgres://postgres:postgres@127.0.0.1:${port}/${database}`, stop: () => pg.stop(), reused: false, pg };
}
