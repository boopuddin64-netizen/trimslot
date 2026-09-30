/* Minimal admin CLI (there is no admin web panel in the MVP). Works against ANY Postgres via DATABASE_URL:
     DATABASE_URL='postgresql://…' npm run admin -- list-barbers [--pending]
     DATABASE_URL='postgresql://…' npm run admin -- verify-barber <email|phone>
     DATABASE_URL='postgresql://…' npm run admin -- unverify-barber <email|phone>            */
import { closeDb, getDb } from '../src/db';
import { config } from '../src/config';
import { normPhone } from '../src/validation';
import { isoNow } from '../src/time';
import { audit, notify } from '../src/helpers';

const [cmd, arg] = process.argv.slice(2);
import { getSettings, settingsView, updateSettings, SETTING_KEYS } from '../src/plans';
const usage = (code = cmd ? 1 : 0) => {
  console.log('Usage (set DATABASE_URL first):\n  npm run admin -- list-barbers [--pending]\n  npm run admin -- verify-barber <email|phone>\n  npm run admin -- unverify-barber <email|phone>\n  npm run admin -- settings                      (show platform rules)\n  npm run admin -- set <key> <value> [<key> <value> ...]   e.g. set credit_expiry_days 30 max_plan_price_naira 200000\n  npm run admin -- refunds                       (payments flagged for refund)');
  process.exit(code);
};
if (!cmd || cmd === 'help' || cmd === '--help') usage(0);

async function main() {
  let stop: (() => Promise<void>) | undefined;
  if (config.usesEmbeddedDevDb) { const { startEmbeddedPostgres } = await import('../src/devdb'); stop = (await startEmbeddedPostgres()).stop; }
  else if (!config.databaseUrl) { console.error('DATABASE_URL is not set.'); process.exit(1); }
  const db = getDb();

  if (cmd === 'list-barbers') {
    const rows = await db.many(`SELECT b.id, b.shop_name, b.verified, u.name, u.email, u.phone, b.created_at FROM barbers b JOIN users u ON u.id=b.user_id ORDER BY b.verified, b.id`);
    const shown = process.argv.includes('--pending') ? rows.filter((r) => !r.verified) : rows;
    if (!shown.length) console.log('(none)');
    for (const r of shown) console.log(`${r.verified ? 'VERIFIED  ' : 'UNVERIFIED'}  #${r.id}  ${r.shop_name} — ${r.name}  <${r.email ?? '-'}>  ${r.phone ?? '-'}  (signed up ${String(r.created_at).slice(0, 10)})`);
  } else if (cmd === 'verify-barber' || cmd === 'unverify-barber') {
    if (!arg) usage();
    const key = arg.includes('@') ? arg.trim().toLowerCase() : normPhone(arg);
    const b = await db.maybeOne(`SELECT b.id AS barber_id, b.shop_name, b.verified, u.id AS user_id, u.name, u.email, u.phone FROM barbers b JOIN users u ON u.id=b.user_id WHERE u.email=$1 OR u.phone=$1`, [key]);
    if (!b) { console.error(`No barber found with email/phone "${arg}".`); process.exitCode = 1; }
    else {
      const on = cmd === 'verify-barber';
      await db.tx(async (t) => {
        await t.query('UPDATE barbers SET verified=$1, verified_at=$2 WHERE id=$3', [on, on ? isoNow() : null, b.barber_id]);
        await audit(t, null, { id: null, role: 'system' }, on ? 'BARBER_VERIFIED' : 'BARBER_UNVERIFIED', { barber_id: b.barber_id, via: 'admin CLI' });
        if (on && !b.verified) await notify(t, b.user_id, 'BARBER_VERIFIED', "You're live! 🎉", `${b.shop_name} is now visible to customers and can take bookings.`);
      });
      console.log(`${on ? 'Verified' : 'Unverified'}: ${b.shop_name} (${b.name}, ${b.email ?? b.phone}).`);
    }
  } else if (cmd === 'settings') {
    for (const [k, v] of Object.entries(settingsView(await getSettings(db)))) console.log(`${k} = ${v}`);
  } else if (cmd === 'set') {
    const rest = process.argv.slice(4); const pairs = [arg, ...rest];
    if (!arg || pairs.length % 2) usage();
    const patch: Record<string, unknown> = {};
    for (let i = 0; i < pairs.length; i += 2) {
      const k = pairs[i], v = pairs[i + 1];
      if (!(SETTING_KEYS as readonly string[]).includes(k)) { console.error(`Unknown setting "${k}". Valid: ${SETTING_KEYS.join(', ')}`); process.exit(1); }
      patch[k] = v === 'true' ? true : v === 'false' ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    const out = await db.tx((t) => updateSettings(t, patch));
    for (const [k, v] of Object.entries(out)) console.log(`${k} = ${v}`);
  } else if (cmd === 'refunds') {
    const rows = await db.many(`SELECT reference, amount_kobo, refund_status, refund_reason, refund_error FROM payments WHERE refund_status IS NOT NULL ORDER BY id DESC LIMIT 50`);
    if (!rows.length) console.log('(none)');
    for (const r of rows) console.log(`${r.refund_status}  ${r.reference}  ₦${r.amount_kobo / 100}  ${r.refund_reason ?? ''}${r.refund_error ? '  [gateway error: ' + r.refund_error + ']' : ''}`);
  } else usage();
  await closeDb(); if (stop) await stop();
}
main().catch((e) => { console.error('Admin command failed:', e.message); process.exit(1); });
