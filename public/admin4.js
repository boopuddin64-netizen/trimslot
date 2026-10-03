/* TrimSlot admin portal, part 4: admin PIN, deletes (soft + forever), recently deleted, test-data cleanup.
   The PIN is never stored in the page: every irreversible request that the server refuses with PIN_* asks for it, then retries once. */
'use strict';

/* ---------- PIN prompt: wraps api() so EVERY irreversible action (present and future) is covered ---------- */
const _api = api;
function pinDialog(message, o = {}) {
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = modal(`<form class="rform pinf" id="pinf" autocomplete="off" novalidate><h2 style="margin-top:0">${esc(o.title || 'Enter your admin PIN')}</h2>
      <p class="muted small">${esc(o.help || 'This action cannot be undone, so it needs your 4-digit PIN.')}</p>
      ${message ? `<div class="err" role="alert">${esc(message)}</div>` : ''}
      <label for="pinv">4-digit PIN</label><input id="pinv" class="pin" type="password" inputmode="numeric" pattern="\\d{4}" maxlength="4" autocomplete="one-time-code" aria-label="Admin PIN">
      <div class="btns end"><button type="button" class="btn sec" id="pinx">Cancel</button><button class="btn red" id="ping" type="submit" disabled>Confirm</button></div></form>`);
    const inp = $('#pinv', m.el), go = $('#ping', m.el); inp.focus();
    inp.oninput = () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 4); go.disabled = inp.value.length !== 4; };
    $('#pinx', m.el).onclick = () => fin(null);
    m.el.addEventListener('click', (e) => { if (e.target === m.el) fin(null); });
    $('#pinf', m.el).onsubmit = (e) => { e.preventDefault(); if (inp.value.length === 4) fin(inp.value); };
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); fin(null); } }); obs.observe(document.body, { childList: true });
  });
}
/** First-time PIN creation inside the flow (the action that needed it continues afterwards). */
function pinSetupDialog() {
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = modal(`<form class="rform pinf" id="psf" autocomplete="off" novalidate><h2 style="margin-top:0">Create your admin PIN</h2>
      <p class="muted small">Deletes, bans and other irreversible actions need a 4-digit PIN. You set it once; you can change it later in Settings → Admin PIN.</p>
      <div class="err hidden" id="pserr" role="alert"></div>
      <label for="ps1">New PIN</label><input id="ps1" class="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password">
      <label for="ps2">Repeat PIN</label><input id="ps2" class="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password">
      <div class="btns end"><button type="button" class="btn sec" id="psx">Cancel</button><button class="btn" id="psg" type="submit" disabled>Save PIN</button></div></form>`);
    const a = $('#ps1', m.el), b = $('#ps2', m.el), go = $('#psg', m.el); a.focus();
    const sync = () => { a.value = a.value.replace(/\D/g, '').slice(0, 4); b.value = b.value.replace(/\D/g, '').slice(0, 4); go.disabled = !(a.value.length === 4 && a.value === b.value); };
    a.oninput = sync; b.oninput = sync; $('#psx', m.el).onclick = () => fin(false);
    $('#psf', m.el).onsubmit = async (e) => {
      e.preventDefault(); go.disabled = true;
      try { await _api('/pin/setup', { method: 'POST', body: { pin: a.value } }); toast('Admin PIN saved'); fin(true); }
      catch (er) { const x = $('#pserr', m.el); x.textContent = er.message; x.classList.remove('hidden'); go.disabled = false; }
    };
  });
}
window.api = async function apiWithPin(path, opts = {}) {
  try { return await _api(path, opts); }
  catch (err) {
    if (path.startsWith('/pin/') || !['PIN_REQUIRED', 'PIN_WRONG', 'PIN_NOT_SET'].includes(err.code)) throw err;
    let code = err.code, msg = '';
    for (let tries = 0; tries < 8; tries++) {
      if (code === 'PIN_NOT_SET') { if (!(await pinSetupDialog())) throw new Error('Cancelled. Nothing was changed.'); code = 'PIN_REQUIRED'; }
      const pin = await pinDialog(msg);
      if (pin == null) throw new Error('Cancelled. Nothing was changed.');
      try { return await _api(path, { ...opts, headers: { ...(opts.headers || {}), 'X-Admin-Pin': pin } }); }
      catch (e2) { if (e2.code === 'PIN_WRONG' || e2.code === 'PIN_REQUIRED') { code = 'PIN_REQUIRED'; msg = e2.message; continue; } throw e2; }   // PIN_LOCKED & everything else surface as-is
    }
    throw new Error('Too many attempts.');
  }
};

/* ---------- delete dialogs ---------- */
const LABEL = { customer: 'customer', barber: 'barber', booking: 'booking', plan: 'plan', review: 'review', report: 'report' };
/** o: { type, id, name, upcoming?:bool, after } */
function deleteDialog(o) {
  const hard = o.type === 'booking';
  const fields = [REASON('Reason (saved in the audit log)')];
  if (o.type === 'customer' || o.type === 'barber') fields.push({ name: 'cancel_bookings', label: 'Also cancel their upcoming bookings (the other side is told, paid ones refunded)', type: 'checkbox' });
  return formModal({
    title: `Delete ${LABEL[o.type]}${o.name ? ' — ' + o.name : ''}`,
    help: hard ? 'Bookings are removed permanently (only if nothing was paid and they are not live). Your PIN is required.' : 'Hidden everywhere right away. You can restore it for 30 days from Recently deleted. Your PIN is required.',
    go: hard ? 'Delete permanently' : 'Delete', cls: 'red', fields,
    submit: async (v) => { await post(`/delete/${o.type}/${o.id}`, { reason: v.reason, ...(v.cancel_bookings ? { cancel_bookings: true } : {}) }); return hard ? 'Booking deleted' : 'Deleted. Restorable for 30 days.'; },
    after: o.after,
  });
}
window.ADM4 = { deleteDialog, pinDialog };

/* ---------- Admin PIN page ---------- */
const PIN_IC = '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
async function pinPage() {
  const st = await _api('/pin/status'); drawNav('pin');
  app.innerHTML = head('Admin PIN', 'A 4-digit PIN protects deletes, bans, refunds, ledger waive/adjust and other irreversible actions.') + (st.set ? `
    <div class="card"><div class="row between"><b>PIN is set</b><span class="badge b-green">ACTIVE</span></div>
      <p class="small muted" style="margin:6px 0 0">Set ${esc(stamp(st.set_at))}. ${st.locked ? `<b>Locked for ${Math.ceil(st.retry_after_s / 60)} more minute(s)</b> after too many wrong tries.` : `${st.attempts_left} of 5 tries left before a 15-minute lock.`}</p></div>
    <form class="card rform" id="chg" autocomplete="off" novalidate><h2 style="margin-top:0">Change PIN</h2><div class="err hidden" id="cerr" role="alert"></div>
      <label for="p0">Current PIN</label><input id="p0" class="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="off">
      <label for="p1">New PIN</label><input id="p1" class="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password">
      <label for="p2">Repeat new PIN</label><input id="p2" class="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password">
      <div class="btns end"><button class="btn" id="cgo" type="submit" disabled>Change PIN</button></div></form>`
    : `<div class="warnbox card"><b>No PIN yet.</b><p class="small" style="margin:6px 0 0">Until you set one, deletes and other irreversible actions are refused. Choose 4 digits you will remember — it cannot be recovered, only reset by a developer.</p></div>
    <form class="card rform" id="set" autocomplete="off" novalidate><h2 style="margin-top:0">Create PIN</h2><div class="err hidden" id="cerr" role="alert"></div>
      <label for="p1">New PIN</label><input id="p1" class="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password">
      <label for="p2">Repeat PIN</label><input id="p2" class="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="new-password">
      <div class="btns end"><button class="btn" id="cgo" type="submit" disabled>Save PIN</button></div></form>`);
  const ins = [...app.querySelectorAll('input.pin')], go = $('#cgo');
  const sync = () => { ins.forEach((i) => { i.value = i.value.replace(/\D/g, '').slice(0, 4); }); const v = ins.map((i) => i.value); go.disabled = !(v.every((x) => x.length === 4) && v[v.length - 1] === v[v.length - 2]); };
  ins.forEach((i) => i.oninput = sync);
  (st.set ? $('#chg') : $('#set')).onsubmit = async (e) => {
    e.preventDefault(); go.disabled = true; const er = $('#cerr'); er.classList.add('hidden');
    try {
      if (st.set) await _api('/pin/change', { method: 'POST', body: { old_pin: $('#p0').value, new_pin: $('#p1').value } });
      else await _api('/pin/setup', { method: 'POST', body: { pin: $('#p1').value } });
      toast(st.set ? 'PIN changed' : 'PIN saved'); pinPage();
    } catch (x) { er.textContent = x.message; er.classList.remove('hidden'); go.disabled = false; }
  };
}

/* ---------- Recently deleted ---------- */
async function deletedPage() {
  const r = await _api('/deleted'); drawNav('deleted');
  const cols = [
    ['Item', (x) => `<b>${esc(x.label)}</b><span class="sub">${esc(x.type)}${x.sub ? ' · ' + esc(x.sub) : ''}</span>`], ['Deleted', (x) => dshort(x.deleted_at)],
    ['Time left', (x) => x.days_left > 0 ? `${x.days_left} day${x.days_left === 1 ? '' : 's'} to restore` : bd('b-gray', 'RESTORE ENDED')],
    ['', (x) => (x.days_left > 0 ? act('Restore', '', `data-do="rs" data-t="${x.type}" data-id="${x.id}"`) : '') + act('Delete forever', 'red', `data-do="pg" data-t="${x.type}" data-id="${x.id}" data-n="${esc(x.label)}"`), 'act'],
  ];
  app.innerHTML = head('Recently deleted', `Deleted customers, barbers, plans, reviews and reports can be restored for ${r.window_days} days. “Delete forever” needs your PIN and is refused when real payments are on record.`, refreshBtn) + table(cols, r.items, 'Nothing has been deleted.');
  wireReload(deletedPage);
  wireActions(app, {
    rs: async (d) => { await post(`/restore/${d.t}/${d.id}`); toast('Restored'); deletedPage(); },
    pg: async (d) => { formModal({ title: `Delete forever — ${d.n}`, help: 'This cannot be undone. Your PIN is required.', go: 'Delete forever', cls: 'red', fields: [REASON()], submit: async (v) => { await post(`/purge/${d.t}/${d.id}`, v); return 'Deleted forever'; }, after: deletedPage }); app.querySelectorAll('[data-do]').forEach((x) => x.disabled = false); },
  });
}

/* ---------- Test data ---------- */
async function testDataPage() {
  const p = await _api('/testdata/preview'); drawNav('testdata');
  app.innerHTML = head('Test data', 'Remove throwaway accounts (smoketest+…@example.com and perf…@perf.test) with everything they created. Real accounts can never match.', refreshBtn) + `
    <div class="card"><h2 style="margin-top:0">Preview (nothing is deleted yet)</h2>
      ${kvr('Accounts', p.users)}${kvr('Customers', p.customers)}${kvr('Barbers', p.barbers)}${kvr('Bookings', p.bookings)}
      ${p.sample.length ? `<p class="small muted" style="margin:8px 0 0">e.g. ${p.sample.map(esc).join(', ')}</p>` : '<p class="small muted">No test data found.</p>'}
      <div class="btns end"><button class="btn red" id="tdgo" ${p.users ? '' : 'disabled'}>Delete test data…</button></div></div>`;
  wireReload(testDataPage);
  const b = $('#tdgo'); if (b) b.onclick = () => formModal({ title: `Delete ${p.users} test account${p.users === 1 ? '' : 's'} forever`, help: `This also deletes ${p.bookings} booking${p.bookings === 1 ? '' : 's'} and their payments. Type DELETE TEST DATA to confirm; your PIN is asked next.`, go: 'Delete test data', cls: 'red', fields: [{ name: 'confirm', label: 'Type DELETE TEST DATA', required: true }], submit: async (v) => { if (v.confirm !== 'DELETE TEST DATA') throw new Error('Type DELETE TEST DATA exactly.'); const r = await post('/testdata/purge', { confirm: v.confirm }); return `Deleted ${r.users} account(s) and ${r.bookings} booking(s)`; }, after: testDataPage });
}

IC.pin = PIN_IC; IC.deleted = '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'; IC.testdata = '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/>';
GROUPS.find(([g]) => g === 'Settings')[1].push(['pin', 'Admin PIN'], ['deleted', 'Recently deleted'], ['testdata', 'Test data']);
Object.assign(ROUTES, { pin: pinPage, deleted: deletedPage, testdata: testDataPage });
/* nudge on Home until a PIN exists */
const _home = ROUTES.home || ROUTES.overview;
ROUTES.home = async () => { await _home(); try { const s = await _api('/pin/status'); if (!s.set && location.hash.replace(/^#\/?/, '').split('?')[0] === 'home') app.insertAdjacentHTML('afterbegin', '<div class="warnbox card"><b>Set your admin PIN.</b> <span class="small">Deletes and other irreversible actions are blocked until you do. </span><a href="#/pin" class="btn sm">Set PIN</a></div>'); } catch { /* ignore */ } };
