// Africa/Lagos is UTC+1 all year (no DST), so a fixed offset is exact.
const OFFSET_MIN = 60;
const OFFSET_STR = '+01:00';

let fakeOffsetMs: number | null = null; // test/demo: shifts "now", clock keeps ticking
export const clock = {
  now(): Date {
    return new Date(Date.now() + (fakeOffsetMs ?? 0));
  },
  /** Pretend "now" is `d` (clock keeps ticking from there). Pass null to reset. */
  set(d: Date | null) { fakeOffsetMs = d ? d.getTime() - Date.now() : null; },
  /** Freeze-free helper for tests: jump to an exact instant. */
  setExact(d: Date) { fakeOffsetMs = d.getTime() - Date.now(); },
};

export function initClockFromEnv() {
  const f = process.env.TRIMSLOT_FAKE_NOW;
  if (f && process.env.NODE_ENV !== 'production') {
    const d = new Date(f);
    if (!isNaN(d.getTime())) { clock.set(d); console.log(`[clock] TRIMSLOT_FAKE_NOW active: now = ${d.toISOString()}`); }
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

export function lagosParts(d: Date) {
  const s = new Date(d.getTime() + OFFSET_MIN * 60000);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate(), h: s.getUTCHours(), min: s.getUTCMinutes(), wd: s.getUTCDay() };
}
export function lagosDate(d: Date = clock.now()): string {
  const p = lagosParts(d);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
export function lagosMinutes(d: Date = clock.now()): number {
  const p = lagosParts(d);
  return p.h * 60 + p.min;
}
export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
/** 0=Sunday .. 6=Saturday for a YYYY-MM-DD calendar date */
export function weekdayOf(date: string): number {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}
export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
export function minToHhmm(m: number): string {
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
export function scheduledInstant(date: string, startMin: number): Date {
  return new Date(`${date}T${minToHhmm(startMin)}:00${OFFSET_STR}`);
}
export const isoNow = () => clock.now().toISOString();
