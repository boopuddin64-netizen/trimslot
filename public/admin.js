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
  const r = await fetch('/api/admin' + path, { method: opts.method || 'GET', headers: { Authorization: 'Bearer ' + getKey(), ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  let j = {}; try { j = await r.json(); } catch { /* empty */ }
  if (r.status === 401 && path !== '/login') { signOut(true); throw new Error('Session ended. Sign in again.'); }
  if (!r.ok) { const e = new Error(j.error?.message || 'Request failed'); e.status = r.status; throw e; }
  return j;
}
function signOut(silent) { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } showLogin(silent ? 'Sign in again to continue.' : ''); }

/* ---------- badges ---------- */
const bd = (cls, t) => `<span class="badge ${cls}">${esc(t)}</span>`;
const bookingBadge = (s) => bd({ CONFIRMED: 'b-blue', ARRIVED: 'b-green', IN_SERVICE: 'b-purple', COMPLETED: 'b-gray', CANCELLED: 'b-red', NO_SHOW: 'b-red', NOT_SERVED: 'b-red', PENDING_PAYMENT: 'b-amber' }[s] || 'b-gray', s === 'PENDING_PAYMENT' ? 'NOT CONFIRMED' : s.replace('_', ' '));
const payBadge = (s) => bd({ SUCCESS: 'b-green', FAILED: 'b-red', INITIATED: 'b-amber' }[s] || 'b-gray', s === 'SUCCESS' ? 'PAID' : s);
const refundBadge = (s) => s ? bd({ NEEDS_REFUND: 'b-amber', REFUND_REQUESTED: 'b-blue', REFUNDED: 'b-green' }[s] || 'b-gray', s.replace('_', ' ')) : '';
const bpay = (s) => bd({ PAID: 'b-green', CREDIT_PENDING: 'b-purple', CREDITED: 'b-purple', PAYMENT_DUE: 'b-amber', VOID: 'b-gray', PENDING: 'b-amber' }[s] || 'b-gray', s.replace('_', ' '));

/* table helper: rows -> responsive table (cards on phones). cols: [label, fn(row)->html, cls] ; first col is the card title */
function table(cols, rows, empty) {
  if (!rows.length) return `<div class="empty">${esc(empty || 'Nothing here.')}</div>`;
  const head = cols.map(([l, , c]) => `<th class="${c === 'num' ? 'num' : ''}">${esc(l)}</th>`).join('');
  const body = rows.map((r) => `<tr>${cols.map(([l, f, c], i) => `<td class="${i === 0 ? 'main' : c === 'act' ? 'act' : c === 'num' ? 'num' : ''}" data-l="${esc(l)}">${f(r)}</td>`).join('')}</tr>`).join('');
  return `<div class="tblwrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
const cust = (r) => `<b>${esc(r.customer_name)}</b>`;

/* ---------- sections ---------- */
const SECTIONS = [
  ['overview', 'Overview', '<path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z"/>'],
  ['barbers', 'Barbers', '<path d="M4 9h16l-1-5H5ZM5 9v11h14V9M9 20v-6h6v6"/>'],
  ['bookings', 'Bookings', '<rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/>'],
  ['payments', 'Payments', '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20"/>'],
  ['decisions', 'Refund decisions', '<path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/>'],
  ['plans', 'Plans', '<path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1ZM14 5v14"/>'],
  ['credits', 'Credits', '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 10h4.5a1.5 1.5 0 0 1 0 3H9.5a1.5 1.5 0 0 0 0 3H15"/>'],
  ['rules', 'Platform rules', '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'],
  ['audit', 'Audit log', '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'],
];
let badges = { pending: 0, decisions: 0, refunds: 0 };
function drawNav(cur) {
  const cnt = { barbers: badges.pending, decisions: badges.decisions, payments: badges.refunds };
  $('#nav').innerHTML = SECTIONS.map(([k, l, d], i) => `${k === 'rules' ? '<div class="sep"></div>' : ''}<a href="#/${k}" class="${k === cur ? 'on' : ''}">${ic(d)}${l}${cnt[k] ? `<span class="cnt">${cnt[k]}</span>` : ''}</a>`).join('');
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
  badges = { pending: o.barbers_pending, decisions: o.awaiting_decision, refunds: o.refunds_open }; drawNav('overview');
  const tile = (l, v, s, href, alert) => `<div class="tile ${alert ? 'alert' : ''}">${href ? `<a href="${href}">` : ''}<span>${l}</span><b>${v}</b>${s ? `<small>${s}</small>` : ''}${href ? '</a>' : ''}</div>`;
  app.innerHTML = head('Overview', 'Today is ' + dlabel(o.today) + '. Amounts are in Nigerian naira.', refreshBtn) +
    `<div class="tiles">${tile('Barbers', o.barbers_verified, 'verified and live')}${tile('Pending verification', o.barbers_pending, o.barbers_pending ? 'Review now' : 'All caught up', '#/barbers', o.barbers_pending > 0)}
      ${tile('Customers', o.customers)}${tile('Bookings today', o.bookings_today, o.bookings_total + ' all time')}
      ${tile('Revenue', naira(o.revenue_kobo), naira(o.revenue_30d_kobo) + ' last 30 days')}${tile('Platform fees', naira(o.fees_kobo), 'of paid online payments')}
      ${tile('Plan sales', naira(o.plan_sales_kobo), o.active_plans + ' active plans')}${tile('Live credits', o.live_credits, 'unexpired session credits')}</div>
    <div class="tiles">${tile('Refunds to action', o.refunds_open, 'flagged payments', '#/payments', o.refunds_open > 0)}${tile('Cancellations awaiting decision', o.awaiting_decision, 'convert to credit or refund', '#/decisions', o.awaiting_decision > 0)}</div>`;
  wireReload(overview);
}

async function barbers() {
  const r = await api('/barbers');
  badges.pending = r.barbers.filter((b) => !b.verified).length; drawNav('barbers');
  const pending = r.barbers.filter((b) => !b.verified), live = r.barbers.filter((b) => b.verified);
  const cols = [
    ['Shop', (b) => `${esc(b.shop_name)}<span class="sub">${esc(b.location || 'No location')}</span>`],
    ['Owner', (b) => `${esc(b.name)}<span class="sub">${esc(b.email || b.phone || '')}</span>`],
    ['Status', (b) => b.verified ? bd('b-green', 'VERIFIED') : bd('b-amber', 'PENDING')],
    ['Paystack', (b) => b.paystack_subaccount ? bd('b-green', 'SUBACCOUNT SET') : bd('b-gray', 'NOT SET')],
    ['Services', (b) => b.services, 'num'], ['Bookings', (b) => b.bookings, 'num'],
    ['Joined', (b) => dshort(b.created_at)],
    ['', (b) => b.verified ? act('Suspend', 'red', `data-do="suspend" data-id="${b.id}" data-n="${esc(b.shop_name)}"`) : act('Verify', '', `data-do="verify" data-id="${b.id}"`), 'act'],
  ];
  app.innerHTML = head('Barbers', 'Verified shops are visible to customers. Suspending hides a shop and stops new bookings; existing bookings are kept.', refreshBtn) +
    (pending.length ? `<h2>Pending verification (${pending.length})</h2>${table(cols, pending)}` : '') + `<h2>Live shops (${live.length})</h2>${table(cols, live, 'No verified barbers yet.')}`;
  wireReload(barbers);
  wireActions(app, {
    verify: async (d) => { await api(`/barbers/${d.id}/verify`, { method: 'POST', body: {} }); toast('Barber verified'); await barbers(); },
    suspend: async (d) => { if (!confirm(`Suspend ${d.n}? They will be hidden from customers.`)) throw new Error('Not changed'); await api(`/barbers/${d.id}/suspend`, { method: 'POST', body: {} }); toast('Barber suspended'); await barbers(); },
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
  ];
  app.innerHTML = head('Bookings', 'Newest first, up to 100 results.', refreshBtn) +
    `<div class="filters"><input type="date" id="f-date" value="${esc(bf.date)}" aria-label="Date"><select id="f-barber" aria-label="Barber"><option value="">All barbers</option>${bs.barbers.map((b) => `<option value="${b.id}" ${String(b.id) === bf.barber_id ? 'selected' : ''}>${esc(b.shop_name)}</option>`).join('')}</select>
      <select id="f-status" aria-label="Status"><option value="">Any status</option>${['CONFIRMED', 'ARRIVED', 'IN_SERVICE', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'NOT_SERVED', 'PENDING_PAYMENT'].map((s) => `<option value="${s}" ${s === bf.status ? 'selected' : ''}>${s === 'PENDING_PAYMENT' ? 'NOT CONFIRMED' : s.replace('_', ' ')}</option>`).join('')}</select>
      <button class="btn sm sec" id="f-clear">Clear</button></div>` + table(cols, r.bookings, 'No bookings match these filters.');
  const apply = () => { bf.date = $('#f-date').value; bf.barber_id = $('#f-barber').value; bf.status = $('#f-status').value; bookings(); };
  ['#f-date', '#f-barber', '#f-status'].forEach((s) => $(s).onchange = apply);
  $('#f-clear').onclick = () => { bf.date = bf.barber_id = bf.status = ''; bookings(); };
  wireReload(bookings);
}

let payFilter = 'needs_refund';
async function payments() {
  const r = await api('/payments?filter=' + payFilter);
  badges.refunds = r.summary.open_refunds; drawNav('payments');
  const cols = [
    ['Payment', (p) => `${esc(p.item || 'Payment')}<span class="sub">${esc(p.customer_name || '')}${p.shop_name ? ' · ' + esc(p.shop_name) : ''}</span>`],
    ['Status', (p) => payBadge(p.status) + (p.refund_status ? ' ' + refundBadge(p.refund_status) : '')],
    ['Amount', (p) => naira(p.amount_kobo), 'num'], ['Fee', (p) => naira(p.fee_kobo), 'num'],
    ['Reference', (p) => `<span class="mono">${esc(p.reference)}</span>${p.refund_reason ? `<span class="sub">${esc(p.refund_reason)}</span>` : ''}${p.refund_error ? `<span class="sub" style="color:var(--red)">Gateway: ${esc(p.refund_error)}</span>` : ''}`],
    ['Date', (p) => stamp(p.verified_at || p.created_at)],
    ['', (p) => p.refund_status === 'NEEDS_REFUND' ? act('Retry refund', '', `data-do="retry" data-ref="${esc(p.reference)}"`) + act('Mark refunded', 'sec', `data-do="mark" data-ref="${esc(p.reference)}"`) : p.refund_status === 'REFUND_REQUESTED' ? act('Mark refunded', 'sec', `data-do="mark" data-ref="${esc(p.reference)}"`) : '', 'act'],
  ];
  const f = (k, l) => `<button data-f="${k}" class="${payFilter === k ? 'on' : ''}">${l}</button>`;
  app.innerHTML = head('Payments', 'Refunds are requested from Paystack automatically. If that fails, retry it here or mark it refunded once you paid the customer back yourself.', refreshBtn) +
    `<div class="tiles"><div class="tile"><span>Paid</span><b>${r.summary.paid}</b></div><div class="tile"><span>Failed</span><b>${r.summary.failed}</b></div><div class="tile"><span>Initiated, not paid</span><b>${r.summary.initiated}</b></div><div class="tile ${r.summary.open_refunds ? 'alert' : ''}"><span>Refunds to action</span><b>${r.summary.open_refunds}</b></div></div>
    <div class="pills">${f('needs_refund', 'Needs refund')}${f('paid', 'Paid')}${f('failed', 'Failed')}${f('initiated', 'Not paid')}${f('refunds', 'All refunds')}${f('all', 'All')}</div>` + table(cols, r.payments, payFilter === 'needs_refund' ? 'No refunds waiting.' : 'No payments in this view.');
  document.querySelectorAll('.pills [data-f]').forEach((b) => b.onclick = () => { payFilter = b.dataset.f; payments(); });
  wireReload(payments);
  wireActions(app, {
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
  app.innerHTML = head('Refund decisions', `Paid bookings cancelled in time wait here. A credit is a same-barber session valid ${r.credit_expiry_days} days; a refund goes back to the customer's card and the customer is told.`, refreshBtn) + table(cols, r.bookings, 'Nothing is waiting for a decision.');
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
  ];
  const uc = [
    ['Customer', (p) => `${cust(p)}<span class="sub">${esc(p.plan_name)} · ${esc(p.shop_name)}</span>`], ['Paid', (p) => naira(p.price_kobo), 'num'],
    ['Sessions left', (p) => `${p.sessions_total - p.sessions_used} of ${p.sessions_total}`, 'num'], ['Bought', (p) => dshort(p.paid_at)], ['Ends', (p) => dshort(p.expires_at)],
    ['Status', (p) => p.live ? bd('b-green', 'ACTIVE') : bd('b-gray', p.sessions_used >= p.sessions_total ? 'USED UP' : 'ENDED')],
  ];
  app.innerHTML = head('Plans', 'What barbers sell and what customers have bought.', refreshBtn) + `<h2>Plans on offer</h2>${table(pc, r.plans, 'No plans yet.')}<h2>Purchases</h2>${table(uc, r.purchases, 'No purchases yet.')}`;
  wireReload(plans);
}

async function credits() {
  const r = await api('/credits'); drawNav('credits');
  const cols = [
    ['Customer', (c) => `${cust(c)}<span class="sub">${esc(c.shop_name)}</span>`], ['Reason', (c) => ({ NO_SHOW: 'No-show', LATE_CANCEL: 'Late cancel', EARLY_CANCEL: 'Cancelled in time' }[c.reason] || esc(c.reason))],
    ['Value', (c) => 'up to ' + naira(c.value_kobo), 'num'], ['Issued', (c) => dshort(c.created_at)], ['Expires', (c) => dshort(c.expires_at)],
    ['Status', (c) => c.status === 'USED' ? bd('b-gray', 'USED') : c.live ? bd('b-purple', 'AVAILABLE') : bd('b-gray', 'EXPIRED')],
  ];
  app.innerHTML = head('Credits', 'Same-barber session credits. They are never cashable.', refreshBtn) + table(cols, r.credits, 'No credits issued yet.');
  wireReload(credits);
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

const ACTION_TXT = { SETTINGS_UPDATED: 'Platform rules updated', ADMIN_BARBER_VERIFIED: 'Barber verified', ADMIN_BARBER_SUSPENDED: 'Barber suspended', ADMIN_REFUND_RETRIED: 'Refund retried', ADMIN_MARKED_REFUNDED: 'Marked as refunded', ADMIN_RESOLVED_CREDIT: 'Cancellation converted to credit', ADMIN_RESOLVED_REFUND: 'Cancellation refunded', BARBER_SIGNUP: 'Barber signed up', BARBER_VERIFIED: 'Barber verified (CLI)', BARBER_UNVERIFIED: 'Barber unverified (CLI)' };
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
  const k = (location.hash.replace(/^#\/?/, '') || 'overview');
  const fn = ROUTES[k] || overview;
  $('#login').classList.add('hidden'); $('#shell').classList.remove('hidden');
  drawTop();
  app.innerHTML = '<div class="sk sk-h"></div><div class="card"><div class="sk sk-l"></div><div class="sk sk-l s"></div></div>';
  try { await fn(); } catch (e) { if (getKey()) app.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
  if (k !== 'overview' && !badges.__loaded) { badges.__loaded = true; api('/overview').then((o) => { badges.pending = o.barbers_pending; badges.decisions = o.awaiting_decision; badges.refunds = o.refunds_open; drawNav(k); }).catch(() => {}); }
}
function drawTop() {
  $('#topright').innerHTML = `<button id="theme" aria-label="Toggle dark mode"><svg class="i" viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg></button><button id="so" class="btn sm sec">Sign out</button>`;
  $('#so').onclick = () => signOut(false);
  $('#theme').onclick = () => { const d = document.documentElement.getAttribute('data-theme') !== 'dark'; if (d) document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme'); try { localStorage.setItem('trimslot_theme', d ? 'dark' : 'light'); } catch { /* ignore */ } };
}
function showLogin(msg) {
  $('#shell').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#topright').innerHTML = ''; badges = { pending: 0, decisions: 0, refunds: 0 };
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
    sessionStorage.setItem(KEY, k); $('#key').value = ''; location.hash = '#/overview'; route();
  } catch (e) { showLogin(e.message); } finally { b.disabled = false; }
};
window.addEventListener('hashchange', route);
route();
