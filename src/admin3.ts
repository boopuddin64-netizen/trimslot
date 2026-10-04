/** Admin v3: lean, keyset-paginated lists (search / filter / sort), a fast home summary, command-palette search and bulk actions.
 *  Rows are SUMMARIES; full detail is fetched on demand by the existing detail routes. Every write is audited (actor_role='admin'). */
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { Db } from './db';
import { requirePin } from './adminPin';
import { AppError, badRequest, notFound } from './errors';
import { audit, notify } from './helpers';
import { getSettings } from './plans';
import { clock, isoNow, lagosDate } from './time';
import { ledgerBlocked } from './ledger';
import QRCode from 'qrcode';
import { absolute, ensureShareCode } from './shareLinks';

type H = (req: Request, res: Response) => Promise<any>;
const ADMIN = { id: null as number | null, role: 'admin' as const };
const like = (q: string) => '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
const dOk = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const intQ = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

type SortType = 'int' | 'text' | 'ts' | 'date';
interface Cfg {
  select: string; from: string; id: string;
  sorts: Record<string, { expr: string; type: SortType }>; defSort: string;
  where: (q: Request['query'], add: (sql: string, ...vals: unknown[]) => void, w: string[]) => void;
  after?: (rows: any[]) => Promise<any[]> | any[];
}
const CAST: Record<SortType, string> = { int: 'bigint', text: 'text', ts: 'timestamptz', date: 'date' };
const enc = (v: unknown, id: number) => Buffer.from(JSON.stringify([v, id])).toString('base64url');
const dec = (c: unknown): [unknown, number] | null => { try { const [v, id] = JSON.parse(Buffer.from(String(c), 'base64url').toString()); return Number.isInteger(id) ? [v, id] : null; } catch { return null; } };

export async function pageOf(db: Db, cfg: Cfg, query: Request['query']) {
  const p: unknown[] = []; const w: string[] = [];
  const add = (sql: string, ...vals: unknown[]) => { let s = sql; for (const v of vals) { p.push(v); s = s.replace('?', '$' + p.length); } w.push(s); };
  cfg.where(query, add, w);
  const sortKey = cfg.sorts[String(query.sort)] ? String(query.sort) : cfg.defSort; const sort = cfg.sorts[sortKey];
  const dir = String(query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(100, Math.max(5, intQ(query.limit) ?? 25));
  const baseWhere = w.slice(); const baseP = p.slice();
  const cur = query.cursor ? dec(query.cursor) : null;
  if (cur) { p.push(cur[0]); const a = p.length; p.push(cur[1]); const b = p.length; w.push(`(${sort.expr}, ${cfg.id}) ${dir === 'DESC' ? '<' : '>'} ($${a}::${CAST[sort.type]}, $${b}::bigint)`); }
  const sql = `SELECT ${cfg.select}, ${sort.expr} AS _s FROM ${cfg.from} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ${sort.expr} ${dir}, ${cfg.id} ${dir} LIMIT ${limit + 1}`;
  let rows = await db.many<any>(sql, p);
  const more = rows.length > limit; if (more) rows = rows.slice(0, limit);
  const last = rows[rows.length - 1];
  const next = more && last ? enc(last._s instanceof Date ? last._s.toISOString() : last._s, last.id) : null;
  rows = rows.map(({ _s, ...r }) => r);
  if (cfg.after) rows = await cfg.after(rows);
  let total: number | undefined, capped = false;
  if (!cur && String(query.count) !== '0') {
    const c = await db.one<{ n: number }>(`SELECT COUNT(*)::int n FROM (SELECT 1 FROM ${cfg.from} ${baseWhere.length ? 'WHERE ' + baseWhere.join(' AND ') : ''} LIMIT 10001) x`, baseP);
    total = c.n; capped = c.n > 10000;
  }
  return { rows, next, ...(total !== undefined ? { total: Math.min(total, 10000), total_capped: capped } : {}) };
}

const CFG: Record<string, Cfg> = {
  customers: {
    select: `u.id, u.name, u.email, u.phone, u.avatar_url, u.account_status, u.warn_count, u.created_at, (u.deletion_requested_at IS NOT NULL AND u.anonymised_at IS NULL) AS deletion_requested,
      (SELECT COUNT(*)::int FROM bookings k WHERE k.customer_id=u.id) AS bookings, (SELECT COUNT(*)::int FROM bookings k WHERE k.customer_id=u.id AND k.status='NO_SHOW') AS no_shows`,
    from: 'users u', id: 'u.id',
    sorts: { newest: { expr: 'u.id', type: 'int' }, name: { expr: 'lower(u.name)', type: 'text' } }, defSort: 'newest',
    where: (q, add) => {
      add(`u.role='customer' AND u.deleted_at IS NULL`);
      const s = String(q.q || '').trim().slice(0, 60);
      if (s) { const n = /^#?\d+$/.test(s) ? Number(s.replace('#', '')) : null; add(`(lower(u.name) LIKE lower(?) OR lower(u.email) LIKE lower(?) OR u.phone LIKE ?${n ? ' OR u.id=' + n : ''})`, like(s), like(s), like(s)); }
      const st = String(q.status || '').toUpperCase(); if (['ACTIVE', 'SUSPENDED', 'BANNED'].includes(st)) add('u.account_status=?', st);
    },
  },
  barbers: {
    select: `b.id, b.shop_name, b.location, b.paystack_subaccount IS NOT NULL AS payout_set, b.review_status, b.booking_paused, b.verified, b.created_at, b.resubmitted_at, u.name, u.email, u.phone, u.id AS user_id`,
    from: 'barbers b JOIN users u ON u.id=b.user_id', id: 'b.id',
    sorts: { newest: { expr: 'b.id', type: 'int' }, name: { expr: 'lower(b.shop_name)', type: 'text' } }, defSort: 'newest',
    where: (q, add) => {
      add('u.deleted_at IS NULL');
      const s = String(q.q || '').trim().slice(0, 60); if (s) add(`(lower(b.shop_name) LIKE lower(?) OR lower(u.name) LIKE lower(?) OR lower(u.email) LIKE lower(?))`, like(s), like(s), like(s));
      const st = String(q.status || '').toUpperCase(); if (['PENDING', 'NEEDS_INFO', 'VERIFIED', 'REJECTED', 'SUSPENDED'].includes(st)) add('b.review_status=?', st);
    },
  },
  bookings: {
    select: `k.id, k.date, k.start_min, k.service_name, k.price_kobo, k.status, k.payment_status, k.payment_option, k.barber_id, k.customer_id, b.shop_name, u.name AS customer_name, u.avatar_url AS customer_avatar`,
    from: 'bookings k JOIN barbers b ON b.id=k.barber_id JOIN users u ON u.id=k.customer_id', id: 'k.id',
    sorts: { newest: { expr: 'k.id', type: 'int' }, date: { expr: 'k.date', type: 'date' }, price: { expr: 'k.price_kobo', type: 'int' } }, defSort: 'date',
    where: (q, add) => {
      const s = String(q.q || '').trim().slice(0, 60);
      if (s) { if (/^#?\d+$/.test(s)) add('k.id=?', Number(s.replace('#', ''))); else add(`lower(u.name) LIKE lower(?)`, like(s)); }
      const st = String(q.status || ''); if (['PENDING_PAYMENT', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'NOT_SERVED'].includes(st)) add('k.status=?', st);
      const ps = String(q.payment_status || ''); if (['PAID', 'PAYMENT_DUE', 'PENDING', 'CREDIT_PENDING', 'CREDITED', 'VOID', 'REFUND_PENDING', 'REFUNDED', 'REFUND_DECLINED'].includes(ps)) add('k.payment_status=?', ps);
      const bid = intQ(q.barber_id); if (bid) add('k.barber_id=?', bid);
      const cid = intQ(q.customer_id); if (cid) add('k.customer_id=?', cid);
      const d = dOk(q.date); if (d) add('k.date=?', d); const f = dOk(q.from); if (f) add('k.date>=?', f); const t = dOk(q.to); if (t) add('k.date<=?', t);
    },
  },
  payments: {
    select: `p.id, p.reference, p.amount_kobo, p.fee_kobo, p.status, p.refund_status, p.disputed, p.created_at, p.verified_at, p.booking_id, p.plan_purchase_id,
      COALESCE(b.service_name, pp.plan_name) AS item, cu.name AS customer_name`,
    from: `payments p LEFT JOIN bookings b ON b.id=p.booking_id LEFT JOIN plan_purchases pp ON pp.id=p.plan_purchase_id LEFT JOIN users cu ON cu.id=COALESCE(b.customer_id, pp.customer_id)`, id: 'p.id',
    sorts: { newest: { expr: 'p.id', type: 'int' }, amount: { expr: 'p.amount_kobo', type: 'int' } }, defSort: 'newest',
    where: (q, add) => {
      const f = String(q.filter || 'all');
      if (f === 'paid') add(`p.status='SUCCESS'`); else if (f === 'failed') add(`p.status='FAILED'`); else if (f === 'initiated') add(`p.status='INITIATED'`);
      else if (f === 'refunds') add('p.refund_status IS NOT NULL'); else if (f === 'needs_refund') add(`p.refund_status IN ('NEEDS_REFUND','REFUND_REQUESTED')`); else if (f === 'disputed') add('p.disputed');
      const s = String(q.q || '').trim().slice(0, 60); if (s) add('lower(p.reference) LIKE lower(?)', like(s));
    },
  },
  purchases: {
    select: `pp.id, pp.plan_name, pp.price_kobo, pp.sessions_total, pp.sessions_used, pp.status, pp.paid_at, pp.expires_at, pp.customer_id, b.shop_name, u.name AS customer_name,
      (pp.status='ACTIVE' AND pp.expires_at > now() AND pp.sessions_used < pp.sessions_total) AS live`,
    from: 'plan_purchases pp JOIN barbers b ON b.id=pp.barber_id JOIN users u ON u.id=pp.customer_id', id: 'pp.id',
    sorts: { newest: { expr: 'pp.id', type: 'int' } }, defSort: 'newest',
    where: (q, add) => {
      const st = String(q.status || '').toUpperCase(); if (['ACTIVE', 'CANCELLED'].includes(st)) add('pp.status=?', st); else add(`pp.status IN ('ACTIVE','CANCELLED')`);
      const s = String(q.q || '').trim().slice(0, 60); if (s) add('(lower(u.name) LIKE lower(?) OR lower(pp.plan_name) LIKE lower(?))', like(s), like(s));
    },
  },
  plans: {
    select: `p.id, p.name, p.price_kobo, p.sessions, p.validity_days, p.active, b.shop_name, (SELECT COUNT(*)::int FROM plan_purchases pp WHERE pp.plan_id=p.id AND pp.status='ACTIVE') AS buyers`,
    from: 'plans p JOIN barbers b ON b.id=p.barber_id', id: 'p.id', sorts: { newest: { expr: 'p.id', type: 'int' } }, defSort: 'newest',
    where: (q, add) => { add('p.deleted_at IS NULL'); if (q.active === '1') add('p.active'); if (q.active === '0') add('NOT p.active'); const s = String(q.q || '').trim().slice(0, 60); if (s) add('(lower(p.name) LIKE lower(?) OR lower(b.shop_name) LIKE lower(?))', like(s), like(s)); },
  },
  credits: {
    select: `sc.id, sc.customer_id, sc.reason, sc.status, sc.value_kobo, sc.expires_at, sc.created_at, b.shop_name, u.name AS customer_name, (sc.status='AVAILABLE' AND sc.expires_at > now()) AS live`,
    from: 'session_credits sc JOIN barbers b ON b.id=sc.barber_id JOIN users u ON u.id=sc.customer_id', id: 'sc.id', sorts: { newest: { expr: 'sc.id', type: 'int' } }, defSort: 'newest',
    where: (q, add) => { const st = String(q.status || '').toUpperCase(); if (['AVAILABLE', 'USED', 'REVOKED'].includes(st)) add('sc.status=?', st); const s = String(q.q || '').trim().slice(0, 60); if (s) add('lower(u.name) LIKE lower(?)', like(s)); },
  },
  reports: {
    select: `r.id, r.category, r.status, r.message, r.created_at, r.booking_id, r.reporter_id, r.target_user_id, ru.name AS reporter_name, tu.name AS target_name, EXISTS (SELECT 1 FROM help_requests hr WHERE hr.report_id=r.id) AS staff_alert`,
    from: 'reports r JOIN users ru ON ru.id=r.reporter_id LEFT JOIN users tu ON tu.id=r.target_user_id', id: 'r.id', sorts: { newest: { expr: 'r.id', type: 'int' } }, defSort: 'newest',
    where: (q, add) => { add('r.deleted_at IS NULL'); const st = String(q.status || '').toUpperCase(); if (['OPEN', 'RESOLVED', 'DISMISSED'].includes(st)) add('r.status=?', st); const c = String(q.category || '').toUpperCase(); if (['NO_SHOW', 'BEHAVIOUR', 'PAYMENT', 'QUALITY', 'SAFETY', 'OTHER'].includes(c)) add('r.category=?', c); },
  },
  reviews: {
    select: `r.id, r.rating, r.comment, r.reply, r.hidden, r.created_at, r.booking_id, b.shop_name, u.name AS customer_name`,
    from: 'reviews r JOIN barbers b ON b.id=r.barber_id JOIN users u ON u.id=r.customer_id', id: 'r.id', sorts: { newest: { expr: 'r.id', type: 'int' }, rating: { expr: 'r.rating', type: 'int' } }, defSort: 'newest',
    where: (q, add) => { add('r.deleted_at IS NULL'); if (q.hidden === '1') add('r.hidden'); if (q.hidden === '0') add('NOT r.hidden'); const rt = intQ(q.rating); if (rt && rt <= 5) add('r.rating=?', rt); const bid = intQ(q.barber_id); if (bid) add('r.barber_id=?', bid); },
  },
  waitlist: {
    select: `w.id, w.date, w.status, w.created_at, w.notified_at, w.customer_id, b.shop_name, s.name AS service_name, u.name AS customer_name, u.avatar_url AS customer_avatar`,
    from: 'waitlist w JOIN barbers b ON b.id=w.barber_id JOIN services s ON s.id=w.service_id JOIN users u ON u.id=w.customer_id', id: 'w.id', sorts: { newest: { expr: 'w.id', type: 'int' } }, defSort: 'newest',
    where: (q, add) => { const st = String(q.status || '').toUpperCase(); if (['WAITING', 'NOTIFIED', 'BOOKED', 'CANCELLED', 'EXPIRED'].includes(st)) add('w.status=?', st); },
  },
  broadcasts: {
    select: 'id, audience, user_id, title, body, recipients, created_at', from: 'broadcasts', id: 'id', sorts: { newest: { expr: 'id', type: 'int' } }, defSort: 'newest', where: () => {},
  },
  ledger: {
    select: `x.id, x.shop_name, x.review_status, x.owed_kobo, x.open_entries, x.oldest`,
    from: `(SELECT b.id, b.shop_name, b.review_status, COALESCE(SUM(l.remaining_kobo),0)::bigint AS owed_kobo, COUNT(l.id)::int AS open_entries, MIN(l.created_at) AS oldest
            FROM barbers b JOIN commission_ledger l ON l.barber_id=b.id AND l.status='ACCRUED' GROUP BY b.id) x`, id: 'x.id',
    sorts: { newest: { expr: 'x.id', type: 'int' }, owed: { expr: 'x.owed_kobo', type: 'int' } }, defSort: 'owed',
    where: (q, add) => { const s = String(q.q || '').trim().slice(0, 60); if (s) add('lower(x.shop_name) LIKE lower(?)', like(s)); if (q.overdue === '1') add(`x.oldest < now() - interval '14 days'`); },
    after: (rows) => rows.map((r) => ({ ...r, owed_kobo: Number(r.owed_kobo) })),
  },
};

export function registerAdmin3(api: Router, db: Db, guard: any, wrap: (fn: H) => any) {
  const get = (p: string, fn: H) => api.get('/admin' + p, guard, wrap(fn));
  const post = (p: string, fn: H) => api.post('/admin' + p, guard, wrap(fn));

  /* ---- generic paginated lists: GET /admin/l/:list?q&status&sort&dir&limit&cursor ---- */
  get('/l/:list', async (req, res) => {
    const cfg = CFG[req.params.list]; if (!cfg) throw notFound('We do not know that list.');
    res.json(await pageOf(db, cfg, req.query));
  });
  /* tab counts for a list (cheap, index-backed) */
  get('/counts/:what', async (req, res) => {
    const w = req.params.what;
    if (w === 'barbers') { const r = await db.many<any>('SELECT b.review_status s, COUNT(*)::int n FROM barbers b JOIN users u ON u.id=b.user_id WHERE u.deleted_at IS NULL GROUP BY b.review_status'); const o: any = { ALL: 0 }; for (const x of r) { o[x.s] = x.n; o.ALL += x.n; } return void res.json(o); }
    if (w === 'reports') { const r = await db.many<any>('SELECT status s, COUNT(*)::int n FROM reports WHERE deleted_at IS NULL GROUP BY status'); const o: any = {}; for (const x of r) o[x.s] = x.n; return void res.json(o); }
    if (w === 'customers') { const r = await db.many<any>(`SELECT account_status s, COUNT(*)::int n FROM users WHERE role='customer' AND deleted_at IS NULL GROUP BY account_status`); const o: any = { ALL: 0 }; for (const x of r) { o[x.s] = x.n; o.ALL += x.n; } return void res.json(o); }
    throw notFound('We do not know that count.');
  });

  /* ---- home: a handful of numbers + things that need attention (cached for 10 s) ---- */
  let homeCache: { at: number; v: any } | null = null;
  get('/home', async (_req, res) => {
    if (homeCache && Date.now() - homeCache.at < 10000) return void res.json(homeCache.v);
    const today = lagosDate();
    const r = await db.one<any>(`SELECT
        (SELECT COUNT(*) FROM barbers b JOIN users u ON u.id=b.user_id WHERE u.deleted_at IS NULL AND b.review_status IN ('PENDING','NEEDS_INFO'))::int AS barbers_pending,
        (SELECT COUNT(*) FROM barbers WHERE verified)::int AS barbers_live,
        (SELECT COUNT(*) FROM users WHERE role='customer' AND deleted_at IS NULL)::int AS customers,
        (SELECT COUNT(*) FROM bookings WHERE date=$1 AND status IN ('CONFIRMED','ARRIVED','IN_SERVICE','COMPLETED'))::int AS bookings_today,
        (SELECT COALESCE(SUM(amount_kobo),0) FROM payments WHERE status='SUCCESS' AND verified_at >= now() - interval '30 days')::bigint AS revenue_30d_kobo,
        (SELECT COUNT(*) FROM payments WHERE refund_status IN ('NEEDS_REFUND','REFUND_REQUESTED'))::int AS refunds_open,
        (SELECT COUNT(*) FROM bookings WHERE payment_status IN ('CREDIT_PENDING','REFUND_PENDING'))::int AS awaiting_decision,
        (SELECT COUNT(*) FROM reports WHERE status='OPEN' AND deleted_at IS NULL)::int AS reports_open,
        (SELECT COUNT(DISTINCT barber_id) FROM commission_ledger WHERE status='ACCRUED' AND created_at < now() - interval '14 days')::int AS ledger_overdue,
        (SELECT COALESCE(SUM(remaining_kobo),0) FROM commission_ledger WHERE status='ACCRUED')::bigint AS ledger_owed_kobo,
        (SELECT maintenance_mode FROM platform_settings WHERE id=1) AS maintenance_mode`, [today]);
    const attention = [
      { key: 'barbers', label: 'Shops waiting for review', n: r.barbers_pending, href: '#/barbers?status=PENDING', tone: 'amber' },
      { key: 'refunds', label: 'Refunds that need action', n: r.refunds_open, href: '#/payments?filter=needs_refund', tone: 'red' },
      { key: 'decisions', label: 'Cancellations that need a decision', n: r.awaiting_decision, href: '#/decisions', tone: 'amber' },
      { key: 'reports', label: 'Open reports', n: r.reports_open, href: '#/reports?status=OPEN', tone: 'red' },
      { key: 'ledger', label: 'Barbers who are late paying', n: r.ledger_overdue, href: '#/ledger?overdue=1', tone: 'amber', sub: Number(r.ledger_owed_kobo) },
    ];
    const v = { today, numbers: { customers: r.customers, barbers_live: r.barbers_live, bookings_today: r.bookings_today, revenue_30d_kobo: Number(r.revenue_30d_kobo) }, attention, maintenance_mode: r.maintenance_mode, generated_at: isoNow() };
    homeCache = { at: Date.now(), v }; res.json(v);
  });

  /* ---- cron heartbeat: when the 1-minute timer last reached /api/cron/sweep (stamped by the endpoint on every authorised hit) ---- */
  get('/cron-status', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const r = await db.maybeOne<any>('SELECT cron_last_run_at, cron_last_ok_at, cron_last_error FROM platform_settings WHERE id=1');
    const last = r?.cron_last_run_at ? new Date(r.cron_last_run_at).toISOString() : null;
    const age = last ? Math.max(0, Math.round((clock.now().getTime() - new Date(last).getTime()) / 1000)) : null;
    res.json({ last_run_at: last, last_ok_at: r?.cron_last_ok_at ? new Date(r.cron_last_ok_at).toISOString() : null, last_error: r?.cron_last_error || null, age_seconds: age,
      status: age == null ? 'never' : (age > 180 ? 'late' : (r?.cron_last_error ? 'error' : 'ok')), warn_after_seconds: 180, now: isoNow() });
  });

  /* ---- a barber's private share link (+ QR) so the admin can send it. Admin only; the customers' private-links rule does not apply here. ---- */
  get('/barbers/:id/share', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const id = Number(req.params.id);
    const b = Number.isInteger(id) ? await db.maybeOne<any>('SELECT b.id, b.verified, b.shop_name FROM barbers b JOIN users u ON u.id=b.user_id WHERE b.id=$1 AND u.deleted_at IS NULL', [id]) : undefined;
    if (!b) throw notFound('We could not find that barber.');
    const code = await ensureShareCode(db, id);
    const url = absolute(req, `/b/${code}`);
    const qr_svg = await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
    res.json({ barber_id: id, shop_name: b.shop_name, code, path: `/b/${code}`, url, active: !!b.verified, qr_svg });
  });

  /* ---- command palette: people, shops, bookings by #id, payments by reference (index-backed, 5 each) ---- */
  get('/palette', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q.length < 2) return void res.json({ q, users: [], barbers: [], bookings: [], payments: [] });
    const l = like(q); const n = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : null;
    const [users, barbers, bookings, payments] = await Promise.all([
      db.many(`SELECT id, role, name, email, phone FROM users WHERE deleted_at IS NULL AND (lower(name) LIKE lower($1) OR lower(email) LIKE lower($1) OR phone LIKE $1 ${n ? 'OR id=' + n : ''}) ORDER BY id DESC LIMIT 5`, [l]),
      db.many(`SELECT b.id, b.shop_name, b.review_status, u.name FROM barbers b JOIN users u ON u.id=b.user_id WHERE u.deleted_at IS NULL AND (lower(b.shop_name) LIKE lower($1) ${n ? 'OR b.id=' + n : ''}) ORDER BY b.id DESC LIMIT 5`, [l]),
      n ? db.many(`SELECT k.id, k.service_name, k.status, k.date, u.name AS customer_name FROM bookings k JOIN users u ON u.id=k.customer_id WHERE k.id=$1`, [n]) : Promise.resolve([]),
      db.many(`SELECT reference, amount_kobo, status, booking_id FROM payments WHERE lower(reference) LIKE lower($1) ORDER BY id DESC LIMIT 5`, [q.replace(/[\\%_]/g, '') + '%']),
    ]);
    res.json({ q, users, barbers, bookings, payments });
  });

  /* ---- payment detail on demand (list rows stay lean) ---- */
  get('/payments/:reference', async (req, res) => {
    const p = await db.maybeOne<any>(`SELECT p.*, COALESCE(b.service_name, pp.plan_name) AS item, cu.name AS customer_name, cu.email AS customer_email, br.shop_name
        FROM payments p LEFT JOIN bookings b ON b.id=p.booking_id LEFT JOIN plan_purchases pp ON pp.id=p.plan_purchase_id LEFT JOIN users cu ON cu.id=COALESCE(b.customer_id, pp.customer_id)
        LEFT JOIN barbers br ON br.id=COALESCE(b.barber_id, pp.barber_id) WHERE p.reference=$1`, [req.params.reference]);
    if (!p) throw notFound('We could not find that payment.');
    delete p.authorization_url;
    res.json({ payment: p });
  });

  /* ---- reviews moderation ---- */
  post('/reviews/:id/hide', async (req, res) => {
    const id = intQ(req.params.id); if (!id) throw notFound();
    const d = z.object({ hidden: z.boolean(), reason: z.string().trim().min(3).max(300) }).safeParse(req.body); if (!d.success) throw badRequest('Write a reason (at least 3 letters).');
    res.json(await db.tx(async (t) => {
      const r = await t.query('UPDATE reviews SET hidden=$2 WHERE id=$1', [id, d.data.hidden]); if (!r.rowCount) throw notFound('We could not find that review.');
      await audit(t, null, ADMIN, d.data.hidden ? 'ADMIN_REVIEW_HIDDEN' : 'ADMIN_REVIEW_RESTORED', { review_id: id, reason: d.data.reason });
      return { hidden: d.data.hidden };
    }));
  });

  /* ---- bulk actions (max 200 ids, one audit row per batch, per-item outcome counts) ---- */
  const ids = z.array(z.coerce.number().int().positive()).min(1).max(200);
  const reason = z.string().trim().min(3, 'Write a reason (at least 3 letters).').max(500);
  const parse = <T extends z.ZodTypeAny>(s: T, b: unknown): z.infer<T> => { const r = s.safeParse(b ?? {}); if (!r.success) throw badRequest(r.error.issues[0]?.message || 'Please check what you typed and try again.'); return r.data; };
  post('/bulk/notify', async (req, res) => {
    const d = parse(z.object({ ids, title: z.string().trim().min(2).max(80), body: z.string().trim().min(3).max(500) }), req.body);
    res.json(await db.tx(async (t) => {
      const r = await t.query(`INSERT INTO notifications (user_id, type, title, body, is_read, created_at) SELECT id, 'ADMIN_MESSAGE', $2, $3, FALSE, $4 FROM users WHERE id = ANY($1::int[]) AND account_status='ACTIVE'`, [d.ids, d.title, d.body, isoNow()]);
      await audit(t, null, ADMIN, 'ADMIN_BULK_NOTIFY', { requested: d.ids.length, sent: r.rowCount, title: d.title });
      return { sent: r.rowCount, skipped: d.ids.length - r.rowCount };
    }));
  });
  post('/bulk/customers/:action', async (req, res) => {
    const act = req.params.action; if (!['warn', 'suspend', 'reinstate'].includes(act)) throw notFound();
    const d = parse(z.object({ ids, reason: act === 'reinstate' ? z.string().optional() : reason }), req.body);
    res.json(await db.tx(async (t) => {
      const users = await t.many<any>(`SELECT id, account_status FROM users WHERE id = ANY($1::int[]) AND role='customer' FOR UPDATE`, [d.ids]);
      let changed = 0;
      for (const u of users) {
        if (act === 'warn') { await t.query('UPDATE users SET warn_count=warn_count+1 WHERE id=$1', [u.id]); await notify(t, u.id, 'ACCOUNT_WARNING', 'Warning from TrimSlot', d.reason!); changed++; }
        else if (act === 'suspend' && u.account_status === 'ACTIVE') { await t.query(`UPDATE users SET account_status='SUSPENDED', status_reason=$2, status_at=$3 WHERE id=$1`, [u.id, d.reason, isoNow()]); await notify(t, u.id, 'ACCOUNT_SUSPENDED', 'Account suspended', `Your TrimSlot account is suspended: ${d.reason}`); changed++; }
        else if (act === 'reinstate' && u.account_status !== 'ACTIVE') { await t.query(`UPDATE users SET account_status='ACTIVE', status_reason=NULL, status_at=$2 WHERE id=$1`, [u.id, isoNow()]); await notify(t, u.id, 'ACCOUNT_REINSTATED', 'Account restored', 'Your TrimSlot account works again.'); changed++; }
      }
      await audit(t, null, ADMIN, 'ADMIN_BULK_' + act.toUpperCase(), { requested: d.ids.length, changed, reason: d.reason ?? null, user_ids: users.map((u) => u.id).slice(0, 50) });
      return { changed, skipped: d.ids.length - changed };
    }));
  });
  post('/bulk/barbers/approve', async (req, res) => {
    const d = parse(z.object({ ids }), req.body);
    res.json(await db.tx(async (t) => {
      const rows = await t.many<any>(`SELECT id, user_id, shop_name FROM barbers WHERE id = ANY($1::int[]) AND review_status IN ('PENDING','NEEDS_INFO','REJECTED') FOR UPDATE`, [d.ids]);
      for (const b of rows) {
        await t.query(`UPDATE barbers SET review_status='VERIFIED', review_reason=NULL, reviewed_at=$2, verified_at=COALESCE(verified_at,$2::timestamptz) WHERE id=$1`, [b.id, isoNow()]);
        await notify(t, b.user_id, 'BARBER_VERIFIED', 'Your shop is live', `${b.shop_name} is now visible to customers. It can take bookings.`);
      }
      await audit(t, null, ADMIN, 'ADMIN_BULK_APPROVE_BARBERS', { requested: d.ids.length, approved: rows.length, barber_ids: rows.map((b) => b.id) });
      return { changed: rows.length, skipped: d.ids.length - rows.length };
    }));
  });
  post('/bulk/reports/resolve', async (req, res) => {
    const d = parse(z.object({ ids, status: z.enum(['RESOLVED', 'DISMISSED']), note: reason }), req.body);
    res.json(await db.tx(async (t) => {
      const rows = await t.many<any>(`UPDATE reports SET status=$2, admin_note=$3, resolved_at=$4 WHERE id = ANY($1::int[]) AND status='OPEN' RETURNING id, reporter_id`, [d.ids, d.status, d.note, isoNow()]);
      for (const r of rows) if (!(await t.maybeOne('SELECT 1 FROM help_requests WHERE report_id=$1', [r.id]))) await notify(t, r.reporter_id, 'REPORT_UPDATE', d.status === 'RESOLVED' ? 'Your report was resolved' : 'Your report was reviewed', d.note);
      await audit(t, null, ADMIN, 'ADMIN_BULK_REPORTS_' + d.status, { requested: d.ids.length, closed: rows.length, note: d.note });
      return { changed: rows.length, skipped: d.ids.length - rows.length };
    }));
  });
  post('/bulk/reviews/hide', async (req, res) => {
    const d = parse(z.object({ ids, hidden: z.boolean(), reason }), req.body);
    res.json(await db.tx(async (t) => {
      const r = await t.query('UPDATE reviews SET hidden=$2 WHERE id = ANY($1::int[]) AND hidden <> $2', [d.ids, d.hidden]);
      await audit(t, null, ADMIN, d.hidden ? 'ADMIN_BULK_REVIEWS_HIDDEN' : 'ADMIN_BULK_REVIEWS_RESTORED', { requested: d.ids.length, changed: r.rowCount, reason: d.reason });
      return { changed: r.rowCount, skipped: d.ids.length - r.rowCount };
    }));
  });
  post('/bulk/credits/revoke', async (req, res) => {
    const d = parse(z.object({ ids, reason }), req.body);
    await requirePin(db, req);
    res.json(await db.tx(async (t) => {
      const rows = await t.many<any>(`UPDATE session_credits SET status='REVOKED' WHERE id = ANY($1::int[]) AND status='AVAILABLE' RETURNING id, customer_id`, [d.ids]);
      for (const r of rows) await notify(t, r.customer_id, 'CREDIT_REVOKED', 'Credit removed', `A session credit was removed by TrimSlot: ${d.reason}`);
      await audit(t, null, ADMIN, 'ADMIN_BULK_CREDITS_REVOKED', { requested: d.ids.length, changed: rows.length, reason: d.reason });
      return { changed: rows.length, skipped: d.ids.length - rows.length };
    }));
  });

  /* ledger "overdue" flag helper for the drill-in (blocked reason is computed on demand, not per list row) */
  get('/ledger-status/:id', async (req, res) => { const id = intQ(req.params.id); if (!id) throw notFound(); res.json(await ledgerBlocked(db, id, await getSettings(db))); });
  void AppError;
}
