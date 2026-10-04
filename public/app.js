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

/* outline icon set (24px grid, stroke = currentColor) */
const ICONS = {
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
const avatar = (b, cls = '') => b.photo_url ? `<img class="avatar ${cls}" src="${esc(b.photo_url)}" alt="">` : `<div class="avatar ${cls}">${initials(b.shop_name || b.name)}</div>`;

/* customer avatar (round, initials fallback); implemented in account.js, safe if that file is missing */
const cav = (c, cls = '') => (window.Account ? Account.av(c, cls) : '');

const gcache = new Map(); // tiny GET cache: public, slow-changing data only (perceived speed when navigating back and forth)
const CACHEABLE = /^\/(config|barbers)$/;   // NOT /barbers/:id - it carries per-customer plan/credit balances
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
async function apiCall(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  else if (init.method !== 'GET') { init.headers['Content-Type'] = 'application/json'; init.body = '{}'; }
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 30000); init.signal = ac.signal;
  let r, j = {};
  try {
    try { r = await fetch('/api' + path, init); }
    catch {
      const e = new Error(ac.signal.aborted ? 'This is taking too long. Check your internet and try again.' : navigator.onLine === false ? "You are offline. Go online and try again." : NET_MSG);
      e.code = 'NETWORK'; throw e;
    }
    try { j = await r.json(); } catch { /* empty or HTML error page */ }
  } finally { clearTimeout(to); }
  if (!r.ok) {
    const fallback = r.status === 429 ? 'Too many tries. Wait a minute and try again.' : r.status >= 500 ? 'Something went wrong on our side. Try again in a moment.' : 'That did not work. Try again.';
    const e = new Error(j.error?.message || fallback); e.code = j.error?.code; e.status = r.status; e.details = j.error?.details;
    if (r.status === 401 && e.code === 'UNAUTHENTICATED' && state.user && !path.startsWith('/auth/')) {   // login expired while the app was open
      state.user = null; state.unread = 0; e.message = 'Your log-in has ended. Please log in again.';
      try { sessionStorage.setItem('trimslot_next', location.hash); } catch { /* private mode */ }
      gcache.clear(); location.hash = '#/login';
    }
    throw e;
  }
  return j;
}
window.addEventListener('offline', () => toast("You are offline. Your changes will not save until you go online.", true));
window.addEventListener('online', () => toast('Back online'));
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 3200);
}
const fail = (e) => toast(e.message || 'Something went wrong. Try again.', true);
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
const statusBadge = (s, b) => (b && b.incomplete) ? '<span class="badge b-gray">INCOMPLETE</span>' : `<span class="badge ${STATUS_BADGE[s][0]}">${STATUS_BADGE[s][1]}</span>`;
function payBadge(b) {
  if (b.incomplete) return '<span class="badge b-gray">NO PAYMENT</span>';
  if (b.payment_status === 'PAID' && b.payment_option === 'PLAN') return '<span class="badge b-blue">PLAN SESSION</span>';
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
  if (d) document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('trimslot_theme', d ? 'dark' : 'light'); } catch { /* ignore */ }
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = d ? '#0b1220' : '#3358d4';
  chrome();
  const sw = $('#themesw'); if (sw) sw.setAttribute('aria-checked', String(d));
}
async function signOut() { try { await Notify.detach(); } catch { /* ignore */ } await api('/auth/logout', { method: 'POST' }); state.user = null; state.setup = null; state.open = new Set(); location.hash = '#/'; route(); }
function chrome() {
  const u = state.user;
  $('#mockbar').classList.toggle('hidden', !(state.cfg && state.cfg.mock));
  if (state.cfg?.mock) $('#mockbar').textContent = 'TEST MODE: no real money moves here.';
  let mb = $('#maintbar'); if (!mb) { mb = document.createElement('div'); mb.id = 'maintbar'; mb.className = 'maintbar hidden'; $('#mockbar').after(mb); }
  mb.classList.toggle('hidden', !(state.cfg && state.cfg.maintenance)); if (state.cfg && state.cfg.maintenance) mb.textContent = state.cfg.maintenance;
  $('#topright').innerHTML = u
    ? `<a class="bell" href="#/notifications" aria-label="${state.unread ? `Notifications, ${state.unread} unread` : 'Notifications'}">${ic('bell')}${state.unread ? `<span class="dot">${state.unread > 99 ? '99+' : state.unread}</span>` : ''}</a>`
    : `<button id="theme" aria-label="Toggle dark mode">${ic(isDark() ? 'sun' : 'moon')}</button><a class="txt" href="#/login">Log in</a>`;
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
function startPoll(fn) { stopPoll(); state.poll = setInterval(() => { if (!document.hidden) fn().catch(() => {}); }, 10000); }

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
    chrome();
    if (state.user) { if (state.notifFor !== state.user.id) { state.notifFor = state.user.id; Notify.start(); Notify.resync(); } } else if (state.notifFor) { state.notifFor = null; Notify.stop(); }
    skeletonIfSlow();
    const parts = path.split('/').filter(Boolean);
    const role = state.user?.role;
    if (!parts.length) return role === 'barber' ? go('#/today') : role === 'customer' ? customerHome() : landing();
    if (parts[0] === 'login') return authPage('login');
    if (parts[0] === 'signup') return authPage('signup', q.get('role'));
    if (parts[0] === 'b' && /^[a-f0-9]{12,32}$/.test(parts[1] || '')) return barberPage(0, parts[1]).catch((e) => { app.innerHTML = `<div class="card center"><h2 style="margin-top:0">This link does not work</h2><p class="err" role="alert">${esc(e.message)}</p><a class="btn" href="#/">${state.user ? 'Go to My barbers' : 'Go to the start page'}</a></div>`; });   // a barber's private share link (opens for guests too)
    if (!state.user) { if (parts.length && !['login', 'signup'].includes(parts[0])) { try { sessionStorage.setItem('trimslot_next', h); } catch { /* private mode */ } } return go('#/login'); }
    if (state.user.consent_required && state.user.consent_required.length && window.Account) return Account.reaccept();
    if (parts[0] === 'notifications') return notifications();
    if (parts[0] === 'profile') return role === 'barber' ? barberProfile() : profile();
    if (parts[0] === 'barber') return barberPage(Number(parts[1]));
    if (role === 'customer') {
      if (parts[0] === 'book') return bookWizard(Number(parts[1]));
      if (parts[0] === 'wallet') return wallet(q.get('plan'), Number(q.get('pp')) || 0);
      if (parts[0] === 'bookings') return myBookings();
      if (parts[0] === 'booking') return bookingDetail(Number(parts[1]), q.get('pay'));
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
    app.innerHTML = `<div class="err">${esc(e.message)}</div><a class="btn sec" href="#/">Back home</a>`;
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
    <div class="hero"><span class="pill">${ic('bolt', 'sm')} Skip the long wait</span><h1>Book. Arrive.<br>Get Trimmed.</h1><p>Pick your barber. Book your time. Watch the live line. No more long waits.</p>
      <a class="btn" href="#/signup?role=customer">Book a haircut</a></div>
    <div class="feat"><div>${ic('cal')}Pick a time</div><div>${ic('pin')}Just arrive</div><div>${ic('clock')}Live queue</div></div>
    <div class="card"><div class="row"><div class="avatar sm">${ic('store')}</div><div class="grow"><h3>Are you a barber?</h3><p class="muted small" style="margin:2px 0 0">Run your day, your services and your line from one simple screen.</p></div></div>
      <div style="height:16px"></div><a class="btn sec" href="#/signup?role=barber">Set up my shop</a></div>
    ${state.cfg.demo ? '<div class="card small"><b>Demo logins</b><br>Customer: <code>chidi@trimslot.demo</code> / <code>Customer123!</code><br>Barber: <code>mike@trimslot.demo</code> / <code>Barber123!</code></div>' : ''}
    <p class="center"><a href="#/login">I already have an account</a></p>`;
}
function authPage(mode, roleQ) {
  let role = roleQ === 'barber' ? 'barber' : 'customer', saved = null;
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
        <label>Password</label><input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="8">
        ${signup ? `<label class="chk accept"><input type="checkbox" name="accept_terms" required> <span>I agree to the <a href="/terms.html" target="_blank" rel="noopener">Terms</a> and have read the <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>` : ''}
        ${signup && role === 'barber' ? `<label class="chk accept"><input type="checkbox" name="accept_barber_agreement" required> <span>I agree to the <a href="/barber-agreement.html" target="_blank" rel="noopener">Barber Agreement</a>.</span></label>` : ''}
        ${signup && role === 'barber' ? '<div class="info small">We check every new barber shop before customers can see it. You can add your services and hours now.</div>' : ''}
        <div style="height:24px"></div><button class="btn block" type="submit">${signup ? 'Sign up' : 'Log in'}</button>
      </form>
      <p class="center small">${signup ? 'Have an account? <a href="#/login">Log in</a>' : 'New here? <a href="#/signup">Sign up</a>'}</p>
      ${!signup && state.cfg.demo ? `<div class="card small"><b>Demo logins (tap to fill)</b><br>
        <a href="#" data-fill="chidi@trimslot.demo|Customer123!">Customer: chidi@trimslot.demo</a><br>
        <a href="#" data-fill="tunde@trimslot.demo|Customer123!">Customer 2: tunde@trimslot.demo</a><br>
        <a href="#" data-fill="mike@trimslot.demo|Barber123!">Barber: mike@trimslot.demo</a></div>` : ''}`;
    if (saved) { for (const [k, v] of Object.entries(saved)) { const el = document.querySelector(`#f [name="${k}"]`); if (el && k !== 'password') el.value = v; } }   // keep what was typed after an error
    document.querySelectorAll('#roleseg button').forEach((b) => b.onclick = () => { saved = Object.fromEntries(new FormData($('#f'))); role = b.dataset.r; draw(); });
    document.querySelectorAll('[data-fill]').forEach((a) => a.onclick = (ev) => { ev.preventDefault(); const [i, p] = a.dataset.fill.split('|'); $('[name=identifier]').value = i; $('[name=password]').value = p; $('#f').dispatchEvent(new Event('input')); });
    $('#f').onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = Object.fromEntries(new FormData(ev.target));
      const btn = ev.target.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = signup ? 'Making your account…' : 'Logging in…';
      try {
        if (signup) await api('/auth/signup', { method: 'POST', body: { ...fd, role, accept_terms: fd.accept_terms === 'on', accept_barber_agreement: fd.accept_barber_agreement === 'on' } });
        else await api('/auth/login', { method: 'POST', body: fd });
        let nx = null; try { nx = sessionStorage.getItem('trimslot_next'); sessionStorage.removeItem('trimslot_next'); } catch { /* private mode */ }
        go(nx && /^#\/[a-z]/.test(nx) && !/^#\/(login|signup)/.test(nx) ? nx : '#/');
      } catch (e) { saved = fd; draw(e.message); }
    };
  };
  draw();
}

/* ---------- customer: home ---------- */
const stars = (n, cls = '') => `<span class="stars ${cls}" aria-label="${n} out of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= Math.round(n) ? 'on' : ''}">${ic('star', 'sm')}</i>`).join('')}</span>`;
const ratingChip = (r) => r && r.count ? `<span class="rate">${ic('star', 'sm')}<b>${r.average.toFixed(1)}</b><span class="muted"> (${r.count})</span></span>` : '';
async function customerHome() {
  const F = state.cfg.features || {};
  const [bs, bk, rb, fv, wl] = await Promise.all([api('/me/barbers'), api('/bookings'), F.rebook ? api('/me/rebook').catch(() => ({})) : {}, F.favourites ? api('/me/favourites').catch(() => ({})) : {}, F.waitlist ? api('/waitlist').catch(() => ({})) : {}]);
  const favIds = new Set((fv.barbers || []).map((b) => b.id));
  const sg = rb.suggestion; const opt = sg && sg.options && sg.options[0];
  const rebookCard = sg && opt ? `<div class="card rebook"><div class="row between"><div><div class="small muted">${ic('repeat', 'sm')} Book again</div><h3 style="margin:2px 0 0">${esc(sg.service.name)} · ${esc(sg.barber.shop_name)}</h3></div><b>${naira(sg.service.price_kobo)}</b></div>
      <div class="small muted" style="margin:4px 0 10px">${sg.usual ? `Your usual: ${DAYFULL[sg.usual.weekday]}s around ${t12(sg.usual.time)}` : 'Same barber, same service'}</div>
      <div class="chips rebook-opts">${sg.options.map((o) => `<button class="chip ${o.usual_day ? 'on' : ''}" data-rb="${o.date}|${o.time}"><b>${dateLabel(o.date)}</b><span class="small">${t12(o.time)}</span></button>`).join('')}</div></div>` : '';
  const waitCard = (wl.waitlist || []).length ? `<h2>On your waitlist</h2>${wl.waitlist.map((w) => `<div class="card row between ${w.status === 'NOTIFIED' ? 'hotcard' : ''}"><div><b>${esc(w.shop_name)}</b><div class="small muted">${esc(w.service_name)} · ${dateLabel(w.date)}${w.status === 'NOTIFIED' ? ' · <b style="color:var(--green)">a time is free now</b>' : ''}</div></div><div class="btns">${w.status === 'NOTIFIED' ? `<a class="btn sm" href="#/book/${w.barber_id}">Book</a>` : ''}<button class="btn sm sec" data-unwait="${w.id}">Leave</button></div></div>`).join('')}` : '';
  const active = bk.bookings.filter((b) => ['CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(b.status) && b.date >= bk.today).sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
  app.innerHTML = `<h1>Hi, ${esc(state.user.name.split(' ')[0])}</h1><p class="muted" style="margin-top:0">Book with your barbers, or add a new one with their link.</p>
    ${Notify.promptCard()}${rebookCard}
    ${active.length ? `<h2>Your next booking</h2>${clist(active.slice(0, 2).map(bookingCard))}` : ''}
    <a class="card row wallet-chip" href="#/wallet"><span class="ico">${ic('wallet')}</span><div class="grow"><b>My plans &amp; credits</b><div class="small muted">Session packs and credits</div></div><span class="muted">${ic('right')}</span></a>
    ${waitCard}
    <h2>My barbers</h2>
    ${[...bs.barbers].sort((a, b) => Number(favIds.has(b.id)) - Number(favIds.has(a.id))).map((b) => `<div class="card row mybarber" data-bid="${b.id}"><a class="row grow" style="gap:12px;min-width:0" href="#/barber/${b.id}">
        ${avatar(b)}
        <div class="grow" style="min-width:0"><h3 class="ellip">${favIds.has(b.id) ? `<span class="fav-i">${ic('heart', 'sm')}</span> ` : ''}${esc(b.shop_name)}</h3><div class="muted small ellip">${esc(b.name)} · ${esc(b.location || 'Lagos')}</div></div></a>
        <div class="row" style="gap:6px"><a class="btn sm" href="#/book/${b.id}">Book</a><button class="mini red" data-rmb="${b.id}" aria-label="Remove ${esc(b.shop_name)} from My barbers">${ic('trash', 'sm')}</button></div></div>`).join('')
      || '<div class="card center muted" id="nobarbers"><b>No barbers yet.</b><br><span class="small">Ask your barber for their TrimSlot link or QR code. Open it, then tap Add barber.</span></div>'}
    <form class="card" id="addlink" novalidate><label for="linkin">Add a barber with their link</label>
      <div class="row" style="gap:8px"><input id="linkin" class="grow" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the link you were sent"><button class="btn sm" type="submit">Open</button></div>
      <div id="linkerr" class="err small hidden" role="alert"></div></form>`;
  const lf = $('#addlink'); lf.onsubmit = (ev) => { ev.preventDefault(); const m = /([a-f0-9]{12,32})\s*$/i.exec($('#linkin').value.trim().replace(/[\/#?]+$/, '')); if (!m) { const er = $('#linkerr'); er.textContent = 'That does not look like a TrimSlot barber link. Ask the barber to send it again.'; er.classList.remove('hidden'); return; } location.hash = '#/b/' + m[1].toLowerCase(); };
  document.querySelectorAll('[data-rmb]').forEach((el) => el.onclick = async () => { const nm = el.closest('.mybarber').querySelector('h3').textContent.trim(); if (!confirm(`Remove ${nm} from My barbers? You can add them again with their link.`)) return; el.disabled = true; try { await api('/me/barbers/' + el.dataset.rmb, { method: 'DELETE' }); toast('Removed'); customerHome(); } catch (e) { fail(e); el.disabled = false; } });
  document.querySelectorAll('[data-rb]').forEach((el) => el.onclick = () => {
    const [d, t] = el.dataset.rb.split('|');
    state.wiz = { barberId: sg.barber.id, step: 3, service: sg.service, date: d, time: t, pay: 'ON_ARRIVAL', payTouched: false, note: '' };
    location.hash = '#/book/' + sg.barber.id;
  });
  document.querySelectorAll('[data-unwait]').forEach((el) => el.onclick = async () => { el.disabled = true; try { await api('/waitlist/' + el.dataset.unwait, { method: 'DELETE' }); toast('Taken off the waitlist'); customerHome(); } catch (e) { fail(e); el.disabled = false; } });
  startPoll(customerHome);
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
  if (m.mode === 'ON_ARRIVAL' && m.platform_charge_kobo) return `<div class="money" aria-label="Your earnings">${mrow('Customer pays you', naira(m.price_kobo))}${mrow('TrimSlot charge', naira(m.platform_charge_kobo))}${mrow('Added to your balance (' + m.commission_percent + '%)', naira(m.commission_owed_kobo), 'tot')}</div>`;
  return '';
}
function bookingCard(b) {
  const q = b.queue;
  return crowA({ t: esc(b.service_name), p: statusBadge(b.status, b) + payBadge(b), m: `${esc(b.shop_name)} · ${dateLabel(b.date)} · ${esc(b.start_label)}`, r: naira(b.price_kobo), x: q && q.state !== 'NOT_ACTIVE' && q.is_today ? esc(q.message) : '' }, '#/booking/' + b.id);
}

/* ---------- customer: booking wizard ---------- */
async function bookWizard(barberId) {
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
  const creditFor = () => (my.credits || []).find((c) => c.value_kobo >= w.service.price_kobo && new Date(c.expires_at) >= new Date(slotIso()));
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
    const head = `<a href="#/barber/${barberId}" class="back">${ic('back', 'sm')} ${esc(barber.shop_name)}</a><div class="wiz-head">${avatar(barber, 'sm')}<div class="grow"><h1 class="ellip">Book a session</h1><div class="muted small ellip">${esc(barber.shop_name)}${barber.location ? ' · ' + esc(barber.location) : ''}</div></div></div>${noticeHtml}${stepBar}${err ? `<div class="err">${esc(err)}</div>` : ''}`;
    if (w.step === 1) {
      app.innerHTML = head + `<h2>Pick a service</h2>` + services.map((s) => `<button class="svc ${w.service?.id === s.id ? 'on' : ''}" data-s="${s.id}"><div><b>${esc(s.name)}</b><div class="muted small">${s.duration_min} min</div></div><b>${naira(s.price_kobo)}</b></button>`).join('')
        + (my.credits && my.credits.length ? `<div class="ok small notice">${ic('ticket', 'sm')}<div>You have ${my.credits.length} session credit${my.credits.length === 1 ? '' : 's'} with this barber. ${my.credits.length === 1 ? 'It works' : 'They work'} until ${dateLabel(my.credits[0].expires_at.slice(0, 10))}. We use ${my.credits.length === 1 ? 'it' : 'one'} when you book.</div></div>` : '')
        + (my.plans && my.plans.some((p) => p.sessions_left > 0) ? `<div class="ok small notice">${ic('ticket', 'sm')}<div>${my.plans.filter((p) => p.sessions_left > 0).map((p) => `Your plan <b>${esc(p.plan_name)}</b> covers ${esc(svcNames(p.service_ids, services))}.`).join(' ')} You can use a plan session when you pay for those.</div></div>` : '')
        + `<div class="btns cta"><button class="btn" id="next" ${w.service ? '' : 'disabled'}>Continue</button></div>`;
      document.querySelectorAll('[data-s]').forEach((el) => el.onclick = () => { w.service = services.find((s) => s.id === Number(el.dataset.s)); w.time = null; w.planId = null; draw(); });
      $('#next').onclick = () => setStep(2);
    } else if (w.step === 2) {
      const today = state.cfg.today;
      const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
      if (!w.date) w.date = today;
      app.innerHTML = head + `<h2>Pick a date &amp; time</h2><div class="days">${days.map((d) => { const x = new Date(d + 'T00:00:00Z'); return `<button class="chip ${w.date === d ? 'on' : ''} ${closedDates.has(d) || offWeekdays.has(x.getUTCDay()) ? 'closed' : ''}" data-d="${d}">${DAYN[x.getUTCDay()]}<b>${x.getUTCDate()}</b>${MON[x.getUTCMonth()]}</button>`; }).join('')}</div>
        <div id="slots" class="card muted">Loading times…</div><div class="btns cta"><button class="btn sec" id="back">Back</button><button class="btn" id="next" ${w.time ? '' : 'disabled'}>Continue</button></div>`;
      document.querySelectorAll('[data-d]').forEach((el) => el.onclick = () => { w.date = el.dataset.d; w.time = null; draw(); });
      $('#back').onclick = () => stepBack(1);
      $('#next').onclick = () => setStep(3);
      try {
        const r = await api(`/barbers/${barberId}/slots?service_id=${w.service.id}&date=${w.date}`);
        $('#slots').className = 'card';
        $('#slots').innerHTML = r.slots.length
          ? `<div class="small muted" style="margin-bottom:8px">${esc(w.service.name)} · ${w.service.duration_min} min · ${dateLabel(w.date)}</div><div class="chips">${r.slots.map((s) => `<button class="chip ${w.time === s.time ? 'on' : ''}" data-t="${s.time}">${t12(s.time)}</button>`).join('')}</div>`
          : `<p class="muted center">${esc(r.closed_reason || 'No free times left this day.')}<br>Pick another date.</p>${!r.closed_reason && (state.cfg.features || {}).waitlist ? `<div class="btns center"><button class="btn sm" id="joinwait">${ic('bell', 'sm')} Tell me when a time is free</button></div>` : ''}`;
        const jw = $('#joinwait'); if (jw) jw.onclick = async () => { jw.disabled = true; try { await api('/waitlist', { method: 'POST', body: { barber_id: barberId, service_id: w.service.id, date: w.date } }); jw.outerHTML = `<div class="ok small">You are on the waitlist. We will tell you as soon as a time is free.</div>`; } catch (e) { fail(e); jw.disabled = false; } };
        document.querySelectorAll('[data-t]').forEach((el) => el.onclick = () => { w.time = el.dataset.t; document.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x === el)); $('#next').disabled = false; });
      } catch (e) { $('#slots').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
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
        ${cr ? `<button class="svc ${w.pay === 'CREDIT' ? 'on' : ''}" data-p="CREDIT"><div><b>Use session credit</b><div class="muted small">No payment · works until ${dateLabel(cr.expires_at.slice(0, 10))} · this barber only</div></div></button>` : ''}
        ${pls.map((x) => `<button class="svc ${w.pay === 'PLAN' && pl && pl.id === x.id ? 'on' : ''}" data-p="PLAN" data-pid="${x.id}"><div><b>Use plan session</b><div class="muted small">${esc(x.plan_name)} · ${x.sessions_left} left · ends ${dateLabel(x.expires_at.slice(0, 10))}</div></div></button>`).join('')}
        ${!pls.length && otherPlans().length ? `<div class="info small notice" id="plan-nofit">${ic('ticket', 'sm')}<div>${otherPlans().map((x) => `Your plan <b>${esc(x.plan_name)}</b> covers ${esc(svcNames(x.service_ids, services))} only.`).join(' ')} It does not cover ${esc(w.service.name)}. Choose another way to pay.</div></div>` : ''}
        ${onlineOk ? `<button class="svc ${w.pay === 'ONLINE' ? 'on' : ''}" data-p="ONLINE"><div><b>Pay now</b><div class="muted small">Pay safely online with Paystack${state.cfg.mock ? ' (test checkout)' : ''}. We add a small booking fee: ${naira(pn.booking_fee_kobo)}.</div></div></button>`
          : `<div class="svc off" aria-disabled="true" id="online-off"><div><b>Pay now</b><div class="muted small">Not available. This barber cannot take online payments yet.</div></div></div>`}
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
            location.href = p.authorization_url; return;
          }
          toast('Booking confirmed'); location.hash = '#/booking/' + r.booking.id;
        } catch (e) {
          if (e.code === 'SLOT_UNAVAILABLE') { w.time = null; w.step = 2; draw(e.message); } else draw(e.message);
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

/* ---------- customer: profile ---------- */
async function profile(editing) {
  const [w, bk] = await Promise.all([api('/me/wallet'), api('/bookings')]);
  const u = state.user;
  const livePlans = w.plans.filter((p) => p.live), liveCredits = w.credits.filter((c) => c.live);
  const recent = bk.bookings.slice(0, 3);
  app.innerHTML = `<div class="prof-head"><div class="avatar">${initials(u.name)}</div><div class="grow"><h1 class="ellip">${esc(u.name)}</h1><div class="muted small ellip">${esc(u.email || '')}</div><div class="muted small ellip">${esc(u.phone || '')}</div></div></div>
    <h2>Account</h2>
    <div class="list"><button class="lrow" id="editbtn"><span class="ico">${ic('pencil', 'sm')}</span><span class="grow">Edit details<span class="sub">Name, email and phone</span></span><span class="end">${ic('right', 'sm')}</span></button></div>
    <div id="editbox" class="${editing ? '' : 'hidden'}"><div class="card">${accountForm(u)}</div></div>
    <h2>Plans &amp; credits</h2>
    <div class="list"><a class="lrow" href="#/wallet"><span class="ico">${ic('wallet', 'sm')}</span><span class="grow">My plans<span class="sub">${livePlans.length ? livePlans.map((p) => p.sessions_left + ' left · ' + esc(p.shop_name)).join(', ') : 'No active plan'}</span></span><span class="end">${ic('right', 'sm')}</span></a>
      <a class="lrow" href="#/wallet"><span class="ico">${ic('ticket', 'sm')}</span><span class="grow">Session credits<span class="sub">${liveCredits.length ? liveCredits.length + ' available, next expires ' + expTxt(liveCredits[0].expires_at) : 'None right now'}</span></span><span class="end">${ic('right', 'sm')}</span></a></div>
    <h2>Booking history</h2>
    ${recent.length ? clist(recent.map(bookingCard)) : '<p class="muted small">No bookings yet.</p>'}
    ${bk.bookings.length > 3 ? '<div class="btns end"><a class="btn sm sec" href="#/bookings">All bookings</a></div>' : ''}
    <h2>Preferences</h2>
    <div class="list">${themeRow()}<a class="lrow" href="#/notifications"><span class="ico">${ic('bell', 'sm')}</span><span class="grow">Notification centre</span><span class="end">${state.unread ? `<span class="badge b-blue">${state.unread} new</span>` : ''}${ic('right', 'sm')}</span></a>${Notify.prefsRows()}</div>
    <div class="list">${signOutRow()}</div>`;
  $('#editbtn').onclick = () => $('#editbox').classList.toggle('hidden');
  wireAccount(() => profile(true)); wireTheme(); Notify.wirePrefs(); wireSignOut();
}

/* ---------- barber: profile hub ---------- */
async function barberProfile() {
  const [r, po, shr] = await Promise.all([api('/barber/profile'), api('/barber/plans').catch(() => null), api('/barber/share').catch(() => null)]);
  const p = r.profile, u = state.user;
  const shareCard = shr ? `<div class="card share" id="sharecard"><div class="row" style="gap:14px;align-items:flex-start"><img class="qr" src="${shr.qr_url}" alt="QR code of your shop link" width="132" height="132"><div class="grow" style="min-width:0"><b>Your private shop link</b><p class="small muted" style="margin:4px 0 8px">Customers only find your shop through this link or QR code. Send it to the people you want to book you.</p><div class="linkbox small" id="sharelink">${esc(shr.url)}</div></div></div>
      ${shr.active ? '' : `<div class="warn small notice" style="margin-top:10px">${ic('warn', 'sm')}<div>The link starts working when TrimSlot approves your shop.</div></div>`}
      <div class="btns" style="margin-top:12px"><button class="btn sm" id="copylink">Copy link</button><button class="btn sm sec hidden" id="sharebtn">Share</button><button class="btn sm sec" id="regen">Make a new link</button></div></div>` : '';
  const liveBuyers = po ? po.purchases.filter((x) => x.live).length : 0;
  app.innerHTML = `${pendingBanner()}${payoutBanner()}<div class="prof-head">${avatar({ photo_url: p.photo_url, shop_name: p.shop_name }, 'lg')}<div class="grow"><h1 class="ellip">${esc(p.shop_name)}</h1><div class="muted small ellip">${esc(u.name)}${p.location ? ' · ' + esc(p.location) : ''}</div><div class="muted small ellip">${esc(u.email || u.phone || '')}</div></div></div>
    <h2>My shop</h2>
    ${shareCard}
    <div class="list"><a class="lrow" href="#/payouts"><span class="ico">${ic('wallet', 'sm')}</span><span class="grow">Payouts<span class="sub">${p.payout && p.payout.status === 'ACTIVE' ? 'Payouts on · ' + esc(p.payout.bank_name || 'Bank') + ' ••' + esc(p.payout.account_last4 || '') : 'Add your bank account to get paid online'}</span></span><span class="end">${p.payout && p.payout.status === 'ACTIVE' ? '<span class="badge b-green">ACTIVE</span>' : '<span class="badge b-amber">SET UP</span>'}${ic('right', 'sm')}</span></a>
      <a class="lrow" href="#/settings"><span class="ico">${ic('store', 'sm')}</span><span class="grow">Shop settings<span class="sub">Photo, about, services, hours, days off</span></span><span class="end">${ic('right', 'sm')}</span></a>
      <a class="lrow" href="#/plans"><span class="ico">${ic('ticket', 'sm')}</span><span class="grow">Plans &amp; credits<span class="sub">${po ? po.plans.length + ' plan' + (po.plans.length === 1 ? '' : 's') + ' · ' + liveBuyers + ' active buyer' + (liveBuyers === 1 ? '' : 's') : 'Create and manage plans'}</span></span><span class="end">${ic('right', 'sm')}</span></a>
      <a class="lrow" href="#/balance"><span class="ico">${ic('wallet', 'sm')}</span><span class="grow">Platform balance owed<span class="sub">Commission on bookings paid outside the app</span></span><span class="end">${ic('right', 'sm')}</span></a>
      ${(state.cfg.features || {}).reviews ? `<a class="lrow" href="#/reviews"><span class="ico">${ic('star', 'sm')}</span><span class="grow">Reviews<span class="sub">Ratings from finished visits. Reply to customers.</span></span><span class="end">${ic('right', 'sm')}</span></a>` : ''}
      ${p.verified ? `<a class="lrow" href="#/barber/${p.id}"><span class="ico">${ic('user', 'sm')}</span><span class="grow">View my public page<span class="sub">What customers see</span></span><span class="end">${ic('right', 'sm')}</span></a>` : ''}</div>
    <h2>Account</h2>
    <div class="list"><button class="lrow" id="editbtn"><span class="ico">${ic('pencil', 'sm')}</span><span class="grow">Edit details<span class="sub">Name, email and phone</span></span><span class="end">${ic('right', 'sm')}</span></button></div>
    <div id="editbox" class="hidden"><div class="card">${accountForm(u)}</div></div>
    <h2>Preferences</h2>
    <div class="list">${themeRow()}<a class="lrow" href="#/notifications"><span class="ico">${ic('bell', 'sm')}</span><span class="grow">Notification centre</span><span class="end">${state.unread ? `<span class="badge b-blue">${state.unread} new</span>` : ''}${ic('right', 'sm')}</span></a>${Notify.prefsRows()}</div>
    <div class="list">${signOutRow()}</div>`;
  $('#editbtn').onclick = () => $('#editbox').classList.toggle('hidden');
  if (shr) {
    $('#copylink').onclick = async () => { try { await navigator.clipboard.writeText(shr.url); toast('Link copied'); } catch { const el = $('#sharelink'); const rg = document.createRange(); rg.selectNodeContents(el); const sl = getSelection(); sl.removeAllRanges(); sl.addRange(rg); toast('Press and hold the link to copy it'); } };
    if (navigator.share) { const sb = $('#sharebtn'); sb.classList.remove('hidden'); sb.onclick = () => navigator.share({ title: p.shop_name + ' on TrimSlot', text: 'Book ' + p.shop_name + ' on TrimSlot', url: shr.url }).catch(() => {}); }
    $('#regen').onclick = async () => { if (!confirm('Make a new link? The old link and QR code stop working at once. Customers who already added you keep you in My barbers.')) return; const b = $('#regen'); b.disabled = true; try { await api('/barber/share/regenerate', { method: 'POST', body: {} }); toast('New link ready. Share the new QR code.'); barberProfile(); } catch (e) { fail(e); b.disabled = false; } };
  }
  wireAccount(() => barberProfile()); wireTheme(); Notify.wirePrefs(); wireSignOut();
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
      ${bl.source === 'fallback' || bl.source === 'stale' ? '<div class="info small">We could not load the full bank list, so this list is short. If your bank is not here, reload in a minute.</div>' : ''}${!bl.banks.length ? '<div class="err">We could not load the banks. Check your internet and <a href="#/payouts" onclick="event.preventDefault();location.reload()">reload</a>.</div>' : ''}
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
        $('#pomnote').textContent = e.message + ' We will mark the name as not checked.'; manual.classList.remove('hidden');
      } else if (e.code === 'NETWORK') nameEl.innerHTML = `<span class="errt">${esc(e.message)}</span> <button type="button" class="linkbtn" id="poagain">Try again</button>`;
      else nameEl.innerHTML = `<span class="errt">${esc(e.message)}</span>`;
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
async function barberPlans() {
  const [po, r] = await Promise.all([api('/barber/plans'), api('/barber/profile')]);
  app.innerHTML = `${pendingBanner()}<h1>Plans &amp; credits</h1><p class="muted">Sell session packs to your regular customers. They see the packs on your page.</p><div id="msg"></div>${plansBody(po, r.services)}`;
  const msg = (t, bad) => { const m = $('#msg'); if (m) m.innerHTML = `<div class="${bad ? 'err' : 'ok'}">${esc(t)}</div>`; window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const guard = (fn, okmsg) => async (ev) => { ev && ev.preventDefault && ev.preventDefault(); try { await fn(ev); await barberPlans(); msg(okmsg); } catch (e) { msg(e.message, true); } };
  wirePlans(po, guard);
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
  app.innerHTML = `${state.user ? `<a href="${state.user.role === 'barber' ? '#/profile' : '#/'}" class="back">${ic('back', 'sm')} ${state.user.role === 'barber' ? 'Profile' : 'My barbers'}</a>` : ''}
    ${sh && state.user?.role === 'barber' ? `<div class="info small notice">${ic('ticket', 'sm')}<div>This is how customers see your shop when they open your link.</div></div>` : ''}
    <div class="row" style="align-items:flex-start">${avatar(barber, 'lg')}<div class="grow"><h1>${esc(barber.shop_name)}</h1>${data.rating ? `<div style="margin:2px 0">${ratingChip(data.rating) || '<span class="small muted">No reviews yet</span>'}</div>` : ''}<div class="muted small">${esc(barber.name)}</div>${barber.location ? `<div class="muted small">${ic('pin', 'sm')} ${esc(barber.location)}</div>` : ''}</div></div>
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
    <div id="plans"><h2>Plans</h2>${plans.length ? `<p class="small muted" style="margin-top:0">Buy a pack and book without paying each time. Unused sessions end when the plan ends.</p>${plans.map((pl) => planCard(pl, services, isCustomer)).join('')}` : '<p class="muted small">This barber has no plans right now.</p>'}</div>
    ${rv && rv.reviews.length ? `<h2>Reviews</h2>${rv.reviews.map((x) => `<div class="card review"><div class="row between">${stars(x.rating)}<span class="small muted">${esc(x.customer_name)} · ${dateLabel(x.created_at.slice(0, 10))}</span></div>${x.comment ? `<p style="margin:8px 0 0">${esc(x.comment)}</p>` : ''}${x.reply ? `<div class="reply small"><b>Reply from ${esc(barber.shop_name)}</b><div>${esc(x.reply)}</div></div>` : ''}</div>`).join('')}` : ''}
    <h2>Opening hours</h2>
    <div class="card"><table class="hours">${hoursRows}</table>${brk ? `<div class="small muted" style="margin-top:8px">Break ${t12(brk.break_start)} – ${t12(brk.break_end)}</div>` : ''}</div>
    ${!state.user && !sh ? `<div class="btns" style="margin-top:16px"><a class="btn" href="#/signup?role=customer">Sign up to book</a></div>` : ''}`;
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
async function buyPlan(id, el) {
  if (!confirm('Buy this plan? You will go to Paystack to pay. Sessions you do not use end when the plan ends. We do not refund them.')) return;
  el.disabled = true;
  try { const r = await api(`/plans/${id}/buy`, { method: 'POST' }); location.href = r.authorization_url; } catch (e) { fail(e); el.disabled = false; }
}
const expTxt = (iso) => dateLabel(String(iso).slice(0, 10));
async function wallet(planResult, ppId) {
  if (planResult && ppId && !['processed', 'already_processed', 'refund_due', 'checked', 'amount_mismatch'].includes(planResult)) {
    const r = await confirmReturn('plan', ppId, 'Checking your plan payment…');
    history.replaceState(null, '', '#/wallet?plan=' + (r === 'processed' || r === 'already_processed' || r === 'refund_due' || r === 'amount_mismatch' ? r : 'checked'));
    planResult = new URLSearchParams(location.hash.split('?')[1] || '').get('plan');
  }
  const w = await api('/me/wallet');
  const msg = planResult === 'processed' || planResult === 'already_processed' ? '<div class="ok">You bought the plan. Choose "Use plan session" when you book.</div>'
    : planResult === 'not_paid' ? '<div class="err">Your payment did not go through, so the plan is not on.</div>' : planResult === 'checked' ? '<div class="info">Paystack has not told us yet. If you were charged, the plan turns on by itself in a few minutes, or we refund you.</div>' : planResult === 'amount_mismatch' ? '<div class="err">We got your payment, but the amount was not right, so the plan is not on. Please contact support.</div>' : planResult === 'refund_due' ? '<div class="info">We could not use that payment. We are sending your money back.</div>' : '';
  const live = w.credits.filter((c) => c.live), past = w.credits.filter((c) => !c.live);
  app.innerHTML = `<h1>Plans &amp; credits</h1>${msg}
    <h2>Session credits</h2>
    <p class="small muted" style="margin-top:0">If you miss a paid session, we do not refund it. You get 1 credit with the <b>same barber</b>. It works for ${w.rules.credit_expiry_days} days. You cannot cash it out. We use it when you book with that barber.</p>
    ${live.length ? clist(live.map((c) => `<div class="crow"><span class="cb"><span class="c1"><span class="ct">${esc(c.shop_name)}</span><span class="cp"><span class="badge b-purple">CREDIT</span></span></span><span class="c2"><span class="cm">1 session · any service up to ${naira(c.value_kobo)}</span><span class="cr">until ${expTxt(c.expires_at)}</span></span></span></div>`)) : '<p class="muted small">You have no credits right now.</p>'}
    <h2>My plans</h2>
    ${w.plans.map((p) => `<div class="card ${p.live ? '' : 'faded'}"><div class="row between"><h3 style="margin:0">${esc(p.plan_name)}</h3><span class="badge ${p.live ? 'b-green' : 'b-gray'}">${p.live ? 'ACTIVE' : p.sessions_left === 0 ? 'USED UP' : 'EXPIRED'}</span></div>
      <div class="muted small">${esc(p.shop_name)}</div><div class="small">Covers: ${esc((p.service_names || []).join(', ') || 'no services')}</div><div class="meter"><i style="width:${Math.round(100 * p.sessions_left / p.sessions_total)}%"></i></div>
      <div class="row between small"><b>${p.sessions_left} of ${p.sessions_total} sessions left</b><span class="muted">${p.live ? 'ends' : 'ended'} ${expTxt(p.expires_at)}</span></div>
      ${p.live ? `<div class="btns end" style="margin-top:12px"><a class="btn sm sec" href="#/barber/${p.barber_id}">View barber</a><a class="btn sm" href="#/book/${p.barber_id}">Book</a></div>` : ''}</div>`).join('') || '<p class="muted small">You have no plans yet. Open a barber page to see their plans.</p>'}
    ${past.length ? `<h2>Used or ended credits</h2>${clist(past.map((c) => `<div class="crow"><span class="cb"><span class="c1"><span class="ct">${esc(c.shop_name)}</span><span class="cp"><span class="badge b-gray">${c.status === 'USED' ? 'USED' : 'EXPIRED'}</span></span></span><span class="c2"><span class="cm">${c.status === 'USED' ? 'Used' : 'Ended ' + expTxt(c.expires_at)}</span></span></span></div>`))}` : ''}`;
}

/* ---------- customer: bookings ---------- */
async function myBookings() {
  const r = await api('/bookings');
  const upcoming = r.bookings.filter((b) => ['CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(b.status));
  const past = r.bookings.filter((b) => !upcoming.includes(b));
  app.innerHTML = `<h1>My bookings</h1><h2>Upcoming</h2>${upcoming.length ? clist(upcoming.map(bookingCard)) : ''}${upcoming.length ? '' : '<p class="muted">You have nothing booked. <a href="#/">Book a cut</a></p>'}<h2>History</h2>${past.length ? clist(past.map(bookingCard)) : ''}${past.length ? '' : '<p class="muted">No past bookings yet.</p>'}`;
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
  const { booking: b } = await api('/bookings/' + id);
  if (payResult && !quiet && b.status === 'PENDING_PAYMENT' && !['slot_taken', 'refund_due', 'late_refund', 'duplicate_refund', 'amount_mismatch'].includes(payResult)) {   // back from Paystack (or Paystack was slow to answer): ask again before showing anything
    const r = await confirmReturn('booking', id, 'Checking your payment…');
    history.replaceState(null, '', '#/booking/' + id + '?pay=' + (r === 'processed' || r === 'already_processed' ? 'processed' : PAY_TERMINAL.includes(r) ? r : 'checked'));
    return bookingDetail(id, new URLSearchParams(location.hash.split('?')[1] || '').get('pay'), true);
  }
  const q = b.queue;
  const payMsg = payBanner(b, payResult);
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
  app.innerHTML = `<a href="#/bookings" class="back">${ic('back', 'sm')} My bookings</a>${payMsg}
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
    ${b.status === 'PENDING_PAYMENT' ? `<div class="warn small notice">${ic('warn', 'sm')}<div><b>Not confirmed yet.</b> Your time is saved only after you pay. Until then, others can book it. Pay to save it. If someone takes it first, we refund you.</div></div><div class="btns"><button class="btn" id="payNow">Pay ${naira((b.money && b.money.total_kobo) || b.price_kobo)} now</button><button class="btn sec" id="verify">I paid. Check my payment</button></div>` : ''}
    ${b.can_check_in ? `<button class="btn big green block" id="here">${ic('pin')} I'm Here</button>` : ''}
    ${b.status === 'CONFIRMED' && !b.can_check_in ? `<div class="info small">The "I'm Here" button shows on the day of your visit.</div>` : ''}
    ${canCancel ? `<div class="btns" style="margin-top:16px"><button class="btn sec" id="cancel">Cancel booking</button></div><p class="small muted" style="margin-top:8px">You can cancel until ${lagosTime(b.cancel_deadline)}. The time then opens for others.${b.payment_option === 'PLAN' ? ' You get your plan session back.' : b.payment_option === 'CREDIT' ? ' You get your credit back.' : b.payment_status === 'PAID' ? ' We send your money back the way you paid, once we approve it.' : ''}</p>` : ''}
    ${locked ? `<div class="info small notice" id="lockedbox">${ic('lock', 'sm')}<div>You can no longer cancel. The cut-off was ${lagosTime(b.cancel_deadline)} (${state.cfg.cancel_cutoff_min} min before). The time stays yours. If you do not come and your barber marks a no-show, you get no refund. If you paid, you get 1 credit with this barber instead.${b.barber_contact ? `<div style="margin-top:8px"><b>Something urgent? Call or WhatsApp your barber.</b> Your barber decides what happens to the booking.</div>${contactBtns(b.barber_contact)}` : ''}</div></div>` : ''}
    ${helpHtml(b)}
    ${b.incomplete ? `<div class="info small notice">${ic('warn', 'sm')}<div><b>Not finished.</b> The payment was not finished, so we did not save a time, and we found no payment for it. If you still see a charge, tap “Report a problem” and we will sort it out.<div style="margin-top:8px"><a class="btn sm" href="#/book/${b.barber_id}">Book again</a></div></div></div>` : ''}
    <div class="btns" style="margin-top:14px"><button class="btn sm sec" data-report="${b.id}">${ic('warn', 'sm')} Report a problem</button></div>
    ${b.payment_status === 'CREDITED' ? `<div class="ok small">${ic('ticket', 'sm')} We did not refund this session, but you have <b>1 session credit</b> with this barber. <a href="#/wallet">See my credits</a></div>` : ''}
    ${b.payment_status === 'REFUND_PENDING' ? `<div class="info small notice">${ic('clock', 'sm')}<div><b>Refund asked for.</b> It is waiting to be approved${b.refund && b.refund.due_at ? '. We approve it by ' + lagosTime(b.refund.due_at) + ' at the latest' : ''}. We will tell you when we send it back to your card.</div></div>` : ''}
    ${b.payment_status === 'REFUNDED' ? `<div class="ok small">${ic('check', 'sm')} <b>Refund approved.</b> Your money is on its way back to the way you paid. Your bank may take a few working days to show it.</div>` : ''}
    ${b.payment_status === 'REFUND_DECLINED' ? `<div class="info small notice">${ic('warn', 'sm')}<div><b>Refund not approved.</b> Open your notifications to see why. If you do not agree, use Report a problem.</div></div>` : ''}
    ${b.payment_status === 'CREDIT_PENDING' ? `<div class="info small">We are deciding if you get a credit or a refund for this payment. We will tell you.</div>` : ''}`;
  const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = async () => { el.disabled = true; try { await fn(); } catch (e) { fail(e); el.disabled = false; } }; };
  let stars_ = 0; document.querySelectorAll('[data-star]').forEach((el) => el.onclick = () => { stars_ = Number(el.dataset.star); document.querySelectorAll('[data-star]').forEach((x) => { const on = Number(x.dataset.star) <= stars_; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(Number(x.dataset.star) === stars_)); }); $('#rvsend').disabled = false; });
  on('#rvsend', async () => { await api(`/bookings/${id}/review`, { method: 'POST', body: { rating: stars_, comment: $('#rvtext').value } }); toast('Thank you for your review'); route(); });
  on('#payNow', async () => { const p = await api(`/bookings/${id}/pay`, { method: 'POST' }); location.href = p.authorization_url; });
  on('#verify', async () => { const r = await api(`/bookings/${id}/verify`, { method: 'POST' }); const done = r.booking.status === 'CONFIRMED'; toast(done ? 'Payment confirmed' : ['slot_taken', 'late_refund', 'refund_due'].includes(r.result) ? 'That time was taken. We are refunding you' : r.result === 'duplicate_refund' ? 'Already paid. We are returning the extra payment' : r.result === 'amount_mismatch' ? 'Payment received. Our team will check it' : 'We have not got your payment yet', !done && r.result !== 'duplicate_refund'); route(); });
  on('#helpsend', async () => { const note = ($('#helpnote').value || '').trim(); if (note.length < 3) throw new Error('Write a few words about what happened.'); await api(`/bookings/${id}/help`, { method: 'POST', body: { note } }); toast('We told your barber'); route(); });
  on('#here', async () => { await api(`/bookings/${id}/check-in`, { method: 'POST' }); toast("You are checked in"); route(); });
  on('#cancel', async () => { if (!confirm('Cancel this booking?')) throw new Error('Not cancelled'); await api(`/bookings/${id}/cancel`, { method: 'POST' }); toast('Booking cancelled'); route(); });
  if (['PENDING_PAYMENT', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(b.status)) startPoll(async () => { if (location.hash.startsWith('#/booking/')) await bookingDetail(id, payResult, true); });
}

/* ---------- report a problem (customers + barbers) ---------- */
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest && ev.target.closest('[data-report]'); if (!btn) return;
  const id = Number(btn.dataset.report); let box = $('#reportbox');
  if (box) { box.remove(); return; }
  box = document.createElement('div'); box.id = 'reportbox'; box.className = 'card'; box.style.marginTop = '12px';
  box.innerHTML = `<h3 style="margin-top:0">Report a problem</h3><p class="small muted">Tell us what went wrong. The TrimSlot team reads every report and may contact you.</p>
    <form id="rform"><label>What is this about?</label><select name="category"><option value="NO_SHOW">Someone did not come</option><option value="BEHAVIOUR">How someone acted</option><option value="PAYMENT">Payment</option><option value="QUALITY">How good the service was</option><option value="SAFETY">Safety</option><option value="OTHER">Something else</option></select>
    <label>Details</label><textarea name="message" rows="4" maxlength="1000" required placeholder="What happened?"></textarea>
    <div class="btns cta"><button class="btn" type="submit">Send report</button></div></form>`;
  btn.closest('.btns').after(box); box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#rform').onsubmit = async (e) => {
    e.preventDefault(); const sb = e.target.querySelector('button'); sb.disabled = true;
    try { const d = Object.fromEntries(new FormData(e.target)); await api('/reports', { method: 'POST', body: { ...d, booking_id: id } }); box.innerHTML = `<div class="ok">Thank you. The TrimSlot team got your report.</div>`; }
    catch (err) { sb.disabled = false; toast(err.message || 'We could not send it', true); }
  };
});

/* ---------- barber: platform balance owed (off-app commission ledger) ---------- */
async function barberBalance() {
  const r = await api('/barber/ledger');
  const st = { ACCRUED: ['b-amber', 'Owed'], SETTLED: ['b-green', 'Settled'], WAIVED: ['b-blue', 'Waived'] };
  app.innerHTML = `${pendingBanner()}<a href="#/profile" class="back">${ic('back', 'sm')} Profile</a><h1>Platform balance owed</h1>
    <div class="card"><div class="muted small">YOU CURRENTLY OWE</div><div style="font-size:32px;font-weight:800;margin:4px 0">${naira(r.owed_kobo)}</div>
      <div class="small muted">When a customer pays outside the app (cash or transfer) and you complete the booking, we add TrimSlot's commission here. It is ${Math.round(r.factor * 100)}% of the usual in-app fee. We take it out of your next online payments and plan sales. You do not need to send money.</div></div>
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
  try { await api(`/barber/bookings/${id}/${action}`, { method: 'POST', body: body || {} }); await barberToday(true); } catch (e) { fail(e); }
}
const pendingBanner = () => {
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
  catch (e) { b.disabled = false; toast(e.message || 'We could not send it again', true); }
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
  document.querySelectorAll('[data-delay]').forEach((el) => el.onclick = async () => { if (!confirm(`Tell today's waiting customers you are ${el.dataset.delay} more minutes late?`)) return; el.disabled = true; try { const r = await api('/barber/queue/delay', { method: 'POST', body: { minutes: Number(el.dataset.delay) } }); toast(`You are ${r.delay_min} min late · ${r.notified} customer${r.notified === 1 ? '' : 's'} told`); } catch (e) { fail(e); } el.disabled = false; });
  document.querySelectorAll('[data-tpl]').forEach((el) => el.onclick = async () => { if (!confirm(`Send "${el.textContent}" to everyone waiting today?`)) return; el.disabled = true; try { const r = await api('/barber/queue/message', { method: 'POST', body: { template: el.dataset.tpl } }); toast(`Sent to ${r.sent} customer${r.sent === 1 ? '' : 's'}`); } catch (e) { fail(e); } el.disabled = false; });
  document.querySelectorAll('[data-a]').forEach((el) => el.onclick = () => {
    const a = el.dataset.a;
    if (a === 'no-show' && !confirm('Mark as no-show?')) return;
    if (a === 'not-served' && !confirm('Mark as not served?')) return;
    act(Number(el.dataset.id), a, el.dataset.m ? { method: el.dataset.m } : {});
  });
  startPoll(() => location.hash.startsWith('#/today') ? barberToday() : Promise.resolve());
}
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
      ${arrived ? '' : `<button class="btn red" data-a="no-show" data-id="${b.id}">No-show</button>`}
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
    <div class="btns" style="margin-top:12px"><button class="btn sm sec" data-report="${b.id}">${ic('warn', 'sm')} Report a problem</button></div>
    <h2>Timeline</h2><div class="card"><div class="tl">${timeline.map((t) => `<div><b>${esc(ACTION_LABEL[t.action] || t.action)}</b><div class="small muted">${lagosStamp(t.created_at)} · ${esc(t.actor_role)}${t.actor_name ? ' (' + esc(t.actor_name) + ')' : ''}</div>${t.details && t.details.note ? `<div class="small warn-t">${esc(String(t.details.note).replace(/^TODO\(owner\):.*$/, 'Not refunded yet. The shop or admin will give a refund or a session credit.'))}</div>` : ''}</div>`).join('')}</div></div>`;
  const helpAct = (sel, action, ask, done) => { const el = $(sel); if (el) el.onclick = async () => { if (ask && !confirm(ask)) return; el.disabled = true; try { await api(`/barber/bookings/${id}/${action}`, { method: 'POST', body: action === 'not-served' ? { reason: 'Customer asked for help; barber released it' } : {} }); toast(done); route(); } catch (e) { fail(e); el.disabled = false; } }; };
  helpAct('#helprel', 'not-served', 'Release this booking? It will be marked as not served.', 'Booking released');
  helpAct('#helplater', 'wait', null, 'We told the customer you will wait');
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
  if (!file || !/^image\//.test(file.type || '')) throw new Error('Please choose a picture file.');
  const bmp = await (window.createImageBitmap ? createImageBitmap(file).catch(() => null) : null) || await new Promise((res, rej) => {
    const im = new Image(); const u = URL.createObjectURL(file);
    im.onload = () => { URL.revokeObjectURL(u); res(im); }; im.onerror = () => rej(new Error('We could not read that picture.')); im.src = u;
  });
  const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight;
  let scale = Math.min(1, 1024 / Math.max(w0, h0)), q = 0.85;
  for (let attempt = 0; attempt < 8; attempt++) {
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w0 * scale)); c.height = Math.max(1, Math.round(h0 * scale));
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', q));
    if (blob && blob.size <= 280 * 1024) return blob;
    if (q > 0.55) q -= 0.1; else scale *= 0.8;
  }
  throw new Error('That photo is too big. Try a different one.');
}
async function uploadPhoto(file) {
  const blob = await compressImage(file);
  const r = await fetch('/api/barber/photo', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || 'The upload did not work');
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
    if (!(await confirmSheet(e))) throw new Error('Not saved. Nothing changed.');
    return await doSave(true);
  }
}
const readSchedule = (root) => [...root.querySelectorAll('.dayrow')].map((r) => ({ weekday: Number(r.dataset.wd), is_working: $('.w', r).checked, start: $('.s', r).value || '09:00', end: $('.e', r).value || '18:00', break_start: $('.bs', r).value || null, break_end: $('.be', r).value || null }));
const scheduleRows = (sched) => sched.map((d) => `<div class="dayrow ${d.is_working ? '' : 'off'}" data-wd="${d.weekday}"><label class="check"><input type="checkbox" class="w" ${d.is_working ? 'checked' : ''}> ${DAYFULL[d.weekday]}</label>
      <div class="times"><div><span class="small muted">Opens</span><input type="time" class="s" value="${d.start}"></div><div><span class="small muted">Closes</span><input type="time" class="e" value="${d.end}"></div>
      <div><span class="small muted">Break from</span><input type="time" class="bs" value="${d.break_start || ''}"></div><div><span class="small muted">Break to</span><input type="time" class="be" value="${d.break_end || ''}"></div></div></div>`).join('');
const wireDayRows = (root) => root.querySelectorAll('.dayrow .w').forEach((c) => c.onchange = () => c.closest('.dayrow').classList.toggle('off', !c.checked));
const photoBlock = (p) => `<div class="photo-up">${avatar({ photo_url: p.photo_url, shop_name: p.shop_name }, 'lg')}<div class="grow"><div class="btns">
    <label class="btn sec sm" style="margin:0;cursor:pointer">${ic('camera', 'sm')} Take photo<input id="ph-cam" type="file" accept="image/*" capture="environment"></label>
    <label class="btn sec sm" style="margin:0;cursor:pointer">${ic('image', 'sm')} Choose<input id="ph-file" type="file" accept="image/*"></label></div>
    <div class="small muted" style="margin-top:6px" id="ph-msg">${p.photo_url ? 'Tap to change your shop photo.' : 'Add a photo so customers know your shop.'}</div></div></div>`;
function wirePhoto(p, onDone) {
  const go1 = async (f) => { if (!f) return; const m = $('#ph-msg'); m.textContent = 'Making it smaller and uploading…'; try { p.photo_url = await uploadPhoto(f); toast('Photo saved'); onDone && onDone(); } catch (e) { m.textContent = e.message; fail(e); } };
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
  <div class="btns" style="margin-top:10px"><button class="btn sm ${id ? '' : 'sec'}">${id ? 'Save plan' : ic('plus', 'sm') + ' Create plan'}</button></div></form>`;
function plansBody(po, services) {
  const L = po.limits;
  const rules = `<div class="info small" style="margin:10px 0">Rules: price ${naira(L.min_price_kobo)}–${naira(L.max_price_kobo)} · up to ${L.max_sessions} sessions · lasts up to ${L.max_validity_days} days. If a customer misses a paid session, they get a credit with you. It lasts ${L.credit_expiry_days} days. They cannot cash it out.</div>`;
  const list = po.plans.map((pl) => `<div class="svcline plnline" data-id="${pl.id}"><div><b>${esc(pl.name)}</b><div class="small muted">${naira(pl.price_kobo)} · ${pl.sessions} sessions · ${pl.validity_days} days</div><div class="small muted">Includes ${esc(svcNames(pl.service_ids, services) || 'no services')}</div>${pl.needs_review ? `<div class="warn small notice" style="margin:6px 0">${ic('warn', 'sm')}<div><b>Please check this plan.</b> We linked it to your services that cost no more than ${naira(Math.floor(pl.price_kobo / pl.sessions))} each. Tap edit, check the list, then save.</div></div>` : ''}<div class="small muted">${pl.buyers} buyer${pl.buyers === 1 ? '' : 's'} · ${pl.sessions_used} session${pl.sessions_used === 1 ? '' : 's'} used · ${naira(pl.revenue_kobo)} sold</div></div>
    <div class="row" style="gap:6px"><button class="mini ed" aria-label="Edit">${ic('pencil', 'sm')}</button><button class="mini red del" aria-label="Stop selling">${ic('trash', 'sm')}</button></div>
    <div class="svcedit" style="grid-column:1/-1">${planForm(pl.id, pl, services, L)}</div></div>`).join('') || '<p class="muted small">No plans yet.</p>';
  const buyers = po.purchases.slice(0, 15).map((x) => `<div class="row between small" style="margin:6px 0"><span><b>${esc(x.customer_name)}</b> · ${esc(x.plan_name)}</span><span class="${x.live ? '' : 'muted'}">${x.sessions_total - x.sessions_used}/${x.sessions_total} left${x.live ? '' : ' · ended'}</span></div>`).join('');
  const credits = po.credits.slice(0, 15).map((x) => `<div class="row between small" style="margin:6px 0"><span><b>${esc(x.customer_name)}</b> · ${x.reason === 'NO_SHOW' ? 'no-show' : 'missed session'}</span><span class="${x.live ? '' : 'muted'}">${x.status === 'USED' ? 'used' : x.live ? 'until ' + expTxt(x.expires_at) : 'expired'}</span></div>`).join('');
  return `${rules}${list}<h3 style="margin-top:14px">Create a plan</h3>${planForm(null, null, services, L)}
    ${buyers ? `<h3 style="margin-top:14px">Plan buyers</h3>${buyers}` : ''}${credits ? `<h3 style="margin-top:14px">Session credits issued</h3>${credits}` : ''}`;
}
function wirePlans(po, guard) {
  if (!po) return;
  const body = (f) => { const fd = new FormData(f); return { name: fd.get('name'), price_naira: fd.get('price_naira'), sessions: fd.get('sessions'), validity_days: fd.get('validity_days'), service_ids: fd.getAll('svc').map(Number) }; };
  const add = $('#addplan'); if (add) add.onsubmit = guard(() => api('/barber/plans', { method: 'POST', body: body(add) }), 'Plan created');
  document.querySelectorAll('.plnline .planf').forEach((f) => {
    const l = f.closest('.svcline');
    l.querySelector('.ed').onclick = () => l.classList.toggle('editing');
    f.onsubmit = guard(() => api('/barber/plans/' + f.dataset.id, { method: 'PUT', body: body(f) }), 'Plan saved');
    l.querySelector('.del').onclick = guard(async () => { if (!confirm('Stop selling this plan? People who already bought it keep their sessions.')) throw new Error('Cancelled'); await api('/barber/plans/' + f.dataset.id, { method: 'DELETE' }); }, 'Plan is no longer for sale');
  });
}
const acc = (id, icon, title, sub, body) => `<details class="acc" data-k="${id}" ${state.open.has(id) ? 'open' : ''}><summary><span class="ico">${ic(icon)}</span><span>${title}<span class="sub">${sub}</span></span><span class="chev">${ic('chev')}</span></summary><div class="body">${body}</div></details>`;

async function settings() {
  const r = await api('/barber/profile'); const po = null;
  const p = r.profile;
  const needsSetup = state.setup ? !state.setup.done : r.services.length === 0; // once started, stay in the flow until "Finish setup"
  if (needsSetup) return setupFlow(r);
  const activeDays = r.schedule.filter((d) => d.is_working);
  const hoursSub = activeDays.length ? `${activeDays.length} days · ${t12(activeDays[0].start)}–${t12(activeDays[0].end)}` : 'No working days';
  app.innerHTML = `${pendingBanner()}${payoutBanner()}<a href="#/profile" class="back">${ic('back', 'sm')} Profile</a><h1>Shop settings</h1><p class="muted">Shop details, services and opening hours.</p><div id="msg"></div>
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
  const guard = (fn, okmsg) => async (ev) => { ev && ev.preventDefault && ev.preventDefault(); try { const out = await fn(ev); await refreshMe(); const extra = out && out.notified_bookings ? ` We told ${out.notified_bookings} customer${out.notified_bookings === 1 ? '' : 's'}.` : ''; await settings(); msg(okmsg + extra); } catch (e) { msg(e.message, true); } };
  wirePhoto(p, () => settings());
  wireDayRows(app);
  $('#pf').onsubmit = guard(() => api('/barber/profile', { method: 'PUT', body: Object.fromEntries(new FormData($('#pf'))) }), 'Profile saved');
  document.querySelectorAll('.svcline:not(.plnline)').forEach((l) => {
    l.querySelector('.ed').onclick = () => l.classList.toggle('editing');
    l.querySelector('.svcf').onsubmit = guard(() => api('/barber/services/' + l.dataset.id, { method: 'PUT', body: Object.fromEntries(new FormData(l.querySelector('.svcf'))) }), 'Service saved');
    l.querySelector('.del').onclick = guard(async () => { if (!confirm('Remove this service? Bookings you already have stay.')) throw new Error('Cancelled'); await api('/barber/services/' + l.dataset.id, { method: 'DELETE' }); }, 'Service removed');
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
  const err = (e) => { const m = $('#msg'); if (m) m.innerHTML = `<div class="err">${esc(e.message)}</div>`; };
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
