/* Private barber share links.
 *  - Customers never see a list of all barbers. A barber has a private link /b/<code> (with a QR code); opening it shows the shop and lets the
 *    customer add the barber to "My barbers". A customer may use a barber only when they added them, opened their link, or have booked them before.
 *  - The barber can make a new code at any time; the old link stops working at once.
 *  - Admin routes (Bearer admin key) are separate and still see every barber. */
import crypto from 'crypto';
import QRCode from 'qrcode';
import { NextFunction, Request, Response, Router } from 'express';
import { Conn, Db } from './db';
import { requireRole } from './auth';
import { config } from './config';
import { notFound } from './errors';
import { audit } from './helpers';
import { getSettingsCached } from './plans';
import { isoNow } from './time';
import * as S from './smart';

type H = (req: Request, res: Response) => any;
type U = { id: number; role: string; barberId?: number | null } | undefined;

export const CODE_RE = /^[a-f0-9]{12,32}$/;
/** 64 random bits: unguessable, and safe to paste in a chat. */
export const newShareCode = () => crypto.randomBytes(8).toString('hex');

export async function ensureShareCode(c: Conn, barberId: number): Promise<string> {
  const r = await c.one<{ share_code: string | null }>('SELECT share_code FROM barbers WHERE id=$1', [barberId]);
  if (r.share_code) return r.share_code;
  for (let i = 0; i < 5; i++) {
    const code = newShareCode();
    const u = await c.maybeOne<{ share_code: string }>('UPDATE barbers SET share_code=$1 WHERE id=$2 AND share_code IS NULL RETURNING share_code', [code, barberId]);
    if (u) return u.share_code;
    const again = await c.one<{ share_code: string | null }>('SELECT share_code FROM barbers WHERE id=$1', [barberId]);
    if (again.share_code) return again.share_code;
  }
  throw new Error('could not create a share code');
}

/** New code; the old link stops working immediately. */
export async function regenerateShareCode(t: Conn, barberId: number, actor: { id: number; role: 'barber' | 'admin' }): Promise<string> {
  const code = newShareCode();
  await t.query('UPDATE barbers SET share_code=$1, share_code_rotated_at=$2 WHERE id=$3', [code, isoNow(), barberId]);
  await audit(t, null, actor, 'SHARE_CODE_ROTATED', { barber_id: barberId, note: 'old link no longer works' });
  return code;
}

export const barberByCode = (c: Conn, code: string) =>
  CODE_RE.test(code) ? c.maybeOne<any>('SELECT b.*, u.name FROM barbers b JOIN users u ON u.id=b.user_id WHERE b.share_code=$1 AND b.verified', [code]) : Promise.resolve(undefined);

/** May this signed-in user see / book this barber? Barbers: only themselves. Customers: added, opened by link, or booked before. */
export async function canUseBarber(c: Conn, user: U, barberId: number): Promise<boolean> {
  if (!user) return false;
  if (user.role === 'barber') return user.barberId === barberId;
  if (user.role !== 'customer') return false;
  const r = await c.maybeOne('SELECT 1 FROM customer_barbers WHERE customer_id=$1 AND barber_id=$2 UNION ALL SELECT 1 FROM bookings WHERE customer_id=$1 AND barber_id=$2 LIMIT 1', [user.id, barberId]);
  return !!r;
}

/** Remember a barber for a customer. `added=true` puts them in "My barbers"; an opened link alone only grants access. */
export async function rememberBarber(c: Conn, customerId: number, barberId: number, source: 'link' | 'booking' | 'favourite', added: boolean) {
  await c.query(`INSERT INTO customer_barbers (customer_id, barber_id, added, source, created_at) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (customer_id, barber_id) DO UPDATE SET added = customer_barbers.added OR EXCLUDED.added`, [customerId, barberId, added, source, isoNow()]);
}

export const myBarbers = (c: Conn, customerId: number) => c.many(
  `SELECT b.id, b.shop_name, b.photo_url, b.location, b.share_code, u.name, cb.created_at AS added_at, (f.customer_id IS NOT NULL) AS favourite,
          (SELECT MAX(k.date) FROM bookings k WHERE k.customer_id=cb.customer_id AND k.barber_id=b.id) AS last_booked
     FROM customer_barbers cb JOIN barbers b ON b.id=cb.barber_id AND b.verified JOIN users u ON u.id=b.user_id
     LEFT JOIN favourites f ON f.customer_id=cb.customer_id AND f.barber_id=b.id
    WHERE cb.customer_id=$1 AND cb.added ORDER BY (f.customer_id IS NOT NULL) DESC, last_booked DESC NULLS LAST, cb.created_at DESC`, [customerId]);

/** Removing a barber hides them from "My barbers". Without a booking history it also ends access (the link is needed again). */
export async function removeBarber(c: Conn, customerId: number, barberId: number) {
  const booked = await c.maybeOne('SELECT 1 FROM bookings WHERE customer_id=$1 AND barber_id=$2 LIMIT 1', [customerId, barberId]);
  if (booked) await c.query('UPDATE customer_barbers SET added=FALSE WHERE customer_id=$1 AND barber_id=$2', [customerId, barberId]);
  else await c.query('DELETE FROM customer_barbers WHERE customer_id=$1 AND barber_id=$2', [customerId, barberId]);
}

/** The photo is only a picture, but ids are guessable, so it needs the same access (or the link's own code). */
export async function photoAllowed(c: Conn, req: Request, barberId: number): Promise<boolean> {
  const k = typeof req.query.k === 'string' ? req.query.k : '';
  if (k && CODE_RE.test(k) && (await c.maybeOne('SELECT 1 FROM barbers WHERE id=$1 AND share_code=$2 AND verified', [barberId, k]))) return true;
  return canUseBarber(c, req.user as U, barberId);
}

const idOf = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };

/** Mounted first on the API router: every customer-facing, barber-specific route needs access. A barber without access simply "does not exist". */
export function barberAccessGuard(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      let barberId = 0;
      const m = /^\/barbers\/(\d+)(\/slots|\/reviews|\/favourite|\/share\/qr\.svg)?$/.exec(req.path);
      if (m) barberId = idOf(m[1]);
      else if (req.method === 'POST' && (req.path === '/bookings' || req.path === '/waitlist')) {
        if (!req.user) return next();                       // the route's own login check answers 401
        barberId = idOf((req.body || {}).barber_id);
        if (!barberId) return next();                       // validation answers
      } else {
        const pm = req.method === 'POST' ? /^\/plans\/(\d+)\/buy$/.exec(req.path) : null;
        if (!pm) return next();
        if (!req.user) return next();
        const pl = await db.maybeOne<{ barber_id: number }>('SELECT barber_id FROM plans WHERE id=$1', [idOf(pm[1])]);
        if (!pl) return next();
        barberId = pl.barber_id;
      }
      if (!barberId) return next(notFound('We could not find that barber.'));
      if (!(await canUseBarber(db, req.user as U, barberId))) return next(notFound('We could not find that barber.'));
      next();
    } catch (e) { next(e); }
  };
}

/** The link a customer who can use this barber may pass on. Only for barbers the guard already let the customer see. */
export async function shareLinkFor(c: Conn, req: Request, barberId: number, code?: string | null) {
  const cd = code || await ensureShareCode(c, barberId);
  return { url: absolute(req, `/b/${cd}`), qr_url: `/api/barbers/${barberId}/share/qr.svg?c=${cd.slice(0, 6)}` };
}
export async function myBarbersWithLinks(c: Conn, req: Request) {
  const rows = await myBarbers(c, req.user!.id) as any[];
  return Promise.all(rows.map(async ({ share_code, ...b }) => ({ ...b, share: await shareLinkFor(c, req, b.id, share_code) })));
}
export const absolute = (req: Request, path: string) => {
  const base = config.appBaseUrl && /^https?:\/\//.test(config.appBaseUrl) ? config.appBaseUrl.replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`;
  return base + path;
};

export function registerShareLinks(api: Router, barberR: Router, db: Db, wrap: (fn: H) => any, limits: { shareLink: any }, profileFor: (req: Request, b: any) => Promise<any>) {
  const cust = requireRole('customer');

  /* ----- barber side ----- */
  const shareView = async (req: Request) => {
    const bid = req.user!.barberId!;
    const code = await ensureShareCode(db, bid);
    const b = await db.one<{ verified: boolean; share_code_rotated_at: string | null }>('SELECT verified, share_code_rotated_at FROM barbers WHERE id=$1', [bid]);
    return { code, path: `/b/${code}`, url: absolute(req, `/b/${code}`), active: b.verified, rotated_at: b.share_code_rotated_at, qr_url: '/api/barber/share/qr.svg?c=' + code.slice(0, 6) };
  };
  barberR.get('/share', wrap(async (req, res) => res.json(await shareView(req))));
  barberR.get('/share/qr.svg', wrap(async (req, res) => {
    const v = await shareView(req);
    const svg = await QRCode.toString(v.url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
    res.setHeader('Content-Type', 'image/svg+xml'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(svg);
  }));
  barberR.post('/share/regenerate', wrap(async (req, res) => {
    await db.tx((t) => regenerateShareCode(t, req.user!.barberId!, { id: req.user!.id, role: 'barber' }));
    res.json(await shareView(req));
  }));

  /* ----- the public link ----- */
  api.get('/b/:code', limits.shareLink, wrap(async (req, res) => {
    const b = await barberByCode(db, String(req.params.code));
    if (!b) throw notFound('This link is not valid any more. Ask the barber for a new one.');
    const prof = await profileFor(req, b);
    const u = req.user as U;
    let added = false;
    if (u?.role === 'customer') {
      await rememberBarber(db, u.id, b.id, 'link', false);
      added = !!(await db.maybeOne('SELECT 1 FROM customer_barbers WHERE customer_id=$1 AND barber_id=$2 AND added', [u.id, b.id]));
    }
    const st = await getSettingsCached(db);
    const reviews = st.feature_reviews && prof.rating?.count ? await S.listReviews(db, b.id, { limit: 5 }) : [];
    const code = String(req.params.code);
    const card = prof.barber.photo_url && String(prof.barber.photo_url).startsWith('/api/barbers/') ? { ...prof.barber, photo_url: prof.barber.photo_url + (String(prof.barber.photo_url).includes('?') ? '&' : '?') + 'k=' + code } : prof.barber;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.json({ ...prof, barber: card, reviews, share: { code, added, can_add: u?.role === 'customer', logged_in: !!u, role: u?.role ?? null, ...(u?.role === 'customer' ? await shareLinkFor(db, req, b.id, code) : {}) } });
  }));
  api.post('/b/:code/add', limits.shareLink, cust, wrap(async (req, res) => {
    const b = await barberByCode(db, String(req.params.code));
    if (!b) throw notFound('This link is not valid any more. Ask the barber for a new one.');
    await rememberBarber(db, req.user!.id, b.id, 'link', true);
    res.json({ added: true, barber_id: b.id });
  }));

  /* ----- My barbers ----- */
  api.get('/me/barbers', cust, wrap(async (req, res) => {
    res.json({ barbers: await myBarbersWithLinks(db, req) });
  }));
  /** A customer who may use this barber (added, opened the link, or booked) can see and re-share the barber's link as a QR code too. */
  api.get('/barbers/:id/share/qr.svg', cust, wrap(async (req, res) => {
    const id = idOf(req.params.id);
    const b = await db.maybeOne<{ share_code: string | null }>('SELECT share_code FROM barbers WHERE id=$1 AND verified', [id]);
    if (!b) throw notFound('We could not find that barber.');
    const l = await shareLinkFor(db, req, id, b.share_code);
    const svg = await QRCode.toString(l.url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
    res.setHeader('Content-Type', 'image/svg+xml'); res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(svg);
  }));
  api.delete('/me/barbers/:id', cust, wrap(async (req, res) => { await removeBarber(db, req.user!.id, idOf(req.params.id)); res.json({ removed: true }); }));
}
