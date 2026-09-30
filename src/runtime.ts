import { assertProductionConfig, config } from './config';
import { createApp } from './app';
import { getDb, migrate, Db } from './db';
import { initClockFromEnv } from './time';
import { logger } from './logger';
import { seed } from './seed';

/** Connects (embedded Postgres in local dev if DATABASE_URL is unset), optionally migrates, optionally seeds demo data. */
export async function prepareDb(opts: { migrate?: boolean } = {}): Promise<Db> {
  if (config.usesEmbeddedDevDb) {
    const { startEmbeddedPostgres } = await import('./devdb');
    const r = await startEmbeddedPostgres();
    logger.info('dev_database', { url: r.url.replace(/:[^:@/]*@/, ':***@'), reused: r.reused, note: 'embedded Postgres (development only). Set DATABASE_URL to use your own.' });
  }
  const db = getDb();
  if (opts.migrate ?? !config.isProd) {
    const applied = await migrate(db);
    if (applied.length) logger.info('migrations_applied', { files: applied });
  }
  const n = (await db.one<{ c: number }>('SELECT COUNT(*) c FROM users')).c;
  if (n === 0 && config.demoEnabled) { logger.info('seeding_demo_data', { reason: 'empty database and demo enabled' }); await seed(db, config.bcryptRounds); }
  else if (n === 0) logger.info('empty_database', { note: 'no demo data (production). Sign up as a barber, then: npm run admin -- verify-barber <email>' });
  return db;
}

/** Shared by the long-running server and the Vercel handler. */
export function bootChecks() {
  const { warnings } = assertProductionConfig();   // throws (=> refuse to boot) on unsafe production config
  warnings.forEach((w) => logger.warn('config_warning', { warning: w }));
  initClockFromEnv();
  return createApp;
}
