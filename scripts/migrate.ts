/* Apply SQL migrations in /migrations to DATABASE_URL.   npm run migrate      (DATABASE_URL=… npm run migrate)
   Use the Supabase *direct* or *session pooler* (5432) string for migrations if you can; the transaction pooler (6543) also works. */
import { closeDb, getDb, migrate } from '../src/db';
import { config } from '../src/config';

async function main() {
  let stop: (() => Promise<void>) | undefined;
  if (config.usesEmbeddedDevDb) {
    const { startEmbeddedPostgres } = await import('../src/devdb');
    const r = await startEmbeddedPostgres(); stop = r.stop;
    console.log('Using embedded dev Postgres (no DATABASE_URL set).');
  }
  const host = (() => { try { return new URL(config.databaseUrl).host; } catch { return '(invalid URL)'; } })();
  console.log(`Migrating ${host} …`);
  const db = getDb();
  const applied = await migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date.');
  await closeDb();
  if (stop) await stop();
}
main().catch((e) => { console.error('Migration FAILED:', e.message); process.exit(1); });
