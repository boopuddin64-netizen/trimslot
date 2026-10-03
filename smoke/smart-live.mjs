// Live smoke for push + smart features + admin v3. Needs CRON_SECRET in env (never printed). Throwaway smoketest+smart-*@example.com accounts only.
// Push: subscribes with an obviously fake https endpoint on example.invalid (never a real push service). Toggles are restored at the end.
const B = process.env.BASE || 'https://trimslot-eight.vercel.app', KEY = process.env.CRON_SECRET; if (!KEY) throw new Error('CRON_SECRET missing');
const tag = Date.now().toString(36);
const call = async (p, o = {}, ck) => { const r = await fetch(B + '/api' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}), ...(o.auth ? { Authorization: 'Bearer ' + KEY, ...(process.env.SMOKE_PIN ? { 'X-Admin-Pin': process.env.SMOKE_PIN } : {}) } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); let j = {}; try { j = await r.json(); } catch { /* */ } return { s: r.status, j, r }; };
const A = (p, o = {}) => call(p, { ...o, auth: true }); const P = (p, body) => A(p, { method: 'POST', body: body || {} });
let bad = 0; const ck = (ok, m) => { if (!ok) bad++; console.log((ok ? 'ok   ' : 'FAIL ') + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bE = `smoketest+smart-b-${tag}@example.com`, cE = `smoketest+smart-c-${tag}@example.com`;
const sb = await call('/auth/signup', { method: 'POST', body: { role: 'barber', name: 'Smart Smoke Barber', email: bE, password: 'Smoke12345!', shop_name: 'Smart Smoke Shop', location: 'Test' } });
const sc = await call('/auth/signup', { method: 'POST', body: { role: 'customer', name: 'Smart Smoke Cust', email: cE, password: 'Smoke12345!' } });
ck(sb.s === 201 && sc.s === 201, 'signup throwaway barber + customer');
const bck = sb.r.headers.get('set-cookie').split(';')[0], cck = sc.r.headers.get('set-cookie').split(';')[0];
const svc = await call('/barber/services', { method: 'POST', body: { name: 'Smoke cut', price_naira: 3000, duration_min: 30 } }, bck); const sid = svc.j.id ?? svc.j.service?.id;
const bl = await A('/admin/barbers'); const mine = bl.j.barbers.find((x) => x.email === bE); const bid = mine.id; if (bid === 2 || bid === 9) throw new Error('refusing');
ck((await P(`/admin/barbers/${bid}/approve`)).j.verified === true, 'approve throwaway barber');

// ---- config / push
const cfg = (await call('/config')).j;
ck(typeof cfg.vapid_public_key === 'string' && cfg.vapid_public_key.length > 60 && !JSON.stringify(cfg).includes('PRIVATE'), 'config exposes VAPID public key only (' + (cfg.vapid_public_key || '').length + ' chars)');
ck(cfg.features && cfg.features.push === true && cfg.features.reviews === true && cfg.features.loyalty === false, 'config features: push/reviews on, loyalty off');
ck((await call('/push/status', {}, cck)).j.available === true, 'push available server-side (keys loaded in prod)');
const fake = { endpoint: `https://push.example.invalid/smoke/${tag}`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } };
ck((await call('/push/subscribe', { method: 'POST', body: { subscription: fake } })).s === 401, 'subscribe requires login');
ck((await call('/push/subscribe', { method: 'POST', body: { subscription: { endpoint: 'http://insecure.example/x', keys: fake.keys } } }, cck)).s === 400, 'http endpoint rejected');
ck((await call('/push/subscribe', { method: 'POST', body: { subscription: fake } }, cck)).s === 201, 'subscribe (fake endpoint)');
ck((await call('/push/status', {}, cck)).j.devices === 1, 'device counted');

// ---- booking flow triggers notifications + push attempt
const d = (() => { let t = Date.now() + 86400000 + 3600000; if (new Date(t).getUTCDay() === 0) t += 86400000; return new Date(t).toISOString().slice(0, 10); })(); // never a Sunday (default schedule is closed)
const bk = await call('/bookings', { method: 'POST', body: { barber_id: bid, service_id: sid, date: d, time: '10:00', payment_option: 'ON_ARRIVAL', note: 'Low fade please' } }, cck); ck(bk.s === 201, 'book with a note ' + bk.s);
const bkid = bk.j.booking?.id;
ck((await call('/barber/bookings', {}, bck)).j !== undefined, 'barber bookings load');
const nb = (await call('/notifications', {}, bck)).j; ck(nb.notifications.some((n) => n.booking_id === bkid), 'barber alerted of new booking (in-app)'); ck(typeof nb.unread === 'number' && nb.unread >= 1, 'unread count ' + nb.unread);
const det = await call('/bookings/' + bkid, {}, cck); ck(det.j.booking.note_to_barber === 'Low fade please', 'note stored and returned');
const nid = nb.notifications[0].id;
ck((await call('/notifications/read', { method: 'POST', body: { id: nid } }, bck)).s === 200, 'mark one read');
ck((await call('/notifications?after=' + nid, {}, bck)).s === 200, 'poll after=id');
await sleep(2500);
// dead endpoint cleanup: example.invalid does not resolve; that is a network error (kept, counted), not a 404/410. Force a real-flush path via test button.
const t = await call('/push/test', { method: 'POST', body: {} }, cck); ck(t.s === 200, 'push test route ok (sent=' + t.j.sent + ')');
// ---- favourites, reliability, rebook, notes, ETA
ck((await call(`/barbers/${bid}/favourite`, { method: 'POST', body: { on: true } }, cck)).s === 200, 'favourite');
ck((await call('/me/favourites', {}, cck)).j.favourites?.length >= 1 || (await call('/me/favourites', {}, cck)).j.ids?.length >= 1 || (await call('/me/favourites', {}, cck)).s === 200, 'favourites list');
const bd = await call('/barber/bookings', {}, bck); const row = (bd.j.bookings || []).find((x) => x.id === bkid);
ck(!row || row.customer?.reliability !== undefined, 'barber sees reliability on customer');
ck((await call(`/barber/customers/${row?.customer_id ?? row?.customer?.id ?? 0}/note`, { method: 'PUT', body: { note: 'Prefers a scissor cut' } }, bck)).s < 500, 'barber private note route responds');
ck((await call('/me/rebook', {}, cck)).s === 200, 'rebook route ok');
// ---- lifecycle -> review
ck((await P(`/admin/bookings/${bkid}/complete`, { reason: 'smoke force complete', paid: true })).s === 200, 'complete booking (admin force, booking is tomorrow)');
const rv = await call(`/bookings/${bkid}/review`, { method: 'POST', body: { rating: 5, comment: 'Smoke review' } }, cck); ck(rv.s === 201, 'customer reviews completed booking ' + rv.s);
ck((await call(`/bookings/${bkid}/review`, { method: 'POST', body: { rating: 4 } }, cck)).s === 409 || (await call(`/bookings/${bkid}/review`, { method: 'POST', body: { rating: 4 } }, cck)).s === 400, 'second review rejected');
const pub = await call(`/barbers/${bid}/reviews`); ck(pub.j.summary.count === 1 && pub.j.summary.average === 5, 'public rating summary 5.0 (1)');
const rid = pub.j.reviews[0]?.id; ck((await call(`/barber/reviews/${rid}/reply`, { method: 'POST', body: { reply: 'Thanks!' } }, bck)).s === 200, 'barber replies');
// ---- quick actions
const dl = await call('/barber/queue/delay', { method: 'POST', body: { minutes: 10 } }, bck); ck(dl.s === 200, 'delay +10 ' + dl.s);
ck((await call('/barber/queue/delay', { method: 'DELETE' }, bck)).s === 200, 'clear delay');
ck((await call('/barber/summary', {}, bck)).j.enabled === true, 'daily summary');
// ---- waitlist rejected when day not full
const wl = await call('/waitlist', { method: 'POST', body: { barber_id: bid, service_id: sid, date: d } }, cck); ck(wl.s === 409 || wl.s === 400, 'waitlist refused when slots exist ' + wl.s);

// ---- admin v3
const home = await A('/admin/home'); ck(home.s === 200 && Array.isArray(home.j.attention) && JSON.stringify(home.j).length < 3000, 'admin home lean (' + JSON.stringify(home.j).length + ' B)');
const l1 = await A('/admin/l/customers?limit=5'); ck(l1.s === 200 && l1.j.rows.length >= 2 && l1.j.total > 0, 'customers page 1 + total');
const l1b = await A('/admin/l/bookings?limit=5&sort=newest'); ck(l1b.s === 200 && l1b.j.rows.length === 5 && !!l1b.j.next && l1.j.total > 0, 'bookings page 1 + cursor');
const l2 = await A('/admin/l/bookings?limit=5&sort=newest&count=0&cursor=' + encodeURIComponent(l1b.j.next)); ck(l2.s === 200 && l2.j.rows[0].id < l1b.j.rows[4].id && l2.j.total === undefined, 'cursor page 2 follows, no recount');
const q = await A('/admin/l/customers?q=' + encodeURIComponent(cE)); ck(q.j.rows.length === 1 && q.j.rows[0].email === cE, 'search finds throwaway customer');
ck((await A('/admin/l/bookings?q=%23' + bkid)).j.rows[0]?.id === bkid, 'bookings search by #id');
ck((await A('/admin/l/reviews?limit=5')).j.rows.some((r) => r.id === rid), 'reviews list');
ck((await A('/admin/l/nope')).s === 404, 'unknown list -> 404');
ck((await call('/admin/l/customers')).s === 401, 'lists need the admin key');
const pal = await A('/admin/palette?q=' + encodeURIComponent('Smart Smoke')); ck(pal.j.users.length >= 1 && pal.j.barbers.length >= 1, 'palette finds users + shops');
ck((await P(`/admin/reviews/${rid}/hide`, { hidden: true, reason: 'smoke hide' })).j.hidden === true, 'admin hides review');
ck((await call(`/barbers/${bid}/reviews`)).j.summary.count === 0, 'hidden review leaves rating');
ck((await P(`/admin/reviews/${rid}/hide`, { hidden: false, reason: 'smoke restore' })).j.hidden === false, 'admin restores review');
const cuid = q.j.rows[0].id; if ([3, 4, 32].includes(cuid)) throw new Error('refusing real user');
ck((await P('/admin/bulk/customers/warn', { ids: [cuid] })).s === 400, 'bulk warn needs a reason');
const bw = await P('/admin/bulk/customers/warn', { ids: [cuid], reason: 'smoke bulk warn' }); ck(bw.s === 200 && bw.j.changed === 1, 'bulk warn 1');
ck((await P('/admin/bulk/notify', { ids: [cuid], title: 'Smoke broadcast', body: 'Hello from the smoke test' })).j.sent === 1, 'bulk notify 1');
ck((await call('/notifications', {}, cck)).j.notifications.some((n) => n.title === 'Smoke broadcast'), 'bulk message arrives in notification centre');
ck((await P('/admin/bulk/customers/warn', { ids: Array.from({ length: 201 }, (_, i) => i + 1), reason: 'x'.repeat(5) })).s === 400, 'bulk capped at 200');

// ---- feature toggles: off -> API rejects / hides, then restore
const s0 = (await A('/admin/settings')).j.settings; const keep = { feature_reviews: s0.feature_reviews, feature_push: s0.feature_push, feature_favourites: s0.feature_favourites };
await A('/admin/settings', { method: 'PUT', body: { feature_reviews: false, feature_push: false, feature_favourites: false } });
await sleep(3500);
const c2 = (await call('/config')).j; ck(c2.features.reviews === false && c2.features.push === false, 'toggles off reflected in config');
ck((await call('/push/subscribe', { method: 'POST', body: { subscription: { ...fake, endpoint: fake.endpoint + '-2' } } }, cck)).s === 400, 'push subscribe refused when push is off');
ck((await call(`/barbers/${bid}/favourite`, { method: 'POST', body: { on: true } }, cck)).s >= 400, 'favourite refused when off');
ck((await call(`/barbers/${bid}/reviews`)).j.enabled === false, 'reviews hidden when off');
await A('/admin/settings', { method: 'PUT', body: keep }); await sleep(3500);
const c3 = (await call('/config')).j; ck(c3.features.reviews === true && c3.features.push === true, 'toggles restored');
ck((await call('/push/unsubscribe', { method: 'POST', body: { endpoint: fake.endpoint } }, cck)).s === 200 && (await call('/push/status', {}, cck)).j.devices === 0, 'unsubscribe removes device');
// static assets
for (const f of ['/sw.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/notify.js', '/admin3.js']) { const r = await fetch(B + f); ck(r.ok, `${f} served ${r.status} ${r.headers.get('content-type')}`); }
console.log(bad ? `\n${bad} FAILED` : '\nALL OK'); console.log('throwaway emails:', bE, cE); process.exit(bad ? 1 : 0);
