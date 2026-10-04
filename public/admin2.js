/* TrimSlot admin portal, part 2: customers, booking control, earnings, off-app ledger, broadcasts, reports, analytics, controls, search, audit filters.
   Loaded after admin.js (shares its helpers). All rendering escapes data; the admin key is only ever sent as a Bearer header. */
'use strict';

/* ---------- small helpers ---------- */
const nn = (v) => Number(v || 0);
const human = (a) => { const t = String(a || '').replace(/^ADMIN_/, '').toLowerCase().replace(/_/g, ' '); return ACTION_TXT[a] || t.charAt(0).toUpperCase() + t.slice(1); };
const kvr = (l, v) => `<div class="kv"><span>${esc(l)}</span><b>${v}</b></div>`;
const today0 = () => new Date(Date.now() + 3600000).toISOString().slice(0, 10);   // Lagos date (UTC+1)
const daysAgo = (n) => new Date(Date.now() + 3600000 - n * 86400000).toISOString().slice(0, 10);
const fld = (f) => {
  const id = 'f_' + f.name, req = f.required ? 'required' : '', v = f.value ?? '';
  if (f.type === 'textarea') return `<div><label for="${id}">${esc(f.label)}</label><textarea id="${id}" name="${f.name}" rows="${f.rows || 3}" maxlength="${f.max || 500}" ${req} placeholder="${esc(f.ph || '')}">${esc(v)}</textarea></div>`;
  if (f.type === 'select') return `<div><label for="${id}">${esc(f.label)}</label><select id="${id}" name="${f.name}">${f.options.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  if (f.type === 'checkbox') return `<label class="chk"><input type="checkbox" name="${f.name}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
  return `<div><label for="${id}">${esc(f.label)}</label><input id="${id}" name="${f.name}" type="${f.type || 'text'}" ${f.step ? `step="${f.step}"` : ''} ${f.min != null ? `min="${f.min}"` : ''} value="${esc(v)}" ${req} placeholder="${esc(f.ph || '')}"></div>`;
};
/** Generic reason/fields form in a sheet. submit(values) -> message string (toast). */
function formModal(o) {
  const m = modal(`<form class="rform" id="fm"><h2 style="margin-top:0">${esc(o.title)}</h2>${o.help ? `<p class="muted small">${esc(o.help)}</p>` : ''}
    ${o.body || ''}<div class="fgrid">${(o.fields || []).map(fld).join('')}</div><div class="err hidden" id="ferr"></div>
    <div class="btns end"><button type="button" class="btn sec" data-close>Cancel</button><button class="btn ${o.cls || ''}" id="fgo" type="submit">${esc(o.go || 'Save')}</button></div></form>`);
  const first = $('input,textarea,select', m.el); if (first) first.focus();
  $('#fm', m.el).onsubmit = async (ev) => {
    ev.preventDefault(); const go = $('#fgo', m.el); go.disabled = true; $('#ferr', m.el).classList.add('hidden');
    const v = {}; for (const f of (o.fields || [])) { const e = ev.target.elements[f.name]; v[f.name] = f.type === 'checkbox' ? e.checked : f.type === 'number' ? (e.value === '' ? null : Number(e.value)) : e.value.trim(); }
    try { const msg = await o.submit(v); m.close(); if (msg) toast(msg); if (o.after) await o.after(); }
    catch (e) { go.disabled = false; const er = $('#ferr', m.el); er.textContent = e.message; er.classList.remove('hidden'); }
  };
  return m;
}
const REASON = (label, ph) => ({ name: 'reason', label: label || 'Reason (saved in the audit log)', type: 'textarea', required: true, ph: ph || 'Why are you doing this?' });
const post = (p, body) => api(p, { method: 'POST', body: body || {} });
async function downloadCsv(path, name) {
  const r = await fetch('/api/admin' + path, { headers: { Authorization: 'Bearer ' + getKey() } });
  if (!r.ok) throw new Error('Export failed');
  const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const acctBadge = (s) => bd({ ACTIVE: 'b-green', SUSPENDED: 'b-amber', BANNED: 'b-red' }[s] || 'b-gray', s);

/* ---------- customers ---------- */
let cq = '', cst = '';
async function customers() {
  const r = await api('/customers?' + new URLSearchParams({ q: cq, status: cst }));
  drawNav('customers');
  const cols = [
    ['Customer', (c) => `${esc(c.name)}<span class="sub">${esc(c.email || c.phone || '')}</span>`], ['Status', (c) => acctBadge(c.account_status) + (c.warn_count ? ' ' + bd('b-gray', c.warn_count + ' warn') : '')],
    ['Bookings', (c) => c.bookings, 'num'], ['No-shows', (c) => c.no_shows, 'num'], ['Spent', (c) => naira(c.spent_kobo), 'num'], ['Joined', (c) => dshort(c.created_at)],
    ['', (c) => act('Open', 'sec', `data-do="open" data-id="${c.id}"`), 'act'],
  ];
  app.innerHTML = head('Customers', 'Search by name, email, phone or id. You can warn, suspend, ban or message a customer. Suspended and banned customers cannot log in or book.', refreshBtn) +
    `<div class="filters"><input type="search" id="cq" placeholder="Search customers" value="${esc(cq)}" aria-label="Search customers"><select id="cs" aria-label="Status"><option value="">Any status</option>${['ACTIVE', 'SUSPENDED', 'BANNED'].map((s) => `<option ${s === cst ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
     <p class="small muted">${r.counts.ALL} customers · ${r.counts.SUSPENDED} suspended · ${r.counts.BANNED} banned</p>` + table(cols, r.customers, 'No customers match.');
  let t; $('#cq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { cq = e.target.value.trim(); customers().then(() => { const i = $('#cq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 350); };
  $('#cs').onchange = (e) => { cst = e.target.value; customers(); };
  wireReload(customers);
  wireActions(app, { open: async (d) => { await userSheet(Number(d.id), customers); app.querySelectorAll('[data-do]').forEach((x) => x.disabled = false); } });
}
async function userSheet(id, reload) {
  const r = await api('/users/' + id); const u = r.user;
  const bk = r.bookings.length ? r.bookings.map((b) => `<div class="kv"><span><a href="#" data-bk="${b.id}">#${b.id} ${esc(b.service_name)}</a><small class="muted" style="display:block">${dlabel(b.date)}, ${t12(b.start_min)} · ${esc(b.shop_name)}</small></span><b>${bookingBadge(b.status)}</b></div>`).join('') : '<div class="muted small">No bookings.</div>';
  const pay = (r.payments || []).length ? r.payments.map((p) => `<div class="kv"><span class="mono">${esc(p.reference)}${p.disputed ? ' ⚑' : ''}</span><b>${naira(p.amount_kobo)} ${payBadge(p.status)}</b></div>`).join('') : '<div class="muted small">No payments.</div>';
  const cr = (r.credits || []).map((c) => `<div class="kv"><span>${esc(c.shop_name)} · ${esc(c.reason)}<small class="muted" style="display:block">to ${dshort(c.expires_at)}</small></span><b>${naira(c.value_kobo)} ${bd(c.status === 'AVAILABLE' ? 'b-purple' : 'b-gray', c.status)} ${c.status === 'AVAILABLE' ? act('Revoke', 'sec', `data-rv="${c.id}"`) : ''}</b></div>`).join('') || '<div class="muted small">None.</div>';
  const pl = (r.plans || []).map((p) => `<div class="kv"><span>${esc(p.plan_name)} · ${esc(p.shop_name)}</span><b>${p.sessions_total - p.sessions_used}/${p.sessions_total} ${bd(p.status === 'ACTIVE' ? 'b-green' : 'b-gray', p.status)}</b></div>`).join('') || '<div class="muted small">None.</div>';
  const rp = (r.reports || []).map((x) => `<div class="kv"><span>${esc(x.category)}: ${esc(x.message).slice(0, 80)}</span><b>${bd(x.status === 'OPEN' ? 'b-amber' : 'b-gray', x.status)}</b></div>`).join('') || '<div class="muted small">None.</div>';
  const hist = (r.history || []).map((h) => `<div class="kv"><span>${esc(human(h.action))}<small class="muted" style="display:block">${esc(h.details?.reason || '')}</small></span><b class="small">${stamp(h.created_at)}</b></div>`).join('') || '<div class="muted small">No admin actions yet.</div>';
  const isC = u.role === 'customer'; const btns = [];
  btns.push(act('Message', 'sec', 'data-k="notify"'));
  if (isC) { btns.push(act('Warn', 'sec', 'data-k="warn"')); btns.push(act('Issue credit', 'sec', 'data-k="credit"')); }
  if (isC && u.account_status === 'ACTIVE') { btns.push(act('Suspend', 'red', 'data-k="suspend"')); btns.push(act('Ban', 'red', 'data-k="ban"')); }
  if (isC && u.account_status === 'SUSPENDED') { btns.push(act('Ban', 'red', 'data-k="ban"')); }
  if (isC && u.account_status !== 'ACTIVE') btns.push(act('Reinstate', '', 'data-k="reinstate"'));
  if (isC) btns.push(act('Delete…', 'red', 'data-k="delete"'));
  const m = modal(`<div class="sh-h"><div><h2 style="margin:0">${esc(u.name)}</h2><div class="muted small">${esc(u.role)} · user #${u.id}</div></div><button class="btn sm sec" data-close>Close</button></div>
    <div class="row-badges">${acctBadge(u.account_status)} ${u.warn_count ? bd('b-gray', u.warn_count + ' warning' + (u.warn_count > 1 ? 's' : '')) : ''}</div>
    ${u.status_reason ? `<div class="note"><b>The user sees this reason</b>${esc(u.status_reason)}</div>` : ''}
    <h3>Contact</h3>${kvr('Email', esc(u.email || '—'))}${kvr('Phone', esc(u.phone || '—'))}${kvr('Joined', dshort(u.created_at))}
    <h3>Activity</h3>${kvr('Bookings', r.stats.total)}${kvr('Completed', r.stats.completed)}${kvr('No-shows', r.stats.no_shows)}${kvr('Cancelled', r.stats.cancelled)}${r.balance ? kvr('Platform balance owed', naira(r.balance.owed_kobo)) : ''}
    <h3>Bookings</h3>${bk}${isC ? `<h3>Payments</h3>${pay}<h3>Session credits</h3>${cr}<h3>Plans</h3>${pl}` : ''}<h3>Reports</h3>${rp}<h3>Admin history</h3>${hist}
    <div class="btns end sticky">${btns.join('')}</div>`);
  m.el.querySelectorAll('[data-bk]').forEach((a) => a.onclick = (e) => { e.preventDefault(); m.close(); bookingSheet(Number(a.dataset.bk), reload); });
  m.el.querySelectorAll('[data-rv]').forEach((b) => b.onclick = () => { m.close(); formModal({ title: 'Revoke credit', help: 'The customer is told their credit was removed.', fields: [REASON()], go: 'Revoke credit', cls: 'red', submit: async (v) => { await post(`/credits/${b.dataset.rv}/revoke`, v); return 'Credit revoked'; }, after: reload }); });
  const again = () => reload && reload();
  m.el.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => {
    const k = b.dataset.k; m.close();
    if (k === 'delete') { ADM4.deleteDialog({ type: 'customer', id, name: u.name, after: async () => { again(); } }); return; }
    const cfg = {
      warn: { title: 'Warn ' + u.name, help: 'They get an alert with your message.', go: 'Send warning', fields: [REASON('Warning (the customer sees this)', 'For example: Please arrive on time or cancel early.')], submit: async (v) => { const x = await post(`/users/${id}/warn`, v); return 'Warning sent (' + x.warn_count + ' total)'; } },
      suspend: { title: 'Suspend ' + u.name, help: 'They cannot log in or book until you reinstate them. Their bookings stay as they are.', go: 'Suspend', cls: 'red', fields: [REASON('Reason (the customer sees this)')], submit: async (v) => { await post(`/users/${id}/suspend`, v); return 'Customer suspended'; } },
      ban: { title: 'Ban ' + u.name, help: 'Use a ban for serious abuse. You can still reinstate them later.', go: 'Ban customer', cls: 'red', fields: [REASON('Reason (the customer sees this)')], submit: async (v) => { await post(`/users/${id}/ban`, v); return 'Customer banned'; } },
      notify: { title: 'Message ' + u.name, help: 'They see it in their alerts in the app.', go: 'Send message', fields: [{ name: 'title', label: 'Title (optional)', max: 80 }, { name: 'body', label: 'Message', type: 'textarea', required: true }], submit: async (v) => { await post(`/users/${id}/notify`, v); return 'Message sent'; } },
      credit: { title: 'Issue a session credit to ' + u.name, help: 'A credit for one barber. It cannot be cashed out.', go: 'Issue credit', fields: [{ name: 'barber_id', label: 'Barber (shop id)', type: 'number', required: true, min: 1, ph: 'Shop id from the Barbers list' }, { name: 'value_naira', label: 'Value (₦)', type: 'number', required: true, step: 'any', min: 1 }, REASON()], submit: async (v) => { await post('/credits/issue', { customer_id: id, barber_id: v.barber_id, value_naira: v.value_naira, reason: v.reason }); return 'Credit issued'; } },
      reinstate: { title: 'Reinstate ' + u.name, help: 'They can log in and book again.', go: 'Reinstate', fields: [], submit: async () => { await post(`/users/${id}/reinstate`); return 'Customer reinstated'; } },
    }[k];
    formModal({ ...cfg, after: async () => { again(); } });
  });
}

/* ---------- booking control ---------- */
async function bookingSheet(id, reload) {
  const r = await api('/bookings/' + id); const b = r.booking; const st = b.status; const btns = [];
  const live = ['CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(st);
  if (['PENDING_PAYMENT', 'CONFIRMED', 'ARRIVED'].includes(st)) btns.push(act('Cancel booking', 'red', 'data-k="cancel"'));
  if (st === 'CONFIRMED') btns.push(act('Reschedule', 'sec', 'data-k="reschedule"'));
  if (['CONFIRMED', 'ARRIVED'].includes(st)) btns.push(act('No-show', 'sec', 'data-k="noshow"'));
  if (live) btns.push(act('Force complete', '', 'data-k="complete"'));
  if (!['PENDING_PAYMENT', 'CONFIRMED', 'ARRIVED', 'IN_SERVICE'].includes(st)) btns.push(act('Delete…', 'red', 'data-k="delete"'));
  const pays = r.payments.length ? r.payments.map((p) => `<div class="kv"><span class="mono">${esc(p.reference)}${p.disputed ? ' ⚑ disputed' : ''}<small class="muted" style="display:block">fee ${naira(p.fee_kobo)}${p.debt_netted_kobo ? ' · commission netted ' + naira(p.debt_netted_kobo) : ''}</small></span><b>${naira(p.amount_kobo)} ${payBadge(p.status)} ${refundBadge(p.refund_status)}</b></div>`).join('') : '<div class="muted small">No online payment.</div>';
  const hist = r.history.map((h) => `<div class="kv"><span>${esc(human(h.action))} <small class="muted">${esc(h.actor_role)}</small>${h.details?.reason ? `<small class="muted" style="display:block">${esc(h.details.reason)}</small>` : ''}</span><b class="small">${stamp(h.created_at)}</b></div>`).join('');
  const m = modal(`<div class="sh-h"><div><h2 style="margin:0">Booking #${b.id}</h2><div class="muted small">${esc(b.service_name)} · ${esc(b.shop_name)}</div></div><button class="btn sm sec" data-close>Close</button></div>
    <div class="row-badges">${bookingBadge(st)} ${bpay(b.payment_status)} ${bd('b-gray', String(b.payment_option).replace('_', ' '))}</div>
    <h3>Details</h3>${kvr('Customer', `<a href="#" data-cu="${b.customer_id}">${esc(b.customer_name)}</a>`)}${kvr('Email', esc(b.customer_email || '—'))}${kvr('Barber', esc(b.barber_name))}${kvr('When', dlabel(b.date) + ', ' + esc(b.start_label.split(',').pop().trim()))}${kvr('Duration', b.duration_min + ' min')}${kvr('Price', naira(b.price_kobo))}${b.booking_fee_kobo ? kvr('Booking fee (customer share)', naira(b.booking_fee_kobo)) : ''}${b.barber_fee_kobo ? kvr('Barber share of card fee', naira(b.barber_fee_kobo)) : ''}${b.platform_charge_kobo ? kvr('TrimSlot charge', naira(b.platform_charge_kobo)) : ''}${b.payout_kobo != null ? kvr('Barber payout', naira(b.payout_kobo)) : ''}${b.cancelled_by ? kvr('Cancelled by', esc(b.cancelled_by)) : ''}
    <h3>Payments</h3>${pays}<h3>History</h3>${hist}<div class="btns end sticky">${btns.join('') || '<span class="muted small">No actions available for this status.</span>'}</div>`);
  m.el.querySelector('[data-cu]').onclick = (e) => { e.preventDefault(); m.close(); userSheet(Number(e.target.dataset.cu), reload); };
  const after = async () => { if (reload) await reload(); };
  m.el.querySelectorAll('[data-k]').forEach((x) => x.onclick = () => {
    const k = x.dataset.k; m.close();
    if (k === 'delete') { ADM4.deleteDialog({ type: 'booking', id, name: '#' + id, after }); return; }
    const cfg = {
      cancel: { title: `Cancel booking #${id}`, help: 'We tell the customer and the barber. They both see your reason.', go: 'Cancel booking', cls: 'red',
        fields: [REASON('Reason (the customer and barber see this)'), ...(b.payment_status === 'PAID' && b.payment_option === 'ONLINE' ? [{ name: 'refund', label: 'Paid online: what should happen to the money?', type: 'select', options: [['refund', 'Refund to the customer'], ['credit', 'Give a session credit'], ['none', 'Neither (handle manually)']], value: 'refund' }] : [])],
        submit: async (v) => { await post(`/bookings/${id}/cancel`, v); return 'Booking cancelled'; } },
      reschedule: { title: `Reschedule booking #${id}`, help: 'We tell both of them. We check the new time against the barber\'s hours and other bookings.', go: 'Move booking',
        fields: [{ name: 'date', label: 'New date', type: 'date', required: true, value: b.date.slice(0, 10) }, { name: 'time', label: 'New time', type: 'time', required: true }, { name: 'force', label: 'Allow outside work hours (two bookings at one time are never allowed)', type: 'checkbox' }, REASON('Reason (the customer and barber see this)')],
        submit: async (v) => { await post(`/bookings/${id}/reschedule`, v); return 'Booking moved'; } },
      noshow: { title: `Mark booking #${id} as no-show`, help: 'If the customer paid, they get a credit (as the platform rules say).', go: 'Mark no-show', cls: 'red', fields: [REASON()], submit: async (v) => { await post(`/bookings/${id}/no-show`, v); return 'Marked as no-show'; } },
      complete: { title: `Force-complete booking #${id}`, help: 'Use this when the barber forgot to finish it. If the customer paid outside the app, we add the platform commission.', go: 'Complete booking',
        fields: [...(b.payment_status === 'PAYMENT_DUE' ? [{ name: 'paid', label: 'Pay on arrival: did the customer pay?', type: 'select', options: [['true', 'Yes, paid outside the app'], ['false', 'No, unpaid']], value: 'true' }] : []), REASON()],
        submit: async (v) => { const body = { reason: v.reason }; if (v.paid !== undefined) body.paid = v.paid === 'true'; const o = await post(`/bookings/${id}/complete`, body); return 'Booking completed' + (o.ledger_id ? ' · commission added to the barber\'s balance' : ''); } },
    }[k];
    formModal({ ...cfg, after });
  });
}

/* ---------- earnings & exports ---------- */
let er = { from: daysAgo(29), to: today0() };
async function earnings() {
  const r = await api('/earnings?' + new URLSearchParams(er)); drawNav('earnings');
  const cols = [
    ['Shop', (b) => `${esc(b.shop_name)}<span class="sub">${b.subaccount_status === 'SET' ? 'Paystack subaccount set' : 'No subaccount (platform holds funds)'}${b.fee_override ? ' · custom fee ' + (b.fee_override.percent ?? 0) + '%' : ''}</span>`],
    ['Payments', (b) => b.payments, 'num'], ['Prices paid', (b) => naira(b.gross_kobo), 'num'], ['Booking fees', (b) => naira(b.booking_fee_kobo), 'num'], ['Barber card-fee share', (b) => naira(b.barber_fee_kobo), 'num'], ['TrimSlot charge', (b) => naira(b.fees_kobo), 'num'], ['Paystack fee', (b) => naira(b.ps_fee_kobo), 'num'], ['TrimSlot keeps', (b) => naira(b.platform_net_kobo), 'num'], ['Commission netted', (b) => naira(b.netted_kobo), 'num'],
    ['Barber share', (b) => naira(b.barber_share_kobo), 'num'], ['Off-app bookings', (b) => `${b.offapp_bookings} · ${naira(b.offapp_value_kobo)}`, 'num'], ['Owed to platform', (b) => b.owed_kobo ? `<b style="color:var(--red)">${naira(b.owed_kobo)}</b>` : '—', 'num'],
  ];
  const t = r.totals;
  app.innerHTML = head('Earnings', 'Online payments for each barber in this time, what the platform kept, and what is still owed for bookings paid outside the app.', refreshBtn) +
    `<div class="filters"><input type="date" id="e-from" value="${er.from}" aria-label="From"><input type="date" id="e-to" value="${er.to}" aria-label="To"><button class="btn sm sec" id="e-go">Apply</button></div>
     <div class="tiles"><div class="tile"><span>Prices paid online</span><b>${naira(t.gross_kobo)}</b></div><div class="tile"><span>TrimSlot keeps (after Paystack)</span><b>${naira(t.platform_net_kobo)}</b></div><div class="tile"><span>Commission netted</span><b>${naira(t.netted_kobo)}</b></div><div class="tile ${t.owed_kobo ? 'alert' : ''}"><span>Owed (off-app)</span><b>${naira(t.owed_kobo)}</b></div></div>
     <p class="small muted">Example: a ₦3,000 pay-now booking has a ${naira(r.rules.example.booking_fee_kobo)} booking fee. The barber gets ${naira(r.rules.example.payout_kobo)}. The same booking paid on arrival owes ${naira(r.rules.example_commission_kobo)} (${Math.round(nn(r.rules.commission_factor) * 100)}% of the ${naira(r.rules.example_fee_kobo)} TrimSlot charge).</p>` +
    table(cols, r.barbers, 'No barbers yet.') +
    `<h2>Export CSV</h2><div class="btns"><button class="btn sm sec" data-x="bookings">Bookings</button><button class="btn sm sec" data-x="payments">Payments</button><button class="btn sm sec" data-x="barbers">Barbers</button></div><p class="small muted">Bookings and payments use the dates above. We keep a record of every export.</p>`;
  $('#e-go').onclick = () => { er = { from: $('#e-from').value || er.from, to: $('#e-to').value || er.to }; earnings(); };
  app.querySelectorAll('[data-x]').forEach((b) => b.onclick = async () => { b.disabled = true; try { const n = b.dataset.x; await downloadCsv(`/export/${n}.csv?from=${er.from}&to=${er.to}`, `trimslot-${n}.csv`); toast('Export ready'); } catch (e) { toast(e.message, true); } b.disabled = false; });
  wireReload(earnings);
}

/* ---------- off-app commission ledger ---------- */
async function ledger() {
  const r = await api('/ledger'); badges.ledger = r.total_owed_kobo; drawNav('ledger');
  const ru = r.rules;
  const cols = [
    ['Barber', (b) => `${esc(b.shop_name)}<span class="sub">${b.blocked ? 'Pay on arrival is OFF · ' + esc(b.blocked_reason) : 'Oldest entry ' + b.oldest_days + ' day' + (b.oldest_days === 1 ? '' : 's') + ' old'}</span>`],
    ['Owed now', (b) => b.owed_kobo ? `<b style="color:var(--red)">${naira(b.owed_kobo)}</b>` : '₦0', 'num'], ['Accrued in total', (b) => naira(b.accrued_total_kobo), 'num'], ['Pay on arrival', (b) => b.blocked ? bd('b-red', 'DISABLED') : bd('b-green', 'ON')],
    ['', (b) => act('Ledger', 'sec', `data-do="open" data-id="${b.id}"`), 'act'],
  ];
  app.innerHTML = head('Off-app commission ledger', 'Commission on bookings paid outside the app is added here when the barber completes them. We take it out of the barber\'s next online payments (bookings and plan sales).', refreshBtn) +
    `<div class="tiles"><div class="tile ${r.total_owed_kobo ? 'alert' : ''}"><span>Total owed to the platform</span><b>${naira(r.total_owed_kobo)}</b></div><div class="tile"><span>Commission rule</span><b>${Math.round(nn(ru.commission_factor) * 100)}%</b><small>of the in-app fee${ru.commission_enabled ? '' : ' (SWITCHED OFF)'}</small></div>
      <div class="tile"><span>Barber keeps at least</span><b>${ru.min_payout_percent}%</b><small>of each netted payment</small></div><div class="tile"><span>Pay-on-arrival limit</span><b>${ru.max_debt_kobo ? naira(ru.max_debt_kobo) : 'None'}</b><small>${ru.max_age_days ? 'or ' + ru.max_age_days + ' days old' : 'no age limit'} · <a href="#/controls">change</a></small></div></div>
    <div class="btns"><button class="btn sm sec" id="remind-all">Send reminders now</button></div>` + table(cols, r.barbers, 'No commission yet.');
  wireReload(ledger);
  $('#remind-all').onclick = async (e) => { e.target.disabled = true; try { const x = await post('/ledger/remind'); toast(x.reminded + ' reminder' + (x.reminded === 1 ? '' : 's') + ' sent'); } catch (er2) { toast(er2.message, true); } e.target.disabled = false; };
  wireActions(app, { open: async (d) => { await ledgerSheet(Number(d.id), ledger); app.querySelectorAll('[data-do]').forEach((x) => x.disabled = false); } });
}
async function ledgerSheet(id, reload) {
  const r = await api('/ledger/' + id); const bal = r.balance; const b = r.barber;
  const ST = { ACCRUED: 'b-amber', SETTLED: 'b-green', WAIVED: 'b-blue' };
  const ents = r.entries.length ? r.entries.map((e) => `<div class="kv"><span>${e.kind === 'ADJUSTMENT' ? 'Adjustment' : 'Booking #' + e.booking_id}<small class="muted" style="display:block">${esc(e.note || '')} · ${stamp(e.created_at)}</small></span><b>${naira(e.amount_kobo)} ${bd(ST[e.status], e.status)}${e.status === 'ACCRUED' && e.remaining_kobo < e.amount_kobo ? `<small class="muted" style="display:block">${naira(e.remaining_kobo)} left</small>` : ''}</b></div>`).join('') : '<div class="muted small">No entries.</div>';
  const apps = r.applications.length ? r.applications.map((a) => `<div class="kv"><span>${esc(String(a.kind).replace('_', ' ').toLowerCase())}<small class="muted" style="display:block">${esc(a.reason || '')}${a.reference ? ' · ' + esc(a.reference) : ''} · ${stamp(a.created_at)}</small></span><b>${naira(a.amount_kobo)}</b></div>`).join('') : '<div class="muted small">Nothing applied yet.</div>';
  const m = modal(`<div class="sh-h"><div><h2 style="margin:0">${esc(b.shop_name || 'Barber')} · ledger</h2><div class="muted small">Barber #${id}</div></div><button class="btn sm sec" data-close>Close</button></div>
    <div class="row-badges">${bal.blocked ? bd('b-red', 'PAY ON ARRIVAL OFF') : bd('b-green', 'PAY ON ARRIVAL ON')}</div>${bal.reason ? `<div class="note"><b>Why it is off</b>${esc(bal.reason)}</div>` : ''}
    <div class="tiles" style="grid-template-columns:1fr 1fr"><div class="tile ${bal.outstanding_kobo ? 'alert' : ''}"><span>Owed now</span><b>${naira(bal.outstanding_kobo)}</b></div><div class="tile"><span>Oldest entry</span><b>${bal.oldest_days} d</b></div></div>
    <h3>Entries</h3>${ents}<h3>Settlements, waivers and netting</h3>${apps}
    <div class="btns end sticky"><button class="btn sm sec" data-k="remind">Remind</button><button class="btn sm sec" data-k="adjust">Add adjustment</button><button class="btn sm sec" data-k="waive">Waive</button><button class="btn sm" data-k="settle">Mark settled</button></div>`);
  m.el.querySelectorAll('[data-k]').forEach((x) => x.onclick = async () => {
    const k = x.dataset.k;
    if (k === 'remind') { x.disabled = true; try { const o = await post('/ledger/remind', { barber_id: id }); toast(o.reminded ? 'Reminder sent' : 'Nothing owed'); } catch (e) { toast(e.message, true); } x.disabled = false; return; }
    m.close();
    const amt = { name: 'amount_naira', label: 'Amount (₦)', type: 'number', step: 'any', min: 0.01, ph: 'Leave empty to use the whole balance' };
    const copy = {
      settle: ['Mark as settled', 'Use this when the barber paid the platform outside the app (for example by bank transfer). We clear the oldest items first.', 'Mark settled', ''],
      waive: ['Waive balance', 'Cancel part or all of the balance. We record this and tell the barber.', 'Waive', 'red'],
      adjust: ['Add adjustment', 'Adds money the barber owes (for example to fix a mistake, or a fee).', 'Add to balance', ''],
    }[k];
    formModal({ title: copy[0] + ' — ' + (b.shop_name || ''), help: copy[1], go: copy[2], cls: copy[3], fields: [amt, REASON()], after: async () => { if (reload) await reload(); },
      submit: async (v) => { const body = { reason: v.reason }; if (v.amount_naira) body.amount_naira = v.amount_naira; else if (k === 'adjust') throw new Error('Enter the amount to add.'); else body.all = true; const o = await post(`/ledger/${id}/${k}`, body); return `${naira(o.applied_kobo)} ${k === 'adjust' ? 'added' : k === 'settle' ? 'settled' : 'waived'} · now owed ${naira(o.owed_kobo)}`; } });
  });
}

/* ---------- broadcasts ---------- */
async function broadcast() {
  const r = await api('/broadcasts'); drawNav('broadcast');
  app.innerHTML = head('Broadcast', 'Send a message in the app to a whole group or to one person. Suspended and banned users do not get it.') +
    `<div class="card"><form id="bf"><div class="formgrid"><div><label>Send to</label><select name="audience"><option value="customers">All customers</option><option value="barbers">All barbers</option><option value="user">One user (by id)</option></select></div>
      <div id="uidbox" class="hidden"><label>User id</label><input name="user_id" type="number" min="1" placeholder="e.g. 12 (see Customers)"></div></div>
      <label>Title</label><input name="title" maxlength="80" required><label>Message</label><textarea name="body" rows="4" maxlength="500" required></textarea>
      <div class="err hidden" id="berr"></div><div class="btns cta"><button class="btn" type="submit">Send announcement</button></div></form></div>
    <h2>Recent broadcasts</h2>` + table([['Title', (b) => `${esc(b.title)}<span class="sub">${esc(b.body).slice(0, 120)}</span>`], ['To', (b) => esc(b.audience.toLowerCase()) + (b.user_id ? ' #' + b.user_id : '')], ['Recipients', (b) => b.recipients, 'num'], ['Sent', (b) => stamp(b.created_at)]], r.broadcasts, 'Nothing sent yet.', { row: (b) => ({ t: esc(b.title), p: bd('b-gray', b.audience.toLowerCase() + (b.user_id ? ' #' + b.user_id : '')), m: esc(stamp(b.created_at) + ' · ' + b.body.slice(0, 120)), r: b.recipients + ' sent' }), title: (b) => b.title });
  const f = $('#bf'); f.elements.audience.onchange = () => $('#uidbox').classList.toggle('hidden', f.elements.audience.value !== 'user');
  f.onsubmit = async (ev) => {
    ev.preventDefault(); const v = Object.fromEntries(new FormData(f)); const n = v.audience === 'user' ? 'this user' : 'all ' + v.audience;
    if (!confirm(`Send this announcement to ${n}?`)) return;
    const b = f.querySelector('button'); b.disabled = true; $('#berr').classList.add('hidden');
    try { const body = { audience: v.audience, title: v.title, body: v.body }; if (v.audience === 'user') body.user_id = Number(v.user_id); const o = await post('/broadcast', body); toast(`Sent to ${o.recipients} user${o.recipients === 1 ? '' : 's'}`); await broadcast(); }
    catch (e) { const er2 = $('#berr'); er2.textContent = e.message; er2.classList.remove('hidden'); b.disabled = false; }
  };
}

/* ---------- reports inbox ---------- */
let rstat = 'OPEN';
async function reports() {
  const r = await api('/reports?status=' + rstat); badges.reports = r.counts.OPEN; drawNav('reports');
  const cols = [
    ['Report', (x) => `<b>${esc(x.category.replace('_', ' '))}</b><span class="sub">${esc(x.message)}</span>${x.admin_note ? `<span class="sub"><i>Resolution:</i> ${esc(x.admin_note)}</span>` : ''}`],
    ['From', (x) => `${esc(x.reporter_name)}<span class="sub">${esc(x.reporter_role)} #${x.reporter_id}</span>`], ['About', (x) => x.target_name ? `<a href="#" data-u="${x.target_user_id}">${esc(x.target_name)}</a><span class="sub">${esc(x.target_role)} #${x.target_user_id}</span>` : '—'],
    ['Booking', (x) => x.booking_id ? `<a href="#" data-b="${x.booking_id}">#${x.booking_id}</a>` : '—'], ['Filed', (x) => stamp(x.created_at)],
    ['', (x) => x.status === 'OPEN' ? act('Resolve', '', `data-do="res" data-id="${x.id}"`) + act('Dismiss', 'sec', `data-do="dis" data-id="${x.id}"`) : bd(x.status === 'RESOLVED' ? 'b-green' : 'b-gray', x.status), 'act'],
  ];
  app.innerHTML = head('Reports', 'Complaints from customers and barbers. Close each one with a note. We tell the person who reported it, unless you untick the box.', refreshBtn) +
    `<div class="pills">${['OPEN', 'RESOLVED', 'DISMISSED', 'ALL'].map((k) => `<button data-st="${k}" class="${rstat === k ? 'on' : ''}">${k[0] + k.slice(1).toLowerCase()} <span class="c">${k === 'ALL' ? r.counts.OPEN + r.counts.RESOLVED + r.counts.DISMISSED : r.counts[k]}</span></button>`).join('')}</div>` + table(cols, r.reports, rstat === 'OPEN' ? 'No open reports. 🎉' : 'Nothing here.');
  app.querySelectorAll('[data-st]').forEach((b) => b.onclick = () => { rstat = b.dataset.st; reports(); });
  app.querySelectorAll('[data-u]').forEach((a) => a.onclick = (e) => { e.preventDefault(); userSheet(Number(a.dataset.u), reports); });
  app.querySelectorAll('[data-b]').forEach((a) => a.onclick = (e) => { e.preventDefault(); bookingSheet(Number(a.dataset.b), reports); });
  wireReload(reports);
  const close = (status) => (d) => { formModal({ title: status === 'RESOLVED' ? 'Resolve report' : 'Dismiss report', help: 'We save your note. You can also send it to the person who reported.', go: status === 'RESOLVED' ? 'Resolve' : 'Dismiss', cls: status === 'RESOLVED' ? '' : 'sec',
    fields: [{ name: 'note', label: 'Resolution note', type: 'textarea', required: true, ph: 'What was done?' }, { name: 'notify_reporter', label: 'Tell the reporter', type: 'checkbox', value: true }], submit: async (v) => { await post(`/reports/${d.id}/resolve`, { status, note: v.note, notify_reporter: v.notify_reporter }); return 'Report ' + status.toLowerCase(); }, after: reports }); app.querySelectorAll('[data-do]').forEach((x) => x.disabled = false); };
  wireActions(app, { res: close('RESOLVED'), dis: close('DISMISSED') });
}

/* ---------- analytics (plain SVG-free bar charts) ---------- */
let adays = 30;
const chart = (series, key, fmt, cls) => {
  const max = Math.max(1, ...series.map((s) => s[key]));
  return `<div class="chart ${cls || ''}" role="img" aria-label="${esc(key)} per day">${series.map((s) => `<i style="height:${Math.max(2, Math.round((s[key] / max) * 100))}%" title="${esc(dlabel(s.day))}: ${esc(fmt(s[key]))}"></i>`).join('')}</div>
    <div class="chart-x"><span>${esc(dlabel(series[0].day))}</span><span>peak ${esc(fmt(max))}</span><span>${esc(dlabel(series[series.length - 1].day))}</span></div>`;
};
async function analytics() {
  const r = await api('/analytics?days=' + adays); drawNav('analytics'); const x = r.rates;
  app.innerHTML = head('Analytics', `${dlabel(r.from)} to ${dlabel(r.to)}. Revenue counts confirmed online payments. Bookings do not count checkouts that were left.`, refreshBtn) +
    `<div class="pills"><button data-d="7" class="${adays === 7 ? 'on' : ''}">Last 7 days</button><button data-d="30" class="${adays === 30 ? 'on' : ''}">Last 30 days</button></div>
     <div class="tiles"><div class="tile"><span>Bookings</span><b>${r.totals.bookings}</b></div><div class="tile"><span>Revenue</span><b>${naira(r.totals.revenue_kobo)}</b></div><div class="tile"><span>No-show rate</span><b>${x.no_show_pct}%</b><small>${x.no_show} of ${x.completed + x.no_show} served or missed</small></div><div class="tile"><span>Cancellation rate</span><b>${x.cancellation_pct}%</b><small>${x.cancelled} cancelled</small></div></div>
     <div class="tiles" style="grid-template-columns:repeat(2,1fr)"><div class="tile"><span>Incomplete payments</span><b>${x.incomplete_payment_pct}%</b><small>${x.online_incomplete} of ${x.online_attempts} online attempts</small></div><div class="tile"><span>Completed</span><b>${x.completed}</b></div></div>
     <h2>Bookings per day</h2><div class="card">${chart(r.series, 'bookings', (v) => v + ' booking' + (v === 1 ? '' : 's'))}</div>
     <h2>Revenue per day</h2><div class="card">${chart(r.series, 'revenue_kobo', naira, 'alt')}</div>
     <h2>Top barbers</h2>` + table([['Shop', (b) => esc(b.shop_name)], ['Completed', (b) => b.completed, 'num'], ['Revenue', (b) => naira(b.revenue_kobo), 'num']], r.top_barbers, 'Nothing happened in this time.', { row: (b) => ({ t: esc(b.shop_name), m: b.completed + ' completed', r: naira(b.revenue_kobo) }), title: (b) => b.shop_name });
  app.querySelectorAll('[data-d]').forEach((b) => b.onclick = () => { adays = Number(b.dataset.d); analytics(); });
  wireReload(analytics);
}

/* ---------- controls: maintenance, feature switches, commission ---------- */
const SMART = [
  ['feature_push', 'Push notifications', 'Real alerts on phones and computers for bookings, reminders, the waitlist and messages. If it is off, people only see the bell in the app.'],
  ['feature_reminders', 'Reminders and "leave now" nudges', 'Alerts 2 hours and 30 minutes before, and a reminder to leave based on the live line.'],
  ['feature_favourites', 'Favourites', 'Customers can save barbers. Saved barbers show first.'],
  ['feature_rebook', 'Book again', 'Quick "book again" ideas on the customer home page.'],
  ['feature_waitlist', 'Waitlist', 'Customers can ask us to tell them when a time is free on a full day.'],
  ['feature_reviews', 'Ratings and reviews', 'Customers rate finished visits. Barbers can reply.'],
  ['feature_booking_note', 'Note to barber', 'Customers can add a short note when they book.'],
  ['feature_barber_notes', 'Barber private customer notes', 'Barbers keep private notes and see a customer\'s usual service.'],
  ['feature_reliability', 'Customer reliability badge', 'Barbers see New, Reliable or Often misses, based on past bookings.'],
  ['feature_quick_actions', 'Barber quick actions', '"I am late" delay and quick messages to the line.'],
  ['feature_daily_summary', 'Barber daily summary', 'Today boxes: bookings, earnings, no-shows.'],
  ['feature_loyalty', 'Loyalty credits (off by default)', 'Every Nth finished visit earns the customer a credit with that barber (amounts below).'],
];
async function controls() {
  const [{ settings: s }, earn] = await Promise.all([api('/settings'), api('/earnings?from=' + today0() + '&to=' + today0())]); drawNav('controls');
  const sw = (k, l, sub) => `<label class="chk tog"><input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''}> <span><b>${esc(l)}</b><small class="muted" style="display:block">${esc(sub)}</small></span></label>`;
  app.innerHTML = head('Controls', 'These switches work at once for everyone. Pause, fee and balance controls for one barber are in that barber\'s sheet.') +
    `<div class="card ${s.maintenance_mode ? 'warnbox' : ''}"><form id="cf"><h2 style="margin-top:0">Platform</h2>
      ${sw('maintenance_mode', 'Maintenance mode', 'Stops ALL new bookings and plan purchases. Bookings you already have and the barbers\' tools keep working. Customers see a banner.')}
      <label>Maintenance message (shown to customers)</label><input name="maintenance_message" maxlength="200" value="${esc(s.maintenance_message)}">
      <h2>Features</h2>${sw('feature_plans', 'Plans', 'Customers can buy and use session plans.')}${sw('feature_credits', 'Credits', 'Customers can use session credits.')}${sw('feature_pay_on_arrival', 'Pay on arrival', 'Customers can book and pay with cash or transfer at the shop.')}
      <h2>Notifications and smart features</h2><p class="small muted" style="margin:0 0 4px">Each one can be switched off instantly; nothing else changes. Push also needs the VAPID keys on the server (set).</p>
      ${SMART.map(([k, l, sub]) => sw(k, l, sub)).join('')}
      <div class="formgrid"><div><label>Loyalty: every Nth completed visit earns a credit</label><input type="number" name="loyalty_every_n" step="1" min="2" max="100" value="${esc(s.loyalty_every_n)}"></div>
      <div><label>Loyalty credit value (₦)</label><input type="number" name="loyalty_credit_naira" step="any" min="0" value="${esc(s.loyalty_credit_naira)}"></div></div>
      <h2>Off-app commission</h2>${sw('commission_enabled', 'Charge commission on off-app bookings', 'We add it when a pay-on-arrival booking is completed. We take it out of the barber\'s next online payments.')}
      <div class="formgrid"><div><label>Commission factor (0–1)</label><input type="number" name="commission_factor" step="0.05" min="0" max="1" value="${esc(s.commission_factor)}"><small class="muted">0.5 = half of the in-app platform fee. A ₦3,000 booking: in-app fee ${naira(earn.rules.example_fee_kobo)}.</small></div>
      <div><label>Barber keeps at least (% of a netted payment)</label><input type="number" name="min_barber_payout_percent" step="1" min="0" max="100" value="${esc(s.min_barber_payout_percent)}"></div>
      <div><label>Turn off pay on arrival above this debt (₦, 0 = no limit)</label><input type="number" name="ledger_max_debt_naira" step="any" min="0" value="${esc(s.ledger_max_debt_naira)}"></div>
      <div><label>…or when the oldest debt is this many days old (0 = no limit)</label><input type="number" name="ledger_max_age_days" step="1" min="0" value="${esc(s.ledger_max_age_days)}"></div></div>
      <p class="small muted">Platform fee percent and flat fee are in <a href="#/rules">Platform rules</a>. The fee can also be overridden per barber.</p>
      <div class="btns cta"><button class="btn" type="submit">Save controls</button></div></form></div>`;
  $('#cf').onsubmit = async (ev) => {
    ev.preventDefault(); const f = ev.target.elements; const body = {};
    for (const k of ['maintenance_mode', 'feature_plans', 'feature_credits', 'feature_pay_on_arrival', 'commission_enabled', ...SMART.map((x) => x[0])]) body[k] = f[k].checked;
    body.maintenance_message = f.maintenance_message.value.trim();
    for (const k of ['loyalty_every_n', 'loyalty_credit_naira', 'commission_factor', 'min_barber_payout_percent', 'ledger_max_debt_naira', 'ledger_max_age_days']) body[k] = Number(f[k].value);
    if (body.maintenance_mode && !s.maintenance_mode && !confirm('Turn maintenance mode ON? Customers cannot book until you turn it off.')) return;
    const b = ev.target.querySelector('button[type=submit]'); b.disabled = true;
    try { await api('/settings', { method: 'PUT', body }); toast('Controls saved'); await controls(); } catch (e) { toast(e.message, true); b.disabled = false; }
  };
}

/* ---------- per-barber controls (called from the barber sheet) ---------- */
function barberPause(b, reload) {
  if (b.booking_paused) return post(`/barbers/${b.id}/pause`, { paused: false }).then(() => { toast('Bookings resumed'); return reload(); });
  formModal({ title: 'Pause new bookings — ' + b.shop_name, help: 'Customers still see the shop, but nobody can make a new booking. Bookings you already have stay the same.', go: 'Pause bookings', cls: 'red', fields: [REASON('Reason (the barber sees this)')], submit: async (v) => { await post(`/barbers/${b.id}/pause`, { paused: true, reason: v.reason }); return 'New bookings paused'; }, after: reload });
}
function barberFee(b, reload) {
  const has = b.fee_percent_override != null || b.fee_flat_kobo_override != null;
  formModal({ title: 'Fee override — ' + b.shop_name, help: 'Use these instead of the platform fee for this barber (for online payments, plan sales and commission on bookings paid outside the app). Leave both empty to use the usual platform fee.', go: 'Save fee', fields: [
    { name: 'percent', label: 'Fee percent (%)', type: 'number', step: 'any', min: 0, value: b.fee_percent_override ?? '' }, { name: 'flat_naira', label: 'Flat fee (₦)', type: 'number', step: 'any', min: 0, value: b.fee_flat_kobo_override != null ? b.fee_flat_kobo_override / 100 : '' },
    { name: 'reason', label: 'Reason (optional)', type: 'textarea', rows: 2 }], submit: async (v) => { await post(`/barbers/${b.id}/fee`, { percent: v.percent, flat_naira: v.flat_naira, reason: v.reason }); return has && v.percent == null && v.flat_naira == null ? 'Override cleared' : 'Fee saved'; }, after: reload });
}

/* ---------- global search (top bar) ---------- */
function mountSearch() {
  if ($('#gsearch')) return;
  const h = document.createElement('div'); h.className = 'gsearch'; h.innerHTML = '<input id="gsearch" type="search" placeholder="Search users, bookings, payments" autocomplete="off" aria-label="Global search"><div id="gres" class="gres hidden"></div>';
  $('.topbar').insertBefore(h, $('#topright'));
  let t; const box = $('#gres');
  const hide = () => box.classList.add('hidden');
  $('#gsearch').oninput = (e) => { clearTimeout(t); const q = e.target.value.trim(); if (q.length < 2) return hide(); t = setTimeout(async () => {
    try {
      const r = await api('/search?q=' + encodeURIComponent(q)); const parts = [];
      if (r.users.length) parts.push('<h4>People</h4>' + r.users.map((u) => `<a href="#" data-su="${u.id}">${esc(u.name)} <small>${esc(u.role)} · ${esc(u.email || u.phone || '')}</small></a>`).join(''));
      if (r.barbers.length) parts.push('<h4>Shops</h4>' + r.barbers.map((b) => `<a href="#" data-sb="${b.id}">${esc(b.shop_name)} <small>${esc(b.review_status)} · ${esc(b.name)}</small></a>`).join(''));
      if (r.bookings.length) parts.push('<h4>Bookings</h4>' + r.bookings.map((b) => `<a href="#" data-sk="${b.id}">#${b.id} ${esc(b.service_name)} <small>${esc(b.customer_name)} · ${esc(b.shop_name)}</small></a>`).join(''));
      if (r.payments.length) parts.push('<h4>Payments</h4>' + r.payments.map((p) => `<a href="#" data-sk="${p.booking_id || ''}" data-sp="${esc(p.reference)}"><span class="mono">${esc(p.reference)}</span> <small>${naira(p.amount_kobo)} · ${esc(p.status)}</small></a>`).join(''));
      box.innerHTML = parts.join('') || '<div class="none">No matches.</div>'; box.classList.remove('hidden');
      box.querySelectorAll('[data-su]').forEach((a) => a.onclick = (e) => { e.preventDefault(); hide(); userSheet(Number(a.dataset.su), route); });
      box.querySelectorAll('[data-sb]').forEach((a) => a.onclick = (e) => { e.preventDefault(); hide(); barberDetail(Number(a.dataset.sb), route); });
      box.querySelectorAll('[data-sk]').forEach((a) => a.onclick = (e) => { e.preventDefault(); hide(); if (a.dataset.sk) bookingSheet(Number(a.dataset.sk), route); else { location.hash = '#/payments'; } });
    } catch (e) { box.innerHTML = `<div class="none">${esc(e.message)}</div>`; box.classList.remove('hidden'); }
  }, 300); };
  document.addEventListener('click', (e) => { if (!e.target.closest('.gsearch')) hide(); });
  window.addEventListener('hashchange', () => { hide(); $('#gsearch').value = ''; });
  $('#gsearch').onkeydown = (e) => { if (e.key === 'Escape') { hide(); e.target.blur(); } };
}

/* ---------- audit log with filters ---------- */
let af = { action: '', q: '', from: '', to: '', actor: '', scope: 'admin' };
async function audit2(more) {
  const p = Object.fromEntries(Object.entries(af).filter(([, v]) => v)); if (more) p.before = more;
  const r = await api('/audit?' + new URLSearchParams({ ...p, limit: 100 })); drawNav('audit');
  const rows = r.entries.map((e) => `<div class="arow"><div><b>${esc(human(e.action))}</b> ${e.actor_role === 'admin' ? bd('b-blue', 'ADMIN') : bd('b-gray', String(e.actor_role).toUpperCase())}<div class="when">${stamp(e.created_at)}${e.booking_id ? ' · booking #' + e.booking_id : ''}</div></div>${e.details && Object.keys(e.details).length ? `<pre>${esc(JSON.stringify(e.details))}</pre>` : ''}</div>`).join('');
  const html = r.entries.length ? rows : '<div class="empty">No entries match.</div>';
  if (more) { $('#alist').insertAdjacentHTML('beforeend', html); const mb = $('#amore'); if (r.next_before) mb.dataset.before = r.next_before; else mb.remove(); return; }
  app.innerHTML = head('Audit log', 'Everything an admin did, plus key events. Filter by action, words, type of person or date.', refreshBtn) +
    `<div class="filters"><select id="a-action" aria-label="Action"><option value="">Any action</option>${r.actions.map((a) => `<option value="${esc(a)}" ${a === af.action ? 'selected' : ''}>${esc(human(a))}</option>`).join('')}</select>
      <input type="search" id="a-q" placeholder="Search text or booking #" value="${esc(af.q)}"><select id="a-actor" aria-label="Actor"><option value="">Any actor</option>${['admin', 'system', 'customer', 'barber'].map((a) => `<option ${a === af.actor ? 'selected' : ''}>${a}</option>`).join('')}</select>
      <input type="date" id="a-from" value="${esc(af.from)}" aria-label="From"><input type="date" id="a-to" value="${esc(af.to)}" aria-label="To">
      <select id="a-scope" aria-label="Scope"><option value="admin" ${af.scope === 'admin' ? 'selected' : ''}>Admin + key events</option><option value="all" ${af.scope === 'all' ? 'selected' : ''}>Everything</option></select><button class="btn sm sec" id="a-clear">Clear</button></div>
    <div class="card log" id="alist">${html}</div>${r.next_before ? `<div class="btns cta"><button class="btn sec" id="amore" data-before="${r.next_before}">Load older</button></div>` : ''}`;
  const apply = () => { af = { action: $('#a-action').value, q: $('#a-q').value.trim(), from: $('#a-from').value, to: $('#a-to').value, actor: $('#a-actor').value, scope: $('#a-scope').value }; audit2(); };
  ['#a-action', '#a-actor', '#a-from', '#a-to', '#a-scope'].forEach((s) => $(s).onchange = apply); $('#a-q').onkeydown = (e) => { if (e.key === 'Enter') apply(); };
  $('#a-clear').onclick = () => { af = { action: '', q: '', from: '', to: '', actor: '', scope: 'admin' }; audit2(); };
  const mb = $('#amore'); if (mb) mb.onclick = () => audit2(Number(mb.dataset.before));
  wireReload(() => audit2());
}

/* ---------- plug into admin.js ---------- */
Object.assign(ROUTES, { customers, earnings, ledger, broadcast, reports, analytics, controls, audit: audit2 });
window.ADM2 = { userSheet, bookingSheet, ledgerSheet, barberPause, barberFee, formModal, REASON, post, mountSearch };
