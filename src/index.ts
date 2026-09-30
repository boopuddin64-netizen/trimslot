/** Long-running server entrypoint (local dev, Docker/VPS). On Vercel the entrypoint is api/index.ts instead. */
import { closeDb } from './db';
import { config } from './config';
import { logger } from './logger';
import { expireHolds } from './bookingService';
import { bootChecks, prepareDb } from './runtime';

async function main() {
  try { bootChecks(); } catch (e: any) { console.error(`\nFATAL: ${e.message}\n`); process.exit(1); }
  let db;
  try { db = await prepareDb({ migrate: process.env.AUTO_MIGRATE !== 'false' && (!config.isProd || process.env.AUTO_MIGRATE === 'true') }); }
  catch (e: any) { console.error(`\nFATAL: cannot prepare database: ${e.message}\n`); process.exit(1); }

  const { createApp } = await import('./app');
  const server = createApp(db).listen(config.port, '0.0.0.0', () => {
    logger.info('listening', { port: config.port, env: process.env.NODE_ENV || 'development', payments: config.paystackMode, demo: config.demoEnabled });
    if (config.mockMode) logger.warn('mock_payments', { note: 'MOCK payments mode - no PAYSTACK_SECRET_KEY set (development only)' });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // Long-running deployments (Docker/VPS/dev) keep a light in-process sweeper. On Vercel this does not exist: use /api/cron/sweep.
  const sweeper = config.sweepEverySeconds > 0
    ? setInterval(() => { expireHolds(db).catch((e) => logger.error('hold_sweep_failed', { err: e.message })); }, config.sweepEverySeconds * 1000)
    : undefined;
  sweeper?.unref();

  let closing = false;
  const shutdown = (sig: string) => {
    if (closing) return;
    closing = true;
    logger.info('shutdown_start', { signal: sig });
    if (sweeper) clearInterval(sweeper);
    const force = setTimeout(() => { logger.error('shutdown_forced'); process.exit(1); }, 10_000);
    force.unref();
    server.close(async (err) => {
      try { await closeDb(); } catch { /* ignore */ }
      logger.info('shutdown_complete', { error: err ? String(err.message) : undefined });
      process.exit(err ? 1 : 0);
    });
    (server as any).closeIdleConnections?.();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (r) => logger.error('unhandled_rejection', { err: String((r as any)?.message || r) }));
  process.on('uncaughtException', (e) => { logger.error('uncaught_exception', { err: e.message }); shutdown('uncaughtException'); });
}
main();
