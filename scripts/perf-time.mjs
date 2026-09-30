// LOCAL ONLY: times admin endpoints against the local server. Usage: node scripts/perf-time.mjs [label]
const B = 'http://localhost:4102/api/admin', KEY = 'local-admin-key-xyz';
const get = async (p) => { const t = performance.now(); const r = await fetch(B + p, { headers: { Authorization: 'Bearer ' + KEY } }); const t2 = performance.now(); const j = await r.json(); return { ms: t2 - t, status: r.status, bytes: JSON.stringify(j).length, j }; };
const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
const first = async (l) => (await get(`/l/${l}?limit=25`)).j;
const cases = [
  ['home', () => '/home'], ['customers p1 (count)', () => '/l/customers?limit=25'], ['customers p1 no count', () => '/l/customers?limit=25&count=0'],
  ['customers search "okafor"', () => '/l/customers?q=okafor'], ['customers search email "perf4321@"', () => '/l/customers?q=perf4321@'], ['customers status=SUSPENDED', () => '/l/customers?status=SUSPENDED'],
  ['customers sort name', () => '/l/customers?sort=name&dir=asc'],
  ['barbers PENDING', () => '/l/barbers?status=PENDING'], ['bookings p1 (date desc)', () => '/l/bookings?limit=25'], ['bookings status=CONFIRMED', () => '/l/bookings?status=CONFIRMED'],
  ['bookings by #id', () => '/l/bookings?q=%2325000'], ['bookings one day', () => '/l/bookings?date=2026-09-01'], ['bookings barber+status', () => '/l/bookings?barber_id=' + BID + '&status=COMPLETED'], ['bookings sort price', () => '/l/bookings?sort=price'],
  ['payments p1', () => '/l/payments'], ['payments needs_refund', () => '/l/payments?filter=needs_refund'], ['payments search ref', () => '/l/payments?q=TS-PERF-2500'],
  ['reviews p1', () => '/l/reviews'], ['credits p1', () => '/l/credits'], ['ledger', () => '/l/ledger'], ['purchases', () => '/l/purchases'],
  ['palette "chidi"', () => '/palette?q=chidi'], ['palette "#25000"', () => '/palette?q=%2325000'], ['palette "TS-PERF"', () => '/palette?q=TS-PERF-1'],
  ['audit (old, 100 rows)', () => '/audit?limit=100'],
];
let BID = 1; BID = (await get('/l/barbers?limit=5')).j.rows[0].id;
const out = [];
for (const [name, path] of cases) {
  const ms = []; let last;
  for (let i = 0; i < 7; i++) { last = await get(path()); ms.push(last.ms); }
  out.push({ name, median_ms: +med(ms).toFixed(1), max_ms: +Math.max(...ms).toFixed(1), kb: +(last.bytes / 1024).toFixed(1), status: last.status });
}
// deep paging: walk 40 pages of bookings, time the deepest
let cur = null, deep = 0, pages = 0; const t0 = performance.now();
for (; pages < 40; pages++) { const r = await get('/l/bookings?limit=100&count=0' + (cur ? '&cursor=' + cur : '')); cur = r.j.next; deep = r.ms; if (!cur) break; }
out.push({ name: `bookings deep cursor page ${pages + 1} (100/page)`, median_ms: +deep.toFixed(1), max_ms: +deep.toFixed(1), kb: 0, status: 200 });
out.push({ name: `walk ${pages + 1} pages x100 total`, median_ms: +(performance.now() - t0).toFixed(0), max_ms: 0, kb: 0, status: 200 });
console.log(process.argv[2] || 'run'); console.table(out);
