/** 4-digit admin PIN guarding every irreversible admin action.
 *  - set ONCE by the admin (first-time setup), stored as scrypt(salt, pin) — never the PIN itself
 *  - wrong tries are counted in the database; 5 wrong tries lock PIN checks for 15 minutes (survives restarts / serverless instances)
 *  - changing the PIN needs the old PIN
 *  Sent per action in the `X-Admin-Pin` header (never in a URL). */
import crypto from 'crypto';
import { Request } from 'express';
import { Db } from './db';
import { AppError, badRequest } from './errors';
import { audit } from './helpers';
import { clock } from './time';

export const MAX_TRIES = 5;
export const LOCK_MINUTES = 15;
const ADMIN = { id: null as number | null, role: 'admin' as const };
const hashPin = (pin: string, salt: string) => crypto.scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
const now = () => clock.now();

function validPinFormat(pin: unknown): string {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) throw badRequest('The PIN must have exactly 4 digits.');
  return pin;
}
function weak(pin: string) { return /^(\d)\1{3}$/.test(pin) || pin === '1234' || pin === '4321' || pin === '0123'; }

export async function pinStatus(db: Db) {
  const r = await db.maybeOne<any>('SELECT set_at, fail_count, locked_until FROM admin_pin WHERE id=1');
  if (!r) return { set: false, locked: false, retry_after_s: 0, attempts_left: MAX_TRIES, set_at: null };
  const lockedMs = r.locked_until ? new Date(r.locked_until).getTime() - now().getTime() : 0;
  return { set: true, locked: lockedMs > 0, retry_after_s: lockedMs > 0 ? Math.ceil(lockedMs / 1000) : 0, attempts_left: Math.max(0, MAX_TRIES - (lockedMs > 0 ? MAX_TRIES : r.fail_count)), set_at: r.set_at };
}

/** Verifies a PIN with lockout accounting. Throws a precise AppError; resolves silently when correct. */
export async function verifyPin(db: Db, pin: unknown): Promise<void> {
  await db.tx(async (t) => {
    const r = await t.maybeOne<any>('SELECT * FROM admin_pin WHERE id=1 FOR UPDATE');
    if (!r) throw new AppError(403, 'PIN_NOT_SET', 'Set your 4-digit admin PIN first (Admin → Settings → Admin PIN). You need it to delete things and for other actions you cannot undo.');
    const lockedMs = r.locked_until ? new Date(r.locked_until).getTime() - now().getTime() : 0;
    if (lockedMs > 0) throw new AppError(423, 'PIN_LOCKED', `Too many wrong PINs. Try again in ${Math.ceil(lockedMs / 60000)} minute(s).`, { retry_after_s: Math.ceil(lockedMs / 1000) });
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) throw new AppError(403, 'PIN_REQUIRED', 'Enter your 4-digit admin PIN to go on.');
    const given = Buffer.from(hashPin(pin, r.salt), 'hex'); const want = Buffer.from(r.hash, 'hex');
    if (given.length === want.length && crypto.timingSafeEqual(given, want)) {
      if (r.fail_count || r.locked_until) await t.query('UPDATE admin_pin SET fail_count=0, locked_until=NULL WHERE id=1');
      return;
    }
    const fails = (r.locked_until ? 0 : r.fail_count) + 1;   // an expired lock starts a fresh count
    const lock = fails >= MAX_TRIES;
    await t.query('UPDATE admin_pin SET fail_count=$1, last_fail_at=$2, locked_until=$3 WHERE id=1', [lock ? 0 : fails, now().toISOString(), lock ? new Date(now().getTime() + LOCK_MINUTES * 60000).toISOString() : null]);
    await audit(t, null, ADMIN, lock ? 'ADMIN_PIN_LOCKED' : 'ADMIN_PIN_WRONG', { tries: fails });
    // the failure must persist even though we throw: commit by returning a marker
    return { fail: { lock, left: MAX_TRIES - fails } } as any;
  }).then((marker: any) => {
    if (marker?.fail) {
      if (marker.fail.lock) throw new AppError(423, 'PIN_LOCKED', `Too many wrong PINs. It is locked for ${LOCK_MINUTES} minutes.`, { retry_after_s: LOCK_MINUTES * 60 });
      throw new AppError(403, 'PIN_WRONG', `Wrong PIN. You have ${marker.fail.left} ${marker.fail.left === 1 ? 'try' : 'tries'} left. Then it locks for ${LOCK_MINUTES} minutes.`, { attempts_left: marker.fail.left });
    }
  });
}

/** Route helper: `await requirePin(db, req)` before any irreversible write. */
export async function requirePin(db: Db, req: Request): Promise<void> {
  await verifyPin(db, req.get('x-admin-pin'));
}

export async function setupPin(db: Db, pin: unknown) {
  const p = validPinFormat(pin);
  if (weak(p)) throw badRequest('Pick a PIN that is hard to guess. Do not use 1234, 0000 or 1111.');
  const salt = crypto.randomBytes(16).toString('hex');
  const ins = await db.query(`INSERT INTO admin_pin (id, salt, hash, set_at) VALUES (1,$1,$2,$3) ON CONFLICT (id) DO NOTHING`, [salt, hashPin(p, salt), now().toISOString()]);
  if (!ins.rowCount) throw new AppError(409, 'PIN_ALREADY_SET', 'You already have a PIN. Use “Change PIN” and enter your old PIN.');
  await audit(db, null, ADMIN, 'ADMIN_PIN_SET', {});
}

export async function changePin(db: Db, oldPin: unknown, newPin: unknown) {
  const np = validPinFormat(newPin);
  if (weak(np)) throw badRequest('Pick a PIN that is hard to guess. Do not use 1234, 0000 or 1111.');
  await verifyPin(db, oldPin);
  if (oldPin === np) throw badRequest('The new PIN must be different from the old PIN.');
  const salt = crypto.randomBytes(16).toString('hex');
  await db.query('UPDATE admin_pin SET salt=$1, hash=$2, set_at=$3, fail_count=0, locked_until=NULL WHERE id=1', [salt, hashPin(np, salt), now().toISOString()]);
  await audit(db, null, ADMIN, 'ADMIN_PIN_CHANGED', {});
}
