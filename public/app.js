/* TrimSlot frontend — vanilla JS SPA, hash routing, mobile-first. All rendering escapes user data. */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = (k) => '₦' + (k / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
const DAYN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYFULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const state = { user: null, cfg: null, unread: 0, wiz: null, poll: null, open: new Set(), setup: null };

/* Delegated handler for the "reload" link in the banks-unavailable message (inline handlers are blocked by the strict script-src). */
document.addEventListener('click', (ev) => { if (ev.target.closest && ev.target.closest('[data-reload]')) { ev.preventDefault(); location.reload(); } });

/* Identify once when the authenticated session becomes available. The numeric database id is the stable distinct id; PII stays on the person profile. */
let posthogUserId = null;
function identifyPostHogUser(user) {
  if (!user || user.id == null) return;
  const distinctId = String(user.id);
  if (posthogUserId === distinctId) return;
  if (posthogUserId) window.posthog?.reset();
  const properties = { name: user.name, role: user.role };
  if (user.email) properties.email = user.email;
  window.posthog?.identify(distinctId, properties);
  posthogUserId = distinctId;
}
window.resetPostHogUser = () => {
  if (posthogUserId) window.posthog?.reset();
  posthogUserId = null;
};

/* outline icon set (24px grid, stroke = currentColor) */
const ICONS = {
  more: '<circle cx="5" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.8" fill="currentColor" stroke="none"/>',
  share: '<path d="M12 15V3M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h14M19 12v7"/>', copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.4-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>', chat: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.7-.8L3 21l1.9-5.2A8.4 8.4 0 1 1 21 11.5Z"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>', sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z"/>', cal: '<rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  chev: '<path d="m6 9 6 6 6-6"/>', pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', card: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20"/>', cash: '<rect x="2" y="6" width="20" height="12" rx="3"/><circle cx="12" cy="12" r="2.5"/>',
  camera: '<path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3Z"/><circle cx="12" cy="13" r="3.5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  pencil: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  store: '<path d="M4 9h16l-1-5H5ZM5 9v11h14V9M9 20v-6h6v6"/>', tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01"/>',
  check: '<path d="m5 12 5 5 9-10"/>', back: '<path d="m15 18-6-6 6-6"/>', shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>', bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9Z"/>',
  ticket: '<path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1ZM14 5v14"/>', wallet: '<path d="M19 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v3M3 6v12a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3"/><path d="M21 12h-4a2 2 0 0 0 0 4h4Z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>', refresh: '<path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5"/>', play: '<path d="m7 4 13 8-13 8Z"/>', lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', right: '<path d="m9 6 6 6-6 6"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z"/>', heart: '<path d="M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 22l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8Z"/>', repeat: '<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/>', send: '<path d="m22 2-7 20-4-9-9-4ZM22 2 11 13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', off: '<path d="M18 6 6 18M6 6l12 12"/>',
};
const ic = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;
const initials = (t) => esc(String(t || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'TS');
const avatar = (b, cls = '', eager = false) => b.photo_url ? `<img class="avatar ${cls}" src="${esc(b.photo_url)}" alt="" decoding="async"${eager ? '' : ' loading="lazy"'}>` : `<div class="avatar ${cls}">${initials(b.shop_name || b.name)}</div>`;

/* customer avatar (round, initials fallback); implemented in account.js, safe if that file is missing */
const cav = (c, cls = '') => (window.Account ? Account.av(c, cls) : '');

const gcache = new Map(); // tiny GET cache: public, slow-changing data only (perceived speed when navigating back and forth)
const CACHEABLE = /^\/barbers$/; // Feature flags must be fetched fresh after admin changes.   // NOT /barbers/:id - it carries per-customer plan/credit balances
async function api(path, opts = {}) {
  const isGet = (opts.method || 'GET') === 'GET';
  if (isGet && CACHEABLE.test(path)) {
    const hit = gcache.get(path);
    if (hit && Date.now() - hit.t < 15000) return hit.p;
    const p = apiRaw(path, opts); gcache.set(path, { t: Date.now(), p });
    p.catch(() => gcache.delete(path));
    return p;
  }
  if (!isGet) gcache.clear();
  return apiRaw(path, opts);
}
/* Network layer: in-flight de-duplication of identical writes (double-tap protection), a timeout, plain-English offline /
   server / rate-limit messages, and stale-session handling (expired login -> back to the login page, then back to where you were). */
const inflight = new Map();
const NET_MSG = "We can't reach TrimSlot. Check your internet and try again.";
function apiRaw(path, opts = {}) {
  const method = opts.method || 'GET';
  const key = method === 'GET' ? null : method + ' ' + path + ' ' + (opts.body === undefined ? '' : JSON.stringify(opts.body));
  if (key && inflight.has(key)) return inflight.get(key);
  const p = apiCall(path, opts);
  if (key) { inflight.set(key, p); const done = () => inflight.delete(key); p.then(done, done); }
  return p;
}
/* Offline-cache hook (offline-cache.js): saved read-only copies, instant first paint, offline fallback, stops writes while offline. Plain network call if that file is missing. */
function apiCall(path, opts = {}) { return window.OfflineCache ? OfflineCache.call(path, opts, apiNet) : apiNet(path, opts); }
async function apiNet(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  else if (init.method !== 'GET') { init.headers['Content-Type'] = 'application/json'; init.body = '{}'; }
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 30000); init.signal = ac.signal;
  let r, j = {};
  try {
    try { r = await fetch('/api' + path, init); }
    catch {
      const e = new Error(ac.signal.aborted ? 'This is taking too long. Check your internet and try again.' : navigator.onLine === false ? "You are offline. Go online and try again." : NET_MSG);
      e.code = 'NETWORK'; e.timeout = ac.signal.aborted; throw e;
    }
    try { j = await r.json(); } catch { /* empty or HTML error page */ }
  } finally { clearTimeout(to); }
  if (!r.ok) {
    const fallback = r.status === 429 ? 'Too many tries. Wait a minute and try again.' : r.status >= 500 ? 'Something went wrong on our side. Try again in a moment.' : 'That did not work. Try again.';
    const e = new Error(j.error?.message || fallback); e.code = j.error?.code; e.status = r.status; e.details = j.error?.details;
    if (r.status === 401 && e.code === 'UNAUTHENTICATED' && state.user && !path.startsWith('/auth/')) {   // login expired while the app was open
      window.resetPostHogUser(); state.user = null; state.unread = 0; userMessage(e) = 'Your log-in has ended. Please log in again.';
      try { sessionStorage.setItem('trimslot_next', location.hash); } catch { /* private mode */ }
      gcache.clear(); location.hash = '#/login';
    }
    throw e;
  }
  return j;
}
/* offline / online messages: the network banner (net-banner.js) shows them */
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); if (bad && window.haptics) haptics.error();
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 3200);
}
const emailCheckOn = () => !!(state.cfg && (state.cfg.email_verification || (state.user && state.user.role === 'barber')));   // customers follow the global switch; barbers always verify before going live
const fail = (e) => { if (e && e.code === 'EMAIL_NOT_VERIFIED' && emailCheckOn()) { go('#/verify-email?next=' + encodeURIComponent(location.hash)); return; } toast((e && userMessage(e)) || 'Something went wrong. Try again.', true); };
const dateLabel = (d) => { const x = new Date(d + 'T00:00:00Z'); return `${DAYN[x.getUTCDay()]} ${x.getUTCDate()} ${MON[x.getUTCMonth()]}`; };
const t12 = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
const lagosTime = (iso) => iso ? new Intl.DateTimeFormat('en-NG', { timeZone: 'Africa/Lagos', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)) : '—';
const lagosDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date(iso));
/* a time with its date whenever it falls on a different Lagos day than `ref` (so "2:49 PM" never looks like it belongs to the wrong day) */
const lagosWhen = (iso, ref) => !iso ? '—' : (ref && lagosDay(iso) !== lagosDay(ref) ? `${dateLabel(lagosDay(iso))}, ` : '') + lagosTime(iso);
const lateBy = (iso, ref) => { const m = Math.round((new Date(iso) - new Date(ref)) / 60000); return m >= 20 ? ` (${m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60 ? m % 60 + ' min ' : '') : m + ' min '}after the start time)` : ''; };
const lagosStamp = (iso) => new Intl.DateTimeFormat('en-NG', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).format(new Date(iso));

const STATUS_BADGE = {
  PENDING_PAYMENT: ['b-amber', 'NOT CONFIRMED'], CONFIRMED: ['b-blue', 'CONFIRMED'], ARRIVED: ['b-green', 'ARRIVED'],
  IN_SERVICE: ['b-purple', 'IN SERVICE'], COMPLETED: ['b-gray', 'COMPLETED'], CANCELLED: ['b-red', 'CANCELLED'],
  NO_SHOW: ['b-red', 'NO-SHOW'], NOT_SERVED: ['b-red', 'NOT SERVED'],
};
const statusBadge = (s, b) => (b && b.incomplete) ? '<span class="badge b-gray">INCOMPLETE</span>' : `<span class="badge ${STATUS_BADGE[s][0]}">${state.user?.role === 'customer' && s === 'NO_SHOW' ? 'MISSED' : STATUS_BADGE[s][1]}</span>`;
function payBadge(b) {
  if (b.incomplete) return '<span class="badge b-gray">NO PAYMENT</span>';
  if (b.payment_status === 'PAID' && b.payment_option === 'PLAN') return '<span class="badge b-blue">PAID FROM PLAN</span>';
  if (b.payment_status === 'PAID' && b.payment_option === 'CREDIT') return '<span class="badge b-purple">CREDIT USED</span>';
  if (b.payment_status === 'CREDITED') return '<span class="badge b-purple">CREDITED</span>';
  if (b.payment_status === 'PAID') return '<span class="badge b-green">PAID</span>';
  if (b.payment_status === 'PAYMENT_DUE') return '<span class="badge b-amber">PAY ON ARRIVAL</span>';
  if (b.payment_status === 'REFUND_PENDING') return '<span class="badge b-amber">REFUND PENDING</span>';
  if (b.payment_status === 'REFUNDED') return '<span class="badge b-blue">REFUNDED</span>';
  if (b.payment_status === 'REFUND_DECLINED') return '<span class="badge b-red">REFUND DECLINED</span>';
  if (b.payment_status === 'CREDIT_PENDING') return '<span class="badge b-purple">CREDIT PENDING</span>';
  if (b.payment_status === 'PENDING') return '<span class="badge b-amber">PAYMENT PENDING</span>';
  return '<span class="badge b-gray">VOID</span>';
}

/* ---------- chrome ---------- */
const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';
function toggleTheme() {
  const d = !isDark();
  const apply = () => {
    if (d) document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('trimslot_theme', d ? 'dark' : 'light'); } catch { /* ignore */ }
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = d ? '#0b1220' : '#f6f7fb';
    window.themeSpin = true; // the top-bar icon turns once, after the redraw
    chrome();
    const sw = $('#themesw'); if (sw) sw.setAttribute('aria-checked', String(d));
  };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Smooth switch: a soft cross-fade of the whole page where supported; otherwise a short colour transition.
  if (document.startViewTransition && !reduce) document.startViewTransition(apply);
  else {
    document.documentElement.classList.add('theme-anim');
    apply();
    setTimeout(() => document.documentElement.classList.remove('theme-anim'), 400);
  }
}
async function signOut() { try { await Notify.detach(); } catch { /* ignore */ } await api('/auth/logout', { method: 'POST' }); window.resetPostHogUser(); state.user = null; state.setup = null; state.open = new Set(); location.hash = '#/'; route(); }
function chrome() {
  const u = state.user;
  $('#mockbar').classList.toggle('hidden', !(state.cfg && state.cfg.mock));
  if (state.cfg?.mock) $('#mockbar').textContent = 'TEST MODE: no real money moves here.';
  let mb = $('#maintbar'); if (!mb) { mb = document.createElement('div'); mb.id = 'maintbar'; mb.className = 'maintbar hidden'; $('#mockbar').after(mb); }
  mb.classList.toggle('hidden', !(state.cfg && state.cfg.maintenance)); if (state.cfg && state.cfg.maintenance) mb.textContent = state.cfg.maintenance;
  const spin = window.themeSpin ? ' theme-spin' : ''; window.themeSpin = false;
  const themeBtn = `<button id="theme" class="${spin.trim()}" type="button" aria-label="${isDark() ? 'Switch to light mode' : 'Switch to dark mode'}" aria-pressed="${isDark()}">${ic(isDark() ? 'sun' : 'moon')}</button>`;
  $('#topright').innerHTML = u
    ? `${themeBtn}<a class="bell" href="#/notifications" aria-label="${state.unread ? `Notifications, ${state.unread} unread` : 'Notifications'}">${ic('bell')}${state.unread ? `<span class="dot">${state.unread > 99 ? '99+' : state.unread}</span>` : ''}</a>`
    : `${themeBtn}<a class="txt" href="#/login">Log in</a>`;
  const th = $('#theme'); if (th) th.onclick = toggleTheme;
  if (window.Notify) Notify.paintUnread();
  const tabs = $('#tabs');
  const h = location.hash || '#/';
  const tab = (href, icon, label, on) => `<a href="${href}" class="${on ? 'on' : ''}"><span>${ic(icon)}</span>${label}</a>`;
  if (!u) { tabs.classList.add('hidden'); return; }
  tabs.classList.remove('hidden');
  const hp = (...x) => x.some((y) => h === y || h.startsWith(y + '/') || h.startsWith(y + '?'));
  tabs.innerHTML = u.role === 'barber'
    ? tab('#/today', 'list', 'Today', hp('#/today', '#/b')) + tab('#/upcoming', 'cal', 'Upcoming', hp('#/upcoming')) + tab('#/customers', 'users', 'Customers', hp('#/customers')) + tab('#/plans', 'ticket', 'Plans', hp('#/plans')) + tab('#/profile', 'user', 'Profile', hp('#/profile', '#/settings', '#/notifications', '#/reviews'))
    : tab('#/', 'home', 'Home', h === '#/' || hp('#/book', '#/barber')) + tab('#/bookings', 'cal', 'Bookings', hp('#/bookings', '#/booking')) + tab('#/wallet', 'wallet', 'Plans', hp('#/wallet')) + tab('#/profile', 'user', 'Profile', hp('#/profile', '#/notifications'));
}
async function refreshUnread() {
  if (!state.user) { state.unread = 0; return; }
  try { const r = await api('/notifications'); state.unread = r.unread; } catch { /* ignore */ }
}
/** Perceived speed: if a screen hasn't rendered within 120 ms, show placeholder cards; the first real render replaces them. */
function skeletonIfSlow() {
  const t = setTimeout(() => { app.innerHTML = SKELETON; mo.disconnect(); }, 120);
  const mo = new MutationObserver(() => { clearTimeout(t); mo.disconnect(); });
  mo.observe(app, { childList: true });
  setTimeout(() => { mo.disconnect(); }, 15000);
}
const SKELETON = '<div class="sk sk-h"></div><div class="sk sk-p"></div><div class="card"><div class="sk sk-l"></div><div class="sk sk-l s"></div></div><div class="card"><div class="sk sk-l"></div><div class="sk sk-l s"></div></div>';
function stopPoll() { if (state.poll) { clearInterval(state.poll); state.poll = null; } }
function startPoll(fn) { stopPoll(); state.poll = setInterval(() => { if (!document.hidden && navigator.onLine !== false) fn().catch(() => {}); }, 10000); }   // offline: keep the saved screen, do not redraw it

/* ---------- router ---------- */
async function route() {
  stopPoll();
  const h = location.hash || '#/';
  const [path, qs] = h.slice(1).split('?');
  const q = new URLSearchParams(qs || '');
  try {
    // config + session in parallel (one round trip instead of two sequential ones); the unread count rides along with /auth/me
    const stale = !state.cfg || Date.now() - (state.cfgAt || 0) > 10 * 60 * 1000;   // refresh config (incl. "today") so a tab left open overnight isn't a day behind
    const [cfg, me] = await Promise.all([stale ? api('/config').catch((e) => { if (state.cfg) return state.cfg; throw e; }) : state.cfg, api('/auth/me')]);
    if (stale) state.cfgAt = Date.now();
    state.cfg = cfg; state.user = me.user; state.unread = me.unread || 0;
    identifyPostHogUser(state.user);
    chrome();
    if (state.user) { if (state.notifFor !== state.user.id) { state.notifFor = state.user.id; Notify.start(); Notify.resync(); } } else if (state.notifFor) { state.notifFor = null; Notify.stop(); }
    skeletonIfSlow();
    const parts = path.split('/').filter(Boolean);
    const role = state.user?.role;
    if (parts[0] !== 'receipt-verify') document.head.querySelector('#receipt-verification-robots')?.remove();
    if (!parts.length) return role === 'barber' ? go('#/today') : role === 'customer' ? customerHome() : landing();
    if (parts[0] === 'login') return authPage('login');
    if (parts[0] === 'signup') return authPage('signup', q.get('role'));
    if (parts[0] === 'password-reset') return passwordReset(q.get('email') || '');
    if (parts[0] === 'b' && /^(?:[A-Z0-9]{7}|[a-f0-9]{12,32})$/.test(parts[1] || '')) return barberPage(0, parts[1]).catch((e) => { app.innerHTML = `<div class="card center"><h2 style="margin-top:0">This link does not work</h2><p class="err" role="alert">${esc(userMessage(e))}</p><a class="btn" href="#/">${state.user ? 'Go to My barbers' : 'Go to the start page'}</a></div>`; });   // a barber's private share link (opens for guests too)
    if (parts[0] === 'receipt-verify') return receiptVerificationPage(parts[1] || '');
    if (!state.user) { if (parts.length && !['login', 'signup', 'password-reset'].includes(parts[0])) { try { sessionStorage.setItem('trimslot_next', h); } catch { /* private mode */ } } return go('#/login'); }
    if (state.user.consent_required && state.user.consent_required.length && window.Account) return Account.reaccept();
    if (parts[0] === 'verify-email') { if (!emailCheckOn()) { const nx = q.get('next'); return go(nx && /^#\/[a-z]/.test(nx) && !/^#\/(login|signup|verify-email)/.test(nx) ? nx : '#/'); } return verifyEmail(q.get('next')); }
    if (parts[0] === 'notifications') return notifications();
    if (parts[0] === 'profile') return role === 'barber' ? barberProfile() : profile();
    if (parts[0] === 'barber') return barberPage(Number(parts[1]));
    if (role === 'customer') {
      if (parts[0] === 'book') return bookWizard(Number(parts[1]));
      if (parts[0] === 'wallet') return wallet(q.get('plan'), Number(q.get('pp')) || 0);
      if (parts[0] === 'bookings') return myBookings();
      if (parts[0] === 'receipts') return parts[1] ? customerReceiptDetail(Number(parts[1])) : customerReceipts();
      if (parts[0] === 'booking') return parts[2] === 'move' ? moveBooking(Number(parts[1])) : bookingDetail(Number(parts[1]), q.get('pay'));
    } else {
      if (parts[0] === 'today') return barberToday();
      if (parts[0] === 'plans') return barberPlans();
      if (parts[0] === 'upcoming') return barberUpcoming();
      if (parts[0] === 'reviews') return barberReviews();
      if (parts[0] === 'customers') return parts[1] ? customerProfile(Number(parts[1])) : customerList();
      if (parts[0] === 'settings') return settings();
      if (parts[0] === 'payouts') return barberPayouts();
      if (parts[0] === 'balance') return barberBalance();
      if (parts[0] === 'b') return barberBooking(Number(parts[1]));
    }
    go('#/');
  } catch (e) {
    app.innerHTML = `<div class="err">${esc(userMessage(e))}</div><a class="btn sec" href="#/">Back home</a>`;
  }
}
const go = (h) => { if (location.hash === h) route(); else location.hash = h; };
window.addEventListener('hashchange', route);
window.addEventListener('popstate', () => {   // Back/Forward between booking-wizard steps (same #/book/<id> URL)
  if (!location.hash.startsWith('#/book/') || !state.wiz || !state.wizDraw) return;
  const st = (history.state && history.state.wiz) || 1;
  if (st !== state.wiz.step) { state.wiz.step = Math.min(st, state.wiz.service ? (state.wiz.time ? 4 : 2) : 1); state.wizDraw(); }
});

/* ---------- landing / auth ---------- */
function landing() {
  app.innerHTML = `
    <div class="hero"><span class="pill">${ic('bolt', 'sm')} Skip the long wait</span><h1>Book. Arrive.<br>Get Trimmed.</h1><p>Add your barber. Book your time. Watch the live line. No more long waits.</p>
      <a class="btn" href="#/signup?role=customer">Book a haircut</a></div>
    <div class="feat"><div>${ic('cal')}Pick a time</div><div>${ic('pin')}Just arrive</div><div>${ic('clock')}Live queue</div></div>
    <div class="card"><div class="row"><div class="avatar sm">${ic('store')}</div><div class="grow"><h3>Are you a barber?</h3><p class="muted small" style="margin:2px 0 0">Run your day, your services and your line from one simple screen.</p></div></div>
      <div style="height:16px"></div><a class="btn sec" href="#/signup?role=barber">Set up my shop</a></div>
    ${state.cfg.demo ? '<div class="card small"><b>Demo logins</b><br>Customer: <code>chidi@trimslot.demo</code> / <code>Customer123!</code><br>Barber: <code>mike@trimslot.demo</code> / <code>Barber123!</code></div>' : ''}
    <p class="center"><a href="#/login">I already have an account</a></p>`;
}
let passwordFieldId = 0;
function wirePasswordVisibility(root = app) {
  root.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.parentElement?.classList.contains('password-field')) return;
    const label = input.previousElementSibling?.matches('label') ? input.previousElementSibling : null;
    if (!input.id) input.id = `trimslot-password-${++passwordFieldId}`;
    if (label) label.htmlFor = input.id;
    const wrap = document.createElement('div'); wrap.className = 'password-field';
    input.before(wrap); wrap.append(input);
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'password-visibility'; button.textContent = 'Show';
    button.setAttribute('aria-label', 'Show password'); button.setAttribute('aria-pressed', 'false'); button.setAttribute('aria-controls', input.id);
    button.dataset.passwordToggle = input.id;
    button.addEventListener('click', () => {
      const show = input.type === 'password'; input.type = show ? 'text' : 'password';
      button.textContent = show ? 'Hide' : 'Show'; button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      button.setAttribute('aria-pressed', String(show)); input.focus({ preventScroll: true });
    });
    wrap.append(button);
  });
}
function authPage(mode, roleQ) {
  let role = roleQ === 'barber' ? 'barber' : 'customer', saved = null;
  // Login feedback is decorative only; authentication remains entirely server-side.
  if (!document.getElementById('auth-feedback-motion')) {
    const style = document.createElement('style'); style.id = 'auth-feedback-motion';
    style.textContent = `
      @keyframes trimslot-auth-shake { 0%,100%{transform:translateX(0)} 15%,55%{transform:translateX(-8px)} 35%,75%{transform:translateX(8px)} 90%{transform:translateX(-3px)} }
      @keyframes trimslot-auth-takeoff { 0%{transform:translateY(0) scale(1);opacity:1} 18%{transform:translateY(8px) scale(.985);opacity:1} 100%{transform:translateY(-110vh) scale(.94);opacity:0} }
      #app.auth-shake { animation:trimslot-auth-shake .42s ease-in-out; }
      #app.auth-takeoff { transform-origin:50% 100%; animation:trimslot-auth-takeoff .68s cubic-bezier(.2,.75,.25,1) forwards; pointer-events:none; }
      @media (prefers-reduced-motion:reduce) { #app.auth-shake,#app.auth-takeoff { animation:none !important; } }
    `;
    document.head.appendChild(style);
  }
  const clearAuthMotion = () => app.classList.remove('auth-shake','auth-takeoff');
  const wrongPasswordFeedback = () => {
    clearAuthMotion(); void app.offsetWidth; app.classList.add('auth-shake');
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches && navigator.vibrate) {
      try { navigator.vibrate([75, 35, 75]); } catch { /* optional device capability */ }
    }
  };
  const successTakeoff = async () => {
    clearAuthMotion();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    app.classList.add('auth-takeoff');
    await new Promise((resolve) => setTimeout(resolve, 700));
    app.classList.remove('auth-takeoff');
  };
  const draw = (err) => {
    const signup = mode === 'signup';
    app.innerHTML = `<h1>${signup ? 'Create your account' : 'Welcome back'}</h1><p class="muted" style="margin:0 0 6px">${signup ? 'It takes less than a minute.' : 'Log in to book a cut or run your shop.'}</p>
      ${signup ? `<div class="seg" id="roleseg"><button data-r="customer" class="${role === 'customer' ? 'on' : ''}">I'm a customer</button><button data-r="barber" class="${role === 'barber' ? 'on' : ''}">I'm a barber</button></div>` : ''}
      ${err ? `<div class="err">${esc(err)}</div>` : ''}
      <form id="f"${signup ? ' data-oneof="email,phone"' : ''}>
        ${signup ? `<label>Full name</label><input name="name" autocomplete="name" required>` : ''}
        ${signup && role === 'barber' ? `<label>Shop name</label><input name="shop_name" required><label>Shop location</label><input name="location" placeholder="Street, area, city">` : ''}
        ${signup ? `<label>Email</label><input name="email" type="email" autocomplete="email" placeholder="you@example.com"><label>Phone</label><input name="phone" type="tel" autocomplete="tel" placeholder="0803 123 4567"><p class="small muted">Add an email or a phone number. One is enough.</p>`
      : `<label>Email or phone</label><input name="identifier" autocomplete="username" required>`}
        <label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="8">
        ${signup ? `<label for="auth-confirm-password">Confirm password</label><input id="auth-confirm-password" name="confirm_password" type="password" autocomplete="new-password" required minlength="8" aria-describedby="password-match-error"><p id="password-match-error" class="err hidden" role="alert"></p>` : ''}
        ${signup ? `<label class="chk accept"><input type="checkbox" name="accept_terms" required> <span>I agree to the <a href="/terms.html" target="_blank" rel="noopener">Terms</a> and have read the <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>` : ''}
        ${signup && role === 'barber' ? `<label class="chk accept"><input type="checkbox" name="accept_barber_agreement" required> <span>I agree to the <a href="/barber-agreement.html" target="_blank" rel="noopener">Barber Agreement</a>.</span></label>` : ''}
        ${signup && role === 'barber' ? '<div class="info small">We check every new barber shop before customers can see it. You can add your services and hours now.</div>' : ''}
        <div style="height:24px"></div><button class="btn block" type="submit">${signup ? 'Sign up' : 'Log in'}</button>
      </form>
      <p class="center small">${signup ? 'Have an account? <a href="#/login">Log in</a>' : '<a href="#/password-reset">Forgot password?</a> · New here? <a href="#/signup">Sign up</a>'}</p>
      ${!signup && state.cfg.demo ? `<div class="card small"><b>Demo logins (tap to fill)</b><br>
        <a href="#" data-fill="chidi@trimslot.demo|Customer123!">Customer: chidi@trimslot.demo</a><br>
        <a href="#" data-fill="tunde@trimslot.demo|Customer123!">Customer 2: tunde@trimslot.demo</a><br>
        <a href="#" data-fill="mike@trimslot.demo|Barber123!">Barber: mike@trimslot.demo</a></div>` : ''}`;
    wirePasswordVisibility(app);
    const matchError = $('#password-match-error');
    if (matchError) for (const field of app.querySelectorAll('#f [name="password"], #f [name="confirm_password"]')) field.addEventListener('input', () => { matchError.classList.add('hidden'); matchError.textContent = ''; });
    if (saved) { for (const [k, v] of Object.entries(saved)) { const el = document.querySelector(`#f [name="${k}"]`); if (el && !['password', 'confirm_password'].includes(k)) el.value = v; } }   // keep non-secret fields after an error
    document.querySelectorAll('#roleseg button').forEach((b) => b.onclick = () => { saved = Object.fromEntries(new FormData($('#f'))); delete saved.password; delete saved.confirm_password; role = b.dataset.r; draw(); });
    document.querySelectorAll('[data-fill]').forEach((a) => a.onclick = (ev) => { ev.preventDefault(); const [i, p] = a.dataset.fill.split('|'); $('[name=identifier]').value = i; $('[name=password]').value = p; $('#f').dispatchEvent(new Event('input')); });
    $('#f').onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = Object.fromEntries(new FormData(ev.target));
      if (signup && fd.password !== fd.confirm_password) {
        const feedback = $('#password-match-error'); feedback.textContent = 'Passwords do not match.'; feedback.classList.remove('hidden');
        $('#f [name="confirm_password"]').focus(); return;
      }
      const btn = ev.target.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = signup ? 'Making your account…' : 'Logging in…';
      try {
        if (signup) { const payload = { ...fd }; delete payload.confirm_password; await api('/auth/signup', { method: 'POST', body: { ...payload, role, accept_terms: fd.accept_terms === 'on', accept_barber_agreement: fd.accept_barber_agreement === 'on' } }); window.posthog?.capture('account_registered', { role }); }
        else { await api('/auth/login', { method: 'POST', body: fd }); window.posthog?.capture('user_logged_in'); await successTakeoff(); }
        let nx = null; try { nx = sessionStorage.getItem('trimslot_next'); sessionStorage.removeItem('trimslot_next'); } catch { /* private mode */ }
        const dest = nx && /^#\/[a-z]/.test(nx) && !/^#\/(login|signup)/.test(nx) ? nx : '#/';
        if (signup && fd.email && (emailCheckOn() || role === 'barber')) return go('#/verify-email?next=' + encodeURIComponent(dest));   // new barbers check email before going live; this is not a sign-in code
        go(dest);
      } catch (e) {
        if (!signup && (e.status === 401 || /invalid|incorrect|wrong password|credentials/i.test(userMessage(e, '')))) wrongPasswordFeedback();
        saved = { ...fd }; delete saved.password; delete saved.confirm_password; draw(userMessage(e));
      }
    };
  };
  draw();
}

/* ---------- password reset by email code (separate from email verification) ---------- */
function passwordReset(initialEmail = '') {
  let email = initialEmail, sent = false, msg = '';
  const draw = () => {
    app.innerHTML = `<a class="back" href="#/login">${ic('back', 'sm')} Log in</a><h1>Reset your password</h1>
      <p class="muted">We will send a 6-digit code to the email on your account. It expires after 10 minutes.</p>
      ${sent ? `<div class="info small">${esc(msg || 'If an account uses that email address, a reset code has been sent.')}</div>
        <form id="prf"><label>Email</label><input name="email" type="email" autocomplete="email" required value="${esc(email)}">
          <label>6-digit code</label><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
          <label>New password</label><input name="new_password" type="password" autocomplete="new-password" minlength="8" required>
          <label>Confirm new password</label><input name="confirm_password" type="password" autocomplete="new-password" minlength="8" required>
          ${msg && msg !== 'If an account uses that email address, a reset code has been sent.' ? `<p class="err" role="alert">${esc(msg)}</p>` : ''}
          <div class="btns cta"><button class="btn" type="submit">Reset password</button></div></form>
        <p class="center small"><a href="#" id="pr-resend">Send another code</a></p>`
      : `<form id="prs"><label>Email</label><input name="email" type="email" autocomplete="email" required value="${esc(email)}">
          ${msg ? `<p class="err" role="alert">${esc(msg)}</p>` : ''}<div class="btns cta"><button class="btn" type="submit">Send reset code</button></div></form>`}`;
    wirePasswordVisibility(app);
    const request = async (value) => {
      email = String(value || '').trim(); if (!email) { msg = 'Enter your email address.'; draw(); return; }
      const button = document.querySelector('#prs button[type=submit], #pr-resend'); if (button) button.disabled = true;
      try { const r = await api('/auth/password/reset/send', { method: 'POST', body: { email } }); sent = true; msg = r.message; draw(); }
      catch (e) { msg = userMessage(e, 'We could not send a reset code.'); draw(); }
    };
    const req = $('#prs'); if (req) req.onsubmit = (e) => { e.preventDefault(); request(new FormData(req).get('email')); };
    const resend = $('#pr-resend'); if (resend) resend.onclick = (e) => { e.preventDefault(); request($('#prf [name=email]').value); };
    const form = $('#prf'); if (form) form.onsubmit = async (e) => {
      e.preventDefault(); const f = form.elements;
      if (f.new_password.value !== f.confirm_password.value) { msg = 'Those new passwords do not match.'; draw(); return; }
      const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        await api('/auth/password/reset', { method: 'POST', body: { email: f.email.value, code: f.code.value, new_password: f.new_password.value } });
        window.resetPostHogUser(); state.user = null; state.unread = 0; Notify.stop(); toast('Password reset. Log in with your new password.'); go('#/login');
      } catch (e2) { msg = userMessage(e2, 'We could not reset your password.'); draw(); }
    };
  };
  draw();
}

/* ---------- customer: home ---------- */
const stars = (n, cls = '') => `<span class="stars ${cls}" aria-label="${n} out of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= Math.round(n) ? 'on' : ''}">${ic('star', 'sm')}</i>`).join('')}</span>`;
const ratingChip = (r) => r && r.count ? `<span class="rate">${ic('star', 'sm')}<b>${r.average.toFixed(1)}</b><span class="muted"> (${r.count})</span></span>` : '';
/* ---------- email check by one-time code (both roles) ---------- */
async function verifyEmail(next) {
  const u = state.user;
  const target = next && /^#\/[a-z]/.test(next) && !/^#\/(login|signup|verify-email)/.test(next) ? next : '#/';
  if (u.email_verified) { toast('Your email is already checked'); return go(target); }
  let sent = false, masked = '', msg = '', codeValue = '', verifying = false;
  const verifyCode = async () => {
    if (verifying || !/^[0-9]{6}$/.test(codeValue)) return;
    verifying = true; msg = '';
    const input = $('#vf [name=code]'), button = $('#vf button[type=submit]');
    if (input) input.disabled = true;
    if (button) { button.disabled = true; button.textContent = 'Checking…'; }
    try {
      const r = await api('/auth/email/verify', { method: 'POST', body: { code: codeValue } });
      state.user = { ...state.user, ...r.user };
      toast('Your email is checked'); go(target);
    } catch (e) {
      verifying = false; msg = userMessage(e, 'That code could not be verified.');
      draw();
      const retry = $('#vf [name=code]'); if (retry) { retry.focus(); retry.select(); }
    }
  };
  const draw = () => {
    const devHint = state.cfg.email_dev_code ? `<div class="info small">Test mode: the code is <b>123456</b>.</div>` : '';
    const intro = u.role === 'barber' ? 'Verify your email once before your shop goes live. You will still sign in with your password.' : 'We check your email once, before your first booking. It keeps your account safe.';
    if (!u.email) {
      app.innerHTML = `<h1>Add your email</h1><p class="muted">${intro}</p><form id="ef"><label>Email</label><input name="email" type="email" autocomplete="email" placeholder="you@example.com" required>${msg ? `<p class="err" role="alert">${esc(msg)}</p>` : ''}<div class="btns cta"><button class="btn" type="submit">Send me a code</button></div></form><p class="center small"><a href="${esc(target)}">Do this later</a></p>`;
      $('#ef').onsubmit = async (ev) => { ev.preventDefault(); const btn = ev.target.querySelector('button'); btn.disabled = true; try { const r = await api('/me', { method: 'PATCH', body: { email: new FormData(ev.target).get('email') } }); state.user = { ...state.user, ...r.user }; Object.assign(u, r.user); msg = ''; await send(); } catch (e) { msg = userMessage(e); draw(); } };
      return;
    }
    app.innerHTML = `<h1>Check your email</h1><p class="muted">${intro}</p>${devHint}
      ${sent ? `<form id="vf"><p>We sent a 6-digit code to <b>${esc(masked)}</b>. It works for 10 minutes.</p><label>Your code</label><input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" pattern="[0-9]{6}" maxlength="6" placeholder="123456" value="${esc(codeValue)}" required aria-describedby="code-help" style="font-size:22px;letter-spacing:6px;text-align:center"><p id="code-help" class="small muted" aria-live="polite">${verifying ? 'Checking your code…' : 'Enter or autofill the code. We will verify it automatically.'}</p>${msg ? `<p class="err" role="alert">${esc(msg)}</p>` : ''}<div class="btns cta"><button class="btn" type="submit" ${codeValue.length === 6 || verifying ? '' : 'disabled'}>Verify code</button></div></form>
        <p class="center small"><a href="#" id="resend">Send a new code</a> · <a href="#" id="chg">Use a different email</a></p>`
      : `<div class="card"><p style="margin-top:0">We will send a 6-digit code to <b>${esc(u.email)}</b>.</p>${msg ? `<p class="err" role="alert">${esc(msg)}</p>` : ''}<div class="btns"><button class="btn" id="sendcode">Send me a code</button></div></div><p class="center small"><a href="#" id="chg">Use a different email</a></p>`}
      <p class="center small"><a href="${esc(target)}">Do this later</a></p>`;
    const sc = $('#sendcode'); if (sc) sc.onclick = () => { sc.disabled = true; send(); };
    const rs = $('#resend'); if (rs) rs.onclick = (ev) => { ev.preventDefault(); send(); };
    const ch = $('#chg'); if (ch) ch.onclick = (ev) => { ev.preventDefault(); u.email = null; sent = false; msg = ''; draw(); };
    const vf = $('#vf'); if (vf) {
      const input = vf.querySelector('[name=code]');
      input.focus();
      const updateCode = () => {
        codeValue = input.value.replace(/\D/g, '').slice(0, 6);
        if (input.value !== codeValue) input.value = codeValue;
        const button = vf.querySelector('button[type=submit]');
        if (button) button.disabled = codeValue.length !== 6 || verifying;
        if (codeValue.length === 6) verifyCode();
      };
      input.addEventListener('input', updateCode);
      input.addEventListener('change', updateCode);
      vf.onsubmit = (ev) => { ev.preventDefault(); updateCode(); verifyCode(); };
    }
  };
  const send = async () => { try { const r = await api('/auth/email/send', { method: 'POST' }); if (r.already_verified) { state.user.email_verified = true; toast('Your email is already checked'); return go(target); } sent = true; masked = r.email; msg = ''; } catch (e) { msg = userMessage(e); } draw(); };
  draw();
}

let homeSig = '';
/** Remove-barber confirmation: a bottom sheet that says what happens, with a clear Keep button. */
function openRemoveSheet(name, id) {
  const prev = document.activeElement, el = document.createElement('div'); el.className = 'scrim';
  el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="rms-t"><h3 id="rms-t" style="margin:0 0 8px">Remove ${esc(name)}?</h3>
    <ul><li>They leave My barbers. You can add them again with their link.</li><li>Upcoming bookings with them still happen. You will see them under Bookings.</li><li>Nothing is paid or refunded because of this.</li></ul>
    <div class="btns cta"><button class="btn sec" type="button" id="rm-keep">Keep them</button><button class="btn" type="button" id="rm-go" style="background:var(--red);border-color:var(--red)">Yes, remove</button></div></div>`;
  const close = () => { el.remove(); if (prev && prev.focus) prev.focus(); };
  document.body.appendChild(el);
  el.onclick = (e) => { if (e.target === el) close(); };
  el.querySelector('#rm-keep').onclick = close;
  el.querySelector('#rm-go').onclick = async (e) => { const go = e.currentTarget; go.disabled = true; try { await api('/me/barbers/' + id, { method: 'DELETE' }); close(); toast('Removed'); customerHome(); } catch (err) { close(); fail(err); } };
  el.querySelector('#rm-keep').focus();
}
/** Long text that does not fit slides right-to-left: 2s pause, slide, 2s pause, then starts again. Only when it overflows; off for reduced motion. */
function initMarquees(root = document) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.querySelectorAll('.marq-wrap .marq').forEach((el) => {
    const shift = el.scrollWidth - el.parentElement.clientWidth;
    if (shift <= 4) return;
    const move = shift / 40, total = 2 + move + 2;   // seconds; about 40px per second
    el.animate([{ transform: 'translateX(0)', offset: 0 }, { transform: 'translateX(0)', offset: 2 / total }, { transform: `translateX(-${shift}px)`, offset: (2 + move) / total }, { transform: `translateX(-${shift}px)`, offset: 1 }], { duration: total * 1000, iterations: Infinity });
  });
}
async function customerHome(poll = false) {
  const F = state.cfg.features || {};
  const linkDraft = $('#linkin')?.value || '';
  const [bs, bk, rb, fv, wl] = await Promise.all([api('/me/barbers'), api('/bookings'), F.rebook ? api('/me/rebook').catch(() => ({})) : {}, F.favourites ? api('/me/favourites').catch(() => ({})) : {}, F.waitlist ? api('/waitlist').catch(() => ({})) : {}]);
  // Background refresh: redraw only when the data changed, and never while the customer is typing a link or has a menu open.
  const sig = JSON.stringify([bs, bk, rb, fv, wl]);
  if (poll && (sig === homeSig || document.querySelector('.mmenu.open') || document.activeElement?.closest?.('#addlink'))) return;
  homeSig = sig;
  const favIds = new Set((fv.barbers || []).map((b) => b.id));
  const sg = rb.suggestion; const opt = sg && sg.options && sg.options[0];
  const rebookCard = sg && opt ? `<div class="card rebook"><div class="row between"><div><div class="small muted">${ic('repeat', 'sm')} Book again</div><h3 style="margin:2px 0 0">${esc(sg.service.name)} · ${esc(sg.barber.shop_name)}</h3></div><b>${naira(sg.service.price_kobo)}</b></div>
      <div class="small muted" style="margin:4px 0 10px">${sg.usual ? `Your usual: ${DAYFULL[sg.usual.weekday]}s around ${t12(sg.usual.time)}` : 'Same barber, same service'}</div>
      <div class="chips rebook-opts">${sg.options.map((o) => `<button class="chip ${o.usual_day ? 'on' : ''}" data-rb="${o.date}|${o.time}">${o.usual_day ? '' : '<span class="next-tag">Next free</span>'}<b>${dateLabel(o.date)}</b><span class="small">${t12(o.time)}</span></button>`).join('')}</div></div>` : '';
  const waitCard = (wl.waitlist || []).length ? `<h2>On your waitlist</h2>${wl.waitlist.map((w) => `<div class="card row between ${w.status === 'NOTIFIED' ? 'hotcard' : ''}"><div><b>${esc(w.shop_name)}</b><div class="small muted">${esc(w.service_name)} · ${dateLabel(w.date)}${w.status === 'NOTIFIED' ? ' · <b style="color:var(--green)">a time is free now</b>' : ''}</div></div><div class="btns">${w.status === 'NOTIFIED' ? `<a class="btn sm" href="#/book/${w.barber_id}">Book</a>` : ''}<button class="btn sm sec" data-unwait="${w.id}">Leave</button></div></div>`).join('')}` : '';
  const active = bk.bookings.filter((b) => ['CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(b.status) && b.date >= bk.today).sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
  // Unpaid bookings: the time is not saved until paid, so they must be visible here to be paid in time
  const unpaid = bk.bookings.filter((b) => b.status === 'PENDING_PAYMENT' && b.date >= bk.today).sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
  const unpaidCard = unpaid.length ? `<h2>Waiting for payment</h2>${unpaid.slice(0, 2).map((b) => `<div class="card unpaid-card">
      <a href="#/booking/${b.id}" class="unpaid-link"><div class="row between"><b>${esc(b.service_name)}</b>${naira((b.money && b.money.total_kobo) || b.price_kobo)}</div>
      <div class="small muted">${esc(b.shop_name)} · ${dateLabel(b.date)} · ${esc(b.start_label)}</div>
      <div class="small">Not confirmed. Pay to save your time.</div></a>
      <div class="btns" style="margin-top:10px"><a class="btn sm" href="#/booking/${b.id}">Pay now</a><button class="btn sm sec" data-cancelpay="${b.id}">Cancel</button></div></div>`).join('')}` : '';
  app.innerHTML = `${emailBanner()}<h1>Hi, ${esc(state.user.name.split(' ')[0])}</h1><p class="muted" style="margin-top:0">Book with your barbers, or add a new one with their link.</p>
    ${Notify.promptCard()}${rebookCard}
    ${unpaidCard}
    ${active.length ? `<h2>Your next booking</h2>${clist(active.slice(0, 2).map(bookingCard))}` : ''}
    <a class="card row wallet-chip" href="#/wallet"><span class="ico">${ic('wallet')}</span><div class="grow"><b>My plans &amp; credits</b><div class="small muted">Session packs and credits</div></div><span class="muted">${ic('right')}</span></a>
    ${waitCard}
    <h2>My barbers</h2>
    ${[...bs.barbers].sort((a, b) => Number(favIds.has(b.id)) - Number(favIds.has(a.id))).map((b, i) => `<div class="card mybarber" data-bid="${b.id}"><div class="row" style="gap:12px"><a class="row grow" style="gap:12px;min-width:0" href="#/barber/${b.id}">
        ${avatar(b, '', i < 4)}
        <div class="grow" style="min-width:0"><h3 class="ellip">${favIds.has(b.id) ? `<span class="fav-i">${ic('heart', 'sm')}</span> ` : ''}${esc(b.shop_name)}</h3><div class="muted small marq-wrap"><span class="marq">${esc(b.name)} · ${esc(b.location || 'Lagos')}</span></div></div></a>
        <a class="btn book-lg" href="#/book/${b.id}">Book</a><button class="mini more" type="button" data-more="${b.id}" aria-label="More options for ${esc(b.shop_name)}" aria-expanded="false">${ic('more', 'sm')}</button></div>
        <div class="mmenu" role="group" aria-label="Options for ${esc(b.shop_name)}">${b.share ? `<button class="menu-item" type="button" data-shb="${b.id}">${ic('share', 'sm')} Share link</button>` : ''}<button class="menu-item red" type="button" data-rmb="${b.id}">${ic('trash', 'sm')} Remove from My barbers</button></div></div>`).join('')
      || '<div class="card center muted" id="nobarbers"><b>No barbers yet.</b><br><span class="small">Ask your barber for their TrimSlot link or QR code. Open it, then tap Add barber.</span></div>'}
    <form class="card" id="addlink" novalidate><label for="linkin">Add a barber with their link</label>
      <div class="row" style="gap:8px"><input id="linkin" class="grow" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the link you were sent"><button class="btn sm" type="submit">Open</button></div>
      <div id="linkerr" class="err small hidden" role="alert"></div></form>`;
  const linkInput = $('#linkin'); if (linkInput) linkInput.value = linkDraft;
  initMarquees(app);
  const lf = $('#addlink'); lf.onsubmit = (ev) => { ev.preventDefault(); const raw = $('#linkin').value.trim().replace(/[\/#?]+$/, ''); const m = /(?:\/b\/)?([A-Z0-9]{7}|[a-f0-9]{12,32})$/i.exec(raw); if (!m) { const er = $('#linkerr'); er.textContent = 'That does not look like a TrimSlot barber link. Ask the barber to send it again.'; er.classList.remove('hidden'); return; } location.hash = '#/b/' + (m[1].length === 7 ? m[1].toUpperCase() : m[1].toLowerCase()); };
  document.querySelectorAll('[data-shb]').forEach((el) => el.onclick = () => { const b = bs.barbers.find((x) => x.id === Number(el.dataset.shb)); if (b) openShareSheet(b); });
  document.querySelectorAll('[data-more]').forEach((el) => el.onclick = () => {
    const menu = el.closest('.mybarber').querySelector('.mmenu'); const open = !menu.classList.contains('open');
    document.querySelectorAll('.mmenu.open').forEach((m) => { m.classList.remove('open'); m.closest('.mybarber').querySelector('[data-more]').setAttribute('aria-expanded', 'false'); });
    menu.classList.toggle('open', open); el.setAttribute('aria-expanded', String(open));
  });
  document.querySelectorAll('[data-rmb]').forEach((el) => el.onclick = () => openRemoveSheet(el.closest('.mybarber').querySelector('h3').textContent.trim(), el.dataset.rmb));
  document.querySelectorAll('[data-rb]').forEach((el) => el.onclick = () => {
    const [d, t] = el.dataset.rb.split('|');
    // Shortcut: service, date and time are already chosen; land on the date & time screen so the customer can confirm or change it.
    state.wiz = { barberId: sg.barber.id, step: 2, service: sg.service, date: d, time: t, pay: 'ON_ARRIVAL', payTouched: false, note: '' };
    location.hash = '#/book/' + sg.barber.id;
  });
  document.querySelectorAll('[data-cancelpay]').forEach((el) => el.onclick = async () => {
    if (!confirm('Cancel this booking?\n\nYour time is released. Nothing was paid, so there is nothing to refund.')) return;
    el.disabled = true;
    try { await api('/bookings/' + el.dataset.cancelpay + '/cancel', { method: 'POST' }); window.posthog?.capture('booking_cancelled'); toast('Booking cancelled'); customerHome(); }
    catch (e) { fail(e); el.disabled = false; }
  });
  document.querySelectorAll('[data-unwait]').forEach((el) => el.onclick = async () => { el.disabled = true; try { await api('/waitlist/' + el.dataset.unwait, { method: 'DELETE' }); toast('Taken off the waitlist'); customerHome(); } catch (e) { fail(e); el.disabled = false; } });
  startPoll(() => customerHome(true));
}
/* compact tappable row (~58px): t title, p pills, m one-line meta, r trailing figure, x optional third line */
const crowA = (d, href) => `<a class="crow" href="${href}"><span class="cb"><span class="c1"><span class="ct">${d.t}</span>${d.p ? `<span class="cp">${d.p}</span>` : ''}</span><span class="c2"><span class="cm">${d.m || ''}</span>${d.r ? `<span class="cr">${d.r}</span>` : ''}</span>${d.x ? `<span class="cx">${d.x}</span>` : ''}</span><span class="cgo" aria-hidden="true">›</span></a>`;
const clist = (arr) => `<div class="clist">${arr.join('')}</div>`;
/* money lines: customer sees price + booking fee; barber sees their share of the card fee, the TrimSlot charge and what they receive */
const mrow = (l, v, cls) => `<div class="row between mrow ${cls || ''}"><span>${l}</span><span>${v}</span></div>`;
function custMoney(b) {
  const m = b.money; if (!m || m.mode !== 'ONLINE' || !m.booking_fee_kobo) return '';
  return `<div class="money" aria-label="Payment breakdown">${mrow('Price', naira(m.price_kobo))}${mrow('Booking fee', naira(m.booking_fee_kobo))}${mrow('Total', naira(m.total_kobo), 'tot')}</div>`;
}
function barberMoney(b) {
  const m = b.money; if (!m) return '';
  if (m.mode === 'ONLINE' && m.payout_kobo != null) return `<div class="money" aria-label="Your earnings">${mrow('Price', naira(m.price_kobo))}${m.barber_fee_kobo ? mrow('Paystack fee', '−' + naira(m.barber_fee_kobo)) : ''}${mrow('TrimSlot charge', '−' + naira(m.platform_charge_kobo))}${mrow('You receive', naira(m.payout_kobo), 'tot')}</div>`;
  if (m.mode === 'ON_ARRIVAL' && m.platform_charge_kobo) return `<div class="money" aria-label="Your earnings">${mrow('Customer pays you', naira(m.price_kobo))}${mrow('TrimSlot charge', naira(m.platform_charge_kobo))}${mrow('Added to your balance', naira(m.commission_owed_kobo), 'tot')}</div>`;
  return '';
}
function bookingCard(b) {
  const q = b.queue;
  return crowA({ t: esc(b.service_name), p: statusBadge(b.status, b) + payBadge(b), m: `${esc(b.shop_name)} · ${dateLabel(b.date)} · ${esc(b.start_label)}`, r: b.payment_option === 'PLAN' ? `<s class="muted">${naira(b.price_kobo)}</s>` : naira(b.price_kobo), x: q && q.state !== 'NOT_ACTIVE' && q.is_today ? esc(q.message) : '' }, '#/booking/' + b.id);
}

/* ---------- customer: booking wizard ---------- */
/* Settings the booking screens depend on (the booking window, the cut-off, today). Re-read them when a booking screen opens, so an admin change shows at once instead of after the 10-minute refresh. */
async function freshConfig() {
  // apiNet, not api: the saved offline copy of /config must not answer here, or an old window could still show.
  try { state.cfg = await apiNet('/config'); state.cfgAt = Date.now(); } catch { /* keep what we have */ }
}
async function bookWizard(barberId) {
  await freshConfig();
  if (!state.wiz || state.wiz.barberId !== barberId) state.wiz = { barberId, step: 1, service: null, date: null, time: null, pay: 'ON_ARRIVAL', payTouched: false };
  const w = state.wiz;
  if (w.date && w.date < state.cfg.today) { w.date = null; w.time = null; w.step = Math.min(w.step, 2); }   // a wizard left open since yesterday must not book in the past
  const data = await api('/barbers/' + barberId);
  const { barber, services } = data;
  const plans = data.plans || [], my = data.my || { plans: [], credits: [] };
  const slotIso = () => `${w.date}T${w.time}:00+01:00`;
  /* A plan session only pays for a service the plan lists. Every plan that lists the chosen service is offered; one match is preselected. */
  const plansFor = () => (my.plans || []).filter((p) => (p.service_ids || []).includes(w.service.id) && p.sessions_left > 0 && new Date(p.expires_at) >= new Date(slotIso()));
  const planFor = () => { const l = plansFor(); return l.find((p) => p.id === w.planId) || (l.length === 1 ? l[0] : null); };
  const otherPlans = () => (my.plans || []).filter((p) => p.sessions_left > 0 && new Date(p.expires_at) >= new Date(slotIso()) && !(p.service_ids || []).includes(w.service.id));
  /* A credit covers the SAME service it came from, or any service with the SAME price. The same service is listed first (same rule as the server). */
  const creditsFor = () => (my.credits || []).filter((c) => new Date(c.expires_at) >= new Date(slotIso()) && (c.service_id === w.service.id || c.value_kobo === w.service.price_kobo))
    .sort((a, b) => (b.service_id === w.service.id) - (a.service_id === w.service.id));
  const creditFor = () => creditsFor()[0];
  const notices = data.notices || [];
  const bk = data.booking || { paused: false, maintenance: false, pay_on_arrival: true };
  const closedDates = new Set(notices.filter((n) => n.type === 'CLOSED').map((n) => n.date));
  const offWeekdays = new Set((data.schedule || []).filter((d) => !d.is_working).map((d) => d.weekday));
  const noticeHtml = notices.length ? `<div class="warn small notice">${ic('warn', 'sm')}<div>${notices.map((n) => `<div><b>${esc(n.title)}</b>${n.type === 'CLOSED' && n.reason ? ' — ' + esc(n.reason) : n.type === 'HOURS_UPDATED' ? ' — ' + esc(n.text) : ''}</div>`).join('')}</div></div>` : '';
  /* wizard steps live in browser history, so the phone's Back button goes to the previous step instead of leaving the wizard */
  const setStep = (n) => { if (n > w.step) history.pushState({ wiz: n }, ''); w.step = n; draw(); };
  const stepBack = (n) => { if (history.state && history.state.wiz && history.state.wiz > n) history.back(); else { w.step = n; draw(); } };
  state.wizDraw = () => draw();
  const draw = async (err) => {
    const stepBar = `<div class="steps">${[1, 2, 3, 4].map((i) => `<i class="${i <= w.step ? 'on' : ''}"></i>`).join('')}</div>`;
    const head = `<a href="#/barber/${barberId}" class="back">${ic('back', 'sm')} ${esc(barber.shop_name)}</a><div class="wiz-head">${avatar(barber, 'sm', true)}<div class="grow"><h1 class="ellip">Book a session</h1><div class="muted small ellip">${esc(barber.shop_name)}${barber.location ? ' · ' + esc(barber.location) : ''}</div></div></div>${noticeHtml}${stepBar}${err ? `<div class="err">${esc(err)}</div>` : ''}`;
    if (w.step === 1) {
      app.innerHTML = head + `<h2>Pick a service</h2>` + services.map((s) => `<button class="svc ${w.service?.id === s.id ? 'on' : ''}" data-s="${s.id}"><div><b>${esc(s.name)}</b><div class="muted small">${s.duration_min} min</div></div><b>${naira(s.price_kobo)}</b></button>`).join('')
        + (my.credits && my.credits.length ? `<div class="ok small notice">${ic('ticket', 'sm')}<div>You have ${my.credits.length} session credit${my.credits.length === 1 ? '' : 's'} with this barber. ${my.credits.length === 1 ? 'It works' : 'They work'} until ${dateLabel(my.credits[0].expires_at.slice(0, 10))}. We use ${my.credits.length === 1 ? 'it' : 'one'} when you book.</div></div>` : '')
        + (my.plans && my.plans.some((p) => p.sessions_left > 0) ? `<div class="ok small notice">${ic('ticket', 'sm')}<div>${my.plans.filter((p) => p.sessions_left > 0).map((p) => `Your plan <b>${esc(p.plan_name)}</b> covers ${esc(svcNames(p.service_ids, services))}.`).join(' ')} You can use a plan session when you pay for those.</div></div>` : '')
        + `<div class="btns cta"><button class="btn" id="next" ${w.service ? '' : 'disabled'}>Continue</button></div>`;
      document.querySelectorAll('[data-s]').forEach((el) => el.onclick = () => { w.service = services.find((s) => s.id === Number(el.dataset.s)); w.time = null; w.planId = null; draw(); });
      $('#next').onclick = () => setStep(2);
    } else if (w.step === 2) {
      const today = state.cfg.today;
      const days = Array.from({ length: state.cfg.booking_window_days || 14 }, (_, i) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
      if (!w.date) w.date = today;
      if (!days.includes(w.date)) { w.date = today; w.time = null; }   // the picked day is outside the window now: fall back to today, never a day the strip does not show
      const keepScroll = document.querySelector('.days')?.scrollLeft || 0;   // redrawing after a tap must not jump the date strip back to the first day
      app.innerHTML = head + `<h2>Pick a date &amp; time</h2><div class="days">${days.map((d) => { const x = new Date(d + 'T00:00:00Z'); return `<button class="chip ${w.date === d ? 'on' : ''} ${closedDates.has(d) || offWeekdays.has(x.getUTCDay()) ? 'closed' : ''}" data-d="${d}">${DAYN[x.getUTCDay()]}<b>${x.getUTCDate()}</b>${MON[x.getUTCMonth()]}</button>`; }).join('')}</div>
        <div id="slots" class="card muted">Loading times…</div><div class="btns cta"><button class="btn sec" id="back">Back</button><button class="btn" id="next" ${w.time ? '' : 'disabled'}>Continue</button></div>`;
      const strip = document.querySelector('.days');
      if (strip) { if (keepScroll) strip.scrollLeft = keepScroll; else strip.querySelector('.chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' }); }   // keep the strip where the customer left it, with the chosen day in view
      document.querySelectorAll('[data-d]').forEach((el) => el.onclick = () => { w.date = el.dataset.d; w.time = null; draw(); });
      $('#back').onclick = () => stepBack(1);
      $('#next').onclick = () => setStep(3);
      const seq = w.slotSeq = (w.slotSeq || 0) + 1;   // only the newest slot request may draw the list
      try {
        const r = await api(`/barbers/${barberId}/slots?service_id=${w.service.id}&date=${w.date}`);
        if (seq !== w.slotSeq) return;
        $('#slots').className = 'card';
        $('#slots').innerHTML = r.slots.length
          ? `<div class="small muted" style="margin-bottom:8px">${esc(w.service.name)} · ${w.service.duration_min} min · ${dateLabel(w.date)}</div><div class="chips">${r.slots.map((s) => `<button class="chip ${w.time === s.time ? 'on' : ''}" data-t="${s.time}">${t12(s.time)}</button>`).join('')}</div>`
          : `<p class="muted center">${esc(r.closed_reason || 'No free times left this day.')}<br>Pick another date.</p>${!r.closed_reason && (state.cfg.features || {}).waitlist ? `<div class="btns center"><button class="btn sm" id="joinwait">${ic('bell', 'sm')} Tell me when a time is free</button></div>` : ''}`;
        const jw = $('#joinwait'); if (jw) jw.onclick = async () => { jw.disabled = true; try { await api('/waitlist', { method: 'POST', body: { barber_id: barberId, service_id: w.service.id, date: w.date } }); window.posthog?.capture('waitlist_joined'); jw.outerHTML = `<div class="ok small">You are on the waitlist. We will tell you as soon as a time is free.</div>`; } catch (e) { fail(e); jw.disabled = false; } };
        document.querySelectorAll('[data-t]').forEach((el) => el.onclick = () => { w.time = el.dataset.t; document.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x === el)); $('#next').disabled = false; });
      } catch (e) {
        if (seq !== w.slotSeq) return;
        // The window changed on the server: take the new window and redraw the strip, rather than showing the error for a day that is no longer offered.
        if (/^You can book up to /.test(userMessage(e))) { const before = state.cfg.booking_window_days; await freshConfig(); if (state.cfg.booking_window_days !== before) return draw(); }
        $('#slots').innerHTML = `<div class="err">${esc(userMessage(e))}</div>`;
      }
    } else {
      const cr = creditFor(), pls = plansFor(), pl = planFor();
      const onlineOk = bk.online_payments !== false;
      const opts = (onlineOk ? ['ONLINE'] : []).concat(bk.pay_on_arrival ? ['ON_ARRIVAL'] : [], pls.length ? ['PLAN'] : [], cr ? ['CREDIT'] : []);
      if (!w.payTouched) w.pay = cr ? 'CREDIT' : pls.length === 1 ? 'PLAN' : bk.pay_on_arrival ? 'ON_ARRIVAL' : onlineOk ? 'ONLINE' : null;   // credit / plan session are auto-applied by default
      if (!opts.includes(w.pay)) w.pay = opts[0];
      if (w.pay === 'PLAN' && !pl) w.pay = opts.find((o) => o !== 'PLAN') || null;   // several plans match and none is picked yet: the customer chooses
      const free = w.pay === 'PLAN' || w.pay === 'CREDIT';
      const pn = w.service.pay_now || { booking_fee_kobo: 0, total_kobo: w.service.price_kobo };
      app.innerHTML = head + `<h2>Summary &amp; payment</h2>
        <div class="card"><div class="row between"><b>${esc(w.service.name)}</b><b>${free ? '<s class="muted">' + naira(w.service.price_kobo) + '</s> ₦0' : naira(w.service.price_kobo)}</b></div>
          <div class="muted small">${w.service.duration_min} min · ${dateLabel(w.date)} at ${t12(w.time)}</div><div class="muted small">${esc(barber.shop_name)}, ${esc(barber.location || '')}</div>
          ${w.pay === 'ONLINE' && pn.booking_fee_kobo ? `<div class="money">${mrow('Price', naira(w.service.price_kobo))}${mrow('Booking fee <small class="muted">· helps cover card payment costs</small>', naira(pn.booking_fee_kobo))}${mrow('Total to pay', naira(pn.total_kobo), 'tot')}</div>` : ''}</div>
        <h3 style="margin-top:16px">How would you like to pay?</h3>
        ${cr ? `<button class="svc ${w.pay === 'CREDIT' ? 'on' : ''}" data-p="CREDIT"><div><b>Use session credit</b><div class="muted small">No payment · works until ${dateLabel(cr.expires_at.slice(0, 10))} · this barber, same service or same price</div></div></button>` : ''}
        ${pls.map((x) => `<button class="svc ${w.pay === 'PLAN' && pl && pl.id === x.id ? 'on' : ''}" data-p="PLAN" data-pid="${x.id}"><div><b>Use plan session</b><div class="muted small">${esc(x.plan_name)} · ${x.sessions_left} left · ends ${dateLabel(x.expires_at.slice(0, 10))}</div></div></button>`).join('')}
        ${!pls.length && otherPlans().length ? `<div class="info small notice" id="plan-nofit">${ic('ticket', 'sm')}<div>${otherPlans().map((x) => `Your plan <b>${esc(x.plan_name)}</b> covers ${esc(svcNames(x.service_ids, services))} only.`).join(' ')} It does not cover ${esc(w.service.name)}. Choose another way to pay.</div></div>` : ''}
        ${onlineOk ? `<button class="svc ${w.pay === 'ONLINE' ? 'on' : ''}" data-p="ONLINE"><div><b>Pay now</b><div class="muted small">Pay safely online with Paystack${state.cfg.mock ? ' (test checkout)' : ''}. We add a small booking fee: ${naira(pn.booking_fee_kobo)}.</div></div></button>` : ''}
        ${bk.pay_on_arrival ? `<button class="svc ${w.pay === 'ON_ARRIVAL' ? 'on' : ''}" data-p="ON_ARRIVAL"><div><b>Pay on arrival</b><div class="muted small">Pay with cash or transfer at the shop</div></div></button>` : `<div class="info small notice" id="poa-off">${ic('warn', 'sm')}<div>${onlineOk ? "You cannot pay on arrival for this booking right now. Please pay online." : "This barber cannot take online payments or pay on arrival right now. Pick another barber or try again later."}</div></div>`}
        ${bk.paused || bk.maintenance ? `<div class="warn small notice">${ic('warn', 'sm')}<div>${bk.maintenance ? esc(state.cfg.maintenance || 'TrimSlot is paused for a short time while we fix things.') : 'This shop has paused new bookings.'} You cannot book right now.</div></div>` : ''}
        ${w.pay === 'ONLINE' ? `<div class="warn small notice">${ic('warn', 'sm')}<div><b>Your time is saved only after you pay.</b> Until then, other people can book it. If someone books it first, your booking is not confirmed and we refund your money.</div></div>` : ''}
        <div class="info small">After you book, this time is yours. You can cancel until ${state.cfg.cancel_cutoff_min} minutes before. If you paid online, we refund your card. After that, the time stays yours. If you miss a <b>paid</b> session, we do not refund it. You get one credit with this barber.</div>
        ${(state.cfg.features || {}).booking_note ? `<label for="bnote">Note to your barber <span class="muted small">(optional)</span></label><textarea id="bnote" rows="2" maxlength="200" placeholder="For example: low fade, keep the beard">${esc(w.note || '')}</textarea>` : ''}
        <div class="btns cta"><button class="btn sec" id="back">Back</button><button class="btn" id="confirm" ${bk.paused || bk.maintenance || !w.pay ? 'disabled' : ''}>${w.pay === 'ONLINE' ? 'Go to pay ' + naira(pn.total_kobo) : free ? 'Book with ' + (w.pay === 'CREDIT' ? 'credit' : 'plan session') : 'Confirm booking'}</button></div>`;
      document.querySelectorAll('[data-p]').forEach((el) => el.onclick = () => { w.pay = el.dataset.p; if (el.dataset.pid) w.planId = Number(el.dataset.pid); w.payTouched = true; draw(); });
      const bn = $('#bnote'); if (bn) bn.oninput = () => { w.note = bn.value; };
      $('#back').onclick = () => stepBack(2);
      $('#confirm').onclick = async () => {
        $('#confirm').disabled = true;
        try {
          const r = await api('/bookings', { method: 'POST', body: { barber_id: barberId, service_id: w.service.id, date: w.date, time: w.time, payment_option: w.pay, ...(w.pay === 'PLAN' && planFor() ? { plan_purchase_id: planFor().id } : {}), ...(w.note && w.note.trim() ? { note: w.note.trim() } : {}) } });
          state.wiz = null;
          if (w.pay === 'ONLINE') {
            const p = await api(`/bookings/${r.booking.id}/pay`, { method: 'POST' });
            window.posthog?.capture('booking_payment_started');
            location.href = p.authorization_url; return;
          }
          window.posthog?.capture('booking_confirmed', { payment_option: w.pay });
          toast('Booking confirmed'); if (window.haptics) haptics.success(); location.hash = '#/booking/' + r.booking.id;
        } catch (e) {
          if (e.code === 'EMAIL_NOT_VERIFIED' && emailCheckOn()) { go('#/verify-email?next=' + encodeURIComponent(location.hash)); return; }
          if (e.code === 'SLOT_UNAVAILABLE') { w.time = null; w.step = 2; draw(userMessage(e)); } else draw(userMessage(e));
        }
      };
    }
  };
  draw();
}


/* ---------- shared: theme switch, account form ---------- */
const themeRow = () => `<div class="lrow"><span class="ico">${ic(isDark() ? 'moon' : 'sun')}</span><span class="grow">Dark mode</span><button class="switch" id="themesw" role="switch" aria-checked="${isDark()}" aria-label="Dark mode"></button></div>`;
const wireTheme = () => { const b = $('#themesw'); if (b) b.onclick = () => { toggleTheme(); b.setAttribute('aria-checked', String(isDark())); const i = b.parentElement.querySelector('.ico'); if (i) i.innerHTML = ic(isDark() ? 'moon' : 'sun'); }; };
const accountForm = (u) => `<form id="acct"><label>Full name</label><input name="name" value="${esc(u.name)}" autocomplete="name" required>
  <label>Email</label><input name="email" type="email" value="${esc(u.email || '')}" autocomplete="email" placeholder="you@example.com">
  <label>Phone</label><input name="phone" type="tel" value="${esc(u.phone || '')}" autocomplete="tel" placeholder="0803 123 4567">
  <div class="btns cta"><button class="btn" type="submit">Save changes</button></div></form>`;
function wireAccount(after) {
  $('#acct').onsubmit = async (ev) => {
    ev.preventDefault(); const btn = ev.target.querySelector('button'); btn.disabled = true;
    try { const r = await api('/me', { method: 'PATCH', body: Object.fromEntries(new FormData(ev.target)) }); state.user = { ...state.user, ...r.user }; toast('Saved'); after(); } catch (e) { fail(e); btn.disabled = false; }
  };
}
const signOutRow = () => `<button class="lrow danger" id="signout"><span class="ico">${ic('logout')}</span><span class="grow">Sign out</span></button>`;
const wireSignOut = () => { const b = $('#signout'); if (b) b.onclick = signOut; };


/* Accessible, compact accordion sections shared by customer and barber profiles. */
function wireProfileAccordions() {
  const sections = [...app.querySelectorAll('.profile-section')];
  sections.forEach((section, index) => {
    if (section.dataset.accordionReady === 'true') return;
    const heading = section.querySelector(':scope > h2');
    if (!heading) return;
    section.dataset.accordionReady = 'true';
    const content = document.createElement('div');
    content.className = 'profile-accordion-content';
    content.id = section.id + '-content';
    while (heading.nextSibling) content.appendChild(heading.nextSibling);
    const trigger = document.createElement('div');
    trigger.className = 'profile-accordion-trigger';
    trigger.setAttribute('role', 'button');
    trigger.setAttribute('tabindex', '0');
    trigger.setAttribute('aria-controls', content.id);
    trigger.setAttribute('aria-expanded', String(index === 0));
    heading.className = 'profile-accordion-title';
    trigger.append(heading);
    const chevron = document.createElement('span');
    chevron.className = 'profile-accordion-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML = ic('chev');
    trigger.append(chevron);
    section.append(trigger, content);
    section.classList.toggle('is-open', index === 0);
    const toggle = () => {
      const open = !section.classList.contains('is-open');
      section.classList.toggle('is-open', open);
      trigger.setAttribute('aria-expanded', String(open));
    };
    trigger.addEventListener('click', toggle);
    trigger.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
    });
  });
}

/* ---------- customer: profile ---------- */
async function profile(editing) {
  const [w, bk] = await Promise.all([api('/me/wallet'), api('/bookings')]);
  const u = state.user;
  const livePlans = w.plans.filter((p) => p.live), liveCredits = w.credits.filter((c) => c.live);
  const now = Date.parse(state.cfg?.now || new Date().toISOString());
  const upcoming = bk.bookings.filter((b) => ['CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(b.status) && Date.parse(b.scheduled_time || '') >= now)
    .sort((a, b) => Date.parse(a.scheduled_time) - Date.parse(b.scheduled_time));
  const next = upcoming[0];
  const emailState = !emailCheckOn() ? 'Not required right now' : u.email_verified ? 'Verified' : 'Not verified';
  const emailBadge = !emailCheckOn() ? 'b-blue' : u.email_verified ? 'b-green' : 'b-amber';
  app.innerHTML = `<div class="customer-profile">
    <section class="profile-section" id="profile-contact"><h2>Profile &amp; contact</h2>
      <div class="prof-head"><div class="avatar">${initials(u.name)}</div><div class="grow"><h1 class="ellip">${esc(u.name)}</h1><div class="muted small">Customer profile</div></div></div>
      <div id="profile-photo-slot"></div>
      <div class="card profile-contact"><div><span>Email</span><b>${esc(u.email || 'Not added')}</b><span class="badge ${emailBadge}">${esc(emailState)}</span></div>
        <div><span>Phone</span><b>${esc(u.phone || 'Not added')}</b></div>
        <p class="small muted">Email verification is shown above. Phone verification is not currently available.</p></div>
      <div class="list"><button class="lrow" id="editbtn"><span class="ico">${ic('pencil', 'sm')}</span><span class="grow">Edit details<span class="sub">Name, email and phone</span></span><span class="end">${ic('right', 'sm')}</span></button>
        ${emailCheckOn() ? `<a class="lrow" href="#/verify-email?next=%23%2Fprofile"><span class="ico">${ic('shield', 'sm')}</span><span class="grow">${u.email_verified ? 'Email verified' : (u.email ? 'Verify or resend code' : 'Add and verify email')}<span class="sub">${u.email_verified ? 'Your email is checked' : 'Send a 6-digit code to your email'}</span></span><span class="end">${ic('right', 'sm')}</span></a>` : ''}</div>
      <div id="editbox" class="${editing ? '' : 'hidden'}"><div class="card">${accountForm(u)}</div></div>
    </section>
    <section class="profile-section" id="profile-security"><h2>Security &amp; sign-in</h2>
      <div class="list"><button class="lrow" id="password-toggle" aria-expanded="false"><span class="ico">${ic('lock', 'sm')}</span><span class="grow">Change password<span class="sub">Use your current password to choose a new one</span></span><span class="end">${ic('right', 'sm')}</span></button>
        <a class="lrow" href="#/password-reset"><span class="ico">${ic('refresh', 'sm')}</span><span class="grow">Forgot your password?<span class="sub">Reset it with a code sent by email</span></span><span class="end">${ic('right', 'sm')}</span></a></div>
      <div id="password-box" class="hidden"><form id="password-change" class="card" autocomplete="on"><label>Current password</label><input name="current_password" type="password" autocomplete="current-password" required>
        <label>New password</label><input name="new_password" type="password" autocomplete="new-password" minlength="8" required>
        <label>Confirm new password</label><input name="confirm_password" type="password" autocomplete="new-password" minlength="8" required>
        <div class="err hidden" id="password-error" role="alert"></div><div class="btns cta"><button class="btn" type="submit">Update password</button></div></form></div>
    </section>
    <section class="profile-section" id="profile-bookings"><h2>Bookings</h2>
      ${next ? `<p class="small muted" style="margin:0 0 6px">Nearest upcoming booking</p>${clist([bookingCard(next)])}` : '<p class="muted small">No upcoming bookings.</p>'}
      <div class="list"><a class="lrow" href="#/bookings"><span class="ico">${ic('cal', 'sm')}</span><span class="grow">All bookings<span class="sub">${bk.bookings.length} booking${bk.bookings.length === 1 ? '' : 's'} and history</span></span><span class="end">${ic('right', 'sm')}</span></a></div>
    </section>
    <section class="profile-section" id="profile-wallet"><h2>Wallet &amp; receipts</h2>
      <div class="list"><a class="lrow" href="#/wallet"><span class="ico">${ic('wallet', 'sm')}</span><span class="grow">Plans &amp; credits<span class="sub">${livePlans.length ? livePlans.map((p) => p.sessions_left + ' left · ' + esc(p.shop_name)).join(', ') : 'No active plan'}${liveCredits.length ? ` · ${liveCredits.length} session credit${liveCredits.length === 1 ? '' : 's'}` : ''}</span></span><span class="end">${ic('right', 'sm')}</span></a>
        <a class="lrow" href="#/receipts"><span class="ico">${ic('list', 'sm')}</span><span class="grow">Receipts<span class="sub">View and save paid booking receipts</span></span><span class="end">${ic('right', 'sm')}</span></a></div>
    </section>
    <section class="profile-section" id="profile-preferences"><h2>Preferences</h2>
      <div class="list">${themeRow()}<a class="lrow" href="#/notifications"><span class="ico">${ic('bell', 'sm')}</span><span class="grow">Notification centre</span><span class="end">${state.unread ? `<span class="badge b-blue">${state.unread} new</span>` : ''}${ic('right', 'sm')}</span></a>${Notify.prefsRows()}</div>
    </section>
    <section class="profile-section" id="profile-help"><h2>Help, privacy &amp; account actions</h2>
      <div class="list"><button class="lrow" data-report="0" data-report-category="OTHER"><span class="ico">${ic('warn', 'sm')}</span><span class="grow">Help &amp; Support<span class="sub">Send a question or report a problem to TrimSlot</span></span><span class="end">${ic('right', 'sm')}</span></button>
        <a class="lrow" href="/terms.html" target="_blank" rel="noopener"><span class="ico">${ic('list', 'sm')}</span><span class="grow">Terms of Service</span><span class="end">${ic('right', 'sm')}</span></a></div>
      <div id="profile-data-slot"></div><div class="list">${signOutRow()}</div>
    </section></div>`;
  wireProfileAccordions();
  $('#editbtn').onclick = () => $('#editbox').classList.toggle('hidden');
  wireAccount(() => profile(true)); wireTheme(); Notify.wirePrefs(); wireSignOut();
  $('#password-toggle').onclick = () => { const box = $('#password-box'), open = box.classList.toggle('hidden') === false; $('#password-toggle').setAttribute('aria-expanded', String(open)); };
  $('#password-change').onsubmit = async (ev) => {
    ev.preventDefault(); const f = ev.target.elements, btn = ev.target.querySelector('button[type=submit]'), er = $('#password-error');
    er.classList.add('hidden');
    if (f.new_password.value !== f.confirm_password.value) { er.textContent = 'Those new passwords do not match.'; er.classList.remove('hidden'); return; }
    btn.disabled = true;
    try { await api('/auth/password/change', { method: 'POST', body: { current_password: f.current_password.value, new_password: f.new_password.value } }); ev.target.reset(); toast('Password changed. Other devices will need to log in again.'); }
    catch (e) { er.textContent = userMessage(e, 'We could not change your password.'); er.classList.remove('hidden'); }
    finally { btn.disabled = false; }
  };
}

/* ---------- sharing a private barber link (the barber's own, and a customer passing a barber on) ---------- */
const canShare = () => typeof navigator.share === 'function';
/** QR + link + Copy + Share. `ids` keeps the old element ids for the barber's own card. */
const shareCardHtml = (o) => `<div class="card share" id="${o.id}"><div class="row" style="gap:14px;align-items:flex-start"><img class="qr" src="${esc(o.qr)}" alt="QR code for ${esc(o.name)}" width="132" height="132" loading="lazy" decoding="async"><div class="grow" style="min-width:0"><b>${esc(o.title)}</b><p class="small muted" style="margin:4px 0 8px">${esc(o.hint)}</p><div class="linkbox small" data-linkbox>${esc(o.url)}</div></div></div>
  <div class="btns" style="margin-top:12px"><button class="btn sm" type="button" data-copy>${ic('copy', 'sm')} Copy link</button>${canShare() ? `<button class="btn sm sec" type="button" data-share>${ic('share', 'sm')} Share</button>` : ''}${o.extra || ''}</div></div>`;
async function copyLink(url, box) {
  try { await navigator.clipboard.writeText(url); toast('Link copied'); }
  catch { if (box) { const rg = document.createRange(); rg.selectNodeContents(box); const sl = getSelection(); sl.removeAllRanges(); sl.addRange(rg); } toast('Press and hold the link to copy it'); }
}
const wireShareCard = (root, url, name) => {
  if (!root) return;
  const c = root.querySelector('[data-copy]'); if (c) c.onclick = () => copyLink(url, root.querySelector('[data-linkbox]'));
  const sh = root.querySelector('[data-share]'); if (sh) sh.onclick = () => navigator.share({ title: name + ' on TrimSlot', text: 'Book ' + name + ' on TrimSlot', url }).catch(() => {});
};
/** A small sheet from "My barbers": QR, link, Copy, Share. */
function openShareSheet(b) {
  const prev = document.activeElement, el = document.createElement('div'); el.className = 'scrim';
  el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="shs-t"><h3 id="shs-t" style="margin:0 0 4px">Share ${esc(b.shop_name)}</h3><p class="small muted" style="margin:0 0 12px">Anyone with this link can see the shop. Send it only to people you trust.</p>${shareCardHtml({ id: 'shs-card', qr: b.share.qr_url, name: b.shop_name, title: 'Link and QR code', hint: 'A friend can scan the code or open the link.', url: b.share.url })}<div class="btns cta"><button class="btn sec" type="button" id="shs-close">Close</button></div></div>`;
  const close = () => { document.removeEventListener('keydown', onKey, true); el.remove(); if (prev && prev.focus) prev.focus(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  document.body.appendChild(el); wireShareCard(el.querySelector('#shs-card'), b.share.url, b.shop_name);
  const x = el.querySelector('#shs-close'); x.onclick = close; x.focus();
}

/* ---------- barber: profile hub ---------- */
async function barberProfile() {
  const [r, po, shr] = await Promise.all([api('/barber/profile'), api('/barber/plans').catch(() => null), api('/barber/share').catch(() => null)]);
  const p = r.profile, u = state.user;
  const liveBuyers = po ? po.purchases.filter((x) => x.live).length : 0;
  const emailState = !emailCheckOn() ? 'Not required right now' : u.email_verified ? 'Verified' : 'Not verified';
  const emailBadge = !emailCheckOn() ? 'b-blue' : u.email_verified ? 'b-green' : 'b-amber';
  const review = ({ VERIFIED: ['b-green', 'Approved'], PENDING: ['b-amber', 'Waiting for review'], NEEDS_INFO: ['b-amber', 'Changes requested'], REJECTED: ['b-red', 'Not approved'], SUSPENDED: ['b-red', 'Suspended'] })[p.review_status] || ['b-gray', 'Status unknown'];
  const reviewCopy = p.verified ? 'Your shop has passed review and is available through its share link.' : p.review_status === 'NEEDS_INFO' ? 'Update the requested details in Shop settings, then send your shop for review again.' : p.review_status === 'REJECTED' ? 'Check the review note, update your shop, and send it for review again.' : p.review_status === 'SUSPENDED' ? 'Customers cannot see or book your shop while it is suspended.' : 'Your shop is not live yet. Complete setup and wait for TrimSlot to review it.';
  app.innerHTML = `<div class="customer-profile barber-profile">
    <section class="profile-section" id="barber-profile-status"><h2>Shop status &amp; identity</h2>
      <div class="prof-head">${avatar({ photo_url: p.photo_url, shop_name: p.shop_name }, 'lg', true)}<div class="grow"><h1 class="ellip">${esc(p.shop_name)}</h1><div class="muted small ellip">${esc(u.name)}${p.location ? ' · ' + esc(p.location) : ''}</div></div></div>
      <div class="card profile-contact"><div><span>Shop</span><b>${esc(p.shop_name)}</b></div><div><span>Status</span><span class="badge ${review[0]}">${esc(review[1])}</span></div><p class="small muted">${reviewCopy}</p></div>
      ${pendingBanner()}
      <div class="list"><a class="lrow" href="#/settings"><span class="ico">${ic('store', 'sm')}</span><span class="grow">Edit shop identity<span class="sub">Shop name, photo, location and about</span></span><span class="end">${ic('right', 'sm')}</span></a></div>
    </section>
    <section class="profile-section" id="barber-profile-link"><h2>Booking link/QR</h2>
      ${shr ? shareCardHtml({ id: 'profile-sharecard', qr: shr.qr_url, name: p.shop_name, title: 'Your booking link and QR code', hint: 'Customers can find your shop only through the link or QR code you share. Old links no longer work.', url: shr.url }) : `<div class="card small muted">Your booking link is temporarily unavailable. Open Shop settings to retry.</div>`}
      <div class="list"><a class="lrow" href="#/settings" id="shoplink"><span class="ico">${ic('share', 'sm')}</span><span class="grow">Manage link &amp; QR<span class="sub">View or replace your current booking link</span></span><span class="end">${ic('right', 'sm')}</span></a></div>
    </section>
    <section class="profile-section" id="barber-profile-tools"><h2>Shop tools &amp; payouts</h2>
      ${payoutBanner()}
      <div class="list"><a class="lrow" href="#/payouts"><span class="ico">${ic('wallet', 'sm')}</span><span class="grow">Payouts<span class="sub">${p.payout && p.payout.status === 'ACTIVE' ? 'Payouts on · ' + esc(p.payout.bank_name || 'Bank') + ' ••' + esc(p.payout.account_last4 || '') : 'Add your bank account to get paid online'}</span></span><span class="end">${p.payout && p.payout.status === 'ACTIVE' ? '<span class="badge b-green">ACTIVE</span>' : '<span class="badge b-amber">SET UP</span>'}${ic('right', 'sm')}</span></a>
        <a class="lrow" href="#/settings"><span class="ico">${ic('store', 'sm')}</span><span class="grow">Shop settings<span class="sub">Services, hours and days off</span></span><span class="end">${ic('right', 'sm')}</span></a>
        <a class="lrow" href="#/plans"><span class="ico">${ic('ticket', 'sm')}</span><span class="grow">Plans &amp; credits<span class="sub">${po ? po.plans.length + ' plan' + (po.plans.length === 1 ? '' : 's') + ' · ' + liveBuyers + ' active buyer' + (liveBuyers === 1 ? '' : 's') : 'Create and manage plans'}</span></span><span class="end">${ic('right', 'sm')}</span></a>
        <a class="lrow" href="#/balance"><span class="ico">${ic('wallet', 'sm')}</span><span class="grow">Platform balance owed<span class="sub">Commission on bookings paid outside the app</span></span><span class="end">${ic('right', 'sm')}</span></a>
        ${(state.cfg.features || {}).reviews ? `<a class="lrow" href="#/reviews"><span class="ico">${ic('star', 'sm')}</span><span class="grow">Reviews<span class="sub">Ratings from finished visits. Reply to customers.</span></span><span class="end">${ic('right', 'sm')}</span></a>` : ''}
        ${p.verified ? `<a class="lrow" href="#/barber/${p.id}"><span class="ico">${ic('user', 'sm')}</span><span class="grow">View my public page<span class="sub">What customers see through your link</span></span><span class="end">${ic('right', 'sm')}</span></a>` : ''}</div>
    </section>
    <section class="profile-section" id="barber-profile-contact"><h2>Contact &amp; verification</h2>
      <div class="card profile-contact"><div><span>Name</span><b>${esc(u.name)}</b></div><div><span>Email</span><b>${esc(u.email || 'Not added')}</b><span class="badge ${emailBadge}">${esc(emailState)}</span></div><div><span>Phone</span><b>${esc(u.phone || 'Not added')}</b></div><p class="small muted">We check your email before your shop goes live. Phone verification is not currently available.</p></div>
      <div class="list"><button class="lrow" id="editbtn"><span class="ico">${ic('pencil', 'sm')}</span><span class="grow">Edit contact details<span class="sub">Name, email and phone</span></span><span class="end">${ic('right', 'sm')}</span></button>
        ${emailCheckOn() ? `<a class="lrow" href="#/verify-email?next=%23%2Fprofile"><span class="ico">${ic('shield', 'sm')}</span><span class="grow">${u.email_verified ? 'Email verified' : (u.email ? 'Verify or resend code' : 'Add and verify email')}<span class="sub">${u.email_verified ? 'Your email is checked' : 'Send a 6-digit code to your email'}</span></span><span class="end">${ic('right', 'sm')}</span></a>` : ''}</div>
      <div id="editbox" class="hidden"><div class="card">${accountForm(u)}</div></div>
    </section>
    <section class="profile-section" id="barber-profile-security"><h2>Security</h2>
      <p class="small muted" style="margin:0 0 8px">Sign in with your password. Email codes are only used for verification or password recovery.</p>
      <div class="list"><button class="lrow" id="password-toggle" aria-expanded="false"><span class="ico">${ic('lock', 'sm')}</span><span class="grow">Change password<span class="sub">Use your current password to choose a new one</span></span><span class="end">${ic('right', 'sm')}</span></button>
        <a class="lrow" href="#/password-reset"><span class="ico">${ic('refresh', 'sm')}</span><span class="grow">Reset a forgotten password<span class="sub">Use a code sent to your email</span></span><span class="end">${ic('right', 'sm')}</span></a></div>
      <div id="password-box" class="hidden"><form id="password-change" class="card" autocomplete="on"><label>Current password</label><input name="current_password" type="password" autocomplete="current-password" required>
        <label>New password</label><input name="new_password" type="password" autocomplete="new-password" minlength="8" required>
        <label>Confirm new password</label><input name="confirm_password" type="password" autocomplete="new-password" minlength="8" required>
        <div class="err hidden" id="password-error" role="alert"></div><div class="btns cta"><button class="btn" type="submit">Update password</button></div></form></div>
    </section>
    <section class="profile-section" id="barber-profile-preferences"><h2>Preferences, privacy &amp; help</h2>
      <div class="list">${themeRow()}<a class="lrow" href="#/notifications"><span class="ico">${ic('bell', 'sm')}</span><span class="grow">Notification centre</span><span class="end">${state.unread ? `<span class="badge b-blue">${state.unread} new</span>` : ''}${ic('right', 'sm')}</span></a>${Notify.prefsRows()}</div>
      <div class="list"><button class="lrow" data-report="0" data-report-category="OTHER"><span class="ico">${ic('warn', 'sm')}</span><span class="grow">Help &amp; Support<span class="sub">Send a question or report a problem to TrimSlot</span></span><span class="end">${ic('right', 'sm')}</span></button>
        <a class="lrow" href="/terms.html" target="_blank" rel="noopener"><span class="ico">${ic('list', 'sm')}</span><span class="grow">Terms of Service</span><span class="end">${ic('right', 'sm')}</span></a></div>
      <div id="profile-data-slot"></div><div class="list">${signOutRow()}</div>
    </section></div>`;
  wireProfileAccordions();
  $('#editbtn').onclick = () => $('#editbox').classList.toggle('hidden');
  if (shr) wireShareCard($('#profile-sharecard'), shr.url, p.shop_name);
  wireAccount(() => barberProfile()); wireTheme(); Notify.wirePrefs(); wireSignOut();
  $('#password-toggle').onclick = () => { const box = $('#password-box'), open = box.classList.toggle('hidden') === false; $('#password-toggle').setAttribute('aria-expanded', String(open)); };
  $('#password-change').onsubmit = async (ev) => {
    ev.preventDefault(); const f = ev.target.elements, btn = ev.target.querySelector('button[type=submit]'), er = $('#password-error');
    er.classList.add('hidden');
    if (f.new_password.value !== f.confirm_password.value) { er.textContent = 'Those new passwords do not match.'; er.classList.remove('hidden'); return; }
    btn.disabled = true;
    try { await api('/auth/password/change', { method: 'POST', body: { current_password: f.current_password.value, new_password: f.new_password.value } }); ev.target.reset(); toast('Password changed. Other devices will need to log in again.'); }
    catch (e) { er.textContent = userMessage(e, 'We could not change your password.'); er.classList.remove('hidden'); }
    finally { btn.disabled = false; }
  };
}

/* ---------- barber: payouts (bank list -> account number -> resolve name -> save -> "Payouts active") ---------- */
async function barberPayouts() {
  const [st, bl] = await Promise.all([api('/barber/payout'), api('/barber/payout/banks').catch(() => ({ banks: [], source: 'none' }))]);
  const active = st.status === 'ACTIVE';
  const bank = (code) => (bl.banks.find((b) => b.code === code) || {}).name || '';
  app.innerHTML = `${pendingBanner()}<a href="#/profile" class="back">${ic('back', 'sm')} Profile</a><h1>Payouts</h1>
    <p class="muted">Money from online bookings goes straight to your bank account through Paystack. Pay-on-arrival bookings are paid to you directly.</p><div id="msg"></div>
    ${active ? `<div class="card payok"><div class="row between"><b>${ic('check', 'sm')} Payouts active</b><span class="badge b-green">ACTIVE</span></div>
        <div class="small" style="margin-top:6px">${esc(st.bank_name || 'Bank')} · account ••••${esc(st.account_last4 || '')}</div><div class="small muted">${esc(st.account_name || '')}${st.name_verified === false ? ' · <span class="badge b-amber">NAME NOT CHECKED</span>' : ''}</div>
        <div class="btns" style="margin-top:10px"><button class="btn sm sec" id="chg">Change account</button></div></div>`
      : `<div class="warn notice">${ic('warn')}<div><b>Payouts are not set up.</b> Until you add your bank account, customers cannot pay you online. They only see “Pay on arrival”.</div></div>`}
    <form id="pof" class="card ${active ? 'hidden' : ''}" novalidate>
      ${bl.source === 'fallback' || bl.source === 'stale' ? '<div class="info small">We could not load the full bank list, so this list is short. If your bank is not here, reload in a minute.</div>' : ''}${!bl.banks.length ? '<div class="err">We could not load the banks. Check your internet and <a href="#/payouts" data-reload>reload</a>.</div>' : ''}
      <label for="pobank">Bank</label>
      <select id="pobank" name="bank_code" required><option value="">Choose your bank…</option>${bl.banks.map((b) => `<option value="${esc(b.code)}">${esc(b.name)}</option>`).join('')}</select>
      <label for="poacct">Account number</label>
      <input id="poacct" name="account_number" inputmode="numeric" autocomplete="off" maxlength="10" placeholder="10-digit account number" required>
      <div id="poname" class="small" aria-live="polite" style="min-height:20px;margin-top:6px"></div>
      <div id="pomanual" class="hidden"><label for="pomn">Account name</label><input id="pomn" name="account_name" maxlength="80" autocomplete="off" placeholder="Write the name exactly as it is on the account"><div class="small muted" id="pomnote" style="margin-top:6px"></div><div class="btns" style="margin-top:8px"><button type="button" class="btn sm sec" id="poretry">Look up the name again</button></div></div>
      <div class="btns cta"><button class="btn" id="posave" disabled>Save payout account</button></div>
      <p class="small muted">We never keep your full account number. We keep only the last 4 digits and a Paystack code.</p>
    </form>`;
  const chg = $('#chg'); if (chg) chg.onclick = () => { $('#pof').classList.remove('hidden'); chg.disabled = true; };
  const f = $('#pof'), bankSel = $('#pobank'), acct = $('#poacct'), nameEl = $('#poname'), save = $('#posave'), manual = $('#pomanual'), mn = $('#pomn');
  let resolved = null, seq = 0;
  const valid = () => !!(bankSel.value && /^\d{10}$/.test(acct.value) && (resolved || (!manual.classList.contains('hidden') && mn.value.trim().length >= 2)));
  const sync = () => { save.disabled = !valid(); };
  const resolve = async () => {
    resolved = null; manual.classList.add('hidden'); sync();
    if (!(bankSel.value && /^\d{10}$/.test(acct.value))) { nameEl.textContent = ''; return; }
    const my = ++seq; nameEl.innerHTML = '<span class="muted">Checking the account…</span>';
    try {
      const r = await api('/barber/payout/resolve', { method: 'POST', body: { bank_code: bankSel.value, account_number: acct.value } });
      if (my !== seq) return; resolved = r.account_name; nameEl.innerHTML = `<span class="okt">${ic('check', 'sm')} ${esc(r.account_name)}</span>`;
    } catch (e) {
      if (my !== seq) return;
      if (e.code === 'RESOLVE_UNAVAILABLE') {   // the automatic name lookup is down / limited: let the barber type the name instead
        nameEl.innerHTML = '<span class="muted">We could not check the account name for you.</span>';
        $('#pomnote').textContent = userMessage(e) + ' We will mark the name as not checked.'; manual.classList.remove('hidden');
      } else if (e.code === 'NETWORK') nameEl.innerHTML = `<span class="errt">${esc(userMessage(e))}</span> <button type="button" class="linkbtn" id="poagain">Try again</button>`;
      else nameEl.innerHTML = `<span class="errt">${esc(userMessage(e))}</span>`;
      const ag = $('#poagain'); if (ag) ag.onclick = resolve;
    }
    sync();
  };
  $('#poretry').onclick = resolve; bankSel.onchange = resolve; acct.oninput = () => { acct.value = acct.value.replace(/\D/g, '').slice(0, 10); resolve(); }; mn.oninput = sync;
  f.onsubmit = async (ev) => {
    ev.preventDefault(); if (!valid()) return; save.disabled = true; save.textContent = 'Saving…';
    try {
      await api('/barber/payout', { method: 'POST', body: { bank_code: bankSel.value, account_number: acct.value, ...(resolved ? {} : { account_name: mn.value.trim() }) } });
      const me = await api('/auth/me'); state.user = me.user; toast('Payouts active'); barberPayouts();
    } catch (e) { fail(e); save.textContent = 'Save payout account'; sync(); }
  };
}

/* ---------- barber: plans manager (own tab) ---------- */
function animatePlanCount(el, target) {
  if (!el) return;
  const to = Math.max(0, Math.floor(Number(target) || 0));
  const from = Number(el.dataset.countValue || 0);
  if (el.dataset.countReady && from === to) return;
  el.dataset.countValue = String(to);
  el.dataset.countReady = '1';
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const paint = (n) => { el.textContent = Math.round(n).toLocaleString(); };
  if (reduced || from === to) { paint(to); return; }
  const start = performance.now(), duration = 480;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration), eased = 1 - Math.pow(1 - t, 3);
    paint(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
const barberPlanStats = (po) => {
  const plans = po.plans || [], purchases = po.purchases || [];
  const livePurchases = purchases.filter((p) => p.live);
  return {
    offers: plans.filter((p) => p.active && p.approval_status === 'APPROVED').length,
    purchases: livePurchases.length,
    sessions: livePurchases.reduce((sum, p) => sum + Math.max(0, Number(p.sessions_total) - Number(p.sessions_used)), 0),
  };
};
const barberPlanSignature = (po) => JSON.stringify({
  plans: (po.plans || []).map((p) => [p.id, p.active, p.approval_status, p.buyers, p.sessions_used, p.revenue_kobo]),
  purchases: (po.purchases || []).map((p) => [p.id, p.live, p.sessions_total, p.sessions_used, p.refund_request && p.refund_request.status]),
  credits: (po.credits || []).map((c) => [c.id, c.live, c.status, c.expires_at]),
});
async function barberPlans() {
  const [initial, profile] = await Promise.all([api('/barber/plans'), api('/barber/profile')]);
  const render = (po, openIds = []) => {
    const stats = barberPlanStats(po);
    const previousCounts = new Map([...app.querySelectorAll('[data-plan-counter]')].map((el) => [el.dataset.planCounter, { value: el.dataset.countValue || el.textContent || '0', ready: el.dataset.countReady }]));
    app.innerHTML = `<div class="barber-plans-view">${pendingBanner()}<h1>Plans &amp; credits</h1><p class="muted">Manage the packs customers can buy, and see how sessions are being used.</p>
      <div class="plan-live-summary"><div class="plan-live-head"><h2 class="plan-live-title">Your plan activity</h2><div class="plan-live-tools"><span class="plan-live-dot">LIVE</span><span class="plan-refresh-wrap"><button class="plan-refresh-info" type="button" aria-label="Show refresh information" aria-expanded="false" aria-controls="barber-refresh-note">i</button></span></div></div>
        <div class="plan-metrics barber-plan-metrics"><div class="plan-metric barber-plan-offers"><b data-plan-counter="barber-offers">0</b><span>Plans live</span></div><div class="plan-metric primary barber-plan-sessions"><b data-plan-counter="barber-sessions">0</b><span>Sessions left</span></div><div class="plan-metric barber-plan-purchases"><b data-plan-counter="barber-purchases">0</b><span>Active purchases</span></div><span class="barber-plan-balance" aria-hidden="true"></span></div>
        <p class="plan-live-note" id="barber-refresh-note" role="tooltip">Updates automatically every 10 seconds while this page is open.</p></div>
      <div id="msg"></div>${plansBody(po, profile.services)}</div>`;
    app.dataset.planSignature = barberPlanSignature(po);
    for (const el of app.querySelectorAll('[data-plan-counter]')) { const old = previousCounts.get(el.dataset.planCounter); if (old) { el.textContent = old.value; el.dataset.countValue = old.value; if (old.ready) el.dataset.countReady = old.ready; } }
    animatePlanCount(document.querySelector('[data-plan-counter="barber-offers"]'), stats.offers);
    animatePlanCount(document.querySelector('[data-plan-counter="barber-purchases"]'), stats.purchases);
    animatePlanCount(document.querySelector('[data-plan-counter="barber-sessions"]'), stats.sessions);
    for (const id of openIds) { const d = document.getElementById(id); if (d) d.open = true; }
    const refreshInfo = app.querySelector('.plan-refresh-info');
    if (refreshInfo) {
      const summary = refreshInfo.closest('.plan-live-summary');
      refreshInfo.onclick = () => { const open = !summary.classList.contains('is-refresh-open'); summary.classList.toggle('is-refresh-open', open); refreshInfo.setAttribute('aria-expanded', String(open)); };
      refreshInfo.onkeydown = (ev) => { if (ev.key === 'Escape') { summary.classList.remove('is-refresh-open'); refreshInfo.setAttribute('aria-expanded', 'false'); } };
    }
    const msg = (t, bad) => { const m = $('#msg'); if (m) m.innerHTML = `<div class="${bad ? 'err' : 'ok'}">${esc(t)}</div>`; window.scrollTo({ top: 0, behavior: 'smooth' }); };
    const guard = (fn, okmsg) => async (ev) => { ev && ev.preventDefault && ev.preventDefault(); try { await fn(ev); await barberPlans(); msg(okmsg); } catch (e) { msg(userMessage(e), true); } };
    wirePlans(po, guard);
    wireRefundBox(app, 'BARBER', barberPlans);
  };
  render(initial);
  startPoll(async () => {
    if (!location.hash.startsWith('#/plans')) return;
    const latest = await api('/barber/plans');
    if (barberPlanSignature(latest) === app.dataset.planSignature) return;
    const openIds = [...app.querySelectorAll('details[open][id]')].map((d) => d.id);
    render(latest, openIds);
  });
}

/* ---------- barber public page (customers land here first) ---------- */
async function barberPage(id, shareCode) {
  const data = await api(shareCode ? '/b/' + shareCode : '/barbers/' + id);
  const { barber, services } = data;
  if (shareCode) id = barber.id;
  const sh = data.share || null;                      // set when the page was opened from a share link
  if (sh && !state.user) { try { sessionStorage.setItem('trimslot_next', '#/b/' + shareCode); } catch { /* private mode */ } }   // log in or sign up, then come straight back
  const plans = data.plans || [], my = data.my || { plans: [], credits: [] }, q = data.queue || { waiting: 0, serving: 0 };
  const isCustomer = state.user?.role === 'customer';
  const notices = data.notices || [];
  const wd = new Date(state.cfg.today + 'T00:00:00Z').getUTCDay();
  const order = [1, 2, 3, 4, 5, 6, 0];
  const sched = data.schedule || [];
  const hoursRows = order.map((d) => { const x = sched.find((y) => y.weekday === d); return `<tr class="${d === wd ? 'today' : ''}"><td>${DAYFULL[d]}</td><td>${x && x.is_working ? `${t12(x.start)} – ${t12(x.end)}` : '<span class="muted">Closed</span>'}</td></tr>`; }).join('');
  const brk = sched.find((y) => y.is_working && y.break_start);
  const queueTxt = q.serving ? `Chair in use · ${q.waiting} waiting today` : q.waiting ? `${q.waiting} booked today` : 'No bookings yet today';
  const rv = sh ? { reviews: data.reviews || [] } : data.rating && data.rating.count ? await api('/barbers/' + id + '/reviews?limit=5').catch(() => null) : null;
  const lo = data.loyalty;
  const shareInfo = isCustomer ? (data.share_link || (sh && sh.url ? { url: sh.url, qr_url: sh.qr_url } : null)) : null;   // a customer who can see this barber can pass the link on
  app.innerHTML = `${state.user ? `<a href="${state.user.role === 'barber' ? '#/profile' : '#/'}" class="back">${ic('back', 'sm')} ${state.user.role === 'barber' ? 'Profile' : 'My barbers'}</a>` : ''}
    ${sh && state.user?.role === 'barber' ? `<div class="info small notice">${ic('ticket', 'sm')}<div>This is how customers see your shop when they open your link.</div></div>` : ''}
    <div class="row" style="align-items:flex-start">${avatar(barber, 'lg', true)}<div class="grow"><h1>${esc(barber.shop_name)}</h1>${data.rating ? `<div style="margin:2px 0">${ratingChip(data.rating) || '<span class="small muted">No reviews yet</span>'}</div>` : ''}<div class="muted small">${esc(barber.name)}</div>${barber.location ? `<div class="muted small">${ic('pin', 'sm')} ${esc(barber.location)}</div>` : ''}</div></div>
    <div class="row small muted" style="margin:12px 0 0">${ic('clock', 'sm')}<span>${esc(queueTxt)}</span></div>
    ${sh && !state.user ? `<div class="card" id="guestbox"><b>Want to book ${esc(barber.shop_name)}?</b><p class="small muted" style="margin:4px 0 10px">Log in or create a free account. You will come straight back to this page.</p><div class="btns"><a class="btn" id="loginbtn" href="#/login">Log in</a><a class="btn sec" id="signupbtn" href="#/signup?role=customer">Sign up</a></div></div>` : ''}
    ${sh && isCustomer ? `<div class="btns" style="margin-top:12px"><button class="btn ${sh.added ? 'sec' : ''}" id="addbtn" ${sh.added ? 'disabled' : ''}>${sh.added ? ic('check', 'sm') + ' In My barbers' : ic('plus', 'sm') + ' Add barber'}</button></div>` : ''}
    ${isCustomer ? `<div class="btns" style="margin-top:16px"><a class="btn" id="bookbtn" href="#/book/${barber.id}">Book a session</a>${data.favourite !== undefined ? `<button class="btn sec iconbtn ${data.favourite ? 'faved' : ''}" id="favbtn" aria-pressed="${!!data.favourite}" aria-label="${data.favourite ? 'Remove from favourites' : 'Add to favourites'}">${ic('heart')}</button>` : ''}</div>` : ''}
    ${lo ? `<div class="loyal small"><div class="row between"><span>${ic('ticket', 'sm')} Loyalty: every ${lo.every_n}th visit earns ${naira(lo.reward_kobo)}</span><b>${lo.into_cycle}/${lo.every_n}</b></div><div class="bar"><i style="width:${Math.round(lo.into_cycle / lo.every_n * 100)}%"></i></div></div>` : ''}
    ${barber.about ? `<h2>About</h2><p>${esc(barber.about)}</p>` : ''}
    ${notices.length ? `<div class="warn small notice" style="margin-top:16px">${ic('warn', 'sm')}<div>${notices.map((n) => `<div><b>${esc(n.title)}</b>${n.type === 'CLOSED' && n.reason ? ' — ' + esc(n.reason) : n.type === 'HOURS_UPDATED' ? ' — ' + esc(n.text) : ''}</div>`).join('')}</div></div>` : ''}
    ${(my.credits && my.credits.length) || (my.plans && my.plans.some((p) => p.sessions_left > 0)) ? `<div class="ok small notice">${ic('ticket', 'sm')}<div>${my.plans.filter((p) => p.sessions_left > 0).map((p) => `Plan <b>${esc(p.plan_name)}</b>: ${p.sessions_left} session${p.sessions_left === 1 ? '' : 's'} left.`).join(' ')} ${my.credits.length ? `${my.credits.length} session credit${my.credits.length === 1 ? '' : 's'} available.` : ''} We use it when you book.</div></div>` : ''}
    <h2>Services</h2>
    <div class="list">${services.map((s) => `<div><span class="grow"><b>${esc(s.name)}</b><span class="sub">${s.duration_min} min</span></span><b>${naira(s.price_kobo)}</b></div>`).join('') || '<div class="muted">No services yet.</div>'}</div>
    <div id="plans"><h2>Plans</h2>${plans.length ? `<p class="small muted" style="margin-top:0">Buy a pack and book without paying each time. Unused sessions end when the plan ends.</p>${plans.map((pl) => planCard(pl, services, isCustomer)).join('')}` : ((state.cfg.features || {}).plans === false ? '<p class="muted small">Plans are turned off by TrimSlot right now, so you cannot buy one.</p>' : '<p class="muted small">This barber has no plans right now.</p>')}</div>
${rv && rv.reviews.length ? `<h2>Reviews</h2>${rv.reviews.map((x) => `<div class="card review"><div class="row between">${stars(x.rating)}<span class="small muted">${esc(x.customer_name)} · ${dateLabel(x.created_at.slice(0, 10))}</span></div>${x.comment ? `<p style="margin:8px 0 0">${esc(x.comment)}</p>` : ''}${x.reply ? `<div class="reply small"><b>Reply from ${esc(barber.shop_name)}</b><div>${esc(x.reply)}</div></div>` : ''}</div>`).join('')}` : ''}
    <h2>Opening hours</h2>
    <div class="card"><table class="hours">${hoursRows}</table>${brk ? `<div class="small muted" style="margin-top:8px">Break ${t12(brk.break_start)} – ${t12(brk.break_end)}</div>` : ''}</div>
    ${isCustomer && shareInfo ? `<h2>Share this barber</h2>${shareCardHtml({ id: 'bshare', qr: shareInfo.qr_url, name: barber.shop_name, title: 'Send this barber to a friend', hint: 'Anyone with this link can see the shop. Send it only to people you trust.', url: shareInfo.url })}` : ''}
    ${!state.user && !sh ? `<div class="btns" style="margin-top:16px"><a class="btn" href="#/signup?role=customer">Sign up to book</a></div>` : ''}`;
  if (shareInfo) wireShareCard($('#bshare'), shareInfo.url, barber.shop_name);
  const ab = $('#addbtn'); if (ab) ab.onclick = async () => { ab.disabled = true; try { await api(`/b/${shareCode}/add`, { method: 'POST' }); toast('Added to My barbers'); ab.className = 'btn sec'; ab.innerHTML = ic('check', 'sm') + ' In My barbers'; } catch (e) { fail(e); ab.disabled = false; } };
  document.querySelectorAll('[data-buy]').forEach((el) => el.onclick = () => buyPlan(Number(el.dataset.buy), el));
  const fb = $('#favbtn'); if (fb) fb.onclick = async () => { const on = fb.getAttribute('aria-pressed') !== 'true'; fb.disabled = true; try { await api(`/barbers/${id}/favourite`, { method: 'POST', body: { on } }); fb.classList.toggle('faved', on); fb.setAttribute('aria-pressed', String(on)); toast(on ? 'Added to favourites' : 'Removed from favourites'); } catch (e) { fail(e); } fb.disabled = false; };
  startPoll(() => shareCode ? (location.hash.startsWith('#/b/') ? barberPage(0, shareCode) : Promise.resolve()) : location.hash.startsWith('#/barber/') ? barberPage(id) : Promise.resolve());
}

/* ---------- plans (shared card + buy) ---------- */
const svcNames = (ids, services) => (ids || []).map((id) => (services.find((x) => x.id === id) || {}).name).filter(Boolean).join(', ');
const planCard = (pl, services, canBuy) => `<div class="card plan"><div class="row between"><h3>${esc(pl.name)}</h3><span class="plan-price">${naira(pl.price_kobo)}</span></div>
  <div class="meta"><span>${pl.sessions} session${pl.sessions === 1 ? '' : 's'}</span><span>Valid ${pl.validity_days} days</span><span>${naira(Math.round(pl.price_kobo / pl.sessions))} per session</span></div>
  <div class="small muted">Includes ${esc(svcNames(pl.service_ids, services))}</div>
  ${canBuy ? `<div class="btns end" style="margin-top:12px"><button class="btn sm" data-buy="${pl.id}">Buy plan</button></div>` : ''}</div>`;
/* Balance refund of a part-used plan. TrimSlot reviews the request first, then the other party must agree; then TrimSlot authorizes it. */
function refundBox(p, role) {
  const other = role === 'CUSTOMER' ? 'barber' : 'customer';
  const r = p.refund_request;
  const amt = naira(r ? r.amount_kobo : p.balance_kobo || 0);
  if (r) {
    const mine = r.requested_role === role;
    if (r.status === 'REFUNDING') return `<div class="info small notice">Both of you agreed. The plan is cancelled and ${amt} is being sent back.</div>`;
    if (r.status === 'CONFIRMED') return `<div class="info small notice">Both of you agreed to refund ${amt}. TrimSlot will authorize it and send the money back.</div>${mine ? `<div class="btns end" style="margin-top:8px"><button class="btn sm sec" data-rwd="${r.id}">Withdraw</button></div>` : ''}`;
    if (mine && r.status === 'OPEN') return `<div class="info small notice">You asked to refund ${amt}. TrimSlot checks it first, then sends it to the ${other}.</div><div class="btns end" style="margin-top:8px"><button class="btn sm sec" data-rwd="${r.id}">Withdraw request</button></div>`;
    if (mine) return `<div class="info small notice">You asked to refund ${amt}. TrimSlot sent it to the ${other}, who has to agree.</div><div class="btns end" style="margin-top:8px"><button class="btn sm sec" data-rwd="${r.id}">Withdraw request</button></div>`;
    if (r.status === 'FORWARDED') return `<div class="warn small notice">TrimSlot asks you to agree to cancel this plan and refund ${amt} for the unused sessions. Agree only if you both want this.</div><div class="btns end" style="margin-top:8px"><button class="btn sm sec" data-rdc="${r.id}">Decline</button><button class="btn sm" data-rac="${r.id}" data-amt="${amt}">Agree to refund ${amt}</button></div>`;
    return '';
  }
  if (!p.live) return '';
  if (p.refund_upcoming > 0) return `<div class="small muted" style="margin-top:8px">To ask for a refund of the unused sessions, first cancel this plan's ${p.refund_upcoming} upcoming booking${p.refund_upcoming === 1 ? '' : 's'}. Their sessions go back to the plan.</div>`;
  if (!(p.balance_kobo > 0)) return '';
  return `<div class="btns end" style="margin-top:8px"><button class="btn sm sec" data-rq="${p.id}" data-amt="${amt}">Ask to cancel and refund ${amt}</button></div>`;
}
/* Wires the buttons from refundBox. role says who is acting: the customer or the barber (barber routes sit under /barber). */
function wireRefundBox(root, role, reload) {
  const base = role === 'CUSTOMER' ? '' : '/barber';
  const other = role === 'CUSTOMER' ? 'barber' : 'customer';
  const run = (el, msg, path) => el.onclick = async () => {
    if (!confirm(msg)) return;
    el.disabled = true;
    try { await api(path, { method: 'POST' }); reload(); } catch (e) { fail(e); el.disabled = false; }
  };
  root.querySelectorAll('[data-rq]').forEach((el) => run(el, `Ask to cancel this plan and refund ${el.dataset.amt}? TrimSlot checks it first, then the ${other} must agree. Nothing is sent back until TrimSlot authorizes it. Paystack fees are not refunded.`,
    role === 'CUSTOMER' ? `/plans/${el.dataset.rq}/refund-request` : `/barber/plan-purchases/${el.dataset.rq}/refund-request`));
  root.querySelectorAll('[data-rac]').forEach((el) => run(el, `Agree to cancel this plan and refund ${el.dataset.amt}? The plan ends once TrimSlot authorizes it.`, `${base}/plan-refunds/${el.dataset.rac}/accept`));
  root.querySelectorAll('[data-rdc]').forEach((el) => el.onclick = async () => {
    const reason = prompt('Why are you declining? (optional)');
    if (reason === null) return;
    el.disabled = true;
    try { await api(`${base}/plan-refunds/${el.dataset.rdc}/decline`, { method: 'POST', body: { reason } }); reload(); } catch (e) { fail(e); el.disabled = false; }
  });
  root.querySelectorAll('[data-rwd]').forEach((el) => run(el, 'Withdraw this refund request? The plan stays as it is.', `${base}/plan-refunds/${el.dataset.rwd}/withdraw`));
}

async function buyPlan(id, el) {
  if (!confirm('Buy this plan? You will go to Paystack to pay. Sessions you do not use end when the plan ends. We do not refund them.')) return;
  el.disabled = true;
  try { const r = await api(`/plans/${id}/buy`, { method: 'POST' }); window.posthog?.capture('plan_checkout_started'); location.href = r.authorization_url; } catch (e) { fail(e); el.disabled = false; }
}
const expTxt = (iso) => dateLabel(String(iso).slice(0, 10));
const walletPlanStats = (w) => {
  const plans = w.plans || [], credits = w.credits || [];
  const activePlans = plans.filter((p) => p.live), activeCredits = credits.filter((c) => c.live);
  return { activePlans, activeCredits, sessions: activeCredits.length + activePlans.reduce((sum, p) => sum + Math.max(0, Number(p.sessions_left) || 0), 0) };
};
const walletPlanSignature = (w) => JSON.stringify({
  plans: (w.plans || []).map((p) => [p.id, p.live, p.sessions_left, p.sessions_total, p.expires_at, p.refund_request && p.refund_request.status]),
  credits: (w.credits || []).map((c) => [c.id, c.live, c.status, c.expires_at, c.used_at]),
});
function renderWalletData(w, planResult, openedIds = null) {
  const { activePlans, activeCredits, sessions } = walletPlanStats(w);
  const endedPlans = (w.plans || []).filter((p) => !p.live), endedCredits = (w.credits || []).filter((c) => !c.live);
  const opened = new Set(openedIds || []);
  const previousCounts = new Map([...app.querySelectorAll('[data-plan-counter]')].map((el) => [el.dataset.planCounter, { value: el.dataset.countValue || el.textContent || '0', ready: el.dataset.countReady }]));
  const showPlans = openedIds ? opened.has('wallet-plans') : activePlans.length > 0 || activeCredits.length === 0;
  const showCredits = openedIds ? opened.has('wallet-credits') : activeCredits.length > 0 && activePlans.length === 0;
  const msg = planResult === 'processed' || planResult === 'already_processed' ? '<div class="ok">You bought the plan. Choose “Use plan session” when you book.</div>'
    : planResult === 'not_paid' ? '<div class="err">Your payment did not go through, so the plan is not on.</div>' : planResult === 'checked' ? '<div class="info">Paystack has not told us yet. If you were charged, the plan turns on by itself in a few minutes, or we refund you.</div>' : planResult === 'amount_mismatch' ? '<div class="err">We got your payment, but the amount was not right, so the plan is not on. Please contact support.</div>' : planResult === 'refund_due' ? '<div class="info">We could not use that payment. We are sending your money back.</div>' : '';
  const planRows = activePlans.map((p) => {
    const left = Math.max(0, Number(p.sessions_left) || 0);
    const pct = p.sessions_total > 0 ? Math.max(0, Math.min(100, Math.round(100 * left / p.sessions_total))) : 0;
    const coverage = (p.service_names || []).join(', ') || 'No services';
    const refund = refundBox(p, 'CUSTOMER');
    return `<details class="customer-wallet-row customer-wallet-plan-row" id="wallet-plan-row-${p.id}">
      <summary class="customer-wallet-row-summary"><span class="customer-wallet-row-top"><b class="customer-wallet-row-title">${esc(p.plan_name)}</b><span class="customer-wallet-row-value">${left} of ${p.sessions_total} left</span></span>
        <span class="customer-wallet-row-meta"><span>${esc(p.shop_name)}</span><span>Ends ${expTxt(p.expires_at)}</span></span></summary>
      <div class="customer-wallet-row-details"><div class="customer-wallet-detail-grid">
        <div><span>Barber</span><b>${esc(p.shop_name)}</b></div><div><span>End date</span><b>${expTxt(p.expires_at)}</b></div>
        <div><span>Sessions</span><b>${p.sessions_used} used · ${left} remaining of ${p.sessions_total}</b><span class="customer-wallet-progress"><i style="width:${pct}%"></i></span></div>
        <div><span>Covers</span><b>${esc(coverage)}</b></div></div>
        <div class="customer-wallet-actions"><a class="btn sm sec" href="#/barber/${p.barber_id}">View barber</a><a class="btn sm" href="#/book/${p.barber_id}">Book</a></div>
        ${refund ? `<details class="refund-disclosure customer-wallet-refund" id="wallet-refund-${p.id}"><summary>Refund options</summary><div class="customer-wallet-refund-body">${refund}</div></details>` : ''}
      </div></details>`;
  }).join('');
  const creditCoverage = (c) => c.service_name ? `${esc(c.service_name)} or any service priced ${naira(c.value_kobo)}` : `Any service priced ${naira(c.value_kobo)}`;
  const creditRows = activeCredits.map((c) => {
    const coverage = creditCoverage(c);
    return `<details class="customer-wallet-row customer-wallet-credit-row" id="wallet-credit-row-${c.id}">
      <summary class="customer-wallet-row-summary"><span class="customer-wallet-row-top"><b class="customer-wallet-row-title">${esc(c.shop_name)}</b><span class="badge b-green customer-wallet-row-status">AVAILABLE</span></span>
        <span class="customer-wallet-row-meta"><span>1 session · Covers ${coverage}</span><span>Expires ${expTxt(c.expires_at)}</span></span></summary>
      <div class="customer-wallet-row-details"><div class="customer-wallet-detail-grid">
        <div><span>Barber</span><b>${esc(c.shop_name)}</b></div><div><span>Status</span><b>Available</b></div>
        <div><span>Coverage</span><b>1 session · ${coverage}</b></div><div><span>Credit value</span><b>${naira(c.value_kobo)}</b></div>
        <div><span>Reason</span><b>${esc(c.reason || 'Session credit')}</b></div><div><span>Issued</span><b>${expTxt(c.created_at)}</b></div>
        <div><span>Expires</span><b>${expTxt(c.expires_at)}</b></div></div></div></details>`;
  }).join('');
  const endedPlanRows = endedPlans.map((p) => {
    const status = p.sessions_left === 0 ? 'USED UP' : 'ENDED';
    const left = Math.max(0, Number(p.sessions_left) || 0);
    const coverage = (p.service_names || []).join(', ') || 'No services';
    return `<details class="customer-wallet-row customer-wallet-ended-plan-row" id="wallet-ended-plan-row-${p.id}">
      <summary class="customer-wallet-row-summary"><span class="customer-wallet-row-top"><b class="customer-wallet-row-title">${esc(p.plan_name)}</b><span class="badge b-gray customer-wallet-row-status">${status}</span></span>
        <span class="customer-wallet-row-meta"><span>${esc(p.shop_name)}</span><span>End date ${expTxt(p.expires_at)}</span></span></summary>
      <div class="customer-wallet-row-details"><div class="customer-wallet-detail-grid">
        <div><span>Barber</span><b>${esc(p.shop_name)}</b></div><div><span>Final status</span><b>${status}</b></div>
        <div><span>Sessions</span><b>${p.sessions_used} used · ${left} remaining of ${p.sessions_total}</b></div>
        <div><span>Covers</span><b>${esc(coverage)}</b></div><div><span>End date</span><b>${expTxt(p.expires_at)}</b></div></div></div></details>`;
  }).join('');
  const endedCreditRows = endedCredits.map((c) => {
    const status = c.status === 'USED' ? 'USED' : 'EXPIRED';
    const date = c.status === 'USED' ? (c.used_at ? expTxt(c.used_at) : 'Date unavailable') : expTxt(c.expires_at);
    const dateLabel = c.status === 'USED' ? 'Used on' : 'Expired';
    const coverage = creditCoverage(c);
    return `<details class="customer-wallet-row customer-wallet-ended-credit-row" id="wallet-ended-credit-row-${c.id}">
      <summary class="customer-wallet-row-summary"><span class="customer-wallet-row-top"><b class="customer-wallet-row-title">Session credit · ${esc(c.shop_name)}</b><span class="badge b-gray customer-wallet-row-status">${status}</span></span>
        <span class="customer-wallet-row-meta"><span>1 session · Covers ${coverage}</span><span>${dateLabel} ${date}</span></span></summary>
      <div class="customer-wallet-row-details"><div class="customer-wallet-detail-grid">
        <div><span>Barber</span><b>${esc(c.shop_name)}</b></div><div><span>Final status</span><b>${status}</b></div>
        <div><span>Coverage</span><b>1 session · ${coverage}</b></div><div><span>Credit value</span><b>${naira(c.value_kobo)}</b></div>
        <div><span>Reason</span><b>${esc(c.reason || 'Session credit')}</b></div><div><span>${dateLabel}</span><b>${date}</b></div></div></div></details>`;
  }).join('');
  const planDisabled = (state.cfg.features || {}).plans === false ? '<div class="info small notice">Plans are turned off by TrimSlot right now. You cannot buy one or use a plan session, but your existing sessions and end dates are kept.</div>' : '';
  const creditDisabled = (state.cfg.features || {}).credits === false ? '<div class="info small notice">Session credits are turned off by TrimSlot right now. Your credits are kept and their end dates do not change.</div>' : '';
  const planBody = planRows ? `<div class="customer-wallet-list">${planRows}</div>` : '<p class="muted small">No active plans yet. Open a barber’s link to see the plans they offer.</p>';
  const creditBody = creditRows ? `<div class="customer-wallet-list">${creditRows}</div>` : '<p class="muted small">No session credits ready to use.</p>';
  const endedBody = `${endedPlanRows ? `<h3 class="customer-wallet-list-heading">Plans</h3><div class="customer-wallet-list">${endedPlanRows}</div>` : ''}${endedCreditRows ? `<h3 class="customer-wallet-list-heading">Credits</h3><div class="customer-wallet-list">${endedCreditRows}</div>` : ''}`;
  app.innerHTML = `<div class="customer-wallet-view"><h1>Plans &amp; credits</h1>${msg}
    <div class="plan-live-summary"><div class="plan-live-head"><h2 class="plan-live-title">Your session balance</h2><span class="plan-live-dot">LIVE</span></div>
      <div class="plan-metrics"><div class="plan-metric primary"><b data-plan-counter="wallet-sessions">0</b><span>Sessions ready</span></div><div class="plan-metric"><b data-plan-counter="wallet-plans">0</b><span>Active plans</span></div><div class="plan-metric"><b data-plan-counter="wallet-credits">0</b><span>Credits</span></div></div>
      <p class="plan-live-note" id="wallet-live-note">Balance updates automatically every 10 seconds while this page is open.</p></div>
    ${planDisabled}${creditDisabled}
    <details class="plan-section" id="wallet-plans"${showPlans ? ' open' : ''}><summary><span>My active plans</span><span class="plan-section-count">${activePlans.length} active</span></summary><div class="plan-section-body">${planBody}</div></details>
    <details class="plan-section" id="wallet-credits"${showCredits ? ' open' : ''}><summary><span>Session credits</span><span class="plan-section-count">${activeCredits.length} ready</span></summary><div class="plan-section-body">${creditBody}</div></details>
    ${endedBody ? `<details class="plan-section" id="wallet-ended"><summary><span>Used or ended</span><span class="plan-section-count">${endedPlans.length + endedCredits.length}</span></summary><div class="plan-section-body">${endedBody}</div></details>` : ''}
    <details class="plan-disclosure" id="wallet-rules"><summary><span>How plans and credits work</span><span class="small muted">Terms, expiry and refunds</span></summary><div class="plan-disclosure-body">
      <p class="plan-rule-copy">If you miss a paid session, you do not get a cash refund. You receive one credit with the same barber. It covers the same service or any service at the same price, lasts ${w.rules.credit_expiry_days} days, cannot be cashed out, and is used when you book with that barber.</p>
      <p class="plan-rule-copy">If you miss a plan session, it returns to your plan; the plan keeps its original end date. Refund requests for part-used plans go through TrimSlot review and require the other party’s agreement. Any eligible online-booking refund follows the cancellation cutoff shown when you cancel.</p>
    </div></details></div>`;
  for (const el of app.querySelectorAll('[data-plan-counter]')) { const old = previousCounts.get(el.dataset.planCounter); if (old) { el.textContent = old.value; el.dataset.countValue = old.value; if (old.ready) el.dataset.countReady = old.ready; } }
  for (const id of opened) { const d = document.getElementById(id); if (d) d.open = true; }
  const stats = walletPlanStats(w);
  animatePlanCount(document.querySelector('[data-plan-counter="wallet-sessions"]'), stats.sessions);
  animatePlanCount(document.querySelector('[data-plan-counter="wallet-plans"]'), stats.activePlans.length);
  animatePlanCount(document.querySelector('[data-plan-counter="wallet-credits"]'), stats.activeCredits.length);
  app.dataset.walletSignature = walletPlanSignature(w);
  wireRefundBox(app, 'CUSTOMER', () => wallet());
}
async function wallet(planResult, ppId) {
  if (planResult && ppId && !['processed', 'already_processed', 'refund_due', 'checked', 'amount_mismatch'].includes(planResult)) {
    const r = await confirmReturn('plan', ppId, 'Checking your plan payment…');
    if ((r === 'processed' || r === 'already_processed') && window.haptics) haptics.success();
    history.replaceState(null, '', '#/wallet?plan=' + (r === 'processed' || r === 'already_processed' || r === 'refund_due' || r === 'amount_mismatch' ? r : 'checked'));
    planResult = new URLSearchParams(location.hash.split('?')[1] || '').get('plan');
  }
  const w = await api('/me/wallet');
  renderWalletData(w, planResult);
  startPoll(async () => {
    if (!location.hash.startsWith('#/wallet')) return;
    const latest = await api('/me/wallet');
    if (walletPlanSignature(latest) === app.dataset.walletSignature) return;
    const openIds = [...app.querySelectorAll('details[open][id]')].map((d) => d.id);
    renderWalletData(latest, planResult, openIds);
  });
}

/* ---------- customer: bookings ---------- */
/* History filters and sort. The choices are kept in memory, so the 10-second refresh does not reset them or the open months. */
const HIST = { service: '', recent: 'all', price: 'any', sort: 'new', pref: new Map(), all: [] };
const HIST_PRICE = { any: () => true, under: (k) => k < 100000, mid: (k) => k >= 100000 && k <= 200000, over: (k) => k > 200000 };
const HIST_SORT = {
  new: (a, b) => b.date.localeCompare(a.date) || b.start_time.localeCompare(a.start_time),
  old: (a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time),
  high: (a, b) => b.price_kobo - a.price_kobo || b.date.localeCompare(a.date),
  low: (a, b) => a.price_kobo - b.price_kobo || b.date.localeCompare(a.date),
};
function histCutoff(kind) {
  if (kind === 'all') return '';
  const d = new Date((state.cfg.today || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
  if (kind === '30') d.setUTCDate(d.getUTCDate() - 30); else d.setUTCMonth(d.getUTCMonth() - 3);
  return d.toISOString().slice(0, 10);
}
const monthTitle = (key) => { const [y, m] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
function historyControls(past) {
  const services = [...new Set(past.map((b) => b.service_name))].sort();
  const sel = (id, label, opts, val) => `<label class="hf"><span>${label}</span><select id="${id}">${opts.map(([v, t]) => `<option value="${esc(v)}"${v === val ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  return `<div class="hfilters">${sel('hf-svc', 'Service', [['', 'All services'], ...services.map((x) => [x, x])], HIST.service)}${sel('hf-rec', 'Recent', [['all', 'All time'], ['30', 'Last 30 days'], ['90', 'Last 3 months']], HIST.recent)}${sel('hf-price', 'Price', [['any', 'Any price'], ['under', 'Under ₦1,000'], ['mid', '₦1,000 to ₦2,000'], ['over', 'Over ₦2,000']], HIST.price)}${sel('hf-sort', 'Sort', [['new', 'Newest first'], ['old', 'Oldest first'], ['high', 'Highest price'], ['low', 'Lowest price']], HIST.sort)}</div>`;
}
/* Past bookings after the filters, grouped by month (one drop-down per month). The newest month opens by default. */
function historyBody() {
  const cut = histCutoff(HIST.recent);
  const rows = HIST.all.filter((b) => (!HIST.service || b.service_name === HIST.service) && (!cut || b.date >= cut) && HIST_PRICE[HIST.price](b.price_kobo));
  if (!rows.length) return `<p class="muted">No bookings match these filters.</p><button class="btn sm sec" type="button" id="hclear">Clear filters</button>`;
  const groups = new Map();
  for (const b of rows) { const k = b.date.slice(0, 7); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(b); }
  const keys = [...groups.keys()].sort((a, b) => (HIST.sort === 'old' ? a.localeCompare(b) : b.localeCompare(a)));
  return keys.map((k, i) => {
    const bs = groups.get(k).sort(HIST_SORT[HIST.sort]);
    const open = HIST.pref.has(k) ? HIST.pref.get(k) : i === 0;
    return `<details class="hgroup" data-m="${k}"${open ? ' open' : ''}><summary>${monthTitle(k)} <span class="muted small">· ${bs.length} booking${bs.length === 1 ? '' : 's'}</span></summary>${clist(bs.map(bookingCard))}</details>`;
  }).join('');
}
function drawHistory() {
  const body = $('#histbody'); if (!body) return;
  body.innerHTML = historyBody();
  body.querySelectorAll('details.hgroup').forEach((d) => d.addEventListener('toggle', () => HIST.pref.set(d.dataset.m, d.open)));
  const clr = $('#hclear'); if (clr) clr.onclick = () => { HIST.service = ''; HIST.recent = 'all'; HIST.price = 'any'; syncHistControls(); drawHistory(); };
}
function syncHistControls() {
  const set = (id, v) => { const el = $(id); if (el) el.value = v; };
  set('#hf-svc', HIST.service); set('#hf-rec', HIST.recent); set('#hf-price', HIST.price); set('#hf-sort', HIST.sort);
}
function wireHistory() {
  const bind = (id, key) => { const el = $(id); if (el) el.onchange = () => { HIST[key] = el.value; drawHistory(); }; };
  bind('#hf-svc', 'service'); bind('#hf-rec', 'recent'); bind('#hf-price', 'price'); bind('#hf-sort', 'sort');
  drawHistory();
}
// An unpaid Pay-now attempt is not a booking: it holds no time, so it is not listed here (the home screen still offers to finish it).
const isUnpaidAttempt = (b) => b.payment_option === 'ONLINE' && (b.status === 'PENDING_PAYMENT' || !!b.incomplete);
async function myBookings() {
  const r = await api('/bookings');
  const bookings = r.bookings.filter((b) => !isUnpaidAttempt(b));
  const upcoming = bookings.filter((b) => ['CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(b.status));
  const past = bookings.filter((b) => !upcoming.includes(b));
  HIST.all = past;
  if (HIST.service && !past.some((b) => b.service_name === HIST.service)) HIST.service = '';
  app.innerHTML = `<h1>My bookings</h1><h2>Upcoming</h2>${upcoming.length ? clist(upcoming.map(bookingCard)) : ''}${upcoming.length ? '' : '<p class="muted">You have nothing booked. <a href="#/">Book a cut</a></p>'}<h2>History</h2>${past.length ? `${historyControls(past)}<div id="histbody"></div>` : '<p class="muted">No past bookings yet.</p>'}`;
  if (past.length) wireHistory();
  startPoll(myBookings);
}
/* Back from Paystack: the redirect lands here before the webhook may have arrived, so we ask the server to verify by reference (a few tries, a few seconds apart) instead of showing a stale "not confirmed". */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAY_TERMINAL = ['processed', 'already_processed', 'slot_taken', 'refund_due', 'late_refund', 'duplicate_refund', 'amount_mismatch'];
/* What to tell the customer after paying. It comes from the booking itself (status + the server's payment_issue), not only from the ?pay= word in the address, so a cancelled booking never says "confirmed" and the refund wording survives the 10-second refresh. */
const DONE_STATUS = ['CONFIRMED', 'ARRIVED', 'IN_SERVICE', 'COMPLETED'];
function payBanner(b, payResult) {
  const issue = b.payment_issue;
  const kind = issue ? issue.kind : payResult === 'slot_taken' || payResult === 'refund_due' ? 'slot_taken' : payResult === 'late_refund' ? 'late' : payResult === 'duplicate_refund' ? 'duplicate' : payResult === 'amount_mismatch' ? 'mismatch' : '';
  const sent = issue && issue.refund === 'sent';
  const back = sent ? 'We have sent your payment back. Your bank may take a few working days to show it.' : 'We are refunding your payment.';
  if (kind === 'slot_taken') return `<div class="err">Sorry. Someone else booked that time before your payment finished, so this booking is <b>not confirmed</b>. ${back} Please pick another time.</div>`;
  if (kind === 'late') return `<div class="err">Your payment reached us after the time to pay had ended, and we could not keep this booking, so it is <b>not confirmed</b>. ${back} Please pick another time.</div>`;
  if (kind === 'duplicate') return `<div class="ok">${DONE_STATUS.includes(b.status) ? 'Your booking is already paid and <b>confirmed</b>.' : 'This booking was already paid.'} You paid twice, so ${sent ? 'we have sent the extra payment back. Your bank may take a few working days to show it.' : 'we are sending the extra payment back.'}</div>`;
  if (kind === 'mismatch') return `<div class="err">We got your payment, but the amount was not right for this booking, so we did not confirm it. ${issue && issue.refund !== 'none' ? back : 'Our team is checking it. We will confirm the booking or refund you.'} Please keep your booking number #${b.id}.</div>`;
  if (payResult === 'processed' || payResult === 'already_processed') {
    if (DONE_STATUS.includes(b.status)) return '<div class="ok">We got your payment. Your booking is confirmed.</div>';
    if (b.status === 'PENDING_PAYMENT') return '<div class="info">Paystack has not told us yet. If you were charged, your booking confirms by itself in a few minutes, or we refund you. Tap “Check payment” to try again.</div>';
    return `<div class="info">This booking is ${b.status === 'CANCELLED' ? 'cancelled' : 'closed'}. If you were charged, we will refund you. Use “Report a problem” if you do not hear from us.</div>`;
  }
  if (payResult === 'not_paid') return '<div class="err">Your payment did not go through. Your time is not saved yet. Pay below to save it, if it is still free.</div>';
  if (payResult === 'checked') return b.status === 'CANCELLED' ? '<div class="info">This booking is closed. If you were charged, we will confirm or refund you by ourselves. Use “Report a problem” if you do not hear from us.</div>' : '<div class="info">Paystack has not told us yet. If you were charged, your booking confirms by itself in a few minutes, or we refund you. Tap “Check payment” to try again.</div>';
  return '';
}
let receiptFilter = 'ALL';
function receiptDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-NG', { timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
}
function receiptDateOnly(iso) {
  if (!iso) return '—';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-NG', { timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', year: 'numeric' }).format(d);
}
function receiptTone(status) {
  if (status === 'Paid') return 'success';
  if (status === 'Refunded') return 'refunded';
  if (/refund|pending|credit/i.test(status || '')) return 'pending';
  return 'neutral';
}
function receiptSheetMarkup(r, verification) {
  const isPlan = r.type === 'PLAN';
  const item = isPlan ? r.item : r.service;
  const barber = r.barber || r.shop || 'Barber';
  const shopLine = r.shop && r.shop !== barber ? `${barber} · ${r.shop}` : barber;
  const stateLabel = r.status === 'Paid' ? 'PAYMENT SUCCESSFUL' : String(r.status || 'PAYMENT RECEIVED').toUpperCase();
  const amountLabel = r.status === 'Refunded' ? 'ORIGINAL PAYMENT AMOUNT' : 'AMOUNT RECEIVED';
  const paidText = receiptDateTime(r.paid_at);
  const detailRows = isPlan
    ? [['Plan purchased', item || '—'], ['Barber / shop', shopLine], ['Location', r.location || '—'], ['Sessions included', String(r.sessions_total ?? '—')], ['Validity period', r.validity_days ? `${r.validity_days} days` : '—'], ['Valid until', receiptDateOnly(r.expires_at)]]
    : [['Service booked', item || '—'], ['Barber / shop', shopLine], ['Appointment', `${r.appointment_date ? dateLabel(r.appointment_date) : '—'}${r.appointment_time ? ` · ${r.appointment_time}` : ''}`], ['Location', r.location || '—']];
  const paymentRows = [r.payment_provider ? ['Payment provider', r.payment_provider] : null, ['Payment status', r.status || 'Payment received']].filter(Boolean);
  const supportUrl = `${location.origin}/#/profile`;
  return `<article class="rs-sheet" aria-label="TrimSlot ${isPlan ? 'plan' : 'booking'} payment receipt">
    <header class="rs-header">
      <div class="rs-brand-row"><div class="rs-brand"><span class="rs-brand-mark" aria-hidden="true"><svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><circle cx="32" cy="30" r="10"/><circle cx="32" cy="70" r="10"/><path d="M78 20 40 58M62 62 78 78M40 42 52 54"/></svg></span><span class="rs-wordmark">Trim<span>Slot</span></span></div><span class="rs-status rs-status--${receiptTone(r.status)}">${esc(stateLabel)}</span></div>
      <div class="rs-header-copy"><div class="rs-kicker">PAYMENT RECEIPT</div><div class="rs-kind">${isPlan ? 'Plan purchase' : 'Booking payment'}</div><div class="rs-header-note">A clear record of your TrimSlot payment</div></div>
      <svg class="rs-wave" viewBox="0 0 600 46" preserveAspectRatio="none" aria-hidden="true"><path d="M0,16 C120,42 190,4 310,22 C420,39 510,11 600,27 L600,46 L0,46 Z" fill="#fff"/></svg>
    </header>
    <div class="rs-main">
      <section class="rs-amount"><div><span class="rs-label">${amountLabel}</span><strong>${naira(r.amount_kobo || 0)}</strong></div><div class="rs-number"><span class="rs-label">RECEIPT NUMBER</span><b>${esc(r.receipt_number || '—')}</b></div><div class="rs-issued"><span class="rs-label">RECEIPT DATE</span><b>${esc(paidText)}</b></div></section>
      <section class="rs-section"><h2>${isPlan ? 'PLAN DETAILS' : 'BOOKING DETAILS'}</h2><div class="rs-rows">${detailRows.map(([label, value]) => `<div class="rs-line"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('')}</div></section>
      <section class="rs-section"><h2>CUSTOMER DETAILS</h2><div class="rs-rows">${[['Customer name', r.customer_name || '—'], ['Email', r.customer_email || '—'], ['Phone', r.customer_phone || '—']].map(([label, value]) => `<div class="rs-line"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('')}</div></section>
      <section class="rs-section"><h2>PAYMENT DETAILS</h2><div class="rs-rows">${paymentRows.map(([label, value]) => `<div class="rs-line"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('')}<div class="rs-line rs-reference"><span>Transaction reference</span><b>${esc(r.reference || '—')}</b></div></div></section>
      <footer class="rs-footer"><div class="rs-qr">${verification?.qr_data_url ? `<img src="${esc(verification.qr_data_url)}" alt="QR code to verify this payment receipt">` : ''}</div><div class="rs-footer-copy"><b>Thank you for choosing TrimSlot.</b><span>Scan to verify this receipt number and current payment status. No customer contact or transaction details are shown publicly.</span><a href="${esc(supportUrl)}">Help &amp; Support</a></div></footer>
    </div>
  </article>`;
}
function receiptDocument(r, verification) {
  const isPlan = r.type === 'PLAN';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>TrimSlot payment receipt ${esc(r.receipt_number || '')}</title>
  <style>
  *{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#eef2f8;color:#14233b;font:13px/1.38 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{padding:18px 10px}.rs-sheet{width:min(100%,148mm);min-height:210mm;margin:0 auto;background:#fff;border:1px solid #dce4ef;border-radius:12px;overflow:hidden;box-shadow:0 8px 26px rgba(12,29,54,.12);color:#16243a}.rs-header{height:61mm;min-height:230px;position:relative;overflow:hidden;padding:9mm 10mm 20mm;background:linear-gradient(125deg,#07152d 0%,#102b54 66%,#1b3c70 100%);color:white}.rs-brand-row{display:flex;justify-content:space-between;align-items:center;gap:10px}.rs-brand{display:flex;align-items:center;gap:8px}.rs-brand-mark{display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:#426be0;color:#fff}.rs-brand-mark svg{width:23px;height:23px}.rs-wordmark{font-size:19px;font-weight:850;letter-spacing:-.7px}.rs-wordmark span{color:#8eb3ff}.rs-status{padding:5px 9px;border-radius:30px;font-size:8px;line-height:1.3;font-weight:850;letter-spacing:.35px;white-space:nowrap}.rs-status--success{background:#d9f6e8;color:#116845}.rs-status--refunded{background:#dbe8ff;color:#234e9a}.rs-status--pending{background:#fff0d2;color:#80510a}.rs-status--neutral{background:#e8edf5;color:#3c4d65}.rs-header-copy{margin-top:13mm;position:relative;z-index:1}.rs-kicker{font-size:9px;letter-spacing:2px;font-weight:800;color:#a9c5ff}.rs-kind{font-size:22px;font-weight:800;letter-spacing:-.5px;margin-top:4px}.rs-header-note{font-size:10px;color:#d2ddf0;margin-top:3px}.rs-wave{position:absolute;left:0;bottom:-1px;width:100%;height:19mm}.rs-main{padding:0 10mm 7mm;margin-top:-1px}.rs-amount{position:relative;z-index:2;display:grid;grid-template-columns:1.1fr 1fr;gap:8px 14px;margin:-6mm 0 5mm;padding:10px 12px;border:1px solid #dbe6f5;border-left:3px solid #426be0;border-radius:9px;background:#f5f8fd}.rs-amount strong{display:block;font-size:22px;line-height:1.15;letter-spacing:-.7px;margin-top:3px;color:#10274c}.rs-label{display:block;color:#64748a;font-size:7.5px;font-weight:800;letter-spacing:1px}.rs-number b,.rs-issued b{display:block;margin-top:3px;font-size:9px;overflow-wrap:anywhere}.rs-issued{grid-column:1/-1;border-top:1px solid #dbe4f1;padding-top:6px}.rs-section{margin:4mm 0}.rs-section h2{margin:0 0 4px;color:#355a9c;font-size:8px;letter-spacing:1.4px}.rs-rows{border:1px solid #e0e7f0;border-radius:7px;overflow:hidden}.rs-line{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:5px 8px;border-bottom:1px solid #e8edf4;font-size:9px;min-height:22px}.rs-line:last-child{border-bottom:0}.rs-line span{flex:0 0 34%;color:#64748a}.rs-line b{flex:1;text-align:right;font-weight:650;overflow-wrap:anywhere}.rs-reference b{font:8px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace}.rs-footer{display:flex;align-items:center;gap:10px;margin-top:5mm;padding:8px 9px;border:1px solid #e0e7f0;border-radius:8px;background:#f7f9fc}.rs-qr{width:26mm;height:26mm;flex:none;display:grid;place-items:center;background:#fff;border:1px solid #e1e7f0;border-radius:5px}.rs-qr img{display:block;width:23mm;height:23mm;object-fit:contain}.rs-footer-copy{display:flex;flex-direction:column;gap:4px;font-size:8px;color:#5d6d82}.rs-footer-copy b{font-size:9px;color:#172943}.rs-footer-copy a{color:#3159a8;font-weight:700;text-decoration:none}.rs-actions{width:min(100%,148mm);margin:10px auto 0;display:flex;justify-content:flex-end;gap:8px}.rs-actions button{min-height:40px;padding:0 14px;border:1px solid #d6deea;border-radius:8px;background:#fff;color:#172943;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer}.rs-actions button.primary{border-color:#3358d4;background:#3358d4;color:white}.rs-print-note{width:min(100%,148mm);margin:8px auto;color:#64748a;font-size:11px;text-align:center}
  @media(max-width:560px){body{padding:0;background:#fff}.rs-sheet{border:0;border-radius:0;box-shadow:none}.rs-header{min-height:220px}.rs-main{padding-left:18px;padding-right:18px}.rs-amount{padding:9px}.rs-line{padding:7px 8px}.rs-footer{margin-top:18px}}
  @page{size:A5 portrait;margin:0}@media print{.rs-sheet{height:210mm;min-height:210mm}.rs-header{height:50mm;min-height:185px;padding:7mm 9mm 15mm}.rs-header-copy{margin-top:8mm}.rs-wave{height:13mm}.rs-main{padding:0 8mm 3mm}.rs-amount{margin:-4mm 0 2mm;padding:7px 8px}.rs-amount strong{font-size:18px}.rs-section{margin:8px 0}.rs-line{min-height:18px;padding:3px 7px;font-size:8.3px}.rs-reference b{font-size:7.5px}.rs-footer{margin-top:7px;padding:5px 6px}.rs-qr{width:22mm;height:22mm}.rs-qr img{width:20mm;height:20mm}.rs-footer-copy{gap:3px;font-size:7px}.rs-footer-copy b,.rs-footer-copy a{font-size:8px}}@media print{html,body{width:148mm;min-height:210mm;background:#fff;margin:0;padding:0}.rs-sheet{width:148mm;min-height:210mm;margin:0;border:0;border-radius:0;box-shadow:none;break-after:avoid}.rs-header,.rs-status,.rs-amount,.rs-footer{-webkit-print-color-adjust:exact;print-color-adjust:exact}.rs-actions,.rs-print-note{display:none!important}}
  </style></head><body>${receiptSheetMarkup(r, verification)}</body></html>`;
}
async function receiptMaterial(r, verification) {
  let receipt = r;
  if (!receipt.customer_name || !receipt.receipt_number) receipt = (await api(`/me/receipts/${Number(r.payment_id)}`)).receipt;
  if (!verification) verification = await api(`/me/receipts/${Number(receipt.payment_id)}/verification`);
  return { receipt, verification };
}
function receiptExportDocument(r, verification) {
  const html = receiptDocument(r, verification);
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const style = parsed.querySelector('style')?.textContent || '';
  const sheet = parsed.querySelector('.rs-sheet');
  if (!sheet) throw userError('Receipt layout is unavailable.');
  sheet.style.width = '560px';
  sheet.style.minHeight = '0';
  sheet.style.height = 'auto';
  sheet.style.overflow = 'visible';
  sheet.style.margin = '0';
  sheet.style.border = '0';
  sheet.style.borderRadius = '0';
  sheet.style.boxShadow = 'none';
  return { style, markup: sheet.outerHTML };
}
let htmlToImageReady = null;
function loadHtmlToImage() {
  if (window.htmlToImage) return Promise.resolve(window.htmlToImage);
  if (!htmlToImageReady) htmlToImageReady = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/html-to-image.js';
    script.onload = () => window.htmlToImage ? resolve(window.htmlToImage) : reject(new Error('Image export is unavailable in this browser.'));
    script.onerror = () => { htmlToImageReady = null; reject(new Error('The image tool could not load. Check your connection and try again.')); };
    document.head.appendChild(script);
  });
  return htmlToImageReady;
}
/* The receipt stylesheet carries page-level html/body rules meant for the print view; drop them so they cannot restyle the app. */
function receiptScopedStyle(style) {
  return style.replace(/html,body\{[^}]*\}/g, '').replace(/(^|[{};])body\{[^}]*\}/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}
async function receiptImageBlob(r, verification, format) {
  const lib = await loadHtmlToImage();
  const { style, markup } = receiptExportDocument(r, verification);
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:560px;background:#fff;pointer-events:none;overflow:visible;';
  host.innerHTML = `<style>${receiptScopedStyle(style)}</style>${markup}`;
  document.body.appendChild(host);
  try {
    const node = host.querySelector('.rs-sheet');
    if (!node) throw userError('Receipt layout is unavailable.');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const height = Math.max(Math.ceil(node.getBoundingClientRect().height), node.scrollHeight, node.offsetHeight);
    const canvas = await lib.toCanvas(node, { canvasWidth: 560, canvasHeight: height, pixelRatio: 2, backgroundColor: '#ffffff', cacheBust: true });
    return await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not create the receipt image.')), format === 'jpeg' ? 'image/jpeg' : 'image/png', format === 'jpeg' ? 0.94 : undefined));
  } finally { host.remove(); }
}
async function shareReceiptFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
    await navigator.share({ files: [file], title: 'TrimSlot receipt' });
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.style.display = 'none';
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
/* Backup 1: the server-built PDF, which needs no browser rendering. */
async function downloadReceiptPdf(receipt, base) {
  const res = await fetch(`/api/me/receipts/${Number(receipt.payment_id)}/pdf`, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw userError('The PDF could not be downloaded.');
  const blob = await res.blob();
  await shareReceiptFile(new Blob([blob], { type: 'application/pdf' }), base + '.pdf');
}
async function exportReceipt(r, verification, format) {
  const button = $('#receipt-save');
  if (button) { button.disabled = true; button.textContent = 'Preparing…'; }
  try {
    const material = await receiptMaterial(r, verification);
    const receipt = material.receipt;
    const base = 'TrimSlot-' + String(receipt.receipt_number || 'receipt').replace(/[^A-Za-z0-9_-]/g, '-');
    if (format === 'pdf') {
      try {
        await downloadReceiptPdf(receipt, base);
      } catch (e) {
        if (e?.name === 'AbortError') return;
        throw userError('We could not make the PDF. Try the JPEG or PNG option instead.');
      }
      return;
    }
    /* Primary: JPEG or PNG image. */
    let saved = false;
    try {
      const blob = await receiptImageBlob(receipt, material.verification, format);
      await shareReceiptFile(blob, base + (format === 'jpeg' ? '.jpg' : '.png'));
      saved = true;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      console.warn('Receipt image export failed', e);
    }
    /* Backup 1: the server PDF. */
    if (!saved) {
      try {
        await downloadReceiptPdf(receipt, base);
        saved = true;
        toast('The image could not be made here, so your receipt was saved as a PDF.');
      } catch (e) {
        if (e?.name === 'AbortError') return;
        console.warn('Receipt PDF fallback failed', e);
      }
    }
    /* Backup 2: share the verification link so the receipt is still available. */
    if (!saved) {
      await shareReceipt(receipt, material.verification);
      toast('We could not save a file, so we shared your receipt link instead.');
    }
  } catch (e) {
    if (e?.name !== 'AbortError') toast(e?.message || 'We could not save this receipt. Please try again.', true);
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Save Receipt'; }
  }
}
function openReceiptSaveMenu(r, verification) {
  document.getElementById('receipt-format-menu')?.remove();
  const menu = document.createElement('div');
  menu.id = 'receipt-format-menu';
  menu.className = 'receipt-format-backdrop';
  menu.innerHTML = `<section class="receipt-format-sheet" role="dialog" aria-modal="true" aria-label="Choose receipt format">
    <div class="receipt-format-heading"><b>Save receipt</b><button type="button" aria-label="Close">×</button></div>
    <p>Choose a file format</p>
    <button type="button" data-format="pdf"><span>PDF</span><small>For printing and documents</small></button>
    <button type="button" data-format="jpeg"><span>JPEG image</span><small>Save or share in Photos</small></button>
    <button type="button" data-format="png"><span>PNG image</span><small>Higher-detail image</small></button>
  </section>`;
  const close = () => menu.remove();
  menu.querySelector('.receipt-format-heading button').onclick = close;
  menu.addEventListener('click', event => { if (event.target === menu) close(); });
  menu.querySelectorAll('[data-format]').forEach(option => option.addEventListener('click', () => {
    const format = option.dataset.format; close();
    exportReceipt(r, verification, format);
  }));
  document.body.appendChild(menu);
}
async function shareReceipt(r, verification) {
  const material = await receiptMaterial(r, verification);
  const { receipt, verification: v } = material;
  const type = receipt.type === 'PLAN' ? 'plan payment' : 'booking payment';
  const text = `TrimSlot ${type} receipt ${receipt.receipt_number} · ${receipt.status} · ${receiptDateTime(receipt.paid_at)}. Verify: ${v.verification_url}`;
  const payload = { title: 'TrimSlot payment receipt', text, url: v.verification_url };
  if (navigator.share) {
    try { await navigator.share(payload); return; }
    catch (e) { if (e?.name === 'AbortError') return; }
  }
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(v.verification_url); toast('Receipt verification link copied'); return; }
    catch { /* use the manual prompt if browser clipboard permission is denied */ }
  }
  window.prompt('Copy this receipt verification link:', v.verification_url);
}
function receiptListRow(r) {
  const isPlan = r.type === 'PLAN', title = isPlan ? r.item : r.service;
  const barber = r.barber || r.shop || 'Barber';
  return `<a class="receipt-list-row" href="#/receipts/${Number(r.payment_id)}" aria-label="Open ${isPlan ? 'plan' : 'booking'} receipt for ${esc(title)}">
    <span class="receipt-list-icon">${ic(isPlan ? 'ticket' : 'cal')}</span>
    <span class="receipt-list-main"><b>${esc(title || (isPlan ? 'Plan purchase' : 'Booking'))}</b><span>${esc(barber)}${r.shop && r.shop !== barber ? ` · ${esc(r.shop)}` : ''}</span><small>Receipt date · ${esc(receiptDateTime(r.paid_at))}</small></span>
    <span class="receipt-list-side"><b>${naira(r.amount_kobo || 0)}</b><span class="receipt-list-status receipt-list-status--${receiptTone(r.status)}">${esc(r.status)}</span>${ic('right', 'sm')}</span>
  </a>`;
}
function drawReceiptList(receipts, filter) {
  receiptFilter = filter;
  document.querySelectorAll('[data-receipt-filter]').forEach((el) => {
    const on = el.dataset.receiptFilter === filter;
    el.classList.toggle('on', on); el.setAttribute('aria-selected', String(on));
  });
  const shown = receipts.filter((r) => filter === 'ALL' || (filter === 'PLANS' ? r.type === 'PLAN' : r.type === 'BOOKING'));
  const list = $('#receipt-list');
  list.innerHTML = shown.length ? shown.map(receiptListRow).join('') : `<div class="receipt-list-empty"><span class="receipt-list-empty-icon">${ic('receipt' in ICONS ? 'receipt' : 'list')}</span><b>${receipts.length ? 'No receipts in this filter' : 'No receipts yet'}</b><span>${receipts.length ? 'Choose another tab to see your other receipts.' : 'Paid bookings and plan purchases will appear here.'}</span></div>`;
}
async function customerReceipts() {
  const { receipts } = await api('/me/receipts');
  app.innerHTML = `<section class="receipt-screen"><a class="receipt-screen-back" href="#/profile">${ic('back', 'sm')} Profile</a><div class="receipt-screen-kicker">PAYMENT HISTORY</div><h1>Your receipts</h1><p>Booking and plan payments, in one place.</p>
    <div class="receipt-filter-tabs" role="tablist" aria-label="Filter receipts"><button type="button" role="tab" data-receipt-filter="ALL">All</button><button type="button" role="tab" data-receipt-filter="BOOKINGS">Bookings</button><button type="button" role="tab" data-receipt-filter="PLANS">Plans</button></div><div id="receipt-list" class="receipt-list"></div></section>`;
  document.querySelectorAll('[data-receipt-filter]').forEach((el) => el.onclick = () => drawReceiptList(receipts, el.dataset.receiptFilter));
  drawReceiptList(receipts, receiptFilter);
}
async function customerReceiptDetail(paymentId) {
  if (!Number.isSafeInteger(paymentId) || paymentId < 1) { app.innerHTML = '<section class="receipt-verify"><h1>Receipt not found</h1><a class="btn" href="#/receipts">Back to receipts</a></section>'; return; }
  const { receipt } = await api(`/me/receipts/${paymentId}`);
  const verification = await api(`/me/receipts/${paymentId}/verification`);
  document.title = `TrimSlot payment receipt ${receipt.receipt_number}`;
  app.innerHTML = `<section class="receipt-detail-page"><div class="receipt-detail-toolbar"><a class="back" href="#/receipts">${ic('back', 'sm')} All receipts</a><div class="btns"><button class="btn sm sec" id="receipt-share">Share</button><button class="btn sm" id="receipt-save">Save Receipt</button></div></div><div class="receipt-preview-frame">${receiptSheetMarkup(receipt, verification)}</div></section>`;
  $('#receipt-share').onclick = async () => { const el = $('#receipt-share'); el.disabled = true; try { await shareReceipt(receipt, verification); } catch (e) { fail(e); } finally { el.disabled = false; } };
  $('#receipt-save').onclick = () => openReceiptSaveMenu(receipt, verification);
}
async function receiptVerificationPage(token) {
  const robots = document.createElement('meta'); robots.id = 'receipt-verification-robots'; robots.name = 'robots'; robots.content = 'noindex,nofollow'; document.head.querySelector('#receipt-verification-robots')?.remove(); document.head.appendChild(robots);
  document.title = 'Verify a TrimSlot payment receipt';
  app.innerHTML = `<section class="receipt-verify" role="status" aria-live="polite"><div class="receipt-verify-mark">${ic('shield')}</div><div class="receipt-screen-kicker">TRIMSLOT RECEIPT CHECK</div><h1>Checking receipt…</h1><p>This page shows only a limited verification result.</p></section>`;
  try {
    const result = await api('/receipts/verify', { method: 'POST', body: { token } });
    if (!result.verified) throw userError('not verified');
    const type = result.type === 'PLAN' ? 'Plan payment' : 'Booking payment';
    app.innerHTML = `<section class="receipt-verify"><div class="receipt-verify-mark receipt-verify-mark--ok">${ic('check')}</div><div class="receipt-screen-kicker">TRIMSLOT RECEIPT CHECK</div><h1>Receipt verified</h1><p>This payment receipt matches a TrimSlot payment record.</p><div class="receipt-verify-facts"><div><span>Receipt number</span><b>${esc(result.receipt_number)}</b></div><div><span>Receipt type</span><b>${esc(type)}</b></div><div><span>Current status</span><b>${esc(result.status)}</b></div><div><span>Receipt date</span><b>${esc(receiptDateTime(result.paid_at))}</b></div></div><p class="receipt-verify-privacy">For privacy, this public check does not display the customer’s contact details, purchase amount, or transaction reference.</p><a class="btn sec" href="#/">Go to TrimSlot</a></section>`;
  } catch {
    app.innerHTML = `<section class="receipt-verify"><div class="receipt-verify-mark receipt-verify-mark--bad">${ic('warn')}</div><div class="receipt-screen-kicker">TRIMSLOT RECEIPT CHECK</div><h1>Could not verify</h1><p>This receipt link is invalid or has been withdrawn. Ask the receipt holder to open the receipt and create a fresh verification code.</p><a class="btn sec" href="#/">Go to TrimSlot</a></section>`;
  }
}
async function confirmReturn(kind, id, title) {
  app.innerHTML = `<div class="card center confirming" role="status" aria-live="polite"><div class="spin"></div><h1>${title}</h1><p class="muted small">Please keep this page open. It takes a few seconds.</p></div>`;
  let last = null;
  for (let i = 0; i < 6; i++) {
    try {
      last = await api(kind === 'plan' ? `/plan-purchases/${id}/verify` : `/bookings/${id}/verify`, { method: 'POST' });
      if (PAY_TERMINAL.includes(last.result)) break;
    } catch (e) { last = { result: 'error' }; }
    await sleep(2000);
  }
  return last ? last.result : 'not_paid';
}
/** Call + WhatsApp buttons. `c` has tel_url / whatsapp_url from the server (links are built there). */
const helpHtml = (b) => {
  const h = b.help;
  if (h && h.status === 'OPEN') return `<div class="${h.escalated ? 'warn' : 'info'} small notice" id="helpstatus">${ic('clock', 'sm')}<div><b>${h.escalated ? 'Your barber has not answered yet.' : 'We told your barber. Waiting for an answer.'}</b><div>${h.escalated ? 'We told the TrimSlot team. They will help you. You can also call your barber.' : 'You can also call your barber.'}</div><div class="muted">You wrote: “${esc(h.note)}”</div></div></div>`;
  if (h && h.status === 'COME_LATER') return `<div class="ok small" id="helpstatus">${ic('check', 'sm')} <b>Your barber will wait for you.</b> Come as soon as you can.</div>`;
  if (h && h.status === 'RELEASED') return `<div class="info small notice" id="helpstatus">${ic('check', 'sm')}<div><b>Your barber released this booking.</b> See below what happens with your money.</div></div>`;
  if (b.can_ask_help) return `<div class="card" id="helpbox"><b>Emergency, please help</b><p class="small muted" style="margin:4px 0 8px">Use this only if something urgent came up. Your barber gets an urgent message. Your barber decides.</p><textarea id="helpnote" rows="2" maxlength="200" placeholder="What happened? (a few words)"></textarea><div class="btns" style="margin-top:8px"><button class="btn sm red" id="helpsend">Send to my barber</button></div></div>`;
  return '';
};
const contactBtns = (c) => c && c.tel_url ? `<div class="btns contact-btns" style="margin-top:8px"><a class="btn sm" href="${esc(c.tel_url)}">${ic('phone', 'sm')} Call</a><a class="btn sm sec" href="${esc(c.whatsapp_url)}" target="_blank" rel="noopener noreferrer">${ic('chat', 'sm')} WhatsApp</a></div>` : '';
async function bookingDetail(id, payResult, quiet) {
  const typed = $('#helpnote'), keepHelp = typed ? typed.value : '', helpFocus = !!typed && document.activeElement === typed;   // the 10-second refresh redraws this page: keep the help note the customer is writing
  const { booking: b } = await api('/bookings/' + id);
  if (payResult && !quiet && b.status === 'PENDING_PAYMENT' && !['slot_taken', 'refund_due', 'late_refund', 'duplicate_refund', 'amount_mismatch'].includes(payResult)) {   // back from Paystack (or Paystack was slow to answer): ask again before showing anything
    const r = await confirmReturn('booking', id, 'Checking your payment…');
    if ((r === 'processed' || r === 'already_processed') && window.haptics) haptics.success();
    history.replaceState(null, '', '#/booking/' + id + '?pay=' + (r === 'processed' || r === 'already_processed' ? 'processed' : PAY_TERMINAL.includes(r) ? r : 'checked'));
    return bookingDetail(id, new URLSearchParams(location.hash.split('?')[1] || '').get('pay'), true);
  }
  const q = b.queue;
  const payMsg = payBanner(b, payResult);
  const receipt = b.receipt;
  const receiptClass = receipt && receipt.status === 'Paid' ? 'b-green' : receipt && receipt.status === 'Refunded' ? 'b-blue' : 'b-amber';
  const receiptHtml = receipt ? `<section class="card receipt" aria-label="Payment receipt">
    <div class="row between receipt-head"><div><div class="small muted">PAYMENT RECEIPT · ${esc(receipt.receipt_number || '')}</div><b>${esc(receipt.service)}</b></div><span class="badge ${receiptClass}">${esc(receipt.status)}</span></div>
    <div class="receipt-lines"><div><span>Receipt date</span><b>${esc(receiptDateTime(receipt.paid_at))}</b></div><div><span>Barber</span><b>${esc(receipt.barber)}${receipt.shop && receipt.shop !== receipt.barber ? ` · ${esc(receipt.shop)}` : ''}</b></div>
      <div><span>Appointment</span><b>${esc(dateLabel(receipt.appointment_date))}, ${esc(receipt.appointment_time)}</b></div>
      <div><span>${receipt.status === 'Refunded' ? 'Original payment amount' : 'Amount received'}</span><b>${naira(receipt.amount_kobo)}</b></div>
      ${receipt.payment_provider ? `<div><span>Payment provider</span><b>${esc(receipt.payment_provider)}</b></div>` : ''}
      <div class="receipt-ref"><span>Transaction reference</span><code>${esc(receipt.reference)}</code></div></div>
    <div class="btns"><a class="btn sm sec" href="#/receipts/${Number(receipt.payment_id)}">View full receipt</a><button class="btn sm" type="button" id="shareReceipt">Share verification</button><button class="btn sm sec" type="button" id="saveReceipt">Save / Print PDF</button></div>
  </section>` : '';
  const canCancel = b.can_cancel;
  const locked = ['CONFIRMED', 'ARRIVED'].includes(b.status) && !b.can_cancel;
  let qHtml = '';
  if (q && q.is_today && q.state !== 'NOT_ACTIVE') {
    const cls = q.state === 'READY' ? 'ready' : q.state === 'NEXT' ? 'next' : q.state === 'BEING_SERVED' ? 'serving' : '';
    const big = q.state === 'IN_LINE' ? `#${q.position}` : q.state === 'NEXT' ? 'Next' : q.state === 'READY' ? 'Ready' : ic('scissors');
    qHtml = `<div class="qbox ${cls}"><div class="muted small">LIVE QUEUE · updates every 10s</div><div class="n">${big}</div><div style="font-weight:700;margin-top:6px">${esc(q.message)}</div>
      ${q.state === 'IN_LINE' || q.state === 'NEXT' ? `<div class="small muted">${q.ahead} customer${q.ahead === 1 ? ' is' : 's are'} ahead of you</div>` : ''}
      ${q.eta && q.state !== 'BEING_SERVED' ? `<div class="eta">${ic('clock', 'sm')} You should start around <b>${lagosTime(q.eta.est_start)}</b>${q.eta.est_min > 0 ? ` · about ${q.eta.est_min} min` : ''}${q.eta.delay_min ? `<div class="small muted">Your barber is running about ${q.eta.delay_min} min behind</div>` : ''}</div>` : ''}</div>`;
  }
  app.innerHTML = `<a href="#/bookings" class="back">${ic('back', 'sm')} My bookings</a>${payMsg}${receiptHtml}
    <div class="card"><div class="row between"><h1 style="margin:0;font-size:18px">${esc(b.service_name)}</h1>${statusBadge(b.status, b)}</div>
      <div class="muted">${esc(b.shop_name)} · ${esc(b.barber_name)}</div><div class="muted small">${ic('pin', 'sm')} ${esc(b.location || '')}</div>
      <hr><div class="row between"><span>${ic('cal', 'sm')} ${dateLabel(b.date)}</span><b>${esc(b.start_label)}</b></div>
      <div class="row between" style="margin-top:6px"><span>${ic('clock', 'sm')} ${b.duration_min} min</span><b>${naira(b.price_kobo)}</b></div>${custMoney(b)}
      <div class="row between" style="margin-top:8px"><span class="small muted">Payment</span>${payBadge(b)}</div>
      ${b.arrival_time ? `<div class="small muted" style="margin-top:6px">Checked in ${lagosWhen(b.arrival_time, b.scheduled_time)}${lateBy(b.arrival_time, b.scheduled_time)}</div>` : ''}</div>
    ${b.barber_contact && !locked ? `<div class="card" id="contactbox"><b>Contact your barber</b><div class="small muted">${esc(b.barber_contact.name || '')} · ${esc(b.barber_contact.phone || '')}</div>${contactBtns(b.barber_contact)}</div>` : ''}
    ${b.note_to_barber ? `<div class="card small"><span class="muted">Your note to the barber:</span> ${esc(b.note_to_barber)}</div>` : ''}
    ${qHtml}
    ${b.status === 'COMPLETED' && (state.cfg.features || {}).reviews ? (b.review ? `<div class="card review"><div class="row between"><b>Your review</b>${stars(b.review.rating)}</div>${b.review.comment ? `<p style="margin:8px 0 0">${esc(b.review.comment)}</p>` : ''}${b.review.reply ? `<div class="reply small"><b>Reply from your barber</b><div>${esc(b.review.reply)}</div></div>` : ''}</div>` : `<div class="card" id="rvcard"><h3 style="margin:0 0 4px">How was your visit?</h3><div class="starpick" id="starpick" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((i) => `<button type="button" data-star="${i}" role="radio" aria-checked="false" aria-label="${i} star${i > 1 ? 's' : ''}">${ic('star')}</button>`).join('')}</div><textarea id="rvtext" rows="2" maxlength="500" placeholder="Add a short comment (optional)"></textarea><div class="btns"><button class="btn sm" id="rvsend" disabled>Send review</button></div></div>`) : ''}
    ${b.status === 'COMPLETED' && (state.cfg.features || {}).rebook ? `<div class="btns"><a class="btn sec" href="#/book/${b.barber_id}">${ic('repeat', 'sm')} Book again</a></div>` : ''}
    ${b.status === 'PENDING_PAYMENT' && b.pay_blocked ? `<div class="info small notice" id="payhold">${ic('warn', 'sm')}<div><b>Please do not pay again.</b> We already have a payment for this booking, and we are sorting it out. You will not be charged twice.</div></div><div class="btns"><button class="btn sec" id="verify">Check my payment</button></div>` : b.status === 'PENDING_PAYMENT' ? `<div class="warn small notice">${ic('warn', 'sm')}<div><b>Not confirmed yet.</b> Your time is saved only after you pay. Until then, others can book it. Pay to save it. If someone takes it first, we refund you.</div></div><div class="btns"><button class="btn" id="payNow">Pay ${naira((b.money && b.money.total_kobo) || b.price_kobo)} now</button><button class="btn sec" id="verify">I paid. Check my payment</button></div>` : ''}
    ${b.can_check_in ? `<button class="btn big green block" id="here">${ic('pin')} I'm Here</button>` : ''}
    ${b.status === 'CONFIRMED' && !b.can_check_in ? `<div class="info small">The "I'm Here" button shows on the day of your visit.</div>` : ''}
    ${canCancel ? `<div class="btns" style="margin-top:16px">${b.can_reschedule ? `<a class="btn" id="move" href="#/booking/${b.id}/move">${ic('cal', 'sm')} Change time</a>` : ''}<button class="btn sec" id="cancel">Cancel booking</button></div><p class="small muted" style="margin-top:8px">You can cancel until ${lagosTime(b.cancel_deadline)}. The time then opens for others.${b.payment_option === 'PLAN' ? ' You get your plan session back.' : b.payment_option === 'CREDIT' ? ' You get your credit back.' : b.payment_status === 'PAID' ? ' We send your money back the way you paid, once we approve it.' : ''}</p>` : ''}
    ${locked ? `<div class="info small notice" id="lockedbox">${ic('lock', 'sm')}<div>You can no longer cancel. The cut-off was ${lagosTime(b.cancel_deadline)} (${state.cfg.cancel_cutoff_min} min before). The time stays yours. If you do not come and your barber marks a no-show, you get no refund. If you paid, you get 1 credit with this barber instead.${b.barber_contact ? `<div style="margin-top:8px"><b>Something urgent? Call or WhatsApp your barber.</b> Your barber decides what happens to the booking.</div>${contactBtns(b.barber_contact)}` : ''}</div></div>` : ''}
    ${helpHtml(b)}
    ${b.incomplete ? `<div class="info small notice">${ic('warn', 'sm')}<div><b>Not finished.</b> The payment was not finished, so we did not save a time, and we found no payment for it. If you still see a charge, tap “Report a problem” and we will sort it out.<div style="margin-top:8px"><a class="btn sm" href="#/book/${b.barber_id}">Book again</a></div></div></div>` : ''}
    <div class="btns" style="margin-top:14px"><button class="btn sm sec" data-report="${b.id}">${ic('warn', 'sm')} Report a problem</button></div>
    ${b.payment_status === 'CREDITED' ? `<div class="ok small">${ic('ticket', 'sm')} We did not refund this session, but you have <b>1 session credit</b> with this barber. <a href="#/wallet">See my credits</a></div>` : ''}
    ${b.payment_status === 'REFUND_PENDING' ? `<div class="info small notice">${ic('clock', 'sm')}<div><b>Refund asked for.</b> We are checking it. You will get a message soon.</div></div>` : ''}
    ${b.payment_status === 'REFUNDED' ? `<div class="ok small">${ic('check', 'sm')} <b>Refund approved.</b> Your money is on its way back to the way you paid. Your bank may take a few working days to show it.</div>` : ''}
    ${b.payment_status === 'REFUND_DECLINED' ? `<div class="info small notice">${ic('warn', 'sm')}<div><b>Refund not approved.</b> Open your notifications to see why. If you do not agree, use Report a problem.</div></div>` : ''}
    ${b.payment_status === 'CREDIT_PENDING' ? `<div class="info small">We are deciding if you get a credit or a refund for this payment. We will tell you.</div>` : ''}`;
  if (quiet && keepHelp) { const hn = $('#helpnote'); if (hn) { hn.value = keepHelp; if (helpFocus) hn.focus(); } }
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = async () => { el.disabled = true; try { await fn(); } catch (e) { fail(e); el.disabled = false; } }; };
  on('#shareReceipt', async () => shareReceipt(receipt));
  on('#saveReceipt', async () => openReceiptPdf(receipt));
  let stars_ = 0; document.querySelectorAll('[data-star]').forEach((el) => el.onclick = () => { stars_ = Number(el.dataset.star); document.querySelectorAll('[data-star]').forEach((x) => { const on = Number(x.dataset.star) <= stars_; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(Number(x.dataset.star) === stars_)); }); $('#rvsend').disabled = false; });
  on('#rvsend', async () => { await api(`/bookings/${id}/review`, { method: 'POST', body: { rating: stars_, comment: $('#rvtext').value } }); window.posthog?.capture('review_submitted', { rating: stars_ }); toast('Thank you for your review'); route(); });
  on('#payNow', async () => { const p = await api(`/bookings/${id}/pay`, { method: 'POST' }); window.posthog?.capture('booking_payment_started'); location.href = p.authorization_url; });
  on('#verify', async () => { const r = await api(`/bookings/${id}/verify`, { method: 'POST' }); const done = r.booking.status === 'CONFIRMED'; toast(done ? 'Payment confirmed' : ['slot_taken', 'late_refund', 'refund_due'].includes(r.result) ? 'That time was taken. We are refunding you' : r.result === 'duplicate_refund' ? 'Already paid. We are returning the extra payment' : r.result === 'amount_mismatch' ? (r.booking.payment_issue && r.booking.payment_issue.refund === 'sent' ? 'We have sent your payment back' : r.booking.payment_issue && r.booking.payment_issue.refund === 'coming' ? 'We are sending your payment back' : 'Payment received. Our team will check it') : 'We have not got your payment yet', !done && r.result !== 'duplicate_refund'); route(); });
  on('#helpsend', async () => { const note = ($('#helpnote').value || '').trim(); if (note.length < 3) throw userError('Write a few words about what happened.'); await api(`/bookings/${id}/help`, { method: 'POST', body: { note } }); toast('We told your barber'); route(); });
  on('#here', async () => { await api(`/bookings/${id}/check-in`, { method: 'POST' }); window.posthog?.capture('customer_checked_in'); toast("You are checked in"); route(); });
  on('#cancel', async () => { if (!confirm('Cancel this booking?')) { $('#cancel').disabled = false; return; } await api(`/bookings/${id}/cancel`, { method: 'POST' }); window.posthog?.capture('booking_cancelled'); toast('Booking cancelled'); route(); });
  if (['PENDING_PAYMENT', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(b.status)) startPoll(async () => { if (location.hash.startsWith('#/booking/')) await bookingDetail(id, payResult, true); });
}

/* ---------- customer: change the time of an upcoming booking (same barber and service) ---------- */
async function moveBooking(id) {
  await freshConfig();
  const { booking: b } = await api('/bookings/' + id);
  if (!b.can_reschedule) { app.innerHTML = `<a href="#/booking/${id}" class="back">${ic('back', 'sm')} Booking</a><div class="info notice">${ic('lock', 'sm')}<div>You cannot change the time of this booking any more.</div></div>`; return; }
  const today = state.cfg.today;
  const days = Array.from({ length: state.cfg.booking_window_days || 14 }, (_, i) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
  let date = b.date < today ? today : b.date, time = null;
  const draw = async () => {
    app.innerHTML = `<a href="#/booking/${id}" class="back">${ic('back', 'sm')} Booking</a><h1>Change time</h1>
      <div class="card small"><b>${esc(b.service_name)}</b> with ${esc(b.shop_name)}<div class="muted">Now: ${dateLabel(b.date)}, ${esc(b.start_label)}</div><div class="muted">Your payment stays the same.</div></div>
      <div class="days">${days.map((d) => { const x = new Date(d + 'T00:00:00Z'); return `<button class="chip ${date === d ? 'on' : ''}" data-d="${d}">${DAYN[x.getUTCDay()]}<b>${x.getUTCDate()}</b>${MON[x.getUTCMonth()]}</button>`; }).join('')}</div>
      <div id="slots" class="card muted">Loading times…</div>
      <div class="btns cta"><a class="btn sec" href="#/booking/${id}">Keep my time</a><button class="btn" id="save" disabled>Move my booking</button></div>`;
    document.querySelectorAll('[data-d]').forEach((el) => el.onclick = () => { date = el.dataset.d; time = null; draw(); });
    try {
      const r = await api(`/bookings/${id}/move-slots?date=${date}`);
      $('#slots').className = 'card';
      $('#slots').innerHTML = r.slots.length ? `<div class="small muted" style="margin-bottom:8px">${dateLabel(date)} · ${b.duration_min} min</div><div class="chips">${r.slots.map((s) => `<button class="chip ${time === s.time ? 'on' : ''}" data-t="${s.time}">${t12(s.time)}</button>`).join('')}</div>` : `<p class="muted center">${esc(r.closed_reason || 'No free times left this day.')}<br>Pick another date.</p>`;
      document.querySelectorAll('[data-t]').forEach((el) => el.onclick = () => { time = el.dataset.t; document.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x === el)); $('#save').disabled = false; });
    } catch (e) { $('#slots').innerHTML = `<div class="err">${esc(userMessage(e))}</div>`; }
    $('#save').onclick = async () => { const btn = $('#save'); btn.disabled = true; try { await api(`/bookings/${id}/reschedule`, { method: 'POST', body: { date, time } }); window.posthog?.capture('booking_rescheduled'); toast('Your booking is moved'); go('#/booking/' + id); } catch (e) { fail(e); btn.disabled = false; } };
  };
  draw();
}

/* ---------- report a problem (customers + barbers) ---------- */
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest && ev.target.closest('[data-report]'); if (!btn) return;
  const id = Number(btn.dataset.report); let box = $('#reportbox');
  if (box) { box.remove(); return; }
  const category = btn.dataset.reportCategory || 'NO_SHOW';
  box = document.createElement('div'); box.id = 'reportbox'; box.className = 'card'; box.style.marginTop = '12px';
  box.innerHTML = `<h3 style="margin-top:0">Help &amp; Support</h3><p class="small muted">Tell us what you need help with. The TrimSlot team reads every report; replies appear in your notifications.</p>
    <form id="rform"><label>What is this about?</label><select name="category"><option value="NO_SHOW"${category === 'NO_SHOW' ? ' selected' : ''}>Someone did not come</option><option value="BEHAVIOUR"${category === 'BEHAVIOUR' ? ' selected' : ''}>How someone acted</option><option value="PAYMENT"${category === 'PAYMENT' ? ' selected' : ''}>Payment</option><option value="QUALITY"${category === 'QUALITY' ? ' selected' : ''}>How good the service was</option><option value="SAFETY"${category === 'SAFETY' ? ' selected' : ''}>Safety</option><option value="OTHER"${category === 'OTHER' ? ' selected' : ''}>Something else</option></select>
    <label>Details</label><textarea name="message" rows="4" maxlength="1000" required placeholder="What happened?"></textarea>
    <div class="btns cta"><button class="btn" type="submit">Send report</button></div></form>`;
  const anchor = btn.closest('.btns') || btn.closest('.list') || btn; anchor.after(box); box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#rform').onsubmit = async (e) => {
    e.preventDefault(); const sb = e.target.querySelector('button'); sb.disabled = true;
    try { const d = Object.fromEntries(new FormData(e.target)); const payload = { ...d }; if (id > 0) payload.booking_id = id; await api('/reports', { method: 'POST', body: payload }); box.innerHTML = `<div class="ok">Thank you. The TrimSlot team got your report.</div>`; }
    catch (err) { sb.disabled = false; toast(userMessage(err, 'We could not send it'), true); }
  };
});

/* ---------- barber: platform balance owed (off-app commission ledger) ---------- */
async function barberBalance() {
  const r = await api('/barber/ledger');
  const st = { ACCRUED: ['b-amber', 'Owed'], SETTLED: ['b-green', 'Settled'], WAIVED: ['b-blue', 'Waived'] };
  app.innerHTML = `${pendingBanner()}<a href="#/profile" class="back">${ic('back', 'sm')} Profile</a><h1>Platform balance owed</h1>
    <div class="card"><div class="muted small">YOU CURRENTLY OWE</div><div style="font-size:32px;font-weight:800;margin:4px 0">${naira(r.owed_kobo)}</div>
      <div class="small muted">When a customer pays outside the app (cash or transfer) and you complete the booking, we add TrimSlot's charge here. We take it out of your next online payments and plan sales. You do not need to send money.</div></div>
    ${r.blocked.blocked ? `<div class="warn notice">${ic('warn')}<div><b>Pay on arrival is paused for your shop.</b><div class="small">Your balance ${esc(r.blocked.reason || '')}. Customers can still pay online. When you clear the balance, pay on arrival comes back.</div></div></div>` : ''}
    <h2>Entries</h2>${r.entries.length ? r.entries.map((e) => `<div class="card"><div class="row between"><b>${e.kind === 'ADJUSTMENT' ? 'Adjustment' : e.booking_id ? `<a href="#/b/${e.booking_id}">Booking #${e.booking_id}</a>` : 'Commission'}</b><span class="badge ${st[e.status][0]}">${st[e.status][1]}</span></div>
      <div class="row between" style="margin-top:4px"><span class="small muted">${esc(e.note || '')}</span><b>${naira(e.amount_kobo)}</b></div>
      <div class="small muted" style="margin-top:4px">${lagosStamp(e.created_at)}${e.status === 'ACCRUED' && e.remaining_kobo < e.amount_kobo ? ' · ' + naira(e.remaining_kobo) + ' still owed' : ''}${e.settled_at ? ' · cleared ' + lagosStamp(e.settled_at) : ''}</div></div>`).join('') : '<div class="card muted center">You owe nothing. Commission shows here after you complete a booking that was paid outside the app.</div>'}`;
}

/* ---------- notifications ---------- */
const NOTIF_TONE = (t) => /^(YOUR_TURN|YOURE_NEXT|LEAVE_NOW|WAITLIST_OPEN|HELP_REQUEST)$/.test(t) ? 'hot' : /^(AVAILABILITY|SHOP_PAUSED|BARBER_REJECTED|BARBER_NEEDS|BARBER_SUSPENDED|ACCOUNT|LEDGER|BOOKING_INCOMPLETE|NO_SHOW|BOOKING_CANCELLED)/.test(t) ? 'warn' : /^(PLAN_|CREDIT|LOYALTY|PAYMENT|REVIEW)/.test(t) ? 'money' : '';
const agoTxt = (iso) => { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 1 ? 'Just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : lagosStamp(iso).replace(/, \d+:\d+:\d+/, ',').replace(/:\d\d (?=[AP]M)/, ' '); };
const notifItem = (n) => `<a class="nitem ${n.is_read ? '' : 'unread'} ${NOTIF_TONE(n.type)}" href="${Notify.urlOf(n)}" data-nid="${n.id}"><span class="nico">${ic(Notify.iconFor(n.type))}</span><span class="nbody"><span class="ntop"><b>${esc(n.title)}</b><span class="small muted">${agoTxt(n.created_at)}</span></span><span class="small ntext">${esc(n.body)}</span></span>${n.is_read ? '' : '<i class="udot" aria-label="unread"></i>'}</a>`;
async function notifications() {
  const r = await api('/notifications?limit=30');
  let items = r.notifications, more = r.next_before;
  const draw = () => {
    const unread = items.filter((n) => !n.is_read).length;
    app.innerHTML = `<div class="row between"><h1>Notifications</h1>${unread ? '<button class="btn sm sec" id="read">Mark all as read</button>' : ''}</div>
      ${Notify.promptCard()}
      ${items.length ? `<div class="nlist">${items.map(notifItem).join('')}</div>${more ? '<div class="btns end"><button class="btn sm sec" id="more">Older</button></div>' : ''}`
        : `<div class="empty">${ic('bell')}<b>You have no new alerts</b><span class="small muted">Booking news, reminders and line updates show up here.</span></div>`}`;
    const rd = $('#read'); if (rd) rd.onclick = async () => { await api('/notifications/read', { method: 'POST' }); items = items.map((n) => ({ ...n, is_read: true })); state.unread = 0; Notify.paintUnread(); chrome(); draw(); };
    const mo = $('#more'); if (mo) mo.onclick = async () => { mo.disabled = true; const x = await api('/notifications?limit=30&before=' + more); items = items.concat(x.notifications); more = x.next_before; draw(); };
    document.querySelectorAll('[data-nid]').forEach((el) => el.addEventListener('click', () => {
      const id = Number(el.dataset.nid); const n = items.find((x) => x.id === id);
      if (n && !n.is_read) { n.is_read = true; state.unread = Math.max(0, state.unread - 1); api('/notifications/read', { method: 'POST', body: { id } }).catch(() => {}); Notify.paintUnread(); }
    }));
  };
  draw();
  startPoll(async () => { if (!location.hash.startsWith('#/notifications')) return; const x = await api('/notifications?limit=30'); if (x.notifications[0] && (!items[0] || x.notifications[0].id !== items[0].id)) { items = x.notifications; more = x.next_before; state.unread = x.unread; chrome(); draw(); } });
}

/* ---------- barber: Today ---------- */
const relBadge = (r) => r ? `<span class="badge rel-${r.tone}" title="${r.completed} completed, ${r.no_shows} no-show${r.no_shows === 1 ? '' : 's'}">${esc(r.label)}</span>` : '';
function custLine(b) { return `${cav(b.customer, 'in')}<b>${esc(b.customer.name)}</b> ${relBadge(b.customer.reliability)} <span class="muted small">${esc(b.service_name)} · ${naira(b.price_kobo)}</span>`; }
async function act(id, action, body) {
  try { await api(`/barber/bookings/${id}/${action}`, { method: 'POST', body: body || {} }); window.posthog?.capture('barber_booking_updated', { action }); await barberToday(true); } catch (e) { fail(e); }
}
const emailBanner = () => {
  const u = state.user; if (!emailCheckOn() || !u || u.email_verified !== false) return '';
  const here = (location.hash || '').startsWith('#/verify-email');
  if (here) return '';
  const barberHint = u.verified === false ? 'Verify your email before your shop can go live.' : 'Customers cannot book your shop until your email is checked.';
  return `<a class="notice warn" id="emailban" href="#/verify-email?next=%23%2Fprofile" style="text-decoration:none;color:inherit">${ic('shield')}<div><b>${u.email ? 'Check your email address.' : 'Add your email address.'}</b><div class="small">${u.role === 'barber' ? barberHint : 'You need this before your first booking.'} ${u.email ? 'Tap to get a 6-digit code.' : 'Tap to add it.'}</div></div></a>`;
};
const pendingBanner = () => emailBanner() + pendingBanner0();
const pendingBanner0 = () => {
  const u = state.user; if (!u || u.role !== 'barber' || u.verified !== false) return '';
  const st = u.review_status || 'PENDING', why = u.review_reason ? `<div class="why">${esc(u.review_reason)}</div>` : '';
  const btn = (label) => `<div class="btns" style="margin-top:10px"><button class="btn sm" data-resubmit>${label}</button></div>`;
  if (st === 'REJECTED') return `<div class="err notice" id="rvbox">${ic('shield')}<div><b>We did not approve your shop.</b>${why}<div class="small">Fix what we listed in Settings. Then send it for review again.</div>${btn('Send for review again')}</div></div>`;
  if (st === 'NEEDS_INFO') return `<div class="warn notice" id="rvbox">${ic('shield')}<div><b>We need a little more information.</b>${why}<div class="small">Update your shop details in Settings. Then send them for review again.</div>${btn('Send for review again')}</div></div>`;
  if (st === 'SUSPENDED') return `<div class="err notice" id="rvbox">${ic('shield')}<div><b>Your shop is paused.</b>${why}<div class="small">Customers cannot see or book your shop. Contact support to get it back.</div></div></div>`;
  return '<div class="info notice" id="rvbox">'+ic('shield')+'<div><b>We are checking your shop.</b> Customers cannot see or book it yet. Finish your profile, services and hours in Settings. We will tell you when we approve it.</div></div>';
};
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest && ev.target.closest('[data-resubmit]'); if (!b) return;
  b.disabled = true;
  try { const r = await api('/barber/resubmit', { method: 'POST', body: {} }); state.user = { ...state.user, review_status: r.review_status, review_reason: r.review_reason, verified: r.verified }; toast('Sent for review'); route(); }
  catch (e) { b.disabled = false; toast(userMessage(e, 'We could not send it again'), true); }
});
const payoutBanner = () => {
  const u = state.user; if (!u || u.role !== 'barber' || u.verified === false || u.payout_ok !== false) return '';
  return `<a class="notice warn payban" href="#/payouts">${ic('wallet')}<div><b>Set up payouts to get paid online.</b><div class="small">Until you add your bank account, customers can only pay you on arrival. <u>Set up now</u></div></div></a>`;
};
async function barberToday(keepScroll) {
  const d = await api('/barber/today');
  const ns = d.now_serving;
  const nowCard = ns ? `<div class="now"><div class="lbl">NOW SERVING</div><div class="nm">${cav(ns.customer, 'in')}${esc(ns.customer.name)}</div>
      <div>${esc(ns.service_name)} · ${naira(ns.price_kobo)} ${payBadge(ns)}</div><div class="small" style="opacity:.8;margin:4px 0 12px">Started ${lagosTime(ns.service_start)} · booked for ${esc(ns.start_label)}</div>
      ${ns.payment_status === 'PAYMENT_DUE' ? `<div class="info small">Collect ${naira(ns.price_kobo)} before you complete:</div><div class="btns"><button class="btn amber" data-a="record-payment" data-id="${ns.id}" data-m="cash">Cash received</button><button class="btn amber" data-a="record-payment" data-id="${ns.id}" data-m="transfer">Transfer received</button></div><div style="height:12px"></div>` : ''}
      <button class="btn big green block" data-a="complete" data-id="${ns.id}" ${ns.payment_status === 'PAYMENT_DUE' ? 'disabled' : ''}>Complete</button></div>`
    : `<div class="now idle"><div class="lbl">NOW SERVING</div><div class="nm" style="font-size:20px">Nobody in the chair</div>
      ${d.next ? `<div class="small">Next: ${cav(d.next.customer, 'in sm')}<b>${esc(d.next.customer.name)}</b> ${d.next.status === 'ARRIVED' ? '(here)' : '(not here yet)'}</div>` : '<div class="small">No one is in line.</div>'}</div>`;
  const nx = d.next;
  const nextCard = nx ? `<h2>NEXT</h2><div class="card">${personRow(nx, !ns)}</div>` : '';
  const F = state.cfg.features || {};
  const [sm, tp] = await Promise.all([F.daily_summary ? api('/barber/summary').catch(() => null) : null, F.quick_actions ? api('/barber/queue/templates').catch(() => null) : null]);
  const smHtml = sm && sm.enabled ? `<div class="summary"><div><b>${sm.today.completed}</b><span>done</span></div><div><b>${naira(sm.today.earned)}</b><span>earned</span></div><div><b>${sm.today.remaining}</b><span>to go</span></div><div><b>${sm.tomorrow_booked}</b><span>tomorrow</span></div></div>
    <div class="small muted" style="margin:-2px 0 8px">${sm.yesterday.completed ? `Yesterday: ${sm.yesterday.completed} cuts · ${naira(sm.yesterday.earned)}` : 'No cuts yesterday'}${sm.rating && sm.rating.count ? ` · ${ratingChip(sm.rating)}` : ''}${sm.waitlisted ? ` · ${sm.waitlisted} on waitlist` : ''}</div>` : '';
  const qaHtml = tp && tp.enabled ? `<details class="acc qa"><summary><span class="ico">${ic('send', 'sm')}</span><span class="grow">Quick actions<span class="sub">Tell today's customers you are late</span></span>${ic('chev', 'sm')}</summary><div class="acc-b"><div class="small muted" style="margin-bottom:6px">Move everyone's start time later</div><div class="chips">${[5, 10, 15, 20, 30].map((m) => `<button class="chip" data-delay="${m}">+${m} min</button>`).join('')}</div>
      <div class="small muted" style="margin:12px 0 6px">Or send a message to everyone still waiting</div><div class="btns">${tp.templates.map((t) => `<button class="btn sm sec" data-tpl="${t.key}">${esc(t.label)}</button>`).join('')}</div></div></details>` : '';
  const urgent = [d.now_serving, d.next, ...d.waiting].filter((x) => x && x.help);
  const urgentHtml = urgent.map((x) => `<a class="notice warn" role="alert" href="#/b/${x.id}" style="text-decoration:none;color:inherit">${ic('warn')}<div><b>Urgent: ${esc(x.customer.name)} needs help</b><div class="small">“${esc(x.help.note)}” Tap to answer.</div></div></a>`).join('');
  app.innerHTML = `${pendingBanner()}${payoutBanner()}${urgentHtml}${Notify.promptCard()}<div class="row between"><div><h1>Today</h1><div class="muted small">${dateLabel(d.date)} · ${d.stats.completed} done · ${naira(d.stats.earned_kobo)} earned</div></div><button class="btn sm sec" id="refresh" aria-label="Refresh">${ic('refresh', 'sm')}</button></div>
    ${smHtml}${qaHtml}
    ${nowCard}${nextCard}
    <h2>WAITING (${d.waiting.length})</h2>${d.waiting.map((b) => `<div class="card">${personRow(b, !ns && false)}</div>`).join('') || '<p class="muted small">No one else is in line.</p>'}
    ${d.done.length ? `<h2>Done today</h2>${clist(d.done.map((b) => crowA({ t: cav(b.customer) + esc(b.customer.name), p: statusBadge(b.status) + payBadge(b), m: `${esc(b.start_label)} · ${esc(b.service_name)}`, r: naira(b.price_kobo) }, '#/b/' + b.id)))}` : ''}`;
  $('#refresh').onclick = () => barberToday();
  document.querySelectorAll('[data-delay]').forEach((el) => el.onclick = async () => { if (!confirm(`Tell today's waiting customers you are ${el.dataset.delay} more minutes late?`)) return; el.disabled = true; try { const r = await api('/barber/queue/delay', { method: 'POST', body: { minutes: Number(el.dataset.delay) } }); window.posthog?.capture('barber_queue_delay_sent', { delay_minutes: r.delay_min, notified_count: r.notified }); toast(`You are ${r.delay_min} min late · ${r.notified} customer${r.notified === 1 ? '' : 's'} told`); } catch (e) { fail(e); } el.disabled = false; });
  document.querySelectorAll('[data-tpl]').forEach((el) => el.onclick = async () => { if (!confirm(`Send "${el.textContent}" to everyone waiting today?`)) return; el.disabled = true; try { const r = await api('/barber/queue/message', { method: 'POST', body: { template: el.dataset.tpl } }); toast(`Sent to ${r.sent} customer${r.sent === 1 ? '' : 's'}`); } catch (e) { fail(e); } el.disabled = false; });
  document.querySelectorAll('[data-a]').forEach((el) => el.onclick = () => {
    const a = el.dataset.a;
    if (a === 'no-show' && !confirm('Mark as no-show?')) return;
    if (a === 'not-served' && !confirm('Mark as not served?')) return;
    act(Number(el.dataset.id), a, el.dataset.m ? { method: el.dataset.m } : {});
  });
  startPoll(() => location.hash.startsWith('#/today') ? barberToday() : Promise.resolve());
}
// A barber can mark a no-show only on the booking's day, from the booked time until midnight, if the customer has not arrived (the server checks the same rule).
const lagosToday = () => new Date(Date.now() + 3600000).toISOString().slice(0, 10);
const canNoShow = (b) => b.status === 'CONFIRMED' && b.date === lagosToday() && !!b.scheduled_time && Date.now() >= new Date(b.scheduled_time).getTime();
function personRow(b, canStartNow) {
  const arrived = b.status === 'ARRIVED';
  return `<div class="row between"><a href="#/b/${b.id}" style="color:inherit;text-decoration:none">${custLine(b)}<div class="small muted">Booked ${esc(b.start_label)}${b.arrival_time ? ` · arrived ${lagosWhen(b.arrival_time, b.scheduled_time)}` : ''}</div></a>
      <div style="text-align:right"><span class="badge ${arrived ? 'b-green' : 'b-gray'}">${arrived ? 'ARRIVED' : 'NOT ARRIVED'}</span><div style="margin-top:4px">${payBadge(b)}</div></div></div>
    ${b.note_to_barber ? `<div class="small cnote">${ic('pencil', 'sm')} <b>Note:</b> ${esc(b.note_to_barber)}</div>` : ''}${b.customer.note ? `<div class="small cnote priv">${ic('shield', 'sm')} ${esc(b.customer.note)}</div>` : ''}${b.customer.usual ? `<div class="small muted">Usual: ${esc(b.customer.usual.service_name)}</div>` : ''}
    ${b.barber_hold && !arrived ? '<div class="small" style="color:var(--accent-ink);margin-top:4px">Waiting for this customer</div>' : ''}${b.skipped ? '<div class="small muted">Skipped. Moved back in line.</div>' : ''}
    <div class="btns" style="margin-top:12px">
      ${arrived ? `<button class="btn green" data-a="start" data-id="${b.id}">Start</button>` : `<button class="btn blue" data-a="mark-present" data-id="${b.id}">Mark Present</button>`}
      ${arrived ? '' : `<button class="btn sec" data-a="wait" data-id="${b.id}">Wait</button>`}
      <button class="btn sec" data-a="skip" data-id="${b.id}">Skip</button>
      ${canNoShow(b) ? `<button class="btn red" data-a="no-show" data-id="${b.id}">No-show</button>` : ''}
    </div>`;
}
async function barberUpcoming() {
  const r = await api('/barber/bookings');
  const groups = {};
  r.bookings.forEach((b) => (groups[b.date] = groups[b.date] || []).push(b));
  app.innerHTML = `<h1>Upcoming</h1>${Object.keys(groups).sort().map((d) => `<h2>${dateLabel(d)}</h2>${clist(groups[d].map((b) => crowA({ t: cav(b.customer) + esc(b.customer.name), p: statusBadge(b.status) + payBadge(b), m: `${esc(b.start_label)} · ${esc(b.service_name)}`, r: naira(b.price_kobo) }, '#/b/' + b.id)))}`).join('') || '<p class="muted">No upcoming bookings.</p>'}`;
  startPoll(barberUpcoming);
}
const ACTION_LABEL = { BOOKED: 'Booked', PAYMENT_CONFIRMED: 'Payment confirmed', CHECKED_IN: 'Customer checked in ("I\'m Here")', MARKED_PRESENT: 'Barber marked present', STARTED: 'Service started', COMPLETED: 'Service completed', CANCELLED: 'Cancelled', NO_SHOW: 'Marked no-show', NOT_SERVED: 'Marked not served', PAYMENT_RECORDED: 'Payment recorded', SKIPPED: 'Skipped (moved back in line)', WAITING_FOR_CUSTOMER: 'Barber is waiting for the customer', HOLD_EXPIRED: 'Payment time ran out', CREDIT_ISSUED: 'Session credit given (no refund)', PAYMENT_SLOT_TAKEN: 'Payment came after someone took the time', LATE_PAYMENT: 'Late payment marked', DUPLICATE_PAYMENT: 'Double payment marked' };
async function barberBooking(id) {
  const { booking: b, timeline } = await api('/barber/bookings/' + id);
  const hp = b.help;
  const helpCard = hp ? `<div class="warn notice" id="helpcard" role="alert">${ic('warn')}<div><b>Urgent: this customer needs help.</b><div style="margin:4px 0">“${esc(hp.note)}”</div>${hp.escalated ? '<div class="small">You have not answered for a while, so the TrimSlot team was told.</div>' : ''}${contactBtns(b.customer)}
      <div class="btns" style="margin-top:8px"><button class="btn sm" id="helprel">OK, release it</button><button class="btn sm sec" id="helplater">Come later</button></div>
      <div class="small muted" style="margin-top:6px">“Release it” marks the booking as not served: a paid online booking is refunded, and a plan session or credit goes back. “Come later” tells the customer you will wait.</div></div></div>` : '';
  app.innerHTML = `<a href="#/today" class="back" id="goback">${ic('back', 'sm')} Back</a>${helpCard}
    <div class="card"><div class="row between"><h1 style="margin:0;font-size:20px;display:flex;align-items:center;gap:10px">${cav(b.customer, 'lg')}${esc(b.customer.name)}</h1>${statusBadge(b.status)}</div>
      <div class="muted small">${esc(b.customer.phone || '')} ${esc(b.customer.email || '')}</div>${contactBtns(b.customer)}<hr>
      <div class="row between"><b>${esc(b.service_name)}</b><b>${naira(b.price_kobo)}</b></div>
      <div class="small muted">${dateLabel(b.date)} · ${esc(b.start_label)} · ${b.duration_min} min</div>${barberMoney(b)}<div style="margin-top:6px">${payBadge(b)} <span class="small muted">${b.paid_via ? 'via ' + esc(b.paid_via) : ''}</span></div>
      ${b.payment_option === 'PLAN' ? `<div class="small" style="margin-top:6px">${ic('ticket', 'sm')} The customer used a <b>plan session</b>. Nothing to collect.</div>` : b.payment_option === 'CREDIT' ? `<div class="small" style="margin-top:6px">${ic('ticket', 'sm')} The customer used a <b>session credit</b>. Nothing to collect.</div>` : ''}
      ${b.payment_status === 'CREDITED' ? `<div class="small muted" style="margin-top:6px">The customer missed a paid session. They got one credit with you. No refund.</div>` : ''}
      ${['REFUND_PENDING', 'REFUNDED'].includes(b.payment_status) ? `<div class="small muted" style="margin-top:6px">The paid session did not happen, or it was cancelled in time. The customer gets a refund. No credit.</div>` : ''}
      <hr><div class="small">Scheduled: <b>${lagosTime(b.scheduled_time)}</b> · Arrived: <b>${lagosTime(b.arrival_time)}</b> · Started: <b>${lagosTime(b.service_start)}</b> · Completed: <b>${lagosTime(b.service_complete)}</b></div>
      ${relBadge(b.customer.reliability)}${b.note_to_barber ? `<div class="cnote small" style="margin-top:8px">${ic('pencil', 'sm')} <b>Customer note:</b> ${esc(b.note_to_barber)}</div>` : ''}${b.customer.note ? `<div class="cnote priv small" style="margin-top:8px">${ic('shield', 'sm')} <b>Your private note:</b> ${esc(b.customer.note)}</div>` : ''}${b.customer.usual ? `<div class="small muted" style="margin-top:6px">Usual: ${esc(b.customer.usual.service_name)} (${b.customer.usual.times}×)</div>` : ''}
      <a class="small" href="#/customers/${b.customer.id}">View customer profile ›</a></div>
    ${canNoShow(b) ? `<div class="btns" style="margin-top:12px"><button class="btn sm red" id="noshow">No-show</button></div><div class="small muted" style="margin-top:6px">Use this if the customer has not come. A plan session or credit goes back to them.</div>` : ''}
    <div class="btns" style="margin-top:12px"><button class="btn sm sec" data-report="${b.id}">${ic('warn', 'sm')} Report a problem</button></div>
    <h2>Timeline</h2><div class="card"><div class="tl">${timeline.map((t) => `<div><b>${esc(ACTION_LABEL[t.action] || t.action)}</b><div class="small muted">${lagosStamp(t.created_at)} · ${esc(t.actor_role)}${t.actor_name ? ' (' + esc(t.actor_name) + ')' : ''}</div>${t.details && t.details.note ? `<div class="small warn-t">${esc(String(t.details.note).replace(/^TODO\(owner\):.*$/, 'Not refunded yet. The shop or admin will give a refund or a session credit.'))}</div>` : ''}</div>`).join('')}</div></div>`;
  const helpAct = (sel, action, ask, done) => { const el = $(sel); if (el) el.onclick = async () => { if (ask && !confirm(ask)) return; el.disabled = true; try { await api(`/barber/bookings/${id}/${action}`, { method: 'POST', body: action === 'not-served' ? { reason: 'Customer asked for help; barber released it' } : {} }); toast(done); route(); } catch (e) { fail(e); el.disabled = false; } }; };
  helpAct('#helprel', 'not-served', 'Release this booking? It will be marked as not served.', 'Booking released');
  helpAct('#helplater', 'wait', null, 'We told the customer you will wait');
  const nsBtn = $('#noshow');
  if (nsBtn) nsBtn.onclick = async () => { if (!confirm('Mark as no-show? The customer did not arrive.')) return; nsBtn.disabled = true; try { await api(`/barber/bookings/${id}/no-show`, { method: 'POST', body: {} }); await barberBooking(id); } catch (e) { fail(e); nsBtn.disabled = false; } };
}

/* ---------- barber: customers ---------- */
async function customerList() {
  app.innerHTML = `<h1>Customers</h1><input id="q" type="search" placeholder="Search name, phone or email" autocomplete="off"><div id="list" style="margin-top:10px"></div>`;
  const load = async () => {
    const r = await api('/barber/customers?q=' + encodeURIComponent($('#q').value));
    $('#list').innerHTML = (r.customers.length ? clist(r.customers.map((c) => crowA({ t: cav(c) + esc(c.name), m: esc([c.phone || c.email, c.last_visit ? 'last ' + dateLabel(c.last_visit) : 'no visits yet'].filter(Boolean).join(' · ')), r: c.total_visits + ' visit' + (c.total_visits === 1 ? '' : 's') }, '#/customers/' + c.id))) : '') || '<p class="muted center">No customers found.</p>';
  };
  let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(load, 200); };
  load();
}
async function customerProfile(id) {
  const r = await api('/barber/customers/' + id);
  const c = r.customer;
  app.innerHTML = `<a href="#/customers" class="back">${ic('back', 'sm')} Customers</a><div class="card"><h1 style="margin:0;display:flex;align-items:center;gap:10px">${cav(c, 'lg')}${esc(c.name)}</h1><div class="muted">${esc(c.phone || '')} ${esc(c.email || '')}</div><hr>
    <div class="row between center"><div class="grow"><div style="font-size:26px;font-weight:800">${c.total_visits}</div><div class="small muted">Visits</div></div><div class="grow"><div style="font-size:16px;font-weight:800;padding:5px 0">${c.last_visit ? dateLabel(c.last_visit) : '—'}</div><div class="small muted">Last visit</div></div><div class="grow"><div style="font-size:16px;font-weight:800;padding:5px 0">${naira(c.total_spent_kobo)}</div><div class="small muted">Spent</div></div></div>
    ${c.no_shows ? `<div class="small" style="color:var(--red);margin-top:8px">${c.no_shows} no-show${c.no_shows > 1 ? 's' : ''}</div>` : ''}</div>
    ${r.insights && r.insights.reliability ? `<div style="margin-top:8px">${relBadge(r.insights.reliability)} <span class="small muted">${r.insights.reliability.completed} completed · ${r.insights.reliability.no_shows} no-show${r.insights.reliability.no_shows === 1 ? '' : 's'}</span></div>` : ''}
    ${r.insights && r.insights.note !== undefined ? `<h2>Private notes</h2><div class="card"><div class="small muted" style="margin-bottom:6px">${ic('shield', 'sm')} Only you can see this. ${r.insights.usual ? `Usual: <b>${esc(r.insights.usual.service_name)}</b> (${r.insights.usual.times}×).` : ''}</div><textarea id="cnote" rows="3" maxlength="1000" placeholder="Style, likes, allergies…">${esc(r.insights.note)}</textarea><div class="btns"><button class="btn sm" id="cnotesave">Save note</button></div></div>` : ''}
    <h2>Booking history</h2>${r.bookings.map((b) => `<a class="card row between" style="color:inherit" href="#/b/${b.id}"><div><b>${esc(b.service_name)}</b><div class="small muted">${dateLabel(b.date)} · ${esc(b.start_label)} · ${naira(b.price_kobo)}</div></div>${statusBadge(b.status)}</a>`).join('')}`;
  const sv = $('#cnotesave'); if (sv) sv.onclick = async () => { sv.disabled = true; try { await api(`/barber/customers/${id}/note`, { method: 'PUT', body: { note: $('#cnote').value } }); toast('Note saved'); } catch (e) { fail(e); } sv.disabled = false; };
}

/* ---------- barber: reviews ---------- */
async function barberReviews() {
  const r = await api('/barber/reviews');
  app.innerHTML = `<a href="#/profile" class="back">${ic('back', 'sm')} Profile</a><h1>Reviews</h1>${r.summary.count ? `<div class="card row between"><div><div style="font-size:30px;font-weight:800">${r.summary.average.toFixed(1)}</div>${stars(r.summary.average)}</div><div class="muted small">${r.summary.count} review${r.summary.count === 1 ? '' : 's'}</div></div>` : ''}
    ${r.reviews.length ? r.reviews.map((x) => `<div class="card review"><div class="row between">${stars(x.rating)}<span class="small muted">${esc(x.customer_name)} · ${dateLabel(x.created_at.slice(0, 10))}</span></div>${x.comment ? `<p style="margin:8px 0 0">${esc(x.comment)}</p>` : ''}
      ${x.reply ? `<div class="reply small"><b>Your reply</b><div>${esc(x.reply)}</div></div>` : `<div class="replyform"><input data-rt="${x.id}" maxlength="500" placeholder="Write a public reply…"><button class="btn sm" data-reply="${x.id}">Reply</button></div>`}</div>`).join('') : `<div class="empty">${ic('star')}<b>No reviews yet</b><span class="small muted">Customers can rate you after a completed visit.</span></div>`}`;
  document.querySelectorAll('[data-reply]').forEach((el) => el.onclick = async () => { const id = el.dataset.reply; el.disabled = true; try { await api(`/barber/reviews/${id}/reply`, { method: 'POST', body: { reply: $(`[data-rt="${id}"]`).value } }); toast('Reply posted'); barberReviews(); } catch (e) { fail(e); el.disabled = false; } });
}

/* ---------- barber: settings ---------- */
/** Client-side downscale: longest side <= 1024px, JPEG, shrunk until it fits the server's 300 KB cap. */
async function compressImage(file) {
  const bmp = (await window.ImgDecode.load(file, { maxSide: 1024 })).canvas;
  const w0 = bmp.width, h0 = bmp.height;
  let scale = Math.min(1, 1024 / Math.max(w0, h0)), q = 0.85;
  for (let attempt = 0; attempt < 8; attempt++) {
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w0 * scale)); c.height = Math.max(1, Math.round(h0 * scale));
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', q));
    if (blob && blob.size <= 280 * 1024) return blob;
    if (q > 0.55) q -= 0.1; else scale *= 0.8;
  }
  throw userError('That photo is too big. Try a different one.');
}
async function uploadPhoto(file) {
  const blob = await compressImage(file);
  const r = await fetch('/api/barber/photo', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw userError(j.error?.message || 'The upload did not work');
  return j.photo_url;
}
/** A confirmation sheet listing bookings that a change would strand. Resolves true when the barber confirms. */
function confirmSheet(e) {
  return new Promise((resolve) => {
    const d = e.details || { count: 0, bookings: [] };
    const el = document.createElement('div'); el.className = 'scrim';
    el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="notice"><div class="logo" style="background:var(--accent)">${ic('warn')}</div><div><h3 style="margin:0">This affects ${d.count} booking${d.count === 1 ? '' : 's'}</h3>
      <p class="muted small" style="margin:4px 0 0">We will tell these customers. Nothing is cancelled for them. They can keep the booking, book again, or cancel.</p></div></div>
      <ul>${(d.bookings || []).map((b) => `<li>${esc(b.when)} · ${esc(b.service_name)}</li>`).join('')}${d.count > (d.bookings || []).length ? `<li>…and ${d.count - d.bookings.length} more</li>` : ''}</ul>
      <div class="btns cta"><button class="btn sec" id="sh-no">Go back</button><button class="btn amber" id="sh-yes">Save and tell them</button></div></div>`;
    document.body.appendChild(el);
    const done = (v) => { el.remove(); resolve(v); };
    el.querySelector('#sh-no').onclick = () => done(false); el.querySelector('#sh-yes').onclick = () => done(true);
    el.onclick = (ev) => { if (ev.target === el) done(false); };
  });
}
/** Run a save that may answer 409 AVAILABILITY_CONFLICT: ask for confirmation, then retry with confirm:true. */
async function withConfirm(doSave) {
  try { return await doSave(false); } catch (e) {
    if (e.code !== 'AVAILABILITY_CONFLICT') throw e;
    if (!(await confirmSheet(e))) throw userError('Not saved. Nothing changed.');
    return await doSave(true);
  }
}
const readSchedule = (root) => [...root.querySelectorAll('.dayrow')].map((r) => ({ weekday: Number(r.dataset.wd), is_working: $('.w', r).checked, start: $('.s', r).value || '09:00', end: $('.e', r).value || '18:00', break_start: $('.bs', r).value || null, break_end: $('.be', r).value || null }));
const scheduleRows = (sched) => sched.map((d) => `<div class="dayrow ${d.is_working ? '' : 'off'}" data-wd="${d.weekday}"><label class="check"><input type="checkbox" class="w" ${d.is_working ? 'checked' : ''}> ${DAYFULL[d.weekday]}</label>
      <div class="times"><div><span class="small muted">Opens</span><input type="time" class="s" value="${d.start}"></div><div><span class="small muted">Closes</span><input type="time" class="e" value="${d.end}"></div>
      <div><span class="small muted">Break from</span><input type="time" class="bs" value="${d.break_start || ''}"></div><div><span class="small muted">Break to</span><input type="time" class="be" value="${d.break_end || ''}"></div></div></div>`).join('');
const wireDayRows = (root) => root.querySelectorAll('.dayrow .w').forEach((c) => c.onchange = () => c.closest('.dayrow').classList.toggle('off', !c.checked));
const photoBlock = (p) => `<div class="photo-up">${avatar({ photo_url: p.photo_url, shop_name: p.shop_name }, 'lg', true)}<div class="grow"><div class="btns">
    <label class="btn sec sm" style="margin:0;cursor:pointer">${ic('camera', 'sm')} Take photo<input id="ph-cam" type="file" accept="image/*" capture="environment"></label>
    <label class="btn sec sm" style="margin:0;cursor:pointer">${ic('image', 'sm')} Choose<input id="ph-file" type="file" accept="image/*"></label></div>
    <div class="small muted" style="margin-top:6px" id="ph-msg">${p.photo_url ? 'Tap to change your shop photo.' : 'Add a photo so customers know your shop.'}</div></div></div>`;
function wirePhoto(p, onDone) {
  const go1 = async (f) => { if (!f) return; const m = $('#ph-msg'); m.textContent = 'Making it smaller and uploading…'; try { p.photo_url = await uploadPhoto(f); toast('Photo saved'); onDone && onDone(); } catch (e) { m.textContent = userMessage(e); fail(e); } };
  ['#ph-cam', '#ph-file'].forEach((sel) => { const el = $(sel); if (el) el.onchange = () => go1(el.files[0]); });
}
const svcLine = (s) => `<div class="svcline" data-id="${s.id}"><div><b>${esc(s.name)}</b><div class="small muted">${s.duration_min} min · ${naira(s.price_kobo)}</div></div>
  <div class="row" style="gap:6px"><button class="mini ed" aria-label="Edit">${ic('pencil', 'sm')}</button><button class="mini red del" aria-label="Remove">${ic('trash', 'sm')}</button></div>
  <form class="svcedit svcf" style="grid-column:1/-1"><div class="row wrap"><input name="name" value="${esc(s.name)}" style="flex:2 1 140px"><input name="price_naira" type="number" min="0" step="50" value="${s.price_kobo / 100}" style="flex:1 1 80px" aria-label="Price ₦"><input name="duration_min" type="number" min="5" step="5" value="${s.duration_min}" style="flex:1 1 70px" aria-label="Minutes"></div>
  <div class="btns" style="margin-top:8px"><button class="btn sm">Save</button></div></form></div>`;
const addSvcForm = () => `<form id="addsvc"><div class="row wrap"><input name="name" placeholder="e.g. Fade" style="flex:2 1 140px" required><input name="price_naira" type="number" min="0" step="50" placeholder="Price in ₦" style="flex:1 1 80px" required><input name="duration_min" type="number" min="5" step="5" placeholder="Minutes" style="flex:1 1 70px" required></div><div style="height:8px"></div><button class="btn sec sm">${ic('plus', 'sm')} Add service</button></form>`;
const planForm = (id, pl, services, limits) => `<form class="planf" ${id ? `data-id="${id}"` : 'id="addplan"'}>
  <label>Plan name</label><input name="name" value="${esc(pl ? pl.name : '')}" placeholder="e.g. Monthly 4 cuts" required>
  <div class="row wrap" style="gap:8px"><div style="flex:1 1 90px"><label>Price ₦</label><input name="price_naira" type="number" min="0" step="50" value="${pl ? pl.price_kobo / 100 : ''}" required></div>
  <div style="flex:1 1 80px"><label>Sessions</label><input name="sessions" type="number" min="1" max="${limits.max_sessions}" value="${pl ? pl.sessions : ''}" required></div>
  <div style="flex:1 1 80px"><label>Valid (days)</label><input name="validity_days" type="number" min="1" max="${limits.max_validity_days}" value="${pl ? pl.validity_days : ''}" required></div></div>
  <label>Included services</label><div class="small muted" style="margin:-2px 0 6px">A plan session can only book the services you tick here.</div>${services.map((s) => `<label class="chk"><input type="checkbox" name="svc" value="${s.id}" ${pl && (pl.service_ids || []).includes(s.id) ? 'checked' : ''}> ${esc(s.name)} <span class="muted small">${naira(s.price_kobo)}</span></label>`).join('') || '<p class="small muted">Add a service first.</p>'}
  ${pl && pl.active && pl.approval_status === 'APPROVED' && limits.approval_required ? '<div class="warn small" style="margin:8px 0">Saving changes hides this plan from customers until TrimSlot approves the new version. People who already bought it keep their sessions and the old terms.</div>' : ''}
  <div class="btns" style="margin-top:10px"><button class="btn sm ${id ? '' : 'sec'}">${id ? 'Save plan' : ic('plus', 'sm') + ' Create plan'}</button></div></form>`;
function plansBody(po, services) {
  const L = po.limits;
  const F = state.cfg.features || {};
  const plans = po.plans || [], purchases = po.purchases || [], credits = po.credits || [];
  const offNote = (F.plans === false ? '<div class="warn small" style="margin:10px 0">Plans are turned off by TrimSlot right now. Customers cannot buy a plan or use a plan session. Your plans are saved and show again when plans are back on.</div>' : '')
    + (F.credits === false ? '<div class="warn small" style="margin:10px 0">Session credits are turned off by TrimSlot right now. Customers cannot use a credit. Credits they have are kept, and their end dates do not change.</div>' : '');
  const planStatus = (pl) => {
    if (pl.approval_status === 'PENDING') return ['b-amber', 'PENDING APPROVAL', 'Hidden from customers until TrimSlot approves it. People who already bought it keep using it.'];
    if (pl.approval_status === 'REJECTED') return ['b-red', 'CHANGES NEEDED', 'Not live — update the plan and save it to send it for review again.'];
    if (!pl.active) return ['b-gray', 'HIDDEN', 'Not live — new customers cannot buy it. Existing purchases continue.'];
    return ['b-green', 'LIVE', 'Customers can see and buy this plan.'];
  };
  const list = plans.map((pl) => {
    const [statusClass, statusLabel, statusHelp] = planStatus(pl);
    const buyers = Number(pl.buyers) || 0;
    const perSession = naira(Math.floor(pl.price_kobo / pl.sessions));
    return `<div class="svcline plnline plan-offer-card" data-id="${pl.id}">
      <div class="plan-offer-main"><div class="plan-offer-info"><h3>${esc(pl.name)}</h3><div class="small muted">${naira(pl.price_kobo)} · ${pl.sessions} sessions · ${pl.validity_days} days</div>
          <div class="small muted">Includes ${esc(svcNames(pl.service_ids, services) || 'no services')}</div></div>
        <div class="plan-offer-status"><span class="badge ${statusClass}">${statusLabel}</span><div class="plan-offer-buyers"><b>${buyers}</b><span>purchase${buyers === 1 ? '' : 's'}</span></div></div>
        <div class="plan-offer-actions"><button class="btn sm plan-manage" type="button" aria-controls="plan-stats-${pl.id}" aria-expanded="false">Manage</button><button class="btn sm sec ed" type="button" aria-controls="plan-edit-${pl.id}" aria-expanded="false" aria-label="Edit ${esc(pl.name)}">Edit</button></div></div>
      ${statusLabel !== 'LIVE' ? `<p class="plan-status-help small muted">${statusHelp}</p>` : ''}
      ${pl.approval_reason ? `<div class="warn small notice plan-card-warning" style="margin:8px 0">${ic('warn', 'sm')}<div><b>Admin note:</b> ${esc(pl.approval_reason)}</div></div>` : ''}
      ${pl.needs_review ? `<div class="warn small notice plan-card-warning" style="margin:8px 0">${ic('warn', 'sm')}<div><b>Please check this plan.</b> We linked it to your services that cost no more than ${naira(Math.floor(pl.price_kobo / pl.sessions))} each. Tap edit, check the list, then save.</div></div>` : ''}
      <details class="plan-stats" id="plan-stats-${pl.id}"><summary>Performance details</summary><div class="plan-stats-body"><div>${buyers} buyer${buyers === 1 ? '' : 's'} · ${pl.sessions_used} session${pl.sessions_used === 1 ? '' : 's'} used · ${naira(pl.revenue_kobo)} sold · ${perSession} per session</div>${pl.active ? `<div class="plan-stats-actions"><button class="btn sm sec del" type="button" aria-label="Stop selling ${esc(pl.name)}">Stop selling</button></div>` : ''}</div></details>
      <div class="svcedit" id="plan-edit-${pl.id}">${planForm(pl.id, pl, services, L)}</div></div>`;
  }).join('') || '<p class="muted small">No plans yet. Create one when you are ready to offer session packs.</p>';
  const purchaseRows = purchases.slice(0, 15).map((x) => {
    const left = Math.max(0, x.sessions_total - x.sessions_used);
    const refund = x.live ? refundBox(x, 'BARBER') : '';
    const status = x.live ? 'ACTIVE' : 'ENDED';
    const label = `${x.customer_name}, ${x.plan_name}, ${left} of ${x.sessions_total} sessions left, ${status}`;
    return `<details class="barber-compact-row" id="barber-purchase-${x.id}"><summary class="barber-compact-summary" aria-label="${esc(label)}">
      <span class="barber-compact-title" title="${esc(`${x.customer_name} · ${x.plan_name}`)}"><b>${esc(x.customer_name)}</b><i aria-hidden="true">·</i><span>${esc(x.plan_name)}</span></span>
      <b class="barber-compact-count" aria-label="${left} of ${x.sessions_total} sessions left">${left}/${x.sessions_total}</b><span class="badge ${x.live ? 'b-green' : 'b-gray'}">${status}</span>
      </summary><div class="barber-compact-details"><div class="barber-compact-detail-grid">
        <div><span>Plan</span><b>${esc(x.plan_name)}</b></div><div><span>Sessions left</span><b>${left} of ${x.sessions_total}</b></div>
        <div><span>Sessions used</span><b>${x.sessions_used} of ${x.sessions_total}</b></div><div><span>Price paid</span><b>${naira(x.price_kobo)}</b></div>
        <div><span>Paid</span><b>${x.paid_at ? expTxt(x.paid_at) : '—'}</b></div><div><span>Expires</span><b>${expTxt(x.expires_at)}</b></div>
      </div>${refund ? `<details class="refund-disclosure"><summary>Refund options</summary>${refund}</details>` : ''}</div></details>`;
  }).join('');
  const creditRows = credits.slice(0, 15).map((x) => {
    const reason = x.reason === 'NO_SHOW' ? 'No-show' : x.reason === 'LOYALTY' ? 'Loyalty credit' : x.reason === 'ADMIN_GRANT' ? 'Added by TrimSlot' : 'Missed session';
    const status = x.status === 'USED' ? 'USED' : x.live ? 'AVAILABLE' : 'EXPIRED';
    const until = x.status === 'USED' ? 'Used' : expTxt(x.expires_at);
    const label = `${x.customer_name}, ${reason}, one session credit, ${status}`;
    return `<details class="barber-compact-row" id="barber-credit-${x.id}"><summary class="barber-compact-summary" aria-label="${esc(label)}">
      <span class="barber-compact-title" title="${esc(`${x.customer_name} · ${reason}`)}"><b>${esc(x.customer_name)}</b><i aria-hidden="true">·</i><span>${esc(reason)}</span></span>
      <b class="barber-compact-count" aria-label="One session credit">1 session</b><span class="badge ${x.status === 'USED' || !x.live ? 'b-gray' : 'b-green'}">${status}</span>
      </summary><div class="barber-compact-details"><div class="barber-compact-detail-grid">
        <div><span>Customer</span><b>${esc(x.customer_name)}</b></div><div><span>Reason</span><b>${esc(reason)}</b></div>
        <div><span>Credit value</span><b>${naira(x.value_kobo)}</b></div><div><span>Status</span><b>${status}</b></div>
        <div><span>Valid until</span><b>${until}</b></div>
      </div></div></details>`;
  }).join('');
  const buyersContent = purchaseRows ? `<div class="barber-compact-list">${purchaseRows}</div>${purchases.length > 15 ? '<p class="small muted">Showing the latest 15 purchases.</p>' : ''}` : '<p class="muted small">No customers have bought a plan yet.</p>';
  const creditsContent = creditRows ? `<div class="barber-compact-list">${creditRows}</div>${credits.length > 15 ? '<p class="small muted">Showing the latest 15 credits.</p>' : ''}` : '<p class="muted small">No session credits have been issued.</p>';
  const rules = `Plan sessions are valid for the number of days shown. Customers keep the terms they bought if you later edit a plan. When a customer misses a paid session, they receive one credit with you; it covers the same service or a service at the same price, expires after ${L.credit_expiry_days} days, and cannot be cashed out. A missed plan session returns to the plan and does not extend its end date. Refunds for part-used plans go through TrimSlot review, then require the other party's agreement.`;
  return `${offNote}
    <details class="plan-section" id="barber-offers" open><summary><span>Plans you offer</span><span class="plan-section-count">${plans.length} plan${plans.length === 1 ? '' : 's'}</span></summary><div class="plan-section-body">${list}</div></details>
    <details class="plan-disclosure" id="barber-create"><summary><span class="plan-add-label">${ic('plus', 'sm')} Add a plan</span><span class="small muted">Price · sessions · services</span></summary><div class="plan-disclosure-body">${planForm(null, null, services, L)}</div></details>
    <details class="plan-section" id="barber-purchases"><summary><span>Customer purchases</span><span class="plan-section-count">${purchases.length}</span></summary><div class="plan-section-body">${buyersContent}</div></details>
    <details class="plan-section" id="barber-credits"><summary><span>Session credits</span><span class="plan-section-count">${credits.length}</span></summary><div class="plan-section-body">${creditsContent}</div></details>
    <details class="plan-disclosure" id="barber-rules"><summary><span>Rules &amp; refunds</span><span class="small muted">Plan terms</span></summary><div class="plan-disclosure-body"><p class="plan-rule-copy">${rules}</p><p class="plan-rule-copy">Plan limits: price ${naira(L.min_price_kobo)}–${naira(L.max_price_kobo)}, up to ${L.max_sessions} sessions, and up to ${L.max_validity_days} days.</p></div></details>`;
}

function wirePlans(po, guard) {
  if (!po) return;
  const body = (f) => { const fd = new FormData(f); return { name: fd.get('name'), price_naira: fd.get('price_naira'), sessions: fd.get('sessions'), validity_days: fd.get('validity_days'), service_ids: fd.getAll('svc').map(Number) }; };
  const add = $('#addplan'); if (add) add.onsubmit = guard(() => api('/barber/plans', { method: 'POST', body: body(add) }), 'Plan created');
  document.querySelectorAll('.plnline .planf').forEach((f) => {
    const l = f.closest('.svcline');
    const edit = l.querySelector('.ed');
    edit.onclick = () => { const open = l.classList.toggle('editing'); edit.setAttribute('aria-expanded', String(open)); };
    const manage = l.querySelector('.plan-manage'), stats = l.querySelector('.plan-stats');
    if (manage && stats) {
      const syncManage = () => manage.setAttribute('aria-expanded', String(stats.open));
      manage.onclick = () => { stats.open = !stats.open; syncManage(); };
      stats.addEventListener('toggle', syncManage);
      syncManage();
    }
    f.onsubmit = guard(() => api('/barber/plans/' + f.dataset.id, { method: 'PUT', body: body(f) }), 'Plan saved');
    const del = l.querySelector('.del');
    if (del) del.onclick = guard(async () => { if (!confirm('Stop selling this plan? People who already bought it keep their sessions.')) throw userError('Cancelled'); await api('/barber/plans/' + f.dataset.id, { method: 'DELETE' }); }, 'Plan is no longer for sale');
  });
}
const acc = (id, icon, title, sub, body) => `<details class="acc" data-k="${id}" ${state.open.has(id) ? 'open' : ''}><summary><span class="ico">${ic(icon)}</span><span>${title}<span class="sub">${sub}</span></span><span class="chev">${ic('chev')}</span></summary><div class="body">${body}</div></details>`;

async function settings() {
  const [r, shr] = await Promise.all([api('/barber/profile'), api('/barber/share').catch(() => null)]); const po = null;
  const p = r.profile;
  const needsSetup = state.setup ? !state.setup.done : r.services.length === 0; // once started, stay in the flow until "Finish setup"
  if (needsSetup) return setupFlow(r);
  const activeDays = r.schedule.filter((d) => d.is_working);
  const hoursSub = activeDays.length ? `${activeDays.length} days · ${t12(activeDays[0].start)}–${t12(activeDays[0].end)}` : 'No working days';
  app.innerHTML = `${pendingBanner()}${payoutBanner()}<a href="#/profile" class="back">${ic('back', 'sm')} Profile</a><h1>Shop settings</h1><p class="muted">Shop details, services and opening hours.</p><div id="msg"></div>
    ${shr ? `<h2 id="shareh">Share your shop</h2>${shareCardHtml({ id: 'sharecard', qr: shr.qr_url, name: p.shop_name, title: 'Your private shop link', hint: 'Customers only find your shop through this link or QR code. Send it to the people you want to book you.', url: shr.url, extra: '<button class="btn sm sec" type="button" id="regen">Make a new link</button>' })}${shr.active ? '' : `<div class="warn small notice" style="margin-top:10px">${ic('warn', 'sm')}<div>The link starts working when TrimSlot approves your shop.</div></div>`}` : ''}
    ${acc('profile', 'store', 'Shop profile', 'Name, photo, location, about', `<form id="pf">${photoBlock(p)}
      <label>Your name</label><input name="name" value="${esc(state.user.name)}"><label>Shop name</label><input name="shop_name" value="${esc(p.shop_name)}">
      <label>Location</label><input name="location" value="${esc(p.location || '')}"><label>About</label><textarea name="about" rows="3">${esc(p.about || '')}</textarea>
      <div class="btns cta"><button class="btn">Save profile</button></div></form>`)}
    ${acc('services', 'tag', 'Services', `${r.services.length} service${r.services.length === 1 ? '' : 's'}`, `<p class="small muted" style="margin:10px 0 0">A new price only counts for future bookings.</p>${r.services.map(svcLine).join('')}<h3 style="margin-top:14px">Add a service</h3>${addSvcForm()}`)}
    ${acc('hours', 'clock', 'Weekly hours', hoursSub, `<p class="small muted" style="margin:10px 0">Leave the break empty if you have no break. If a change affects bookings you already have, we ask you to confirm. Then we tell those customers.</p><div class="days-grid">${scheduleRows(r.schedule)}</div><div class="btns cta"><button class="btn" id="savesch">Save hours</button></div>`)}
    ${acc('off', 'cal', 'Days off', r.days_off.length ? `${r.days_off.length} upcoming` : 'Nothing coming up', `${r.days_off.map((d) => `<div class="row between" style="margin:8px 0"><span>${dateLabel(d.date)}${d.reason ? ' · <span class="muted">' + esc(d.reason) + '</span>' : ''}</span><button class="mini red" data-rm="${d.id}" aria-label="Remove">${ic('off', 'sm')}</button></div>`).join('') || '<p class="muted small">Nothing coming up.</p>'}
      <form id="off"><div class="row"><input type="date" name="date" required min="${state.cfg.today}"><input name="reason" placeholder="Reason (optional)"></div><div style="height:8px"></div><button class="btn sec sm">${ic('plus', 'sm')} Add day off</button></form>`)}`;
  document.querySelectorAll('.acc').forEach((d) => d.addEventListener('toggle', () => { d.open ? state.open.add(d.dataset.k) : state.open.delete(d.dataset.k); }));
  const msg = (t, bad) => { const m = $('#msg'); if (m) m.innerHTML = `<div class="${bad ? 'err' : 'ok'}">${esc(t)}</div>`; window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const refreshMe = async () => { const me = await api('/auth/me'); state.user = me.user; };
  const guard = (fn, okmsg) => async (ev) => { ev && ev.preventDefault && ev.preventDefault(); try { const out = await fn(ev); await refreshMe(); const extra = out && out.notified_bookings ? ` We told ${out.notified_bookings} customer${out.notified_bookings === 1 ? '' : 's'}.` : ''; await settings(); msg(okmsg + extra); } catch (e) { msg(userMessage(e), true); } };
  if (shr) {
    wireShareCard($('#sharecard'), shr.url, p.shop_name);
    $('#regen').onclick = async () => { if (!confirm('Make a new link? The old link and QR code stop working at once. Customers who already added you keep you in My barbers.')) return; const b = $('#regen'); b.disabled = true; try { await api('/barber/share/regenerate', { method: 'POST', body: {} }); toast('New link ready. Share the new QR code.'); settings(); } catch (e) { fail(e); b.disabled = false; } };
  }
  wirePhoto(p, () => settings());
  wireDayRows(app);
  $('#pf').onsubmit = guard(() => api('/barber/profile', { method: 'PUT', body: Object.fromEntries(new FormData($('#pf'))) }), 'Profile saved');
  document.querySelectorAll('.svcline:not(.plnline)').forEach((l) => {
    l.querySelector('.ed').onclick = () => l.classList.toggle('editing');
    l.querySelector('.svcf').onsubmit = guard(() => api('/barber/services/' + l.dataset.id, { method: 'PUT', body: Object.fromEntries(new FormData(l.querySelector('.svcf'))) }), 'Service saved');
    l.querySelector('.del').onclick = guard(async () => { if (!confirm('Remove this service? Bookings you already have stay.')) throw userError('Cancelled'); await api('/barber/services/' + l.dataset.id, { method: 'DELETE' }); }, 'Service removed');
  });
  $('#addsvc').onsubmit = guard(() => api('/barber/services', { method: 'POST', body: Object.fromEntries(new FormData($('#addsvc'))) }), 'Service added');
  $('#savesch').onclick = guard(() => withConfirm((confirmed) => api('/barber/schedule', { method: 'PUT', body: { days: readSchedule(app), ...(confirmed ? { confirm: true } : {}) } })), 'Hours saved.');
  $('#off').onsubmit = guard(() => withConfirm((confirmed) => api('/barber/days-off', { method: 'POST', body: { ...Object.fromEntries(new FormData($('#off'))), ...(confirmed ? { confirm: true } : {}) } })), 'Day off added.');
  document.querySelectorAll('[data-rm]').forEach((b) => b.onclick = guard(() => api('/barber/days-off/' + b.dataset.rm, { method: 'DELETE' }), 'Day off removed'));
}

/** First-time setup: three slim steps (shop → services → hours), then it collapses into the compact settings above. */
function setupFlow(r) {
  const st = state.setup = state.setup || { step: 1, done: false };
  const p = r.profile;
  const dots = `<div class="dots">${[1, 2, 3].map((i) => `<i class="${i <= st.step ? 'on' : ''}"></i>`).join('')}</div>`;
  const head = (t, sub) => `${pendingBanner()}<div class="setup-head"><div class="logo">${ic(st.step === 1 ? 'store' : st.step === 2 ? 'tag' : 'clock')}</div><div><div class="small muted">Step ${st.step} of 3</div><h1 style="margin:0;font-size:21px">${t}</h1></div></div>${dots}<p class="muted small" style="margin:0 0 4px">${sub}</p><div id="msg"></div>`;
  const err = (e) => { const m = $('#msg'); if (m) m.innerHTML = `<div class="err">${esc(userMessage(e))}</div>`; };
  if (st.step === 1) {
    app.innerHTML = `${head('Your shop', 'Just the basics. You can change it all later.')}<div class="card setup-card"><form id="pf">${photoBlock(p)}
      <label>Shop name</label><input name="shop_name" value="${esc(p.shop_name)}" required><label>Location</label><input name="location" value="${esc(p.location || '')}" placeholder="Street, area, city">
      <label>About (optional)</label><textarea name="about" rows="2">${esc(p.about || '')}</textarea><div class="btns cta"><button class="btn">Continue</button></div></form></div>`;
    wirePhoto(p, () => { const f = $('#pf'); const keep = Object.fromEntries(new FormData(f)); r.profile = { ...p, ...keep }; setupFlow(r); });
    $('#pf').onsubmit = async (ev) => { ev.preventDefault(); const b = Object.fromEntries(new FormData(ev.target)); try { await api('/barber/profile', { method: 'PUT', body: b }); st.step = 2; settings(); } catch (e) { err(e); } };
  } else if (st.step === 2) {
    app.innerHTML = `${head('What do you offer?', 'Add at least one service so customers can book you.')}<div class="card setup-card">${r.services.map((s) => `<div class="svcline"><div><b>${esc(s.name)}</b><div class="small muted">${s.duration_min} min · ${naira(s.price_kobo)}</div></div></div>`).join('')}${addSvcForm()}</div>
      <div class="btns cta"><button class="btn ghost" id="back">Back</button><button class="btn" id="next" ${r.services.length ? '' : 'disabled'}>Continue</button></div>`;
    $('#back').onclick = () => { st.step = 1; settings(); }; $('#next').onclick = () => { st.step = 3; settings(); };
    $('#addsvc').onsubmit = async (ev) => { ev.preventDefault(); try { await api('/barber/services', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) }); settings(); } catch (e) { err(e); } };
  } else {
    app.innerHTML = `${head('When are you open?', 'We set Mon–Sat, 9am–6pm for you. Change it or keep it.')}<div class="card setup-card"><div class="days-grid">${scheduleRows(r.schedule)}</div></div>
      <div class="btns cta"><button class="btn ghost" id="back">Back</button><button class="btn" id="finish">Finish setup</button></div>`;
    wireDayRows(app);
    $('#back').onclick = () => { st.step = 2; settings(); };
    $('#finish').onclick = async () => { try { await api('/barber/schedule', { method: 'PUT', body: { days: readSchedule(app) } }); st.done = true; state.open = new Set(); toast('You are all set'); settings(); } catch (e) { err(e); } };
  }
}

// CSP forbids inline handlers: hide broken images (barber photo URLs) via a capturing listener
document.addEventListener('error', (e) => { if (e.target && e.target.tagName === 'IMG') e.target.style.visibility = 'hidden'; }, true);
document.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('#goback'); if (a) { e.preventDefault(); history.length > 1 ? history.back() : (location.hash = '#/today'); } });

route();
