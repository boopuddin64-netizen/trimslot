/* TrimSlot admin portal. The admin key lives only in sessionStorage (this tab); nothing secret is in the page. All rendering escapes data. */
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const naira = (k) => '₦' + (Number(k || 0) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 });
const KEY = 'trimslot_admin_key';
const getKey = () => { try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; } };
const app = $('#app');
const DAYN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dlabel = (d) => { const x = new Date(String(d).slice(0, 10) + 'T00:00:00Z'); return `${DAYN[x.getUTCDay()]} ${x.getUTCDate()} ${MON[x.getUTCMonth()]}`; };
const t12 = (m) => { const h = Math.floor(m / 60); return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
const stamp = (iso) => iso ? new Intl.DateTimeFormat('en-NG', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)) : '—';
const dshort = (iso) => iso ? new Intl.DateTimeFormat('en-NG', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)) : '—';
function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 3500); }
const ic = (d) => `<svg class="i sm" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;

async function api(path, opts = {}) {
  const r = await fetch('/api/admin' + path, { method: opts.method || 'GET', headers: { Authorization: 'Bearer ' + getKey(), ...(opts.headers || {}), ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  let j = {}; try { j = await r.json(); } catch { /* empty */ }
  if (r.status === 401 && path !== '/login') { signOut(true); throw new Error('Session ended. Sign in again.'); }
  if (!r.ok) { const e = new Error(j.error?.message || 'Request failed'); e.status = r.status; e.code = j.error?.code; e.details = j.error?.details; throw e; }
  return j;
}
function signOut(silent) { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } showLogin(silent ? 'Sign in again to continue.' : ''); }

/* ---------- badges ---------- */
const bd = (cls, t) => `<span class="badge ${cls}">${esc(t)}</span>`;
const bookingBadge = (s) => bd({ CONFIRMED: 'b-blue', ARRIVED: 'b-green', IN_SERVICE: 'b-purple', COMPLETED: 'b-gray', CANCELLED: 'b-red', NO_SHOW: 'b-red', NOT_SERVED: 'b-red', PENDING_PAYMENT: 'b-amber' }[s] || 'b-gray', s === 'PENDING_PAYMENT' ? 'NOT CONFIRMED' : s.replace('_', ' '));
const payBadge = (s) => bd({ SUCCESS: 'b-green', FAILED: 'b-red', INITIATED: 'b-amber' }[s] || 'b-gray', s === 'SUCCESS' ? 'PAID' : s);
const refundBadge = (s) => s ? bd({ NEEDS_REFUND: 'b-amber', REFUND_REQUESTED: 'b-blue', REFUNDED: 'b-green' }[s] || 'b-gray', s.replace('_', ' ')) : '';
const bpay = (s) => bd({ PAID: 'b-green', CREDIT_PENDING: 'b-purple', CREDITED: 'b-purple', PAYMENT_DUE: 'b-amber', VOID: 'b-gray', PENDING: 'b-amber' }[s] || 'b-gray', s.replace('_', ' '));

/* compact rows (phones): one row = ~58px, two lines. d = { t: title, p: pills (right of title), m: meta (one line, ellipsis), r: trailing figure, sel: checkbox html } */
const crow = (d, attrs = '') => `<div class="crow" role="button" tabindex="0" ${attrs}>${d.sel || ''}<div class="cb"><div class="c1"><span class="ct">${d.t}</span>${d.p ? `<span class="cp">${d.p}</span>` : ''}</div><div class="c2"><span class="cm">${d.m || ''}</span>${d.r ? `<span class="cr">${d.r}</span>` : ''}</div></div><span class="cgo" aria-hidden="true">›</span></div>`;
const MQD = window.matchMedia('(min-width:720px)');
/* buttons an action column would show, read from its markup so the pop-up can offer the same actions */
function colActions(cols, r) {
  const ac = cols.find(([, , c]) => c === 'act'); if (!ac) return [];
  const t = document.createElement('div'); t.innerHTML = ac[1](r);
  return [...t.querySelectorAll('button')].map((b, i) => ({ i, label: b.textContent.trim(), cls: [...b.classList].filter((x) => x !== 'btn' && x !== 'sm').join(' '), data: { ...b.dataset } }));
}
/* tap-a-row pop-up: bottom sheet on phones, side drawer on wide screens. o = { title, sub, pills, acts:[{label,cls,run}], links(reload) } */
function openRowSheet(cols, r, o) {
  const f0 = cols[0][1]; const kv = cols.slice(1).filter(([l, , c]) => l && c !== 'act' && !(o.pills && l === 'Status')).map(([l, f]) => kvr(l, f(r))).join('');
  const acts = o.acts || [];
  const m = modal(`<div class="sh-h"><div class="shtitle">${o.title ? esc(o.title) : f0(r)}</div><button class="btn sm sec" data-close>Close</button></div>
    ${o.pills ? `<div class="row-badges">${o.pills}</div>` : ''}<h3>Details</h3>${kv}
    <div class="btns end sticky">${acts.map((a, i) => `<button class="btn ${a.cls}" data-ai="${i}">${esc(a.label)}</button>`).join('') || '<span class="muted small">No actions available.</span>'}</div>`);
  m.el.querySelectorAll('[data-ai]').forEach((x) => x.onclick = () => { m.close(); acts[Number(x.dataset.ai)].run(); });
  m.el.querySelectorAll('[data-u]').forEach((x) => x.onclick = (e) => { e.preventDefault(); m.close(); userSheet(Number(x.dataset.u), o.reload || (() => route())); });
  m.el.querySelectorAll('[data-b]').forEach((x) => x.onclick = (e) => { e.preventDefault(); m.close(); bookingSheet(Number(x.dataset.b), o.reload || (() => route())); });
  return m;
}
/* table helper: rows -> responsive table on wide screens; compact tappable rows on phones when o.row is given (o.row(r) -> descriptor, o.title(r) optional).
   cols: [label, fn(row)->html, cls] ; first col is the row title; the 'act' column is shown as buttons in the table and in the row's pop-up. */
const TSETS = {}; let tsn = 0;
function table(cols, rows, empty, o) {
  if (!rows.length) return `<div class="empty">${esc(empty || 'Nothing here.')}</div>`;
  const head = cols.map(([l, , c]) => `<th class="${c === 'num' ? 'num' : ''}">${esc(l)}</th>`).join('');
  const body = rows.map((r, ri) => `<tr data-ri="${ri}">${cols.map(([l, f, c], i) => `<td class="${i === 0 ? 'main' : c === 'act' ? 'act' : c === 'num' ? 'num' : ''}" data-l="${esc(l)}">${f(r)}</td>`).join('')}</tr>`).join('');
  const desk = `<div class="tblwrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  if (!o || !o.row) return desk;
  const id = ++tsn; TSETS[id] = { cols, rows, o }; delete TSETS[id - 12];
  return `<div class="tblset" data-ts="${id}">${desk}<div class="clist">${rows.map((r, ri) => crow(o.row(r), `data-ri="${ri}"`)).join('')}</div></div>`;
}
function openTblRow(el) {
  const set = el.closest('.tblset'); if (!set) return; const T = TSETS[set.dataset.ts]; if (!T) return;
  const ri = Number(el.dataset.ri), r = T.rows[ri]; const tr = set.querySelector(`.tbl tbody tr[data-ri="${ri}"]`);
  const acts = colActions(T.cols, r).map((a) => ({ label: a.label, cls: a.cls, run: () => tr.querySelectorAll('td.act button')[a.i]?.click() }));
  openRowSheet(T.cols, r, { title: T.o.title ? T.o.title(r) : null, pills: T.o.row(r).p, acts });
}
document.addEventListener('click', (e) => { const c = e.target.closest('.tblset .crow'); if (c) openTblRow(c); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches?.('.tblset .crow')) openTblRow(e.target); });
const cust = (r) => `<b>${esc(r.customer_name)}</b>`;

/* ---------- sections ---------- */
const IC = {
  home: '<path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"/>',
  barbers: '<path d="M4 9h16l-1-5H5ZM5 9v11h14V9M9 20v-6h6v6"/>',
  customers: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .6 3.2 2.3 3.5 5.2"/>',
  bookings: '<rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  payments: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20"/>',
  decisions: '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/>',
  plans: '<path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1ZM14 5v14"/>',
  credits: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 10h4.5a1.5 1.5 0 0 1 0 3H9.5a1.5 1.5 0 0 0 0 3H15"/>',
  earnings: '<path d="M3 17l6-6 4 4 8-9M15 6h6v6"/>',
  ledger: '<path d="M5 3h11l3 3v15H5zM9 9h6M9 13h6M9 17h3"/>',
  analytics: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  reviews: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  waitlist: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  reports: '<path d="M4 21V4M4 4h13l-2 4 2 4H4"/>',
  broadcast: '<path d="M3 11v3a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1ZM17 9a4 4 0 0 1 0 6"/>',
  controls: '<path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  rules: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  audit: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
};
const GROUPS = [
  [null, [['home', 'Home']]],
  ['People', [['customers', 'Customers'], ['barbers', 'Barbers']]],
  ['Bookings', [['bookings', 'Bookings'], ['decisions', 'Refund decisions']]],
  ['Money', [['payments', 'Payments'], ['credits', 'Credits'], ['plans', 'Plans'], ['earnings', 'Earnings'], ['ledger', 'Off-app ledger']]],
  ['Growth', [['analytics', 'Analytics'], ['reviews', 'Reviews'], ['waitlist', 'Waitlist'], ['broadcast', 'Broadcast'], ['reports', 'Reports']]],
  ['Settings', [['controls', 'Controls'], ['rules', 'Platform rules'], ['audit', 'Audit log']]],
];
let badges = { pending: 0, decisions: 0, refunds: 0, reports: 0, ledger: 0 };
function drawNav(cur) {
  const cnt = { barbers: badges.pending, decisions: badges.decisions, payments: badges.refunds, reports: badges.reports };
  if (cur === 'overview') cur = 'home';
  $('#nav').innerHTML = GROUPS.map(([g, items]) => `<div class="ngrp">${g ? `<div class="nlab">${g}</div>` : ''}${items.map(([k, l]) => `<a href="#/${k}" class="${k === cur ? 'on' : ''}">${ic(IC[k])}<span>${l}</span>${cnt[k] ? `<span class="cnt">${cnt[k]}</span>` : ''}</a>`).join('')}</div>`).join('');
  $('#nav a.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}
const head = (t, sub, right) => `<div class="page-h"><div><h1>${esc(t)}</h1>${sub ? `<p class="muted small">${esc(sub)}</p>` : ''}</div>${right || ''}</div>`;
const refreshBtn = `<button class="btn sm sec" id="reload">Refresh</button>`;
const wireReload = (fn) => { const b = $('#reload'); if (b) b.onclick = fn; };
const act = (label, cls, attrs) => `<button class="btn sm ${cls}" ${attrs}>${label}</button>`;
function wireActions(root, handlers) {
  root.querySelectorAll('[data-do]').forEach((b) => b.onclick = async () => {
    const h = handlers[b.dataset.do]; if (!h) return;
    b.disabled = true;
    try { await h(b.dataset); } catch (e) { toast(e.message, true); b.disabled = false; }
  });
}

async function overview() {
  const o = await api('/overview');
  badges = { ...badges, pending: o.barbers_pending, decisions: o.awaiting_decision, refunds: o.refunds_open, reports: o.reports_open || 0 }; drawNav('overview');
  const tile = (l, v, s, href, alert) => `<div class="tile ${alert ? 'alert' : ''}">${href ? `<a href="${href}">` : ''}<span>${l}</span><b>${v}</b>${s ? `<small>${s}</small>` : ''}${href ? '</a>' : ''}</div>`;
  app.innerHTML = head('Overview', 'Today is ' + dlabel(o.today) + '. Amounts are in Nigerian naira.', refreshBtn) +
    `<div class="tiles">${tile('Barbers', o.barbers_verified, 'verified and live')}${tile('Awaiting review', o.barbers_pending, o.barbers_pending ? 'Review now' : 'All caught up', '#/barbers', o.barbers_pending > 0)}
      ${tile('Customers', o.customers)}${tile('Bookings today', o.bookings_today, o.bookings_total + ' all time')}
      ${tile('Revenue', naira(o.revenue_kobo), naira(o.revenue_30d_kobo) + ' last 30 days')}${tile('Platform fees', naira(o.fees_kobo), 'of paid online payments')}
      ${tile('Plan sales', naira(o.plan_sales_kobo), o.active_plans + ' active plans')}${tile('Live credits', o.live_credits, 'unexpired session credits')}</div>
    <div class="tiles">${tile('Refunds to action', o.refunds_open, 'flagged payments', '#/payments', o.refunds_open > 0)}${tile('Cancellations awaiting decision', o.awaiting_decision, 'convert to credit or refund', '#/decisions', o.awaiting_decision > 0)}${tile('Open reports', o.reports_open || 0, 'complaints to review', '#/reports', o.reports_open > 0)}${tile('Owed by barbers', naira(o.ledger_owed_kobo), 'off-app commission', '#/ledger', o.ledger_owed_kobo > 0)}</div>${o.maintenance_mode ? '<div class="warnbox"><b>Maintenance mode is ON.</b> Customers cannot make new bookings. <a href="#/controls">Change</a></div>' : ''}`;
  wireReload(overview);
}

/* ---------- barbers: review workflow ---------- */
const RS = { PENDING: ['b-amber', 'PENDING'], NEEDS_INFO: ['b-blue', 'NEEDS INFO'], VERIFIED: ['b-green', 'VERIFIED'], REJECTED: ['b-red', 'REJECTED'], SUSPENDED: ['b-purple', 'SUSPENDED'] };
const rsBadge = (s) => bd(...(RS[s] || ['b-gray', s]));
const TABS = [['ALL', 'All'], ['PENDING', 'Pending'], ['NEEDS_INFO', 'Needs info'], ['VERIFIED', 'Verified'], ['SUSPENDED', 'Suspended'], ['REJECTED', 'Rejected']];
let btab = 'PENDING', btabSet = false;
function modal(html) {
  const m = document.createElement('div'); m.className = 'modal' + (html.includes('class="sh-h"') ? ' drawer' : ''); m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(m); document.body.style.overflow = 'hidden';
  const close = () => { m.remove(); document.body.style.overflow = ''; document.removeEventListener('keydown', esch); };
  const esch = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esch); m.addEventListener('click', (e) => { if (e.target === m) close(); });
  m.querySelectorAll('[data-close]').forEach((x) => x.onclick = close);
  return { el: m, close };
}
const reasonForm = (o) => `<form class="rform" id="rfm"><h2 style="margin-top:0">${esc(o.title)}</h2><p class="muted small">${esc(o.help)}</p>
  <label for="rtxt">${esc(o.label)}</label><textarea id="rtxt" rows="4" maxlength="500" required minlength="3" placeholder="${esc(o.ph || '')}"></textarea>
  <div id="rwarn"></div><div class="err hidden" id="rerr"></div>
  <div class="btns end"><button type="button" class="btn sec" data-close>Cancel</button><button class="btn ${o.cls || ''}" id="rgo" type="submit">${esc(o.go)}</button></div></form>`;
async function barberDetail(id, reload) {
  const r = await api('/barbers/' + id); const b = r.barber; const st = b.review_status;
  const sched = r.schedule.map((d) => `<div class="kv"><span>${DAYN[d.weekday]}</span><b>${d.is_working ? t12(d.start_min) + ' – ' + t12(d.end_min) + (d.break_start_min != null ? ` <small class="muted">(break ${t12(d.break_start_min)}–${t12(d.break_end_min)})</small>` : '') : '<span class="muted">Closed</span>'}</b></div>`).join('');
  const svc = r.services.length ? r.services.map((x) => `<div class="kv"><span>${esc(x.name)}${x.active ? '' : ' <small class="muted">(hidden)</small>'}</span><b>${naira(x.price_kobo)} · ${x.duration_min} min</b></div>`).join('') : '<div class="muted small">No services yet.</div>';
  const hist = r.history.length ? r.history.map((h) => `<div class="kv"><span>${esc(ACTION_TXT[h.action] || h.action)}${h.details && (h.details.reason || h.details.message || h.details.note) ? `<small class="muted" style="display:block">${esc(h.details.reason || h.details.message || h.details.note)}</small>` : ''}</span><b class="small muted">${stamp(h.created_at)}</b></div>`).join('') : '<div class="muted small">No review history yet.</div>';
  const btns = [];
  if (st === 'VERIFIED') { btns.push(act(b.booking_paused ? 'Resume bookings' : 'Pause bookings', 'sec', 'data-k="pause"')); }
  btns.push(act('Fee', 'sec', 'data-k="fee"')); btns.push(act('Ledger', 'sec', 'data-k="ledger"'));
  if (['PENDING', 'NEEDS_INFO', 'REJECTED'].includes(st)) btns.push(act('Approve', '', 'data-k="approve"'));
  if (['PENDING', 'NEEDS_INFO'].includes(st)) { btns.push(act('Request info', 'sec', 'data-k="info"')); btns.push(act('Reject', 'red', 'data-k="reject"')); }
  btns.push(act('Delete…', 'red', 'data-k="delete"'));
  if (st === 'VERIFIED') btns.push(act('Suspend', 'red', 'data-k="suspend"'));
  if (st === 'SUSPENDED') btns.push(act('Reinstate', '', 'data-k="reinstate"'));
  const m = modal(`<div class="sh-h"><div><h2 style="margin:0">${esc(b.shop_name)}</h2><div class="muted small">${esc(b.location || 'No location')}</div></div><button class="btn sm sec" data-close aria-label="Close">Close</button></div>
    <div class="row-badges">${rsBadge(st)} ${b.paystack_subaccount ? bd('b-green', 'PAYOUTS ACTIVE' + (b.payout_account_last4 ? ' · ' + esc(b.payout_bank_name || 'Bank') + ' ••' + esc(b.payout_account_last4) : '')) : bd('b-gray', 'NO PAYOUT ACCOUNT')} ${b.booking_paused ? bd('b-amber', 'BOOKINGS PAUSED') : ''} ${b.fee_percent_override != null || b.fee_flat_kobo_override != null ? bd('b-blue', 'CUSTOM FEE') : ''} ${b.owed_kobo ? bd('b-red', 'OWES ' + naira(b.owed_kobo)) : ''}</div>
    ${b.booking_paused && b.pause_reason ? `<div class="note"><b>Bookings paused</b>${esc(b.pause_reason)}</div>` : ''}
    ${b.review_reason ? `<div class="note"><b>${st === 'NEEDS_INFO' ? 'Message sent' : 'Reason shown to barber'}</b>${esc(b.review_reason)}</div>` : ''}
    ${b.resubmit_note || b.resubmitted_at ? `<div class="note"><b>Resubmitted ${stamp(b.resubmitted_at)}</b>${esc(b.resubmit_note || 'No note added.')}</div>` : ''}
    <h3>Owner &amp; contact</h3><div class="kv"><span>Name</span><b>${esc(b.name)}</b></div><div class="kv"><span>Email</span><b>${esc(b.email || '—')}</b></div><div class="kv"><span>Phone</span><b>${esc(b.phone || '—')}</b></div><div class="kv"><span>Signed up</span><b>${dshort(b.created_at)}</b></div>
    ${b.about ? `<h3>About</h3><p class="small" style="margin:0;overflow-wrap:anywhere">${esc(b.about)}</p>` : ''}
    <h3>Activity</h3><div class="kv"><span>Completed / active bookings</span><b>${b.bookings}</b></div><div class="kv"><span>Upcoming bookings</span><b>${b.upcoming}</b></div><div class="kv"><span>Active plans</span><b>${r.plans}</b></div><div class="kv"><span>Photo</span><b>${b.has_photo ? 'Yes' : 'No'}</b></div>
    <h3>Services (${r.services.length})</h3>${svc}<h3>Opening hours</h3>${sched}<h3>Review history</h3>${hist}
    <div class="btns end sticky">${btns.join('')}</div>`);
  const done = async (msg) => { m.close(); toast(msg); await reload(); };
  const call = (k, body) => api(`/barbers/${id}/${k}`, { method: 'POST', body: body || {} });
  m.el.querySelectorAll('[data-k]').forEach((x) => x.onclick = async () => {
    const k = x.dataset.k;
    if (k === 'pause') { m.close(); ADM2.barberPause({ ...b, id }, reload); return; }
    if (k === 'fee') { m.close(); ADM2.barberFee({ ...b, id }, reload); return; }
    if (k === 'ledger') { m.close(); ADM2.ledgerSheet(id, reload); return; }
    if (k === 'delete') { m.close(); ADM4.deleteDialog({ type: 'barber', id, name: b.shop_name, after: reload }); return; }
    if (k === 'approve') { x.disabled = true; try { await call('approve'); await done('Barber approved'); } catch (e) { toast(e.message, true); x.disabled = false; } return; }
    if (k === 'reinstate') { x.disabled = true; try { await call('reinstate'); await done('Barber reinstated'); } catch (e) { toast(e.message, true); x.disabled = false; } return; }
    const cfg = {
      reject: { title: 'Reject ' + b.shop_name, help: 'The barber sees this reason and can fix things and resubmit.', label: 'Reason (shown to the barber)', ph: 'e.g. Please add a clear shop photo and your real address.', go: 'Reject shop', cls: 'red', path: 'reject', key: 'reason', ok: 'Barber rejected' },
      info: { title: 'Ask ' + b.shop_name + ' for more information', help: 'The barber gets a notification with your message and can resubmit once updated.', label: 'Message to the barber', ph: 'e.g. Please add at least one service with prices.', go: 'Send request', path: 'request-info', key: 'message', ok: 'Request sent' },
      suspend: { title: 'Suspend ' + b.shop_name, help: 'The shop is hidden from customers and cannot take new bookings. You can reinstate it later.', label: 'Reason (shown to the barber)', ph: 'e.g. Complaints about no-shows.', go: 'Suspend shop', cls: 'red', path: 'suspend', key: 'reason', ok: 'Barber suspended' },
    }[k];
    m.close();
    const f = modal(reasonForm(cfg)); const txt = $('#rtxt', f.el); txt.focus();
    let choice;
    const send = async (extra) => {
      const go = $('#rgo', f.el); go.disabled = true; $('#rerr', f.el).classList.add('hidden');
      try { const out = await call(cfg.path, { [cfg.key]: txt.value.trim(), ...(extra || {}) }); f.close(); toast(cfg.ok + (out.upcoming ? ` · ${out.customers_notified} customer${out.customers_notified === 1 ? '' : 's'} notified${out.cancelled ? `, ${out.cancelled} cancelled` : ''}` : '')); await reload(); }
      catch (e) {
        go.disabled = false;
        if (e.code === 'FUTURE_BOOKINGS' && e.details) {
          const n = e.details.count; $('#rwarn', f.el).innerHTML = `<div class="warnbox"><b>${n} upcoming booking${n === 1 ? '' : 's'}</b><div class="small">${e.details.bookings.map((k) => esc(k.when + ' · ' + k.service_name + (k.paid ? ' (paid)' : ''))).join('<br>')}${n > e.details.bookings.length ? '<br>…' : ''}</div>
            <p class="small" style="margin:8px 0 0">Nothing is cancelled unless you choose it. Customers are notified either way.</p>
            <div class="btns end" style="margin-top:8px"><button type="button" class="btn sm sec" id="keepb">Suspend, keep bookings</button><button type="button" class="btn sm red" id="cancelb">Suspend and cancel ${n}</button></div></div>`;
          $('#keepb', f.el).onclick = () => send({ bookings: 'keep' });
          $('#cancelb', f.el).onclick = () => { if (confirm(`Cancel ${n} booking${n === 1 ? '' : 's'}? Customers are told and paid ones are refunded.`)) send({ bookings: 'cancel' }); };
          go.classList.add('hidden');
        } else { const er = $('#rerr', f.el); er.textContent = e.message; er.classList.remove('hidden'); }
      }
    };
    $('#rfm', f.el).onsubmit = (ev) => { ev.preventDefault(); send(); };
  });
}
async function barbers() {
  const r = await api('/barbers');
  badges.pending = (r.counts.PENDING || 0) + (r.counts.NEEDS_INFO || 0); drawNav('barbers');
  if (!btabSet) { btabSet = true; if (!r.counts.PENDING && !r.counts.NEEDS_INFO) btab = 'ALL'; }
  const rows = r.barbers.filter((b) => btab === 'ALL' || b.review_status === btab);
  const cols = [
    ['Shop', (b) => `${esc(b.shop_name)}<span class="sub">${esc(b.location || 'No location')}</span>`],
    ['Owner', (b) => `${esc(b.name)}<span class="sub">${esc(b.email || b.phone || '')}</span>`],
    ['Status', (b) => rsBadge(b.review_status) + (b.resubmitted_at && b.review_status === 'PENDING' ? ' ' + bd('b-blue', 'RESUBMITTED') : '')],
    ['Payouts', (b) => (b.payout_set || b.paystack_subaccount) ? bd('b-green', 'ACTIVE') : bd('b-gray', 'NOT SET')],
    ['Services', (b) => b.services, 'num'], ['Bookings', (b) => b.bookings, 'num'],
    ['Joined', (b) => dshort(b.created_at)],
    ['', (b) => act('Details', 'sec', `data-do="detail" data-id="${b.id}"`) + (['PENDING', 'NEEDS_INFO', 'REJECTED'].includes(b.review_status) ? act('Approve', '', `data-do="approve" data-id="${b.id}"`) : b.review_status === 'VERIFIED' ? act('Suspend', 'red', `data-do="detail" data-id="${b.id}"`) : act('Reinstate', '', `data-do="reinstate" data-id="${b.id}"`)), 'act'],
  ];
  app.innerHTML = head('Barbers', 'Only verified shops are visible and bookable. Review new signups, ask for more information, reject with a reason, or suspend a live shop (reversible).', refreshBtn) +
    `<div class="pills" role="tablist">${TABS.map(([k, l]) => `<button role="tab" data-tab="${k}" class="${btab === k ? 'on' : ''}">${l} <span class="c">${r.counts[k === 'ALL' ? 'ALL' : k] || 0}</span></button>`).join('')}</div>` +
    table(cols, rows, btab === 'PENDING' ? 'No shops waiting for review.' : 'No barbers in this state.');
  wireReload(barbers);
  app.querySelectorAll('[data-tab]').forEach((x) => x.onclick = () => { btab = x.dataset.tab; barbers(); });
  wireActions(app, {
    detail: async (d) => { await barberDetail(d.id, barbers); app.querySelector(`[data-do="detail"][data-id="${d.id}"]`)?.removeAttribute('disabled'); app.querySelectorAll('[data-do]').forEach((x) => x.disabled = false); },
    approve: async (d) => { await api(`/barbers/${d.id}/approve`, { method: 'POST', body: {} }); toast('Barber approved'); await barbers(); },
    reinstate: async (d) => { await api(`/barbers/${d.id}/reinstate`, { method: 'POST', body: {} }); toast('Barber reinstated'); await barbers(); },
  });
}

const bf = { date: '', barber_id: '', status: '' };
async function bookings() {
  const [bs, r] = await Promise.all([api('/barbers'), api('/bookings?' + new URLSearchParams(Object.fromEntries(Object.entries(bf).filter(([, v]) => v))))]);
  drawNav('bookings');
  const cols = [
    ['Customer', (b) => `${cust(b)}<span class="sub">${esc(b.service_name)}</span>`],
    ['Shop', (b) => esc(b.shop_name)], ['When', (b) => `${dlabel(b.date)}, ${t12(b.start_min)}`],
    ['Status', (b) => bookingBadge(b.status)], ['Payment', (b) => bpay(b.payment_status) + `<span class="sub">${esc(b.payment_option.replace('_', ' ').toLowerCase())}</span>`],
    ['Price', (b) => naira(b.price_kobo), 'num'], ['#', (b) => '#' + b.id, 'num'],
    ['', (b) => act('Manage', 'sec', `data-do="manage" data-id="${b.id}"`), 'act'],
  ];
  app.innerHTML = head('Bookings', 'Newest first, up to 100 results.', refreshBtn) +
    `<div class="filters"><input type="date" id="f-date" value="${esc(bf.date)}" aria-label="Date"><select id="f-barber" aria-label="Barber"><option value="">All barbers</option>${bs.barbers.map((b) => `<option value="${b.id}" ${String(b.id) === bf.barber_id ? 'selected' : ''}>${esc(b.shop_name)}</option>`).join('')}</select>
      <select id="f-status" aria-label="Status"><option value="">Any status</option>${['CONFIRMED', 'ARRIVED', 'IN_SERVICE', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'NOT_SERVED', 'PENDING_PAYMENT'].map((s) => `<option value="${s}" ${s === bf.status ? 'selected' : ''}>${s === 'PENDING_PAYMENT' ? 'NOT CONFIRMED' : s.replace('_', ' ')}</option>`).join('')}</select>
      <button class="btn sm sec" id="f-clear">Clear</button></div>` + table(cols, r.bookings, 'No bookings match these filters.');
  const apply = () => { bf.date = $('#f-date').value; bf.barber_id = $('#f-barber').value; bf.status = $('#f-status').value; bookings(); };
  ['#f-date', '#f-barber', '#f-status'].forEach((s) => $(s).onchange = apply);
  $('#f-clear').onclick = () => { bf.date = bf.barber_id = bf.status = ''; bookings(); };
  wireReload(bookings);
  wireActions(app, { manage: async (d) => { await ADM2.bookingSheet(Number(d.id), bookings); app.querySelectorAll('[data-do]').forEach((x) => x.disabled = false); } });
}

let payFilter = 'needs_refund';
async function payments() {
  const r = await api('/payments?filter=' + payFilter);
  badges.refunds = r.summary.open_refunds; drawNav('payments');
  const cols = [
    ['Payment', (p) => `${esc(p.item || 'Payment')}<span class="sub">${esc(p.customer_name || '')}${p.shop_name ? ' · ' + esc(p.shop_name) : ''}</span>`],
    ['Status', (p) => payBadge(p.status) + (p.refund_status ? ' ' + refundBadge(p.refund_status) : '') + (p.disputed ? ' ' + bd('b-red', 'DISPUTED') : '')],
    ['Amount', (p) => naira(p.amount_kobo), 'num'], ['Fee', (p) => naira(p.fee_kobo), 'num'],
    ['Reference', (p) => `<span class="mono">${esc(p.reference)}</span>${p.refund_reason ? `<span class="sub">${esc(p.refund_reason)}</span>` : ''}${p.refund_error ? `<span class="sub" style="color:var(--red)">Gateway: ${esc(p.refund_error)}</span>` : ''}`],
    ['Date', (p) => stamp(p.verified_at || p.created_at)],
    ['', (p) => (p.status === 'SUCCESS' ? act(p.disputed ? 'Clear flag' : 'Flag', 'sec', `data-do="flag" data-ref="${esc(p.reference)}" data-on="${p.disputed ? 0 : 1}"`) : '') + (p.refund_status === 'NEEDS_REFUND' ? act('Retry refund', '', `data-do="retry" data-ref="${esc(p.reference)}"`) + act('Mark refunded', 'sec', `data-do="mark" data-ref="${esc(p.reference)}"`) : p.refund_status === 'REFUND_REQUESTED' ? act('Mark refunded', 'sec', `data-do="mark" data-ref="${esc(p.reference)}"`) : ''), 'act'],
  ];
  const f = (k, l) => `<button data-f="${k}" class="${payFilter === k ? 'on' : ''}">${l}</button>`;
  app.innerHTML = head('Payments', 'Refunds are requested from Paystack automatically. If that fails, retry it here or mark it refunded once you paid the customer back yourself.', refreshBtn) +
    `<div class="tiles"><div class="tile"><span>Paid</span><b>${r.summary.paid}</b></div><div class="tile"><span>Failed</span><b>${r.summary.failed}</b></div><div class="tile"><span>Initiated, not paid</span><b>${r.summary.initiated}</b></div><div class="tile ${r.summary.open_refunds ? 'alert' : ''}"><span>Refunds to action</span><b>${r.summary.open_refunds}</b></div></div>
    <div class="pills">${f('needs_refund', 'Needs refund')}${f('paid', 'Paid')}${f('failed', 'Failed')}${f('initiated', 'Not paid')}${f('refunds', 'All refunds')}${f('all', 'All')}</div>` + table(cols, r.payments, payFilter === 'needs_refund' ? 'No refunds waiting.' : 'No payments in this view.');
  document.querySelectorAll('.pills [data-f]').forEach((b) => b.onclick = () => { payFilter = b.dataset.f; payments(); });
  wireReload(payments);
  wireActions(app, {
    flag: async (d) => { const on = d.on === '1'; if (!on) { await api(`/payments/${encodeURIComponent(d.ref)}/dispute`, { method: 'POST', body: { disputed: false } }); toast('Flag cleared'); return payments(); } ADM2.formModal({ title: 'Flag payment as disputed', help: 'A private marker for follow-up (e.g. a chargeback or a customer claim). It does not move money.', go: 'Flag payment', fields: [{ name: 'note', label: 'Note', type: 'textarea', required: true }], submit: async (v) => { await api(`/payments/${encodeURIComponent(d.ref)}/dispute`, { method: 'POST', body: { disputed: true, note: v.note } }); return 'Payment flagged'; }, after: payments }); app.querySelectorAll('[data-do]').forEach((x) => x.disabled = false); },
    retry: async (d) => { const x = await api(`/payments/${encodeURIComponent(d.ref)}/retry-refund`, { method: 'POST', body: {} }); toast(x.result === 'requested' ? 'Refund requested from Paystack' : 'Gateway refused: ' + (x.refund_error || 'try again later'), x.result !== 'requested'); await payments(); },
    mark: async (d) => { if (!confirm('Mark this payment as refunded? Only do this after the customer has been paid back.')) throw new Error('Not changed'); await api(`/payments/${encodeURIComponent(d.ref)}/mark-refunded`, { method: 'POST', body: {} }); toast('Marked as refunded'); await payments(); },
  });
}

async function decisions() {
  const r = await api('/cancellations');
  badges.decisions = r.bookings.length; drawNav('decisions');
  const cols = [
    ['Customer', (b) => `${cust(b)}<span class="sub">${esc(b.customer_email || '')}</span>`],
    ['Booking', (b) => `${esc(b.service_name)}<span class="sub">${esc(b.shop_name)} · ${dlabel(b.date)}, ${t12(b.start_min)}</span>`],
    ['Paid', (b) => naira(b.price_kobo), 'num'], ['Cancelled', (b) => stamp(b.cancelled_at)],
    ['', (b) => act('Convert to credit', 'sec', `data-do="credit" data-id="${b.id}"`) + act('Refund', '', `data-do="refund" data-id="${b.id}"`), 'act'],
  ];
  app.innerHTML = head('Refund decisions', `Paid bookings cancelled in time wait here. A credit is a same-barber session valid ${r.credit_expiry_days} days; a refund goes back to the customer's card and the customer is told.`, refreshBtn) + table(cols, r.bookings, 'Nothing is waiting for a decision.', { row: (b) => ({ t: esc(b.customer_name), p: bd('b-amber', 'AWAITING'), m: `${esc(b.service_name)} · ${esc(b.shop_name)} · ${dlabel(b.date)}, ${t12(b.start_min)}`, r: naira(b.price_kobo) }), title: (b) => b.customer_name });
  wireReload(decisions);
  wireActions(app, {
    credit: async (d) => { await api(`/bookings/${d.id}/resolve`, { method: 'POST', body: { action: 'credit' } }); toast('Converted to a session credit'); await decisions(); },
    refund: async (d) => { if (!confirm('Refund this payment to the customer?')) throw new Error('Not changed'); const x = await api(`/bookings/${d.id}/resolve`, { method: 'POST', body: { action: 'refund' } }); toast(x.refund === 'failed' ? 'Marked for refund; the gateway call failed, retry from Payments' : 'Refund requested'); await decisions(); },
  });
}

async function plans() {
  const r = await api('/plans'); drawNav('plans');
  const pc = [
    ['Plan', (p) => `${esc(p.name)}<span class="sub">${esc(p.shop_name)}</span>`], ['Price', (p) => naira(p.price_kobo), 'num'], ['Sessions', (p) => p.sessions, 'num'], ['Valid', (p) => p.validity_days + ' days', 'num'],
    ['Buyers', (p) => p.buyers, 'num'], ['Sales', (p) => naira(p.revenue_kobo), 'num'], ['Status', (p) => p.active ? bd('b-green', 'ON SALE') : bd('b-gray', 'STOPPED')],
    ['', (p) => act(p.active ? 'Hide' : 'Restore', p.active ? 'sec' : '', `data-do="vis" data-id="${p.id}" data-on="${p.active ? 0 : 1}" data-n="${esc(p.name)}"`), 'act'],
  ];
  const uc = [
    ['Customer', (p) => `${cust(p)}<span class="sub">${esc(p.plan_name)} · ${esc(p.shop_name)}</span>`], ['Paid', (p) => naira(p.price_kobo), 'num'],
    ['Sessions left', (p) => `${p.sessions_total - p.sessions_used} of ${p.sessions_total}`, 'num'], ['Bought', (p) => dshort(p.paid_at)], ['Ends', (p) => dshort(p.expires_at)],
    ['Status', (p) => p.status === 'CANCELLED' ? bd('b-red', 'CANCELLED') : p.live ? bd('b-green', 'ACTIVE') : bd('b-gray', p.sessions_used >= p.sessions_total ? 'USED UP' : 'ENDED')],
    ['', (p) => p.status === 'ACTIVE' ? act('Adjust', 'sec', `data-do="padj" data-id="${p.id}"`) + act('Cancel', 'red', `data-do="pcan" data-id="${p.id}"`) : '', 'act'],
  ];
  app.innerHTML = head('Plans', 'What barbers sell and what customers have bought.', refreshBtn) + `<h2>Plans on offer</h2>${table(pc, r.plans, 'No plans yet.')}<h2>Purchases</h2>${table(uc, r.purchases, 'No purchases yet.')}`;
  wireReload(plans);
  const unlock = () => app.querySelectorAll('[data-do]').forEach((x) => x.disabled = false);
  wireActions(app, {
    vis: async (d) => { const on = d.on === '1'; ADM2.formModal({ title: (on ? 'Restore plan ' : 'Hide plan ') + d.n, help: on ? 'The plan goes back on sale.' : 'Customers can no longer buy it. Existing purchases keep working. The barber is told.', go: on ? 'Restore' : 'Hide plan', fields: [ADM2.REASON()], submit: async (v) => { await ADM2.post(`/plans/${d.id}/visibility`, { active: on, reason: v.reason }); return on ? 'Plan restored' : 'Plan hidden'; }, after: plans }); unlock(); },
    padj: async (d) => { ADM2.formModal({ title: 'Adjust plan purchase #' + d.id, help: 'Add or remove sessions and/or extend the expiry. The customer is told.', go: 'Apply', fields: [{ name: 'delta', label: 'Sessions to add (negative removes)', type: 'number', step: 1, ph: '0' }, { name: 'extend_days', label: 'Extend expiry by (days, negative shortens)', type: 'number', step: 1, ph: '0' }, ADM2.REASON()], submit: async (v) => { await ADM2.post(`/plan-purchases/${d.id}/adjust`, { reason: v.reason, delta: v.delta || undefined, extend_days: v.extend_days || undefined }); return 'Plan purchase updated'; }, after: plans }); unlock(); },
    pcan: async (d) => { ADM2.formModal({ title: 'Cancel plan purchase #' + d.id, help: 'Ends the plan. Tick refund to flag the payment for a refund (requested from Paystack at once).', go: 'Cancel purchase', cls: 'red', fields: [{ name: 'refund', label: 'Also refund the payment', type: 'checkbox' }, ADM2.REASON()], submit: async (v) => { const o = await ADM2.post(`/plan-purchases/${d.id}/cancel`, { reason: v.reason, refund: v.refund }); return 'Purchase cancelled' + (o.refund === 'requested' ? ' · refund requested' : o.refund === 'failed' ? ' · refund could not be requested, see Payments' : ''); }, after: plans }); unlock(); },
  });
}

async function credits() {
  const r = await api('/credits'); drawNav('credits');
  const cols = [
    ['Customer', (c) => `${cust(c)}<span class="sub">${esc(c.shop_name)}</span>`], ['Reason', (c) => ({ NO_SHOW: 'No-show', LATE_CANCEL: 'Late cancel', EARLY_CANCEL: 'Cancelled in time' }[c.reason] || esc(c.reason))],
    ['Value', (c) => 'up to ' + naira(c.value_kobo), 'num'], ['Issued', (c) => dshort(c.created_at)], ['Expires', (c) => dshort(c.expires_at)],
    ['Status', (c) => c.status === 'USED' ? bd('b-gray', 'USED') : c.status === 'REVOKED' ? bd('b-red', 'REVOKED') : c.live ? bd('b-purple', 'AVAILABLE') : bd('b-gray', 'EXPIRED')],
    ['', (c) => c.status === 'AVAILABLE' ? act('Revoke', 'sec', `data-do="rev" data-id="${c.id}"`) : '', 'act'],
  ];
  app.innerHTML = head('Credits', 'Same-barber session credits. They are never cashable. Issue one to a customer from their profile (Customers).', refreshBtn) + table(cols, r.credits, 'No credits issued yet.');
  wireReload(credits);
  wireActions(app, { rev: async (d) => { ADM2.formModal({ title: 'Revoke credit #' + d.id, help: 'The customer is told their credit was removed.', go: 'Revoke credit', cls: 'red', fields: [ADM2.REASON()], submit: async (v) => { await ADM2.post(`/credits/${d.id}/revoke`, v); return 'Credit revoked'; }, after: credits }); app.querySelectorAll('[data-do]').forEach((x) => x.disabled = false); } });
}

const FIELDS = [
  ['min_plan_price_naira', 'Minimum plan price (₦)', 'number'], ['max_plan_price_naira', 'Maximum plan price (₦)', 'number'],
  ['max_plan_validity_days', 'Maximum plan duration (days)', 'number'], ['max_plan_sessions', 'Maximum sessions per plan', 'number'],
  ['platform_fee_percent', 'Platform fee (%)', 'number'], ['platform_fee_naira', 'Platform fee, flat (₦)', 'number'],
  ['credit_expiry_days', 'Credit expiry (days)', 'number'], ['plan_refund_policy', 'Unused plan sessions', 'select'],
  ['credit_on_missed_session', 'A missed paid session (no-show or late cancel) gives 1 credit', 'checkbox'],
  ['credit_on_early_cancel_prepaid', 'Cancelling a prepaid booking in time gives a credit', 'checkbox'],
];
async function rules() {
  const { settings: s } = await api('/settings'); drawNav('rules');
  const el = (k, l, t) => t === 'checkbox' ? `<label class="chk"><input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''}> ${esc(l)}</label>`
    : t === 'select' ? `<div><label>${esc(l)}</label><select name="${k}"><option value="NONE" ${s[k] === 'NONE' ? 'selected' : ''}>No refund</option><option value="MANUAL" ${s[k] === 'MANUAL' ? 'selected' : ''}>Case by case</option></select></div>`
      : `<div><label>${esc(l)}</label><input type="number" step="any" min="0" name="${k}" value="${esc(s[k])}"></div>`;
  app.innerHTML = head('Platform rules', 'Barbers cannot create plans outside these limits. Changes apply to new plans and new bookings.') +
    `<div class="card"><form id="rf"><div class="formgrid">${FIELDS.filter((f) => f[2] !== 'checkbox').map(([k, l, t]) => el(k, l, t)).join('')}</div>${FIELDS.filter((f) => f[2] === 'checkbox').map(([k, l, t]) => el(k, l, t)).join('')}
      <div class="btns cta"><button class="btn" type="submit">Save rules</button></div><p class="small muted" style="margin:8px 0 0">Last saved ${stamp(s.updated_at)}</p></form></div>`;
  $('#rf').onsubmit = async (ev) => {
    ev.preventDefault(); const out = {}; const f = ev.target.elements;
    for (const [k, , t] of FIELDS) out[k] = t === 'checkbox' ? f[k].checked : t === 'number' ? Number(f[k].value) : f[k].value;
    const b = ev.target.querySelector('button'); b.disabled = true;
    try { await api('/settings', { method: 'PUT', body: out }); toast('Rules saved'); await rules(); } catch (e) { toast(e.message, true); b.disabled = false; }
  };
}

const ACTION_TXT = { SETTINGS_UPDATED: 'Platform rules updated', ADMIN_BARBER_VERIFIED: 'Barber approved', ADMIN_BARBER_SUSPENDED: 'Barber suspended', ADMIN_BARBER_REINSTATED: 'Barber reinstated', ADMIN_BARBER_REJECTED: 'Barber rejected', ADMIN_BARBER_INFO_REQUESTED: 'More information requested', ADMIN_BOOKING_CANCELLED_SUSPENSION: 'Booking cancelled (shop suspended)', BARBER_RESUBMITTED: 'Barber resubmitted for review', ADMIN_REFUND_RETRIED: 'Refund retried', ADMIN_MARKED_REFUNDED: 'Marked as refunded', ADMIN_RESOLVED_CREDIT: 'Cancellation converted to credit', ADMIN_RESOLVED_REFUND: 'Cancellation refunded', BARBER_SIGNUP: 'Barber signed up', BARBER_VERIFIED: 'Barber verified (CLI)', BARBER_UNVERIFIED: 'Barber unverified (CLI)' };
async function audit() {
  const r = await api('/audit'); drawNav('audit');
  app.innerHTML = head('Audit log', 'Admin actions and key platform events, newest first.', refreshBtn) +
    (r.entries.length ? `<div class="card log">${r.entries.map((e) => `<div style="padding:8px 0;border-top:1px solid var(--line)"><b>${esc(ACTION_TXT[e.action] || e.action)}</b> ${e.actor_role === 'admin' ? bd('b-blue', 'ADMIN') : ''}<div class="when">${stamp(e.created_at)}${e.booking_id ? ' · booking #' + e.booking_id : ''}</div>${e.details ? `<pre>${esc(JSON.stringify(e.details))}</pre>` : ''}</div>`).join('')}</div>` : '<div class="empty">No entries yet.</div>');
  wireReload(audit);
}

/* ---------- shell / routing ---------- */
const ROUTES = { overview, barbers, bookings, payments, decisions, plans, credits, rules, audit };
async function route() {
  if (!getKey()) return showLogin();
  const raw = location.hash.replace(/^#\/?/, '') || 'home'; const qi = raw.indexOf('?');
  const k = qi < 0 ? raw : raw.slice(0, qi); window.QS = new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1));
  const fn = ROUTES[k] || ROUTES.home || overview;
  $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden');
  drawTop();
  app.innerHTML = '<div class="sk sk-h"></div><div class="card"><div class="sk sk-l"></div><div class="sk sk-l s"></div></div>';
  try { await fn(); } catch (e) { if (getKey()) app.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
  if (k !== 'home' && !badges.__loaded) { badges.__loaded = true; api('/home').then((o) => { const m = Object.fromEntries(o.attention.map((a) => [a.key, a.n])); badges.pending = m.barbers || 0; badges.decisions = m.decisions || 0; badges.refunds = m.refunds || 0; badges.reports = m.reports || 0; drawNav(k); }).catch(() => {}); }
}
function drawTop() {
  $('#topright').innerHTML = `<button id="theme" aria-label="Toggle dark mode"><svg class="i" viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg></button><button id="so" class="btn sm sec">Sign out</button>`;
  $('#so').onclick = () => signOut(false);
  if (window.ADM2) ADM2.mountSearch();
  $('#theme').onclick = () => { const d = document.documentElement.getAttribute('data-theme') !== 'dark'; if (d) document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme'); try { localStorage.setItem('trimslot_theme', d ? 'dark' : 'light'); } catch { /* ignore */ } };
}
function showLogin(msg) {
  $('#shell').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#topright').innerHTML = ''; badges = { pending: 0, decisions: 0, refunds: 0, reports: 0, ledger: 0 }; const gs = $('.gsearch'); if (gs) gs.remove();
  const m = $('#lmsg'); if (msg) { m.textContent = msg; m.classList.remove('hidden'); } else m.classList.add('hidden');
  $('#key').value = ''; setTimeout(() => $('#key').focus(), 50);
}
$('#lf').onsubmit = async (ev) => {
  ev.preventDefault(); const k = $('#key').value.trim(); if (!k) return;
  const b = ev.target.querySelector('button'); b.disabled = true;
  try {
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' }, body: '{}' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 401 ? 'That key is not right.' : j.error?.message || 'Could not sign in.');
    sessionStorage.setItem(KEY, k); $('#key').value = ''; location.hash = '#/home'; route();
  } catch (e) { showLogin(e.message); } finally { b.disabled = false; }
};
window.addEventListener('hashchange', route);
setTimeout(route, 0);   // admin2.js registers more sections first
