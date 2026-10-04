/* TrimSlot admin portal, part 5: refund approval queue, admin alerts + preferences + push, editable published numbers, customer avatars,
   acceptance history. Loaded after admin4.js (shares its helpers). All rendering escapes data; the admin key only travels as a Bearer header. */
'use strict';
(() => {
const A = window.ADM2;

/* ---------- avatars (admin photos need the Bearer header, so they are fetched into blob URLs) ---------- */
const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const avId = (url) => { const m = /\/avatars\/(\d+)/.exec(url || ''); return m ? Number(m[1]) : 0; };
const avHtml = (url, name, cls) => { const id = avId(url); return `<span class="av ${cls || ''}" ${id ? `data-av="${id}" data-v="${esc(url)}"` : ''} aria-hidden="true">${esc(initials(name))}</span>`; };
const blobs = new Map();
async function loadAv(el) {
  el.dataset.avd = '1';
  try {
    const key = el.dataset.v;
    if (!blobs.has(key)) blobs.set(key, fetch('/api/admin/avatars/' + el.dataset.av, { headers: { Authorization: 'Bearer ' + getKey() } }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error('no photo')))).then((b) => URL.createObjectURL(b)));
    const u = await blobs.get(key);
    el.style.backgroundImage = `url("${u}")`; el.classList.add('has');
  } catch { /* keep the initials */ }
}
const scanAv = () => document.querySelectorAll('[data-av]:not([data-avd])').forEach(loadAv);
new MutationObserver(scanAv).observe(document.body, { childList: true, subtree: true });

if (A && A.LISTS) {
  const L = A.LISTS;
  const wrapTitle = (cfg, name, url) => { const o = cfg.row; cfg.row = (r) => { const d = o(r); d.t = avHtml(url(r), name(r), 'sm') + d.t; return d; }; };
  wrapTitle(L.customers, (u) => u.name, (u) => u.avatar_url);
  wrapTitle(L.bookings, (b) => b.customer_name, (b) => b.customer_avatar);
  wrapTitle(L.waitlist, (w) => w.customer_name, (w) => w.customer_avatar);
  const c0 = L.customers.cols[0]; const f0 = c0[1]; c0[1] = (u) => `<div class="av-row">${avHtml(u.avatar_url, u.name)}<div>${f0(u)}</div></div>`;
  const wc = L.waitlist.cols && L.waitlist.cols[0]; if (wc) { const g = wc[1]; wc[1] = (w) => `<div class="av-row">${avHtml(w.customer_avatar, w.customer_name)}<div>${g(w)}</div></div>`; }
}

/* ---------- navigation: alerts page + unread badge ---------- */
IC.alerts = '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>';
GROUPS[0][1].push(['alerts', 'Alerts']);
let alertsUnread = 0;
const _drawNav = drawNav;
drawNav = function (cur) { _drawNav(cur); if (alertsUnread > 0) { const a = $('#nav a[href="#/alerts"]'); if (a && !a.querySelector('.cnt')) a.insertAdjacentHTML('beforeend', `<span class="cnt">${alertsUnread}</span>`); } };
async function pollUnread() {
  if (!getKey()) return;
  try { const r = await api('/alerts/unread'); if (r.unread !== alertsUnread) { alertsUnread = r.unread; const cur = (location.hash.replace(/^#\/?/, '') || 'home').split('?')[0]; drawNav(cur === 'overview' ? 'home' : cur); } } catch { /* offline or signed out */ }
}
setInterval(pollUnread, 60000); setTimeout(pollUnread, 1500);
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.type === 'go' && m.hash) location.hash = m.hash;
  if (m.type === 'push') { pollUnread(); if (m.payload && m.payload.title) toast(m.payload.title + (m.payload.body ? ': ' + m.payload.body : '')); }
});

/* ---------- refund approval queue (replaces the old "convert to credit / refund" page) ---------- */
const left = (iso) => {
  if (!iso) return 'no deadline';
  const ms = new Date(iso).getTime() - Date.now(); if (ms <= 0) return 'approved by itself on the next check';
  const m = Math.ceil(ms / 60000); return 'auto-approves in ' + (m >= 90 ? Math.round(m / 60 * 10) / 10 + ' h' : m + ' min');
};
async function decisions5() {
  const r = await api('/refund-queue'); badges.decisions = r.pending.length + r.legacy.length; drawNav('decisions');
  const cols = [
    ['Customer', (b) => `<div class="av-row">${avHtml(b.customer_avatar, b.customer_name)}<div>${cust(b)}<span class="sub">${esc(b.customer_email || '')}</span></div></div>`],
    ['Booking', (b) => `${esc(b.service_name)}<span class="sub">${esc(b.shop_name)} · ${dlabel(b.date)}, ${t12(b.start_min)}</span>`],
    ['Paid', (b) => naira(b.price_kobo), 'num'],
    ['Why', (b) => esc(b.refund_reason || (b.status === 'NOT_SERVED' ? 'Barber could not serve' : 'Cancelled in time')) + `<span class="sub">${esc(left(b.refund_due_at))}</span>`],
    ['', (b) => act('Reject…', 'sec', `data-do="reject" data-id="${b.id}"`) + act('Approve refund', '', `data-do="approve" data-id="${b.id}"`), 'act'],
  ];
  const legacyCols = [
    ['Customer', (b) => `${cust(b)}<span class="sub">${esc(b.customer_email || '')}</span>`],
    ['Booking', (b) => `${esc(b.service_name)}<span class="sub">${esc(b.shop_name)} · ${dlabel(b.date)}, ${t12(b.start_min)}</span>`],
    ['Paid', (b) => naira(b.price_kobo), 'num'],
    ['', (b) => act('Convert to credit', 'sec', `data-do="credit" data-id="${b.id}"`) + act('Refund', '', `data-do="refund" data-id="${b.id}"`), 'act'],
  ];
  app.innerHTML = head('Refund decisions', `If a customer cancels a paid booking in time, or the barber could not serve them, the money goes back to their card. If you do nothing, no one loses out. After ${r.auto_approve_hours} hour${r.auto_approve_hours === 1 ? '' : 's'}, we approve a refund nobody decided. If a customer misses a booking (no-show), they get a ${r.credit_expiry_days}-day credit with that barber instead. They never get both.`, refreshBtn) +
    table(cols, r.pending, 'No refunds need a decision.') +
    (r.legacy.length ? `<h2 style="margin-top:24px">Older cancellations (before refunds became automatic)</h2><p class="muted small">These were cancelled under the old rule. They still need a decision: a credit or a refund.</p>` + table(legacyCols, r.legacy, '') : '');
  wireReload(decisions5);
  wireActions(app, {
    approve: async (d) => { if (!confirm('Approve this refund and send it to Paystack now?')) throw new Error('Not changed'); const x = await api(`/bookings/${d.id}/refund-decision`, { method: 'POST', body: { action: 'approve' } }); toast(x.refund === 'failed' ? 'Approved. Paystack did not take the request. Try again in Payments.' : 'Refund approved and sent'); await decisions5(); },
    reject: async (d) => { A.formModal({ title: 'Reject refund #' + d.id, help: 'The customer gets no refund and no credit. They see your reason. Use this only if the service was done or the claim is wrong.', go: 'Reject refund', cls: 'red', fields: [A.REASON('Reason (the customer sees this)')], submit: async (v) => { await A.post(`/bookings/${d.id}/refund-decision`, { action: 'reject', reason: v.reason }); return 'Refund rejected'; }, after: decisions5 }); const b = app.querySelector(`[data-do="reject"][data-id="${d.id}"]`); if (b) b.disabled = false; },
    credit: async (d) => { await api(`/bookings/${d.id}/resolve`, { method: 'POST', body: { action: 'credit' } }); toast('Converted to a session credit'); await decisions5(); },
    refund: async (d) => { if (!confirm('Send this payment back to the customer?')) throw new Error('Not changed'); const x = await api(`/bookings/${d.id}/resolve`, { method: 'POST', body: { action: 'refund' } }); toast(x.refund === 'failed' ? 'Marked for refund. Paystack did not take the request. Try again in Payments.' : 'Refund requested'); await decisions5(); },
  });
}
ROUTES.decisions = decisions5;

/* ---------- admin alerts ---------- */
const b64 = (s) => { const p = '='.repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map((c) => c.charCodeAt(0))); };
const pushOk = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
async function deviceSub() { if (!pushOk()) return null; const reg = await navigator.serviceWorker.getRegistration('/'); return reg ? reg.pushManager.getSubscription() : null; }
async function enablePush(key) {
  if (!pushOk() || !key) throw new Error('Push does not work on this device, or the server has no push keys.');
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Alerts are blocked. Allow them in your browser settings. Then try again.');
  const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
  await api('/alerts/subscribe', { method: 'POST', body: sub.toJSON() });
}
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
async function alertsPage() {
  const [list, prefs] = await Promise.all([api('/alerts'), api('/alerts/prefs')]); alertsUnread = list.unread; drawNav('alerts');
  const sub = await deviceSub().catch(() => null);
  const state = !pushOk() ? 'This browser cannot get push alerts.' : !prefs.push.available ? 'The server has no push keys, so only alerts in the app work.' : Notification.permission === 'denied' ? 'Alerts are blocked in this browser.' : sub ? 'Push is ON for this device.' : 'Push is off on this device.';
  const q = prefs.quiet;
  const items = list.items.length ? list.items.map((n) => `<a class="kv alrt${n.read_at ? '' : ' unread'}" href="${esc(n.link || '#/alerts')}" data-read="${n.id}"><span><b>${esc(n.title)}</b><small class="muted" style="display:block">${esc(n.body)}</small></span><b class="small">${stamp(n.created_at)}</b></a>`).join('') : '<div class="empty">No alerts yet.</div>';
  app.innerHTML = head('Alerts', 'Refunds that need you, refunds approved by themselves, and refunds that failed. Choose which alerts you get and how.', `<button class="btn sm sec" id="readall">Mark all read</button>`) +
    `<div class="card">${items}</div>
    <div class="card"><form id="apf"><h2 style="margin-top:0">What to tell me</h2>
      <table class="tbl"><thead><tr><th>Event</th><th>In the app</th><th>Push</th></tr></thead><tbody>${prefs.events.map((e) => `<tr><td data-l="Event">${esc(e.label)}</td><td data-l="In the app"><input type="checkbox" name="${e.event}:in_app" aria-label="${esc(e.label)} in the app" ${e.in_app ? 'checked' : ''}></td><td data-l="Push"><input type="checkbox" name="${e.event}:push" aria-label="${esc(e.label)} by push" ${e.push ? 'checked' : ''}></td></tr>`).join('')}</tbody></table>
      <h2>Quiet hours</h2><label class="chk"><input type="checkbox" name="quiet_on" ${q.enabled ? 'checked' : ''}> <span><b>Hold push notifications during quiet hours</b><small class="muted" style="display:block">They are sent when quiet hours end. In-app alerts are not affected. Times are Lagos time.</small></span></label>
      <div class="formgrid"><div><label>From</label><input type="time" name="quiet_start" value="${hhmm(q.start_min)}"></div><div><label>Until</label><input type="time" name="quiet_end" value="${hhmm(q.end_min)}"></div></div>
      <div class="btns cta"><button class="btn" type="submit">Save preferences</button></div></form></div>
    <div class="card"><h2 style="margin-top:0">Push on this device</h2><p class="muted small">${esc(state)} ${prefs.push.devices} device${prefs.push.devices === 1 ? '' : 's'} registered in total.</p>
      <div class="btns">${sub ? '<button class="btn sec" id="pushoff">Turn off on this device</button><button class="btn sec" id="pushtest">Send a test</button>' : '<button class="btn" id="pushon">Turn on push on this device</button>'}</div></div>`;
  $('#readall').onclick = async () => { await api('/alerts/read', { method: 'POST', body: { all: true } }); alertsUnread = 0; await alertsPage(); };
  app.querySelectorAll('[data-read]').forEach((a) => a.addEventListener('click', () => { api('/alerts/read', { method: 'POST', body: { id: Number(a.dataset.read) } }).catch(() => {}); }));
  $('#apf').onsubmit = async (ev) => {
    ev.preventDefault(); const f = ev.target.elements; const body = { prefs: {}, quiet: { enabled: f.quiet_on.checked, start: f.quiet_start.value || '22:00', end: f.quiet_end.value || '07:00' } };
    for (const e of prefs.events) body.prefs[e.event] = { in_app: f[e.event + ':in_app'].checked, push: f[e.event + ':push'].checked };
    const b = ev.target.querySelector('button[type=submit]'); b.disabled = true;
    try { await api('/alerts/prefs', { method: 'PUT', body }); toast('Preferences saved'); } catch (e) { toast(e.message, true); } b.disabled = false;
  };
  const on = $('#pushon'); if (on) on.onclick = async () => { on.disabled = true; try { await enablePush(prefs.push.vapid_public_key); toast('Push turned on'); await alertsPage(); } catch (e) { toast(e.message, true); on.disabled = false; } };
  const off = $('#pushoff'); if (off) off.onclick = async () => { try { const s = await deviceSub(); if (s) { await api('/alerts/unsubscribe', { method: 'POST', body: { endpoint: s.endpoint } }); await s.unsubscribe(); } toast('Push turned off'); await alertsPage(); } catch (e) { toast(e.message, true); } };
  const test = $('#pushtest'); if (test) test.onclick = async () => { try { await api('/alerts/test', { method: 'POST', body: {} }); toast('Test sent'); } catch (e) { toast(e.message, true); } };
}
ROUTES.alerts = alertsPage;

/* ---------- Controls: the published numbers ---------- */
const NUMS = [
  ['Cancelling, holds and credits', [
    ['cancel_cutoff_min', 'Cancel lock (minutes before the booking)', 1, 0, 1440, 'Customers cannot cancel inside this time.'],
    ['payment_hold_min', 'Pay-now hold (minutes)', 1, 1, 180, 'How long we hold a time while the customer pays.'],
    ['credit_expiry_days', 'Credit expiry (days)', 1, 1, 3650, 'A credit for a missed booking lasts this long.'],
    ['refund_auto_approve_hours', 'Refund auto-approve after (hours)', 1, 0, 168, 'If nobody decides, we approve the refund after this time. 0 means on the next check.']]],
  ['Who pays the card fee (must add up to 100%)', [
    ['fee_share_customer_pct', 'Customer share (%)', 0.01, 0, 100, 'The customer sees this as a small "booking fee".'],
    ['fee_share_barber_pct', 'Barber share (%)', 0.01, 0, 100, 'Taken from the barber\'s payout.'],
    ['fee_share_platform_pct', 'Platform share (%)', 0.01, 0, 100, 'TrimSlot pays this part.']]],
  ['Paystack rate (we use it to work out the fee)', [
    ['ps_percent', 'Percent of the payment (%)', 0.001, 0, 20, ''],
    ['ps_flat_naira', 'Flat part (₦)', 1, 0, 100000, ''],
    ['ps_flat_waived_below_naira', 'No flat part below (₦)', 1, 0, 10000000, ''],
    ['ps_cap_naira', 'Fee cap (₦)', 1, 0, 10000000, 'The cap applies before VAT.'],
    ['ps_vat_percent', 'VAT on the fee (%)', 0.01, 0, 50, 'When Paystack tells us the real fee, we save that too.']]],
  ['TrimSlot charge on each booking', [
    ['charge_percent', 'Percent of the price (%)', 0.01, 0, 50, ''],
    ['charge_flat_naira', 'Flat part (₦)', 1, 0, 1000000, ''],
    ['charge_min_naira', 'Minimum charge (₦)', 1, 0, 1000000, 'Taken from the barber\'s payout. Pay on arrival has only this charge.'],
    ['commission_pct', 'Pay on arrival: part of the charge the barber owes (%)', 1, 0, 100, 'We save this as the commission factor. 100 means the whole charge.']]],
  ['Liability', [
    ['liability_cap_naira', 'Liability cap (₦, 0 = not set)', 1, 0, 1000000000, 'Shown in the Terms once you set it.']]],
  ['Plan limits', [
    ['min_plan_price_naira', 'Minimum plan price (₦)', 1, 0, 100000000, ''], ['max_plan_price_naira', 'Maximum plan price (₦)', 1, 0, 100000000, ''],
    ['max_plan_validity_days', 'Maximum plan duration (days)', 1, 1, 3650, ''], ['max_plan_sessions', 'Maximum sessions per plan', 1, 1, 1000, '']]],
  ['How long we keep data (shown in the Privacy Policy)', [
    ['retention_events_days', 'Payment webhook records (days)', 1, 30, 3650, ''], ['retention_bad_events_days', 'Rejected webhook records (days)', 1, 1, 3650, ''],
    ['retention_notifications_days', 'In-app notifications (days)', 1, 7, 3650, ''], ['retention_push_stale_days', 'Unused push devices (days)', 1, 7, 3650, ''],
    ['retention_deleted_days', 'Days we keep deleted accounts before we remove them', 1, 1, 3650, ''], ['retention_checkout_days', 'Unfinished plan checkouts (days)', 1, 1, 365, ''],
    ['retention_rate_limit_hours', 'Rate-limit counters (hours)', 1, 1, 720, ''], ['retention_admin_alerts_days', 'Admin alerts (days)', 1, 7, 3650, '']]],
];
const VERS = [['terms_version', 'Terms version'], ['privacy_version', 'Privacy Policy version'], ['barber_agreement_version', 'Barber Agreement version']];
async function addNumbersCard() {
  if ((location.hash.replace(/^#\/?/, '') || '').split('?')[0] !== 'controls') return;
  const [{ settings: s }, pub] = await Promise.all([api('/settings'), fetch('/api/public-settings').then((r) => r.json()).catch(() => ({ settings: {} }))]);
  const v = (k) => k === 'commission_pct' ? Math.round(Number(s.commission_factor) * 100000) / 1000 : s[k];
  const eff = pub.settings || {};
  const field = ([k, l, step, min, max, help]) => `<div><label>${esc(l)}</label><input type="number" name="${k}" step="${step}" min="${min}" max="${max}" value="${esc(v(k))}">${help ? `<small class="muted">${esc(help)}</small>` : ''}</div>`;
  const html = `<div class="card" id="numcard"><form id="nf"><h2 style="margin-top:0">Published numbers</h2><p class="muted small">These are the numbers quoted in the Terms, Refund policy and Privacy Policy. The public pages read them live, so a change here updates the pages at once. Every change is saved in the audit log.</p>
    ${NUMS.map(([g, fs]) => `<h2>${esc(g)}</h2><div class="formgrid">${fs.map(field).join('')}</div>`).join('')}
    <div id="feeprev" class="small"></div>
    <h2>Document versions</h2><p class="muted small">Raise a version when that document changes in a way people must agree to again. Everyone is asked to accept it at their next visit.</p>
    <div class="formgrid">${VERS.map(([k, l]) => `<div><label>${esc(l)}</label><input name="${k}" maxlength="30" value="${esc(s[k])}"></div>`).join('')}</div>
    <div class="btns cta"><button class="btn" type="submit">Save published numbers</button><button class="btn sec" type="button" id="runret">Run data clean-up now</button></div></form></div>`;
  const host = app.querySelector('.card:last-of-type'); (host || app).insertAdjacentHTML(host ? 'afterend' : 'beforeend', html);
  const prev = await api('/fee-preview').catch(() => null);
  if (prev) $('#feeprev').innerHTML = `<h3>What the saved numbers mean in Naira (₦)</h3><div class="tblwrap"><table class="tbl"><thead><tr><th>Price</th><th>Customer pays</th><th>Booking fee</th><th>Barber receives</th><th>TrimSlot keeps*</th><th>Pay on arrival charge</th></tr></thead><tbody>${prev.rows.map((r) => `<tr><td>${naira(r.price_kobo)}</td><td>${naira(r.total_kobo)}</td><td>${naira(r.booking_fee_kobo)}</td><td>${naira(r.payout_kobo)}</td><td>${naira(r.platform_net_kobo)}</td><td>${naira(r.cash)}</td></tr>`).join('')}</tbody></table></div><small class="muted">*After Paystack takes its fee (worked out from the rate above). Pay now only.</small>`;
  // the three shares must add up: the platform share follows the other two
  const fr = $('#nf').elements; const sync = () => { fr.fee_share_platform_pct.value = String(Math.round((100 - Number(fr.fee_share_customer_pct.value) - Number(fr.fee_share_barber_pct.value)) * 10000) / 10000); };
  fr.fee_share_customer_pct.addEventListener('input', sync); fr.fee_share_barber_pct.addEventListener('input', sync);
  // the old commission factor input and this % input must agree
  const fac = app.querySelector('#cf [name=commission_factor]');
  $('#nf').elements.commission_pct.addEventListener('input', (e) => { if (fac) fac.value = String(Math.round(Number(e.target.value) * 10) / 1000); });
  $('#nf').onsubmit = async (ev) => {
    ev.preventDefault(); const f = ev.target.elements; const body = {};
    for (const [, fs] of NUMS) for (const [k] of fs) { const n = Number(f[k].value); if (!Number.isFinite(n)) { toast('Enter a number for ' + k, true); return; } if (String(n) !== String(v(k))) body[k] = n; }
    if (body.commission_pct !== undefined) { body.commission_factor = Math.round(body.commission_pct * 10) / 1000; delete body.commission_pct; }
    for (const [k] of VERS) if (f[k].value.trim() !== String(s[k])) body[k] = f[k].value.trim();
    if (!Object.keys(body).length) { toast('Nothing changed'); return; }
    if (body.terms_version || body.privacy_version || body.barber_agreement_version) if (!confirm('A new document version asks every user to accept it again. Go on?')) return;
    const b = ev.target.querySelector('button[type=submit]'); b.disabled = true;
    try { await api('/settings', { method: 'PUT', body }); toast('Published numbers saved'); await ROUTES.controls(); } catch (e) { toast(e.message, true); b.disabled = false; }
  };
  $('#runret').onclick = async (e) => { e.target.disabled = true; try { const r = await api('/retention/run', { method: 'POST', body: {} }); const t = Object.values(r.result).reduce((a, n) => a + (Number(n) || 0), 0); toast(`Clean-up done. ${t} item${t === 1 ? '' : 's'} removed.`); } catch (er) { toast(er.message, true); } e.target.disabled = false; };
}
/* The Controls page is long (the Published numbers card alone is ~4,000px tall on a phone), so each group is a collapsible section.
   The open/closed state is kept in memory only, so saving a form (which redraws the page) does not close what you were editing. */
const CTL_OPEN = new Set(['Platform']);
function collapsify(form) {
  if (!form) return;
  const kids = [...form.children]; let cur = null, first = true;
  const mk = (title, el) => { const d = document.createElement('details'); d.className = 'sect'; d.dataset.sect = title; d.open = CTL_OPEN.has(title); const sm = document.createElement('summary'); sm.textContent = title; d.appendChild(sm); d.addEventListener('toggle', () => { d.open ? CTL_OPEN.add(title) : CTL_OPEN.delete(title); }); form.insertBefore(d, el); return d; };
  for (const el of kids) {
    if (el.tagName === 'H2' && first && form.id === 'nf') { first = false; continue; }   // the card title stays a heading
    if (el.tagName === 'H2') { first = false; cur = mk(el.textContent.trim(), el); el.remove(); continue; }
    if (el.id === 'feeprev') { cur = mk('What the saved numbers mean in Naira (₦)', el); cur.appendChild(el); cur = null; continue; }
    if (el.classList.contains('btns')) { cur = null; continue; }
    if (cur) cur.appendChild(el);
    else if (el.tagName === 'H2') first = false;
  }
  form.addEventListener('invalid', (e) => { const d = e.target.closest && e.target.closest('details'); if (d) { d.open = true; } }, true);   // a bad value in a closed section opens it
}
const _controls = ROUTES.controls;
ROUTES.controls = async () => {
  await _controls();
  const lab = [...app.querySelectorAll('#cf label')].find((l) => /Commission factor/.test(l.textContent)); if (lab) lab.textContent = 'Commission factor (0–1; also editable below as a %)';
  try { await addNumbersCard(); } catch (e) { toast(e.message, true); }
  collapsify(app.querySelector('#cf')); collapsify(app.querySelector('#nf'));
};

/* ---------- user + booking sheets: photo, acceptance history ---------- */
const lastSheet = () => [...document.querySelectorAll('.modal .sheet')].pop();
const _userSheet = userSheet;
userSheet = async function (id, reload) {
  await _userSheet(id, reload);
  try {
    const r = await api('/users/' + id); const u = r.user; const sh = lastSheet(); if (!sh || sh.dataset.u5) return; sh.dataset.u5 = '1';
    const isC = u.role === 'customer';
    const badgeRow = sh.querySelector('.row-badges');
    if (isC && badgeRow) badgeRow.insertAdjacentHTML('beforebegin', `<div class="avatar-edit">${avHtml(u.avatar_url, u.name, 'xl')}<div><small>${u.avatar_url ? 'Profile photo' : u.avatar_removed_at ? 'Photo removed by admin' : 'No profile photo'}</small></div></div>`);
    if (u.deletion_requested_at && badgeRow) badgeRow.insertAdjacentHTML('afterend', `<div class="note"><b>Deletion requested ${esc(dshort(u.deletion_requested_at))}</b>${esc(u.deletion_request_note || '')}</div>`);
    const cons = (r.consents || []).length ? r.consents.map((c) => `<div class="kv"><span>${esc(String(c.document).replace('_', ' '))} <small class="muted">v${esc(c.version)} · ${esc(c.source)}</small></span><b class="small">${stamp(c.accepted_at || c.created_at)}</b></div>`).join('') : '<div class="muted small">No acceptance recorded.</div>';
    const need = (r.consent_missing || []).length ? `<div class="note"><b>Has not accepted the latest ${r.consent_missing.map((c) => esc(String(c.document).replace('_', ' '))).join(', ')}</b>We ask them the next time they visit.</div>` : '';
    const rep = [...sh.querySelectorAll('h3')].find((h) => h.textContent.trim() === 'Reports');
    if (rep) rep.insertAdjacentHTML('beforebegin', `<h3>Documents accepted</h3>${need}${cons}`);
    const bar = sh.querySelector('.btns.sticky');
    if (isC && u.avatar_url && bar) {
      bar.insertAdjacentHTML('afterbegin', act('Remove photo', 'red', 'data-rmav="1"'));
      bar.querySelector('[data-rmav]').onclick = () => { sh.querySelector('[data-close]')?.click(); A.formModal({ title: 'Remove ' + u.name + "'s photo", help: 'We delete the photo and tell the customer why.', fields: [A.REASON('Reason (the customer sees this)', 'e.g. Not a photo of you')], go: 'Remove photo', cls: 'red', submit: async (x) => { await A.post(`/users/${id}/avatar/remove`, x); return 'Photo removed'; }, after: async () => { reload && reload(); } }); };
    }
    scanAv();
  } catch { /* the original sheet is already usable */ }
};
const _bookingSheet = bookingSheet;
bookingSheet = async function (id, reload) {
  await _bookingSheet(id, reload);
  try {
    const r = await api('/bookings/' + id); const sh = lastSheet(); const a = sh && sh.querySelector('a[data-cu]');
    if (a && r.booking.customer_avatar && !a.querySelector('.av')) { a.insertAdjacentHTML('afterbegin', avHtml(r.booking.customer_avatar, r.booking.customer_name, 'sm') + ' '); scanAv(); }
  } catch { /* ignore */ }
};
})();
