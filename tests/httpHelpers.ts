import assert from 'node:assert/strict';
import { AddressInfo } from 'net';
import { freshDb, setNow, resetNow, WED } from './helpers';
import { createApp } from '../src/app';

/** Boots the real Express app on a random port against a fresh test database, with the clock fixed on WED 08:00 Lagos. */
export async function bootApp(at = `${WED}T08:00:00+01:00`) {
  setNow(at);
  const s = await freshDb();
  const server = createApp(s.db).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: any, cookie?: string) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const login = async (identifier: string, password: string) => {
    const r = await call('POST', '/api/auth/login', { identifier, password });
    assert.equal(r.status, 200, r.text);
    return r.headers.get('set-cookie')!.split(';')[0];
  };
  const chidi = () => login('chidi@trimslot.demo', 'Customer123!');
  const tunde = () => login('tunde@trimslot.demo', 'Customer123!');
  const mike = () => login('mike@trimslot.demo', 'Barber123!');
  const close = () => { server.close(); resetNow(); };
  return { ...s, server, base, call, login, chidi, tunde, mike, close };
}
export type App = Awaited<ReturnType<typeof bootApp>>;
