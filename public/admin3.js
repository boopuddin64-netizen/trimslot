/* TrimSlot admin, part 3: the redesigned shell. Home with "needs attention", lean server-paginated lists (search / filter / sort / saved views / bulk),
   right-hand drawers, and a Ctrl/Cmd+K command palette. Loaded after admin2.js and shares its helpers. All rendering escapes data. */
(() => {
'use strict';
const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const stars = (n) => '<span class="stars" aria-label="' + n + ' out of 5">' + '★'.repeat(n) + '<i>' + '☆'.repeat(5 - n) + '</i></span>';
const STATE = {};
const PAGE = 25;

/* ---------------------------------------------------------------- generic list page */
function listPage(cfg) {
  return async function () {
    drawNav(cfg.nav || cfg.key);
    const counts = cfg.counts ? await api(cfg.counts).catch(() => null) : null;
    const qs = window.QS; const fromUrl = qs && [...qs.keys()].length;
    const base = cfg.defaults ? cfg.defaults(counts) : {};
    let st = STATE[cfg.key] = fromUrl ? { ...base, ...Object.fromEntries([...qs.entries()].filter(([k]) => (cfg.params || []).includes(k))) } : (STATE[cfg.key] || base);
    let cursor = null, rows = [], total = null, capped = false, seq = 0; const sel = new Map(); let sortDir = st.dir || 'desc';
    const saved = () => lsGet('adm_sf_' + cfg.key, []);
    const pills = cfg.pills ? `<div class="pills" id="lpills" role="tablist">${cfg.pills.items.map(([v, l]) => `<button role="tab" data-v="${esc(v)}" class="${String(st[cfg.pills.param] ?? '') === v ? 'on' : ''}">${esc(l)}${counts && cfg.pills.count && counts[v] != null ? ` <span class="c">${counts[v]}</span>` : ''}</button>`).join('')}</div>` : '';
    const sels = (cfg.selects || []).map((s) => `<select data-p="${s.param}" aria-label="${esc(s.label)}">${s.options.map(([v, l]) => `<option value="${esc(v)}" ${String(st[s.param] ?? '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`).join('');
    const dates = (cfg.dates || []).map((d) => `<input type="date" data-p="${d.param}" aria-label="${esc(d.label)}" title="${esc(d.label)}" value="${esc(st[d.param] || '')}">`).join('');
    const sorts = cfg.sorts ? `<select id="lsort" aria-label="Sort by">${cfg.sorts.map(([v, l]) => `<option value="${v}" ${(st.sort || cfg.sorts[0][0]) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><button class="btn sm sec" id="ldir" aria-label="Reverse order" title="Reverse order">${sortDir === 'asc' ? '↑' : '↓'}</button>` : '';
    app.innerHTML = head(cfg.title, cfg.sub, cfg.headRight || '') + pills +
      `<div class="lbar"><input type="search" id="lq" placeholder="${esc(cfg.search || 'Search')}" value="${esc(st.q || '')}" autocomplete="off" aria-label="Search ${esc(cfg.title)}">${sels}${dates}${sorts}
        <span class="sv"><select id="lsaved" aria-label="Saved views"></select><button class="btn sm sec" id="lsave">Save view</button><button class="btn sm sec hidden" id="ldel" aria-label="Delete saved view">Delete</button></span></div>
      <div class="lmeta"><span id="ltotal" class="muted small"></span>${cfg.bulk ? '<label class="chk small" id="lall"><input type="checkbox" id="lallc"> Select loaded rows</label>' : ''}</div>
      <div id="lbulk" class="bulkbar hidden" role="region" aria-label="Bulk actions"></div><div id="lbody"></div><div id="lmore" class="btns cta"></div>`;
    const body = $('#lbody'), more = $('#lmore');
    const drawSaved = () => { const s = saved(); $('#lsaved').innerHTML = '<option value="">Saved views</option>' + s.map((x, i) => `<option value="${i}">${esc(x.name)}</option>`).join(''); $('#lsaved').classList.toggle('hidden', !s.length); $('#ldel').classList.add('hidden'); };
    drawSaved();
    const cols = cfg.cols;
    const cards = () => !!cfg.row && !MQD.matches;
    const crowHtml = (r) => { const d = cfg.row(r); if (cfg.bulk) d.sel = `<label class="selbox"><input type="checkbox" data-sel="${r.id}" aria-label="Select row" ${sel.has(r.id) ? 'checked' : ''}></label>`; return crow(d, `data-id="${r.id}"`); };
    const rowHtml = (r) => `<tr data-id="${r.id}" ${cfg.open ? 'tabindex="0" class="click"' : ''}>${cols.map(([l, f, c], i) => `<td class="${i === 0 ? 'main' : c === 'act' ? 'act' : c === 'num' ? 'num' : ''}" data-l="${esc(l)}">${i === 0 && cfg.bulk ? `<label class="selbox"><input type="checkbox" data-sel="${r.id}" aria-label="Select row" ${sel.has(r.id) ? 'checked' : ''}></label>` : ''}${f(r)}</td>`).join('')}</tr>`;
    const skeleton = () => { body.innerHTML = '<div class="card">' + Array.from({ length: 6 }, () => '<div class="sk sk-l"></div><div class="sk sk-l s"></div>').join('') + '</div>'; more.innerHTML = ''; };
    const empty = () => `<div class="empty"><b>${esc(cfg.empty || 'Nothing here.')}</b><div class="small" style="margin-top:4px">${st.q || hasFilter() ? 'Try a different search or clear the filters.' : ''}</div>${st.q || hasFilter() ? '<div class="btns cta"><button class="btn sm sec" id="lclear">Clear filters</button></div>' : ''}</div>`;
    const hasFilter = () => Object.entries(st).some(([k, v]) => k !== 'q' && k !== 'sort' && k !== 'dir' && v && v !== (base[k] ?? ''));
    function bulkUi() {
      const b = $('#lbulk'); if (!cfg.bulk) return;
      if (!sel.size) { b.classList.add('hidden'); b.innerHTML = ''; return; }
      b.classList.remove('hidden');
      b.innerHTML = `<b>${sel.size} selected</b>${cfg.bulk.map((x, i) => `<button class="btn sm ${x.cls || 'sec'}" data-bulk="${i}">${esc(x.label)}</button>`).join('')}<button class="btn sm sec" id="bclear">Clear</button>`;
      $('#bclear').onclick = () => { sel.clear(); body.querySelectorAll('[data-sel]').forEach((c) => c.checked = false); bulkUi(); };
      b.querySelectorAll('[data-bulk]').forEach((x) => x.onclick = () => cfg.bulk[Number(x.dataset.bulk)].run([...sel.values()], async () => { sel.clear(); bulkUi(); await load(true); }));
    }
    function drawRows(list, fresh) {
      if (cards()) { if (fresh || !$('#lclist')) body.innerHTML = `<div class="clist" id="lclist">${list.map(crowHtml).join('')}</div>`; else $('#lclist').insertAdjacentHTML('beforeend', list.map(crowHtml).join('')); return; }
      if (fresh || !$('#ltbl')) body.innerHTML = `<div class="tblwrap"><table class="tbl" id="ltbl"><thead><tr>${cols.map(([l, , c]) => `<th class="${c === 'num' ? 'num' : ''}">${esc(l)}</th>`).join('')}</tr></thead><tbody>${list.map(rowHtml).join('')}</tbody></table></div>`;
      else $('#ltbl tbody').insertAdjacentHTML('beforeend', list.map(rowHtml).join(''));
    }
    const onMq = () => { if (!document.body.contains(body)) { MQD.removeEventListener('change', onMq); return; } if (rows.length) drawRows(rows, true); };
    MQD.addEventListener('change', onMq);
    function rowSheet(row) {
      const acts = colActions(cols, row).map((a) => ({ label: a.label, cls: a.cls, run: () => Promise.resolve(cfg.handlers?.[a.data.act]?.(row, reload, { disabled: false })).catch((er) => toast(er.message, true)) }));
      openRowSheet(cols, row, { title: cfg.rowTitle ? cfg.rowTitle(row) : null, pills: cfg.row(row).p, acts, reload });
    }
    async function load(reset) {
      const my = ++seq;
      if (reset) { cursor = null; rows = []; skeleton(); } else { const mb = $('#lmoreb'); if (mb) { mb.disabled = true; mb.textContent = 'Loading…'; } }
      const p = new URLSearchParams({ limit: PAGE });
      for (const [k, v] of Object.entries(st)) if (v !== '' && v != null) p.set(k, v);
      p.set('dir', sortDir); if (cursor) p.set('cursor', cursor);
      let r;
      try { r = await api(`/l/${cfg.list}?` + p); } catch (e) { if (my === seq) { body.innerHTML = `<div class="err">${esc(e.message)}</div>`; more.innerHTML = '<div class="btns cta"><button class="btn sec" id="lretry">Try again</button></div>'; $('#lretry').onclick = () => load(reset); } return; }
      if (my !== seq) return;
      if (reset) { total = r.total; capped = r.total_capped; }
      const first = rows.length === 0; rows = rows.concat(r.rows); cursor = r.next;
      $('#ltotal').textContent = total == null ? '' : `${capped ? total.toLocaleString() + '+' : total.toLocaleString()} result${total === 1 ? '' : 's'}${rows.length < total ? ` · showing ${rows.length}` : ''}`;
      if (!rows.length) body.innerHTML = empty();
      else {
        drawRows(r.rows, first);
      }
      more.innerHTML = cursor ? '<button class="btn sec" id="lmoreb">Load more</button>' : (rows.length > PAGE ? '<span class="muted small">End of results</span>' : '');
      if (cursor) $('#lmoreb').onclick = () => load(false);
      const cl = $('#lclear'); if (cl) cl.onclick = () => { st = STATE[cfg.key] = { ...base }; sortDir = 'desc'; window.QS = new URLSearchParams(); (cfg.reopen || ROUTES[cfg.key])(); };
    }
    /* events (delegated once) */
    const reload = () => load(true);
    body.addEventListener('click', (e) => {
      const chk = e.target.closest('[data-sel]');
      if (chk) { const id = Number(chk.dataset.sel); const row = rows.find((x) => x.id === id); if (chk.checked) sel.set(id, row); else sel.delete(id); bulkUi(); return; }
      if (e.target.closest('label.selbox')) return;
      const a = e.target.closest('[data-act]');
      if (a) { e.preventDefault(); const row = rows.find((x) => x.id === Number(a.closest('[data-id]').dataset.id)); const h = cfg.handlers?.[a.dataset.act]; if (h) { a.disabled = true; Promise.resolve(h(row, reload, a)).catch((er) => toast(er.message, true)).finally(() => { a.disabled = false; }); } return; }
      if (e.target.closest('a,button,input,select')) return;
      const tr = e.target.closest('tr[data-id],.crow[data-id]'); if (!tr) return; const row = rows.find((x) => x.id === Number(tr.dataset.id));
      if (cfg.open) cfg.open(row, reload); else if (tr.classList.contains('crow')) rowSheet(row);
    });
    body.addEventListener('keydown', (e) => {
      const tr = e.target.closest?.('tr[data-id],.crow[data-id]'); if (!tr) return;
      if (e.key === 'Enter' && e.target === tr) { const row = rows.find((x) => x.id === Number(tr.dataset.id)); if (cfg.open) cfg.open(row, reload); else if (tr.classList.contains('crow')) rowSheet(row); }
      if (e.key === 'ArrowDown' && tr.nextElementSibling) { e.preventDefault(); tr.nextElementSibling.focus(); }
      if (e.key === 'ArrowUp' && tr.previousElementSibling) { e.preventDefault(); tr.previousElementSibling.focus(); }
    });
    if (cfg.bulk) $('#lallc').onchange = (e) => { body.querySelectorAll('[data-sel]').forEach((c) => { c.checked = e.target.checked; const id = Number(c.dataset.sel); if (e.target.checked) sel.set(id, rows.find((x) => x.id === id)); else sel.delete(id); }); bulkUi(); };
    const q = $('#lq'); q.oninput = debounce(() => { st.q = q.value.trim(); load(true); }, 280);
    q.onkeydown = (e) => { if (e.key === 'Escape') { q.value = ''; st.q = ''; load(true); } };
    app.querySelectorAll('[data-p]').forEach((el) => el.onchange = () => { st[el.dataset.p] = el.value; load(true); });
    if (cfg.pills) $('#lpills').querySelectorAll('button').forEach((b) => b.onclick = () => { st[cfg.pills.param] = b.dataset.v; $('#lpills').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); load(true); });
    if (cfg.sorts) { $('#lsort').onchange = (e) => { st.sort = e.target.value; load(true); }; $('#ldir').onclick = (e) => { sortDir = sortDir === 'asc' ? 'desc' : 'asc'; st.dir = sortDir; e.target.textContent = sortDir === 'asc' ? '↑' : '↓'; load(true); }; }
    $('#lsaved').onchange = (e) => { const s = saved()[Number(e.target.value)]; $('#ldel').classList.toggle('hidden', !s); if (!s) return; st = STATE[cfg.key] = { ...base, ...s.params }; sortDir = st.dir || 'desc'; window.QS = new URLSearchParams(); (cfg.reopen || ROUTES[cfg.key])(); };
    $('#ldel').onclick = () => { const i = Number($('#lsaved').value); const s = saved(); s.splice(i, 1); lsSet('adm_sf_' + cfg.key, s); toast('Saved view deleted'); drawSaved(); };
    $('#lsave').onclick = () => formModal({ title: 'Save this view', help: 'Keeps the current search, filters and sort so you can come back to it in one click. Saved in this browser.', go: 'Save view', fields: [{ name: 'name', label: 'Name', required: true, max: 40, ph: 'e.g. Pending this week' }],
      submit: async (v) => { if (!v.name) throw new Error('Give it a name.'); const s = saved().filter((x) => x.name !== v.name); s.push({ name: v.name.slice(0, 40), params: { ...st, dir: sortDir } }); lsSet('adm_sf_' + cfg.key, s.slice(-12)); drawSaved(); return 'View saved'; } });
    wireReload(() => load(true));
    await load(true);
    if (window.matchMedia('(min-width:720px)').matches && !fromUrl) { /* leave focus alone; "/" jumps to search */ }
  };
}

/* bulk confirm dialog: shows what will happen and to how many, requires a reason where relevant */
function bulkConfirm(o) {
  const n = o.rows.length; const names = o.rows.slice(0, 5).map((r) => esc(o.label(r))).join(', ') + (n > 5 ? ` and ${n - 5} more` : '');
  return formModal({ title: `${o.title} (${n})`, help: o.help, body: `<div class="note"><b>Applies to ${n} ${o.noun}${n === 1 ? '' : 's'}</b>${names}</div>`, go: o.go, cls: o.cls || '', fields: o.fields || [REASON()], after: o.after,
    submit: async (v) => { const out = await post(o.path, o.body(o.rows.map((r) => (o.idOf ? o.idOf(r) : r.id)), v)); const ch = out.changed ?? out.sent ?? 0; return `${o.done} ${ch} of ${n}` + (out.skipped ? ` · ${out.skipped} skipped (not applicable)` : ''); } });
}

/* ---------------------------------------------------------------- list definitions */
const custCols = [
  ['Customer', (u) => `${esc(u.name)}<span class="sub">${esc(u.email || u.phone || '')}</span>`],
  ['Status', (u) => acctBadge(u.account_status) + (u.warn_count ? ' ' + bd('b-amber', u.warn_count + ' warn') : '')],
  ['Bookings', (u) => u.bookings, 'num'], ['No-shows', (u) => u.no_shows ? `<b style="color:var(--red)">${u.no_shows}</b>` : '0', 'num'], ['Joined', (u) => dshort(u.created_at)],
];
const LISTS = {
  customers: {
    key: 'customers', list: 'customers', title: 'Customers', sub: 'Everyone who books. Click a row for their full profile and actions.', search: 'Search name, email, phone or #id', counts: '/counts/customers',
    params: ['q', 'status', 'sort'], defaults: () => ({ q: '', status: '' }), cols: custCols, empty: 'No customers match.',
    pills: { param: 'status', count: true, items: [['', 'All'], ['ACTIVE', 'Active'], ['SUSPENDED', 'Suspended'], ['BANNED', 'Banned']] },
    sorts: [['newest', 'Newest'], ['name', 'Name']], open: (u, rl) => userSheet(u.id, rl),
    bulk: [
      { label: 'Message', run: (rows, done) => bulkConfirm({ rows, noun: 'customer', label: (r) => r.name, title: 'Message customers', help: 'Sent as an in-app notification (and a push if they enabled it).', go: 'Send', path: '/bulk/notify', done: 'Sent to', after: done, fields: [{ name: 'title', label: 'Title', required: true, max: 80 }, { name: 'body', label: 'Message', type: 'textarea', required: true }], body: (ids, v) => ({ ids, title: v.title, body: v.body }) }) },
      { label: 'Warn', run: (rows, done) => bulkConfirm({ rows, noun: 'customer', label: (r) => r.name, title: 'Warn customers', help: 'Adds a warning and tells each customer your reason.', go: 'Send warnings', path: '/bulk/customers/warn', done: 'Warned', after: done, body: (ids, v) => ({ ids, reason: v.reason }) }) },
      { label: 'Suspend', cls: 'red', run: (rows, done) => bulkConfirm({ rows, noun: 'customer', label: (r) => r.name, title: 'Suspend customers', help: 'They can sign in but cannot book. Reversible.', go: 'Suspend', cls: 'red', path: '/bulk/customers/suspend', done: 'Suspended', after: done, body: (ids, v) => ({ ids, reason: v.reason }) }) },
      { label: 'Reinstate', run: (rows, done) => bulkConfirm({ rows, noun: 'customer', label: (r) => r.name, title: 'Reinstate customers', help: 'Restores full access.', go: 'Reinstate', path: '/bulk/customers/reinstate', done: 'Reinstated', after: done, fields: [], body: (ids) => ({ ids }) }) },
    ],
  },
  barbers: {
    key: 'barbers', list: 'barbers', title: 'Barbers', sub: 'Only verified shops are visible and bookable. Review signups, ask for information, reject, or suspend (reversible).', search: 'Search shop, owner or email', counts: '/counts/barbers',
    params: ['q', 'status', 'sort'], defaults: (c) => ({ q: '', status: c && (c.PENDING || c.NEEDS_INFO) ? 'PENDING' : '' }), empty: 'No shops in this view.',
    pills: { param: 'status', count: true, items: [['PENDING', 'Pending'], ['NEEDS_INFO', 'Needs info'], ['VERIFIED', 'Verified'], ['SUSPENDED', 'Suspended'], ['REJECTED', 'Rejected'], ['', 'All']] },
    sorts: [['newest', 'Newest'], ['name', 'Shop name']], open: (b, rl) => barberDetail(b.id, rl),
    cols: [
      ['Shop', (b) => `${esc(b.shop_name)}<span class="sub">${esc(b.location || 'No location')}</span>`], ['Owner', (b) => `${esc(b.name)}<span class="sub">${esc(b.email || b.phone || '')}</span>`],
      ['Status', (b) => rsBadge(b.review_status) + (b.resubmitted_at && b.review_status === 'PENDING' ? ' ' + bd('b-blue', 'RESUBMITTED') : '') + (b.booking_paused ? ' ' + bd('b-amber', 'PAUSED') : '')],
      ['Joined', (b) => dshort(b.created_at)],
      ['', (b) => ['PENDING', 'NEEDS_INFO', 'REJECTED'].includes(b.review_status) ? act('Approve', '', 'data-act="approve"') : b.review_status === 'SUSPENDED' ? act('Reinstate', 'sec', 'data-act="reinstate"') : '', 'act'],
    ],
    handlers: {
      approve: async (b, rl) => { await api(`/barbers/${b.id}/approve`, { method: 'POST', body: {} }); toast('Barber approved'); await rl(); },
      reinstate: async (b, rl) => { await api(`/barbers/${b.id}/reinstate`, { method: 'POST', body: {} }); toast('Barber reinstated'); await rl(); },
    },
    bulk: [
      { label: 'Approve', run: (rows, done) => bulkConfirm({ rows, noun: 'shop', label: (r) => r.shop_name, title: 'Approve shops', help: 'Each shop goes live and its owner is told. Shops already verified are skipped. Check details first if unsure.', go: 'Approve', path: '/bulk/barbers/approve', done: 'Approved', after: done, fields: [], body: (ids) => ({ ids }) }) },
      { label: 'Message', run: (rows, done) => bulkConfirm({ rows, noun: 'shop', label: (r) => r.shop_name, idOf: (r) => r.user_id, title: 'Message barbers', help: 'Sent as an in-app notification (and a push if enabled).', go: 'Send', path: '/bulk/notify', done: 'Sent to', after: done, fields: [{ name: 'title', label: 'Title', required: true, max: 80 }, { name: 'body', label: 'Message', type: 'textarea', required: true }], body: (ids, v) => ({ ids, title: v.title, body: v.body }) }) },
    ],
  },
  bookings: {
    key: 'bookings', list: 'bookings', title: 'Bookings', sub: 'Every booking, newest date first. Filter by status, date or shop; click a row for the full record and admin actions.', search: 'Search #id or customer name',
    params: ['q', 'status', 'payment_status', 'date', 'from', 'to', 'barber_id', 'customer_id', 'sort'], defaults: () => ({ q: '', status: '', payment_status: '', date: '' }), empty: 'No bookings match.',
    pills: { param: 'status', items: [['', 'All'], ['CONFIRMED', 'Confirmed'], ['ARRIVED', 'Arrived'], ['IN_SERVICE', 'In service'], ['COMPLETED', 'Completed'], ['CANCELLED', 'Cancelled'], ['NO_SHOW', 'No-show'], ['PENDING_PAYMENT', 'Awaiting payment']] },
    selects: [{ param: 'payment_status', label: 'Payment', options: [['', 'Any payment'], ['PAID', 'Paid'], ['PAYMENT_DUE', 'Pay on arrival'], ['PENDING', 'Pending'], ['CREDIT_PENDING', 'Awaiting decision'], ['CREDITED', 'Credited'], ['VOID', 'Void']] }],
    dates: [{ param: 'date', label: 'Date' }], sorts: [['date', 'Date'], ['newest', 'Newest created'], ['price', 'Price']], open: (b, rl) => bookingSheet(b.id, rl),
    cols: [
      ['Booking', (b) => `#${b.id} ${esc(b.service_name)}<span class="sub">${esc(b.customer_name)}</span>`], ['Shop', (b) => esc(b.shop_name)],
      ['When', (b) => `${dlabel(b.date)}<span class="sub">${t12(b.start_min)}</span>`], ['Status', (b) => bookingBadge(b.status) + ' ' + bpay(b.payment_status)], ['Price', (b) => naira(b.price_kobo), 'num'],
    ],
  },
  payments: {
    key: 'payments', list: 'payments', title: 'Payments', sub: 'Refunds are requested from Paystack automatically. Retry or mark refunded from a payment\'s drawer.', search: 'Search reference',
    params: ['q', 'filter', 'sort'], defaults: () => ({ q: '', filter: 'all' }), empty: 'No payments in this view.',
    pills: { param: 'filter', items: [['needs_refund', 'Needs refund'], ['paid', 'Paid'], ['failed', 'Failed'], ['initiated', 'Not paid'], ['refunds', 'All refunds'], ['disputed', 'Disputed'], ['all', 'All']] },
    sorts: [['newest', 'Newest'], ['amount', 'Amount']], open: (p, rl) => paymentSheet(p.reference, rl),
    cols: [
      ['Payment', (p) => `${esc(p.item || 'Payment')}<span class="sub">${esc(p.customer_name || '')}</span>`], ['Status', (p) => payBadge(p.status) + (p.refund_status ? ' ' + refundBadge(p.refund_status) : '') + (p.disputed ? ' ' + bd('b-red', 'DISPUTED') : '')],
      ['Amount', (p) => naira(p.amount_kobo), 'num'], ['Fee', (p) => naira(p.fee_kobo), 'num'], ['Reference', (p) => `<span class="mono">${esc(p.reference)}</span>`], ['Date', (p) => stamp(p.verified_at || p.created_at)],
    ],
  },
  credits: {
    key: 'credits', list: 'credits', title: 'Credits', sub: 'Same-barber session credits. Never cashable. Issue one from a customer\'s profile.', search: 'Search customer',
    params: ['q', 'status'], defaults: () => ({ q: '', status: '' }), empty: 'No credits match.',
    pills: { param: 'status', items: [['', 'All'], ['AVAILABLE', 'Available'], ['USED', 'Used'], ['REVOKED', 'Revoked']] },
    cols: [
      ['Customer', (c) => `${esc(c.customer_name)}<span class="sub">${esc(c.shop_name)}</span>`], ['Reason', (c) => ({ NO_SHOW: 'No-show', LATE_CANCEL: 'Late cancel', EARLY_CANCEL: 'Cancelled in time', LOYALTY: 'Loyalty reward' }[c.reason] || esc(c.reason))],
      ['Value', (c) => 'up to ' + naira(c.value_kobo), 'num'], ['Expires', (c) => dshort(c.expires_at)],
      ['Status', (c) => c.status === 'USED' ? bd('b-gray', 'USED') : c.status === 'REVOKED' ? bd('b-red', 'REVOKED') : c.live ? bd('b-purple', 'AVAILABLE') : bd('b-gray', 'EXPIRED')],
      ['', (c) => c.status === 'AVAILABLE' ? act('Revoke', 'sec', 'data-act="rev"') : '', 'act'],
    ],
    handlers: { rev: (c, rl) => formModal({ title: 'Revoke credit #' + c.id, help: 'The customer is told their credit was removed.', go: 'Revoke credit', cls: 'red', fields: [REASON()], submit: async (v) => { await post(`/credits/${c.id}/revoke`, v); return 'Credit revoked'; }, after: rl }) },
    bulk: [{ label: 'Revoke', cls: 'red', run: (rows, done) => bulkConfirm({ rows: rows.filter((r) => r.status === 'AVAILABLE'), noun: 'credit', label: (r) => r.customer_name, title: 'Revoke credits', help: 'Each customer is told. Only available credits are affected.', go: 'Revoke', cls: 'red', path: '/bulk/credits/revoke', done: 'Revoked', after: done, body: (ids, v) => ({ ids, reason: v.reason }) }) }],
  },
  reports: {
    key: 'reports', list: 'reports', title: 'Reports', sub: 'Complaints from customers and barbers. Resolve with a note; the reporter is told.', counts: '/counts/reports', search: 'Filter by status or category below',
    params: ['status', 'category'], defaults: () => ({ status: 'OPEN', category: '' }), empty: 'No reports in this view.',
    pills: { param: 'status', count: true, items: [['OPEN', 'Open'], ['RESOLVED', 'Resolved'], ['DISMISSED', 'Dismissed'], ['', 'All']] },
    selects: [{ param: 'category', label: 'Category', options: [['', 'Any category'], ['NO_SHOW', 'No-show'], ['BEHAVIOUR', 'Behaviour'], ['PAYMENT', 'Payment'], ['QUALITY', 'Quality'], ['SAFETY', 'Safety'], ['OTHER', 'Other']] }],
    cols: [
      ['Report', (x) => `<b>${esc(x.category.replace('_', ' '))}</b><span class="sub">${esc(x.message)}</span>`], ['From', (x) => esc(x.reporter_name)], ['About', (x) => x.target_name ? `<a href="#" data-u="${x.target_user_id}">${esc(x.target_name)}</a>` : '—'],
      ['Booking', (x) => x.booking_id ? `<a href="#" data-b="${x.booking_id}">#${x.booking_id}</a>` : '—'], ['Filed', (x) => stamp(x.created_at)],
      ['', (x) => (x.status === 'OPEN' ? act('Resolve', '', 'data-act="res"') + act('Dismiss', 'sec', 'data-act="dis"') : bd(x.status === 'RESOLVED' ? 'b-green' : 'b-gray', x.status)) + act('Delete', 'red', 'data-act="del"'), 'act'],
    ],
    handlers: {
      del: (x, rl) => ADM4.deleteDialog({ type: 'report', id: x.id, name: '#' + x.id, after: rl }), res: (x, rl) => reportForm(x, 'RESOLVED', rl), dis: (x, rl) => reportForm(x, 'DISMISSED', rl),
    },
    bulk: [
      { label: 'Resolve', run: (rows, done) => bulkConfirm({ rows: rows.filter((r) => r.status === 'OPEN'), noun: 'report', label: (r) => r.category, title: 'Resolve reports', help: 'One note is sent to every reporter.', go: 'Resolve', path: '/bulk/reports/resolve', done: 'Resolved', after: done, fields: [{ name: 'reason', label: 'Resolution note', type: 'textarea', required: true }], body: (ids, v) => ({ ids, status: 'RESOLVED', note: v.reason }) }) },
      { label: 'Dismiss', run: (rows, done) => bulkConfirm({ rows: rows.filter((r) => r.status === 'OPEN'), noun: 'report', label: (r) => r.category, title: 'Dismiss reports', help: 'One note is sent to every reporter.', go: 'Dismiss', path: '/bulk/reports/resolve', done: 'Dismissed', after: done, fields: [{ name: 'reason', label: 'Note', type: 'textarea', required: true }], body: (ids, v) => ({ ids, status: 'DISMISSED', note: v.reason }) }) },
    ],
  },
  ledger: {
    key: 'ledger', list: 'ledger', title: 'Off-app ledger', sub: 'Commission on bookings paid outside the app. It is netted from the barber\'s next online payments.', search: 'Search shop',
    params: ['q', 'overdue', 'sort'], defaults: () => ({ q: '', overdue: '', sort: 'owed' }), empty: 'No commission has accrued yet.',
    pills: { param: 'overdue', items: [['', 'All owing'], ['1', 'Overdue (14+ days)']] }, sorts: [['owed', 'Amount owed'], ['newest', 'Newest']], open: (b, rl) => ledgerSheet(b.id, rl),
    headRight: '<button class="btn sm sec" id="remind-all">Send reminders</button>',
    cols: [['Barber', (b) => `${esc(b.shop_name)}<span class="sub">${b.oldest ? 'Oldest entry ' + dshort(b.oldest) : ''}</span>`], ['Owed now', (b) => `<b style="color:var(--red)">${naira(b.owed_kobo)}</b>`, 'num'], ['Open entries', (b) => b.open_entries, 'num'], ['', (b) => act('Ledger', 'sec', 'data-act="open"'), 'act']],
    handlers: { open: (b, rl) => ledgerSheet(b.id, rl) },
  },
  reviews: {
    key: 'reviews', list: 'reviews', title: 'Reviews', sub: 'Customer ratings. Hide anything abusive; hidden reviews leave the shop\'s rating.', search: 'Filter using the controls below',
    params: ['hidden', 'rating', 'sort'], defaults: () => ({ hidden: '', rating: '' }), empty: 'No reviews yet.',
    pills: { param: 'hidden', items: [['', 'All'], ['0', 'Visible'], ['1', 'Hidden']] },
    selects: [{ param: 'rating', label: 'Rating', options: [['', 'Any rating'], ['1', '1 star'], ['2', '2 stars'], ['3', '3 stars'], ['4', '4 stars'], ['5', '5 stars']] }], sorts: [['newest', 'Newest'], ['rating', 'Rating']],
    cols: [
      ['Review', (r) => `${stars(r.rating)}${r.hidden ? ' ' + bd('b-red', 'HIDDEN') : ''}<span class="sub">${esc(r.comment || 'No comment')}</span>${r.reply ? `<span class="sub"><i>Shop replied:</i> ${esc(r.reply)}</span>` : ''}`],
      ['Customer', (r) => esc(r.customer_name)], ['Shop', (r) => esc(r.shop_name)], ['Date', (r) => dshort(r.created_at)],
      ['', (r) => (r.hidden ? act('Restore', 'sec', 'data-act="show"') : act('Hide', 'sec', 'data-act="hide"')) + act('Delete', 'red', 'data-act="del"'), 'act'],
    ],
    handlers: {
      del: (r, rl) => ADM4.deleteDialog({ type: 'review', id: r.id, name: r.customer_name + ' → ' + r.shop_name, after: rl }),
      hide: (r, rl) => formModal({ title: 'Hide review', help: 'It stops showing on the shop page and in its rating. Reversible.', go: 'Hide review', cls: 'red', fields: [REASON()], submit: async (v) => { await post(`/reviews/${r.id}/hide`, { hidden: true, reason: v.reason }); return 'Review hidden'; }, after: rl }),
      show: (r, rl) => formModal({ title: 'Restore review', go: 'Restore', fields: [REASON()], submit: async (v) => { await post(`/reviews/${r.id}/hide`, { hidden: false, reason: v.reason }); return 'Review restored'; }, after: rl }),
    },
    bulk: [
      { label: 'Hide', cls: 'red', run: (rows, done) => bulkConfirm({ rows, noun: 'review', label: (r) => r.customer_name, title: 'Hide reviews', help: 'Reversible.', go: 'Hide', cls: 'red', path: '/bulk/reviews/hide', done: 'Hidden', after: done, body: (ids, v) => ({ ids, hidden: true, reason: v.reason }) }) },
      { label: 'Restore', run: (rows, done) => bulkConfirm({ rows, noun: 'review', label: (r) => r.customer_name, title: 'Restore reviews', go: 'Restore', path: '/bulk/reviews/hide', done: 'Restored', after: done, body: (ids, v) => ({ ids, hidden: false, reason: v.reason }) }) },
    ],
  },
  waitlist: {
    key: 'waitlist', list: 'waitlist', title: 'Waitlist', sub: 'Customers waiting for a slot on a full day. They are told automatically when one opens.', search: 'Filter by status',
    params: ['status'], defaults: () => ({ status: 'WAITING' }), empty: 'Nobody is waiting.',
    pills: { param: 'status', items: [['WAITING', 'Waiting'], ['NOTIFIED', 'Notified'], ['BOOKED', 'Booked'], ['EXPIRED', 'Expired'], ['CANCELLED', 'Cancelled'], ['', 'All']] },
    cols: [['Customer', (w) => `${esc(w.customer_name)}<span class="sub">${esc(w.service_name)}</span>`], ['Shop', (w) => esc(w.shop_name)], ['Day', (w) => dlabel(w.date)], ['Status', (w) => bd({ WAITING: 'b-amber', NOTIFIED: 'b-blue', BOOKED: 'b-green' }[w.status] || 'b-gray', w.status)], ['Joined', (w) => stamp(w.created_at)]],
  },
};
function reportForm(x, status, rl) {
  return formModal({ title: status === 'RESOLVED' ? 'Resolve report' : 'Dismiss report', help: 'Your note is saved and (optionally) sent to the person who filed it.', go: status === 'RESOLVED' ? 'Resolve' : 'Dismiss', cls: status === 'RESOLVED' ? '' : 'sec',
    fields: [{ name: 'note', label: 'Resolution note', type: 'textarea', required: true, ph: 'What was done?' }, { name: 'notify_reporter', label: 'Tell the reporter', type: 'checkbox', value: true }], submit: async (v) => { await post(`/reports/${x.id}/resolve`, { status, note: v.note, notify_reporter: v.notify_reporter }); return 'Report ' + status.toLowerCase(); }, after: rl });
}

/* compact phone rows (see crow() in admin.js): t title, p pills, m one-line meta, r trailing figure */
const dnoy = (iso) => dshort(iso).replace(/ \d{4}$/, '');
const ell = (...a) => a.filter(Boolean).join(' · ');
LISTS.customers.row = (u) => ({ t: esc(u.name), p: acctBadge(u.account_status) + (u.warn_count ? bd('b-amber', u.warn_count + ' warn') : ''), m: esc(ell(u.email || u.phone, 'joined ' + dshort(u.created_at))), r: u.bookings + ' bk' + (u.no_shows ? ` · <span style="color:var(--red)">${u.no_shows} missed</span>` : '') });
LISTS.barbers.row = (b) => ({ t: esc(b.shop_name), p: rsBadge(b.review_status) + (b.booking_paused ? bd('b-amber', 'PAUSED') : ''), m: esc(ell(b.location, b.name, b.email || b.phone)) });
LISTS.bookings.row = (b) => ({ t: `<b>#${b.id}</b> ${esc(b.service_name)}`, p: bookingBadge(b.status) + bpay(b.payment_status), m: esc(ell(`${dlabel(b.date)} ${t12(b.start_min)}`, b.customer_name, b.shop_name)), r: naira(b.price_kobo) });
LISTS.payments.row = (p) => ({ t: esc(p.item || 'Payment'), p: payBadge(p.status) + (p.refund_status ? refundBadge(p.refund_status) : '') + (p.disputed ? bd('b-red', 'DISPUTED') : ''), m: esc(ell(stamp(p.verified_at || p.created_at), p.customer_name)), r: naira(p.amount_kobo) });
LISTS.credits.row = (c) => ({ t: esc(c.customer_name), p: c.status === 'USED' ? bd('b-gray', 'USED') : c.status === 'REVOKED' ? bd('b-red', 'REVOKED') : c.live ? bd('b-purple', 'AVAILABLE') : bd('b-gray', 'EXPIRED'), m: esc(ell('exp ' + dnoy(c.expires_at), c.shop_name, { NO_SHOW: 'No-show', LATE_CANCEL: 'Late cancel', EARLY_CANCEL: 'Cancelled in time', LOYALTY: 'Loyalty' }[c.reason] || c.reason)), r: naira(c.value_kobo) });
LISTS.credits.rowTitle = (c) => 'Credit #' + c.id + ' · ' + c.customer_name;
LISTS.reports.row = (x) => ({ t: esc(x.category.replace('_', ' ')), p: bd(x.status === 'OPEN' ? 'b-amber' : x.status === 'RESOLVED' ? 'b-green' : 'b-gray', x.status), m: esc(ell(x.reporter_name + (x.target_name ? ' → ' + x.target_name : ''), x.message)), r: dshort(x.created_at).replace(/ \d{4}$/, '') });
LISTS.reports.rowTitle = (x) => 'Report #' + x.id + ' · ' + x.category.replace('_', ' ');
LISTS.ledger.row = (b) => ({ t: esc(b.shop_name), p: '', m: esc(ell(b.open_entries + ' open entr' + (b.open_entries === 1 ? 'y' : 'ies'), b.oldest ? 'oldest ' + dshort(b.oldest) : '')), r: `<b style="color:var(--red)">${naira(b.owed_kobo)}</b>` });
LISTS.reviews.row = (r) => ({ t: stars(r.rating) + ' ' + esc(r.customer_name), p: r.hidden ? bd('b-red', 'HIDDEN') : '', m: esc(ell(r.shop_name, r.comment || 'No comment')), r: dshort(r.created_at).replace(/ \d{4}$/, '') });
LISTS.reviews.rowTitle = (r) => 'Review #' + r.id + ' · ' + r.customer_name;
LISTS.waitlist.row = (w) => ({ t: esc(w.customer_name), p: bd({ WAITING: 'b-amber', NOTIFIED: 'b-blue', BOOKED: 'b-green' }[w.status] || 'b-gray', w.status), m: esc(ell(w.service_name, w.shop_name, dlabel(w.date))) });
LISTS.waitlist.rowTitle = (w) => 'Waitlist · ' + w.customer_name;

/* plans page = two lists behind tabs */
let plansTab = 'purchases';
const PURCHASES = {
  key: 'purchases', nav: 'plans', list: 'purchases', title: 'Plans', sub: 'What barbers sell and what customers bought.', search: 'Search customer or plan',
  params: ['q', 'status'], defaults: () => ({ q: '', status: '' }), empty: 'No purchases yet.', pills: { param: 'status', items: [['', 'All'], ['ACTIVE', 'Active'], ['CANCELLED', 'Cancelled']] },
  headRight: '<div class="pills" style="margin:0"><button class="on" data-tab="purchases">Purchases</button><button data-tab="plans">Plans on offer</button></div>',
  cols: [['Customer', (p) => `${esc(p.customer_name)}<span class="sub">${esc(p.plan_name)} · ${esc(p.shop_name)}</span>`], ['Price', (p) => naira(p.price_kobo), 'num'], ['Sessions used', (p) => `${p.sessions_used}/${p.sessions_total}`, 'num'], ['Expires', (p) => dshort(p.expires_at)], ['Status', (p) => p.status === 'ACTIVE' ? bd(p.live ? 'b-green' : 'b-gray', p.live ? 'ACTIVE' : 'ENDED') : bd('b-gray', p.status)],
    ['', (p) => p.status === 'ACTIVE' ? act('Adjust', 'sec', 'data-act="adj"') + act('Cancel', 'red', 'data-act="can"') : '', 'act']],
  handlers: {
    adj: (p, rl) => formModal({ title: 'Adjust plan purchase #' + p.id, help: 'Add or remove sessions and/or extend the expiry. The customer is told.', go: 'Apply', fields: [{ name: 'delta', label: 'Sessions to add (negative removes)', type: 'number', step: 1, ph: '0' }, { name: 'extend_days', label: 'Extend expiry by (days)', type: 'number', step: 1, ph: '0' }, REASON()], submit: async (v) => { await post(`/plan-purchases/${p.id}/adjust`, { reason: v.reason, delta: v.delta || undefined, extend_days: v.extend_days || undefined }); return 'Plan purchase updated'; }, after: rl }),
    can: (p, rl) => formModal({ title: 'Cancel plan purchase #' + p.id, help: 'Ends the plan. Tick refund to flag the payment for a refund.', go: 'Cancel purchase', cls: 'red', fields: [{ name: 'refund', label: 'Also refund the payment', type: 'checkbox' }, REASON()], submit: async (v) => { const o = await post(`/plan-purchases/${p.id}/cancel`, { reason: v.reason, refund: v.refund }); return 'Purchase cancelled' + (o.refund === 'requested' ? ' · refund requested' : ''); }, after: rl }),
  },
};
PURCHASES.row = (p) => ({ t: esc(p.customer_name), p: p.status === 'ACTIVE' ? bd(p.live ? 'b-green' : 'b-gray', p.live ? 'ACTIVE' : 'ENDED') : bd('b-gray', p.status), m: esc(ell('exp ' + dnoy(p.expires_at), p.plan_name, p.shop_name)), r: `${p.sessions_used}/${p.sessions_total} used` });
PURCHASES.rowTitle = (p) => 'Plan purchase #' + p.id + ' · ' + p.customer_name;
const PLANS = {
  key: 'plans', nav: 'plans', list: 'plans', title: 'Plans', sub: 'What barbers sell and what customers bought.', search: 'Search plan or shop',
  params: ['q', 'active'], defaults: () => ({ q: '', active: '' }), empty: 'No plans yet.', pills: { param: 'active', items: [['', 'All'], ['1', 'On sale'], ['0', 'Hidden']] },
  headRight: '<div class="pills" style="margin:0"><button data-tab="purchases">Purchases</button><button class="on" data-tab="plans">Plans on offer</button></div>',
  cols: [['Plan', (p) => `${esc(p.name)}<span class="sub">${esc(p.shop_name)}</span>`], ['Price', (p) => naira(p.price_kobo), 'num'], ['Sessions', (p) => p.sessions, 'num'], ['Valid', (p) => p.validity_days + ' d', 'num'], ['Buyers', (p) => p.buyers, 'num'], ['Status', (p) => p.active ? bd('b-green', 'ON SALE') : bd('b-gray', 'HIDDEN')],
    ['', (p) => act(p.active ? 'Hide' : 'Restore', 'sec', 'data-act="vis"') + act('Delete', 'red', 'data-act="del"'), 'act']],
  handlers: {
    del: (p, rl) => ADM4.deleteDialog({ type: 'plan', id: p.id, name: p.name, after: rl }),
    vis: (p, rl) => { const on = !p.active; return formModal({ title: (on ? 'Restore plan ' : 'Hide plan ') + p.name, help: on ? 'The plan goes back on sale.' : 'Customers can no longer buy it. Existing purchases keep working. The barber is told.', go: on ? 'Restore' : 'Hide plan', fields: [REASON()], submit: async (v) => { await post(`/plans/${p.id}/visibility`, { active: on, reason: v.reason }); return on ? 'Plan restored' : 'Plan hidden'; }, after: rl }); },
  },
};
PLANS.row = (p) => ({ t: esc(p.name), p: p.active ? bd('b-green', 'ON SALE') : bd('b-gray', 'HIDDEN'), m: esc(ell(p.shop_name, p.sessions + ' sessions', p.validity_days + ' d', p.buyers + ' buyer' + (p.buyers === 1 ? '' : 's'))), r: naira(p.price_kobo) });
PLANS.rowTitle = (p) => 'Plan · ' + p.name;
function plansRoute() {
  const cfg = plansTab === 'plans' ? PLANS : PURCHASES;
  return listPage({ ...cfg, reopen: plansRoute })().then(() => { app.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { plansTab = b.dataset.tab; plansRoute(); }); });
}

/* report links (people / bookings inside rows) */
document.addEventListener('click', (e) => {
  const u = e.target.closest('#app [data-u]'), b = e.target.closest('#app [data-b]');
  if (u) { e.preventDefault(); userSheet(Number(u.dataset.u), () => route()); } else if (b) { e.preventDefault(); bookingSheet(Number(b.dataset.b), () => route()); }
});

/* ---------------------------------------------------------------- payment drawer */
async function paymentSheet(ref, reload) {
  const { payment: p } = await api('/payments/' + encodeURIComponent(ref));
  const btns = [];
  if (p.status === 'SUCCESS') btns.push(act(p.disputed ? 'Clear flag' : 'Flag disputed', 'sec', 'data-k="flag"'));
  if (p.refund_status === 'NEEDS_REFUND') btns.push(act('Retry refund', '', 'data-k="retry"'), act('Mark refunded', 'sec', 'data-k="mark"'));
  else if (p.refund_status === 'REFUND_REQUESTED') btns.push(act('Mark refunded', 'sec', 'data-k="mark"'));
  if (p.status !== 'SUCCESS' && !String(p.reference).startsWith('MOCK')) btns.push(act('Re-verify with Paystack', '', 'data-k="reverify"'));
  if (p.booking_id) btns.push(act('Open booking', 'sec', 'data-k="bk"'));
  const m = modal(`<div class="sh-h"><div><h2 style="margin:0">Payment</h2><div class="muted small mono">${esc(p.reference)}</div></div><button class="btn sm sec" data-close>Close</button></div>
    <div class="row-badges">${payBadge(p.status)} ${p.refund_status ? refundBadge(p.refund_status) : ''} ${p.disputed ? bd('b-red', 'DISPUTED') : ''}</div>
    <h3>Details</h3>${kvr('For', esc(p.item || '—'))}${kvr('Customer', esc(p.customer_name || '—') + (p.customer_email ? `<small class="muted" style="display:block">${esc(p.customer_email)}</small>` : ''))}${kvr('Shop', esc(p.shop_name || '—'))}
    ${kvr('Amount', naira(p.amount_kobo))}${p.gateway_fee_kobo ? kvr('Paystack fee (customer paid)', naira(p.gateway_fee_kobo)) : ''}${kvr('Platform fee', naira(p.fee_kobo))}${p.debt_netted_kobo ? kvr('Commission netted', naira(p.debt_netted_kobo)) : ''}${kvr('Created', stamp(p.created_at))}${p.verified_at ? kvr('Verified', stamp(p.verified_at)) : ''}
    ${p.refund_reason ? `<div class="note"><b>Refund reason</b>${esc(p.refund_reason)}</div>` : ''}${p.refund_error ? `<div class="note"><b>Gateway said</b>${esc(p.refund_error)}</div>` : ''}${p.dispute_note ? `<div class="note"><b>Dispute note</b>${esc(p.dispute_note)}</div>` : ''}
    <div class="btns end sticky">${btns.join('') || '<span class="muted small">No actions available.</span>'}</div>`);
  const enc = encodeURIComponent(p.reference); const done = async () => { if (reload) await reload(); };
  m.el.querySelectorAll('[data-k]').forEach((x) => x.onclick = async () => {
    const k = x.dataset.k;
    if (k === 'bk') { m.close(); return bookingSheet(p.booking_id, reload); }
    if (k === 'reverify') { x.disabled = true; try { const o = await api(`/payments/${enc}/reverify`, { method: 'POST', body: {} }); const R = { processed: 'Payment confirmed', already_processed: 'Already confirmed', refund_due: 'Slot was gone: refund requested from Paystack', slot_taken: 'Slot was taken: refund requested', not_paid: 'Paystack says this was not paid', amount_mismatch: 'Paystack amount does not match' }; toast(R[o.result] || o.result, o.result === 'not_paid' || o.result === 'amount_mismatch'); m.close(); await done(); } catch (er) { toast(er.message, true); x.disabled = false; } return; }
    if (k === 'flag') { m.close(); if (p.disputed) { await api(`/payments/${enc}/dispute`, { method: 'POST', body: { disputed: false } }); toast('Flag cleared'); return done(); }
      return formModal({ title: 'Flag payment as disputed', help: 'A private marker for follow-up. It does not move money.', go: 'Flag payment', fields: [{ name: 'note', label: 'Note', type: 'textarea', required: true }], submit: async (v) => { await api(`/payments/${enc}/dispute`, { method: 'POST', body: { disputed: true, note: v.note } }); return 'Payment flagged'; }, after: done }); }
    if (k === 'retry') { x.disabled = true; try { const o = await api(`/payments/${enc}/retry-refund`, { method: 'POST', body: {} }); toast(o.result === 'requested' ? 'Refund requested from Paystack' : 'Gateway refused: ' + (o.refund_error || 'try again later'), o.result !== 'requested'); m.close(); await done(); } catch (er) { toast(er.message, true); x.disabled = false; } return; }
    if (k === 'mark') { m.close(); return formModal({ title: 'Mark as refunded', help: 'Only do this after the customer has been paid back.', go: 'Mark refunded', fields: [], submit: async () => { await api(`/payments/${enc}/mark-refunded`, { method: 'POST', body: {} }); return 'Marked as refunded'; }, after: done }); }
  });
}

/* ---------------------------------------------------------------- home */
async function home() {
  drawNav('home');
  const h = await api('/home'); const n = h.numbers;
  const items = h.attention.filter((a) => a.n > 0);
  const tile = (l, v, s) => `<div class="tile"><span>${l}</span><b>${v}</b>${s ? `<small>${s}</small>` : ''}</div>`;
  const hr = new Date(Date.now() + 3600000).getUTCHours(); const greet = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
  app.innerHTML = head(greet, 'Today is ' + dlabel(h.today) + '. Amounts are in Nigerian naira.', `<a class="btn sm sec" href="#/overview">Full overview</a>`) +
    (h.maintenance_mode ? '<div class="warnbox"><b>Maintenance mode is ON.</b> Customers cannot book. <a href="#/controls">Change</a></div>' : '') +
    `<div class="tiles">${tile('Bookings today', n.bookings_today)}${tile('Revenue, 30 days', naira(n.revenue_30d_kobo))}${tile('Customers', n.customers.toLocaleString())}${tile('Live shops', n.barbers_live)}</div>
    <h2>Needs attention</h2>` + (items.length ? `<div class="attn">${items.map((a) => `<a class="acard ${a.tone}" href="${a.href}"><b>${a.n}</b><span>${esc(a.label)}</span>${a.sub ? `<small>${naira(a.sub)} owed</small>` : ''}<i aria-hidden="true">›</i></a>`).join('')}</div>`
      : '<div class="empty"><b>All clear.</b><div class="small">Nothing needs your attention right now.</div></div>') +
    `<h2>Jump to</h2><div class="quick">${[['customers', 'Customers'], ['barbers', 'Barbers'], ['bookings', 'Bookings'], ['payments', 'Payments'], ['broadcast', 'Broadcast'], ['controls', 'Controls']].map(([k, l]) => `<a href="#/${k}">${ic(IC[k])}${l}</a>`).join('')}</div>
    <p class="muted small" style="margin-top:16px">Tip: press <kbd>Ctrl</kbd> <kbd>K</kbd> (<kbd>⌘</kbd> <kbd>K</kbd> on Mac) to search anything or jump to a page. <kbd>/</kbd> focuses a list's search.</p>`;
  wireReload(home);
}

/* ---------------------------------------------------------------- command palette */
let pal = null;
const NAV = GROUPS.flatMap(([g, items]) => items.map(([k, l]) => ({ k, label: l, group: g || 'Home' })));
function openPalette() {
  if (pal || !getKey()) return;
  const el = document.createElement('div'); el.className = 'pal'; el.innerHTML = `<div class="palbox" role="dialog" aria-modal="true" aria-label="Command palette"><input id="palq" type="text" placeholder="Search people, shops, bookings, payments — or jump to a page" autocomplete="off" spellcheck="false" aria-label="Command palette"><div id="palr" class="palr" role="listbox"></div><div class="palh"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div></div>`;
  document.body.appendChild(el); pal = el;
  const input = $('#palq', el), out = $('#palr', el); let items = [], idx = 0, seq = 0;
  const close = () => { el.remove(); pal = null; };
  el.addEventListener('mousedown', (e) => { if (e.target === el) close(); });
  const cmds = () => {
    const q = input.value.trim().toLowerCase();
    const c = NAV.filter((n) => !q || n.label.toLowerCase().includes(q) || n.group.toLowerCase().includes(q)).slice(0, q ? 5 : 20).map((n) => ({ sec: 'Go to', label: n.label, sub: n.group, run: () => { location.hash = '#/' + n.k; } }));
    const extra = [{ sec: 'Actions', label: 'Toggle dark mode', run: () => $('#theme')?.click() }, { sec: 'Actions', label: 'Sign out', run: () => signOut(false) }].filter((a) => q && a.label.toLowerCase().includes(q));
    return c.concat(extra);
  };
  const draw = () => {
    let last = ''; out.innerHTML = items.length ? items.map((it, i) => { const h = it.sec !== last ? `<h4>${esc(it.sec)}</h4>` : ''; last = it.sec; return `${h}<div class="pali ${i === idx ? 'on' : ''}" role="option" data-i="${i}"><b>${esc(it.label)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</div>`; }).join('') : '<div class="none">No matches.</div>';
    out.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const run = (it) => { close(); it.run(); };
  const search = debounce(async () => {
    const q = input.value.trim(); const my = ++seq; const base = cmds();
    if (q.length < 2) { items = base; idx = 0; return draw(); }
    try {
      const r = await api('/palette?q=' + encodeURIComponent(q)); if (my !== seq) return;
      const rl = () => route();
      items = [
        ...r.users.map((u) => ({ sec: 'People', label: u.name, sub: `${u.role} · ${u.email || u.phone || '#' + u.id}`, run: () => userSheet(u.id, rl) })),
        ...r.barbers.map((b) => ({ sec: 'Shops', label: b.shop_name, sub: `${b.review_status} · ${b.name}`, run: () => barberDetail(b.id, rl) })),
        ...r.bookings.map((b) => ({ sec: 'Bookings', label: `#${b.id} ${b.service_name}`, sub: `${b.customer_name} · ${b.status}`, run: () => bookingSheet(b.id, rl) })),
        ...r.payments.map((p) => ({ sec: 'Payments', label: p.reference, sub: `${naira(p.amount_kobo)} · ${p.status}`, run: () => paymentSheet(p.reference, rl) })),
        ...base];
      idx = 0; draw();
    } catch (e) { items = [{ sec: 'Error', label: e.message, run: () => {} }]; draw(); }
  }, 180);
  input.oninput = () => { items = cmds(); idx = 0; draw(); search(); };
  input.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(items.length - 1, idx + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[idx]) run(items[idx]); }
  };
  out.onclick = (e) => { const i = e.target.closest('[data-i]'); if (i) run(items[Number(i.dataset.i)]); };
  items = cmds(); draw(); input.focus();
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); pal ? pal.remove() && (pal = null) : openPalette(); return; }
  if (e.key === '/' && !e.target.closest('input,textarea,select') && !pal) { const q = $('#lq'); if (q) { e.preventDefault(); q.focus(); } }
});
function mountSearch() {
  if ($('.gsearch')) return;
  const h = document.createElement('div'); h.className = 'gsearch';
  h.innerHTML = '<button id="palbtn" type="button" aria-label="Search (Ctrl+K)"><svg class="i sm" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span>Search</span><kbd>Ctrl K</kbd></button>';
  $('.topbar').insertBefore(h, $('#topright')); $('#palbtn').onclick = openPalette;
}

/* ---------------------------------------------------------------- wire in */
Object.assign(ROUTES, {
  home, customers: listPage(LISTS.customers), barbers: listPage(LISTS.barbers), bookings: listPage(LISTS.bookings), payments: listPage(LISTS.payments), credits: listPage(LISTS.credits),
  reports: listPage(LISTS.reports), ledger: async () => { await listPage(LISTS.ledger)(); const b = $('#remind-all'); if (b) b.onclick = async () => { b.disabled = true; try { const x = await post('/ledger/remind'); toast(x.reminded + ' reminder' + (x.reminded === 1 ? '' : 's') + ' sent'); } catch (er) { toast(er.message, true); } b.disabled = false; }; },
  reviews: listPage(LISTS.reviews), waitlist: listPage(LISTS.waitlist), plans: plansRoute,
});
window.ADM2.mountSearch = mountSearch; window.ADM2.paymentSheet = paymentSheet;
})();
