import fs from 'fs';
import path from 'path';
import { Pool, PoolClient, PoolConfig, types } from 'pg';
import { config } from './config';
import { logger } from './logger';

/* ---------- type parsing: keep the app's simple string/number model ---------- */
types.setTypeParser(1082, (v) => v);                                // date        -> 'YYYY-MM-DD' (never a JS Date in the server's zone)
types.setTypeParser(1184, (v) => new Date(v).toISOString());       // timestamptz -> ISO-8601 UTC string
types.setTypeParser(20, (v) => parseInt(v, 10));                    // bigint (COUNT(*)) -> number

export interface QueryResult<R = any> { rows: R[]; rowCount: number }

/** Anything that can run SQL: the pool wrapper (autocommit) or a transaction. Data-access functions take a Conn. */
export interface Conn {
  query<R = any>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
  /** exactly one row expected (throws otherwise) */
  one<R = any>(text: string, params?: unknown[]): Promise<R>;
  /** zero or one row */
  maybeOne<R = any>(text: string, params?: unknown[]): Promise<R | undefined>;
  many<R = any>(text: string, params?: unknown[]): Promise<R[]>;
}

class Base {
  protected run(_text: string, _params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> { throw new Error('abstract'); }
  async query<R = any>(text: string, params: unknown[] = []): Promise<QueryResult<R>> {
    const r = await this.run(text, params);
    return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
  }
  async one<R = any>(text: string, params: unknown[] = []): Promise<R> {
    const r = await this.run(text, params);
    if (r.rows.length !== 1) throw new Error(`expected exactly 1 row, got ${r.rows.length}: ${text.slice(0, 80)}`);
    return r.rows[0] as R;
  }
  async maybeOne<R = any>(text: string, params: unknown[] = []): Promise<R | undefined> {
    return (await this.run(text, params)).rows[0] as R | undefined;
  }
  async many<R = any>(text: string, params: unknown[] = []): Promise<R[]> {
    return (await this.run(text, params)).rows as R[];
  }
}

export class Tx extends Base implements Conn {
  constructor(private client: PoolClient) { super(); }
  protected run(text: string, params?: unknown[]) { return this.client.query(text, params as any[]); }
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

export class Db extends Base implements Conn {
  constructor(public readonly pool: Pool) { super(); }
  protected run(text: string, params?: unknown[]) { return this.pool.query(text, params as any[]); }

  /**
   * Run `fn` in a transaction (READ COMMITTED; correctness comes from advisory/row locks + constraints, not from isolation level).
   * Retried automatically on deadlock/serialization failures. `fn` must only touch the database (no HTTP calls) - it can be re-run,
   * and holding a pooled connection while waiting on the network would starve a small serverless pool.
   */
  async tx<T>(fn: (t: Tx) => Promise<T>, attempts = 3): Promise<T> {
    for (let i = 1; ; i++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(new Tx(client));
        await client.query('COMMIT');
        return out;
      } catch (e: any) {
        try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
        if (RETRYABLE.has(e?.code) && i < attempts) { await new Promise((r) => setTimeout(r, 15 * i + Math.random() * 25)); continue; }
        throw e;
      } finally {
        client.release();
      }
    }
  }

  async close() { await this.pool.end(); }
}

/** SSL policy. Localhost: off. Remote (Supabase etc.): TLS on; certificate verification only when DATABASE_SSL_CA is provided. */
function sslFor(url: URL): PoolConfig['ssl'] {
  if (process.env.DATABASE_SSL === 'false') return false;
  if (['localhost', '127.0.0.1', '::1', 'postgres', 'db'].includes(url.hostname) && process.env.DATABASE_SSL !== 'true') return false;
  const ca = process.env.DATABASE_SSL_CA;
  return ca ? { ca: ca.replace(/\\n/g, '\n'), rejectUnauthorized: true } : { rejectUnauthorized: false };
}

export function poolConfig(connectionString: string, overrides: Partial<PoolConfig> = {}): PoolConfig {
  const url = new URL(connectionString);
  // node-postgres lets sslmode/sslrootcert in the URL override the ssl object; strip them so our policy above is what applies.
  for (const k of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat', 'pgbouncer', 'supa']) url.searchParams.delete(k);
  return {
    connectionString: url.toString(),
    ssl: sslFor(url),
    max: config.poolMax,                       // small: each serverless instance keeps at most this many connections
    idleTimeoutMillis: 10_000,                 // release idle connections quickly (pooler + serverless friendly)
    connectionTimeoutMillis: 8_000,
    allowExitOnIdle: true,
    ...overrides,
  };
}

let shared: Db | undefined;
/** Process-wide singleton (reused across warm serverless invocations). Connections are opened lazily on first query. */
export function getDb(): Db {
  if (shared) return shared;
  const url = config.databaseUrl;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new Pool(poolConfig(url));
  pool.on('error', (e) => logger.error('pg_pool_error', { err: e.message }));   // idle-client errors must never crash the process
  if (process.env.VERCEL) {
    // lets Vercel (Fluid compute) close idle pool clients before the function instance is suspended
    import('@vercel/functions').then((m) => (m as any).attachDatabasePool?.(pool)).catch(() => { /* optional */ });
  }
  shared = new Db(pool);
  return shared;
}
export async function closeDb() { if (shared) { const s = shared; shared = undefined; await s.close(); } }

export function createDb(connectionString: string, overrides: Partial<PoolConfig> = {}): Db {
  const pool = new Pool(poolConfig(connectionString, overrides));
  pool.on('error', (e) => logger.error('pg_pool_error', { err: e.message }));
  return new Db(pool);
}

/* ---------- migrations ---------- */
export function migrationsDir(): string {
  const cands = [path.resolve(__dirname, '..', 'migrations'), path.resolve(process.cwd(), 'migrations')];
  return cands.find((c) => fs.existsSync(c)) || cands[0];
}

/**
 * Forward-only SQL migrations from /migrations/*.sql (lexical order). Each file runs once, in its own transaction, guarded by a
 * transaction-scoped advisory lock (safe with Supabase's transaction pooler and with concurrent deploys).
 */
export async function migrate(db: Db, dir = migrationsDir()): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const files = fs.readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const f of files) {
    await db.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock(727274)');
      if (await t.maybeOne('SELECT 1 FROM schema_migrations WHERE name=$1', [f])) return;
      await t.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await t.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      applied.push(f);
    });
  }
  return applied;
}

export const isUniqueViolation = (e: any) => e?.code === '23505';
export const isExclusionViolation = (e: any) => e?.code === '23P01';
