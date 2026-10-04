import { after } from 'node:test';
import { Client } from 'pg';
import { createDb, Db } from '../src/db';
import { seed } from '../src/seed';
import { clock } from '../src/time';

process.env.NODE_ENV = 'test';
delete process.env.PAYSTACK_SECRET_KEY; // tests run in MOCK mode unless they override

const PORT = process.env.TEST_PG_PORT;
if (!PORT) throw new Error('Tests must be started with `npm test` (it boots the Postgres they run against).');
const ADMIN_URL = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres`;

let counter = 0;
const opened: { db: Db; name: string }[] = [];

/** A brand-new, fully migrated database cloned from the template (real Postgres constraints, indexes and locks). */
export async function newDatabase(opts: { poolMax?: number } = {}): Promise<{ db: Db; name: string }> {
  const name = `t_${process.pid}_${Date.now().toString(36)}_${counter++}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template_trimslot`);
  await admin.end();
  const db = createDb(`postgres://postgres:postgres@127.0.0.1:${PORT}/${name}`, { max: opts.poolMax ?? 8 });
  opened.push({ db, name });
  await verifiedUsersByDefault(db);
  return { db, name };
}

/** Test databases give every NEW user a checked email and treat barbers as ready, so the many tests that insert users directly keep testing what they are about.
 *  Tests of the email rules call unverifiedUsers(db) to switch that off and get the real behaviour. */
async function verifiedUsersByDefault(db: Db) {
  await db.query(`CREATE OR REPLACE FUNCTION test_verify_user() RETURNS trigger AS $$ BEGIN
      IF NEW.email IS NOT NULL AND NEW.email_verified_at IS NULL THEN NEW.email_verified_at := now(); END IF;
      IF NEW.role = 'barber' THEN NEW.email_verify_exempt := TRUE; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await db.query(`CREATE TRIGGER test_verify_user BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION test_verify_user()`);
}
export const unverifiedUsers = (db: Db) => db.query('DROP TRIGGER IF EXISTS test_verify_user ON users');

/** An EMPTY database (no migrations applied) - for tests that migrate step by step. */
export async function emptyDatabase(): Promise<{ db: Db; name: string }> {
  const name = `e_${process.pid}_${Date.now().toString(36)}_${counter++}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  const db = createDb(`postgres://postgres:postgres@127.0.0.1:${PORT}/${name}`, { max: 4 });
  opened.push({ db, name });
  return { db, name };
}

export async function freshDb(opts: { poolMax?: number } = {}): Promise<{ db: Db; barberId: number; customerIds: number[]; serviceIds: number[]; name: string }> {
  const { db, name } = await newDatabase(opts);
  const { barberId } = await seed(db, 4);
  const customerIds = (await db.many<{ id: number }>(`SELECT id FROM users WHERE role='customer' ORDER BY id`)).map((r) => r.id);
  const serviceIds = (await db.many<{ id: number }>('SELECT id FROM services WHERE barber_id=$1 ORDER BY id', [barberId])).map((r) => r.id);
  return { db, barberId, customerIds, serviceIds, name };
}

after(async () => {
  for (const o of opened) await o.db.close().catch(() => {});
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect().catch(() => {});
  for (const o of opened) await admin.query(`DROP DATABASE IF EXISTS ${o.name} WITH (FORCE)`).catch(() => {});
  await admin.end().catch(() => {});
});

/** Wednesday 2026-09-30 (Lagos) */
export const WED = '2026-09-30';
export function setNow(iso: string) { clock.setExact(new Date(iso)); }
export function resetNow() { clock.set(null); }
export const userIdOfBarber = async (db: Db, barberId: number) => (await db.one<{ user_id: number }>('SELECT user_id FROM barbers WHERE id=$1', [barberId])).user_id;
