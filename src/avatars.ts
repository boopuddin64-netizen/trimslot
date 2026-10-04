/** Customer profile pictures. Same storage approach as shop photos (barber_photos): ONE small client-compressed (square, ~256 px JPEG) image per user,
 *  stored in Postgres and served through an authenticated route. Visible to: the customer, barbers who have a booking / waitlist entry with them, and admins. */
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { Db } from './db';
import { AppError, badRequest, notFound } from './errors';
import { audit, notify } from './helpers';
import { isoNow } from './time';

type H = (req: Request, res: Response) => Promise<any>;
export const MAX_AVATAR_BYTES = 120 * 1024;
export function sniffImage(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
const urlFor = (id: number) => `/api/avatars/${id}?v=${Date.now().toString(36)}`;

/** PUT /api/me/avatar - raw image bytes. Mounted by app.ts BEFORE the JSON body parser (like the shop photo upload). */
export function avatarUploadHandler(db: Db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.user!.role !== 'customer') throw new AppError(403, 'FORBIDDEN', 'Only customers add a profile picture. Barbers add a shop photo in Settings.');
      const buf: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : Buffer.isBuffer((req as any).rawBody) ? (req as any).rawBody : undefined;
      if (!buf || !buf.length) throw badRequest('Send the picture as a JPEG, PNG or WebP image.');
      if (buf.length > MAX_AVATAR_BYTES) throw new AppError(413, 'PHOTO_TOO_LARGE', `That picture is too big. Keep it under ${Math.round(MAX_AVATAR_BYTES / 1024)} KB.`);
      const mime = sniffImage(buf);
      if (!mime) throw badRequest('Use a JPEG, PNG or WebP picture.');
      if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== mime) throw badRequest('We could not read that picture. Try a different one.');
      const id = req.user!.id; const url = urlFor(id);
      await db.tx(async (t) => {
        await t.query(`INSERT INTO user_avatars (user_id, mime, data, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`, [id, mime, buf, isoNow()]);
        await t.query('UPDATE users SET avatar_url=$2, avatar_removed_at=NULL WHERE id=$1', [id, url]);
      });
      res.json({ ok: true, avatar_url: url });
    } catch (e) { next(e); }
  };
}

export function registerAvatars(api: Router, db: Db, wrap: (fn: H) => any, requireAuth: any, adminGuard: any) {
  const ADMIN = { id: null as number | null, role: 'admin' as const };
  const send = (res: Response, p: { mime: string; data: Buffer }, cache: string) => {
    res.setHeader('Content-Type', p.mime); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', cache); res.send(p.data);
  };
  api.get('/avatars/:id', requireAuth, wrap(async (req, res) => {
    const id = Number(req.params.id); if (!Number.isInteger(id) || id < 1) throw notFound('There is no picture.');
    const me = req.user!;
    let ok = me.id === id;
    if (!ok && me.role === 'barber' && me.barberId) {
      ok = !!(await db.maybeOne(`SELECT 1 AS x FROM bookings WHERE barber_id=$1 AND customer_id=$2 UNION ALL SELECT 1 FROM waitlist WHERE barber_id=$1 AND customer_id=$2 LIMIT 1`, [me.barberId, id]));
    }
    const p = ok ? await db.maybeOne<{ mime: string; data: Buffer }>('SELECT mime, data FROM user_avatars WHERE user_id=$1', [id]) : undefined;
    if (!p) throw notFound('There is no picture.');
    send(res, p, req.query.v ? 'private, max-age=31536000, immutable' : 'private, max-age=60');
  }));
  api.delete('/me/avatar', requireAuth, wrap(async (req, res) => {
    await db.tx(async (t) => { await t.query('DELETE FROM user_avatars WHERE user_id=$1', [req.user!.id]); await t.query('UPDATE users SET avatar_url=NULL WHERE id=$1', [req.user!.id]); });
    res.json({ ok: true });
  }));
  /* ---------- admin ---------- */
  api.get('/admin/avatars/:id', adminGuard, wrap(async (req, res) => {
    const id = Number(req.params.id); if (!Number.isInteger(id) || id < 1) throw notFound('There is no picture.');
    const p = await db.maybeOne<{ mime: string; data: Buffer }>('SELECT mime, data FROM user_avatars WHERE user_id=$1', [id]);
    if (!p) throw notFound('There is no picture.');
    send(res, p, 'private, no-store');
  }));
  /** Moderation: remove a customer's picture (the reason is shown to the customer). */
  api.post('/admin/users/:id/avatar/remove', adminGuard, wrap(async (req, res) => {
    const id = Number(req.params.id); if (!Number.isInteger(id) || id < 1) throw notFound('We could not find that user.');
    const d = z.object({ reason: z.string().trim().min(3, 'Write a short reason.').max(200) }).safeParse(req.body ?? {});
    if (!d.success) throw badRequest(d.error.issues[0]?.message || 'Write a short reason.');
    res.json(await db.tx(async (t) => {
      const u = await t.maybeOne<any>(`SELECT id, avatar_url FROM users WHERE id=$1 AND role='customer' FOR UPDATE`, [id]);
      if (!u) throw notFound('We could not find that customer.');
      if (!u.avatar_url) return { removed: false };
      await t.query('DELETE FROM user_avatars WHERE user_id=$1', [id]);
      await t.query('UPDATE users SET avatar_url=NULL, avatar_removed_at=$2 WHERE id=$1', [id, isoNow()]);
      await audit(t, null, ADMIN, 'ADMIN_AVATAR_REMOVED', { user_id: id, reason: d.data.reason });
      await notify(t, id, 'AVATAR_REMOVED', 'Profile picture removed', `TrimSlot removed your profile picture: ${d.data.reason}. You can add a different one.`);
      return { removed: true };
    }));
  }));
}
