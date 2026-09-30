/* Demo data (development / staging only).   npm run seed          → seeds only if the DB has no users
                                              npm run seed -- --reset  → TRUNCATEs everything first (refused in production) */
import { closeDb, getDb, migrate } from '../src/db';
import { config } from '../src/config';
import { seed, DEMO } from '../src/seed';

async function main() {
  if (config.isProd && process.env.SEED_DEMO !== 'true') { console.error('Refusing to seed demo data in production. Set SEED_DEMO=true if you really mean it.'); process.exit(1); }
  let stop: (() => Promise<void>) | undefined;
  if (config.usesEmbeddedDevDb) { const { startEmbeddedPostgres } = await import('../src/devdb'); stop = (await startEmbeddedPostgres()).stop; }
  const db = getDb();
  await migrate(db);
  if (process.argv.includes('--reset')) {
    if (config.isProd) { console.error('--reset is refused in production.'); process.exit(1); }
    await db.query('TRUNCATE users, barbers, barber_schedule, days_off, services, bookings, payments, payment_events, audit_log, notifications, rate_limits RESTART IDENTITY CASCADE');
  }
  if ((await db.one<{ c: number }>('SELECT COUNT(*) c FROM users')).c) { console.log('Database already has data. Run `npm run seed -- --reset` to wipe and reseed (non-production only).'); }
  else { await seed(db, config.bcryptRounds); console.log('Seeded demo data.', JSON.stringify(DEMO, null, 2)); }
  await closeDb(); if (stop) await stop();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
