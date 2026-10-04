/* TrimSlot notifications: bell + live banner, sound/vibration, tab-title badge, Web Push enable flow, iOS install hint.
   Loaded after app.js (shares its globals: state, api, ic, esc, toast). Nothing here stores anything sensitive. */
'use strict';
const Notify = (() => {
  const LS = { get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
  const baseTitle = document.title;
  let timer = null, lastId = null, audio = null, inflight = false, banner = null, bannerT = null;
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const feedbackOn = () => LS.get('trimslot_alerts', '1') === '1';

  /* ---------- sound + vibration ---------- */
  const unlock = () => { try { if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch { /* no audio */ } };
  ['pointerdown', 'keydown'].forEach((e) => window.addEventListener(e, unlock, { passive: true }));
  function chime(strong) {
    if (!feedbackOn()) return;
    try {
      if (navigator.vibrate) navigator.vibrate(strong ? [120, 60, 120, 60, 200] : [80, 40, 80]);
      if (!audio || audio.state !== 'running') return;
      const t0 = audio.currentTime;
      [[880, 0], [1174.66, 0.13]].forEach(([f, dt]) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(audio.destination);
        g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(strong ? 0.16 : 0.09, t0 + dt + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.28);
        o.start(t0 + dt); o.stop(t0 + dt + 0.3);
      });
    } catch { /* ignore */ }
  }

  /* ---------- tab title + bell ---------- */
  function paintUnread() {
    const n = state.unread || 0;
    document.title = n ? `(${n > 99 ? '99+' : n}) ${baseTitle}` : baseTitle;
    const badge = document.querySelector('#topright .dot');
    const bell = document.querySelector('#topright .bell');
    if (bell) {
      if (n && !badge) bell.insertAdjacentHTML('beforeend', `<span class="dot">${n > 99 ? '99+' : n}</span>`);
      else if (badge && n) badge.textContent = n > 99 ? '99+' : n;
      else if (badge && !n) badge.remove();
      bell.setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
    }
  }
  function ringBell() { const b = document.querySelector('#topright .bell'); if (b) { b.classList.remove('ring'); void b.offsetWidth; b.classList.add('ring'); } }

  /* ---------- in-app banner ---------- */
  const urlOf = (n) => n.booking_id ? (state.user?.role === 'barber' ? '#/b/' : '#/booking/') + n.booking_id
    : /^(PLAN_|CREDIT|LOYALTY)/.test(n.type) && state.user?.role !== 'barber' ? '#/wallet' : n.type === 'REVIEW_RECEIVED' ? '#/reviews' : n.type === 'WAITLIST_OPEN' ? '#/' : '#/notifications';
  function showBanner(n) {
    const el = document.getElementById('banner'); if (!el) return;
    el.innerHTML = `<button class="bn-body" type="button"><span class="bn-ico">${ic(iconFor(n.type))}</span><span class="bn-txt"><b>${esc(n.title)}</b><span>${esc(n.body)}</span></span></button><button class="bn-x" type="button" aria-label="Dismiss">${ic('off', 'sm')}</button>`;
    el.className = 'banner' + (/^(YOUR_TURN|YOURE_NEXT|LEAVE_NOW)$/.test(n.type) ? ' urgent' : '');
    el.querySelector('.bn-body').onclick = async () => { el.classList.add('hidden'); api('/notifications/read', { method: 'POST', body: { id: n.id } }).catch(() => {}); state.unread = Math.max(0, (state.unread || 1) - 1); paintUnread(); location.hash = urlOf(n); };
    el.querySelector('.bn-x').onclick = () => el.classList.add('hidden');
    clearTimeout(bannerT); bannerT = setTimeout(() => el.classList.add('hidden'), /^(YOUR_TURN|YOURE_NEXT|LEAVE_NOW)$/.test(n.type) ? 12000 : 6500);
  }
  function iconFor(type) {
    if (/^(YOUR_TURN|YOURE_NEXT|QUEUE|LEAVE_NOW|REMINDER|BARBER_MESSAGE)/.test(type)) return 'clock';
    if (/^(PAYMENT|PLAN_|CREDIT|LOYALTY|REFUND)/.test(type)) return /^PAYMENT/.test(type) ? 'card' : 'ticket';
    if (/^(AVAILABILITY|SHOP_PAUSED|BARBER_REJECTED|BARBER_NEEDS|BARBER_SUSPENDED|ACCOUNT|LEDGER|BOOKING_INCOMPLETE|NO_SHOW|HELP_REQUEST|HELP_ESCALATED)/.test(type)) return 'warn';
    if (/^(REVIEW|WAITLIST)/.test(type)) return 'check';
    if (/^(BOOKING|NEW_BOOKING|CUSTOMER_ARRIVED)/.test(type)) return 'cal';
    return 'bell';
  }

  /* ---------- live polling ---------- */
  async function poll() {
    if (!state.user || inflight || document.hidden) return;
    inflight = true;
    try {
      const r = await api('/notifications?limit=' + (lastId === null ? 1 : 20) + (lastId !== null ? '&after=' + lastId : ''));
      const fresh = r.notifications || [];
      if (lastId === null) lastId = fresh.length ? fresh[0].id : 0;
      else if (fresh.length) {
        lastId = Math.max(lastId, ...fresh.map((n) => n.id));
        const newest = fresh[0];
        chime(/^(YOUR_TURN|YOURE_NEXT|LEAVE_NOW)$/.test(newest.type)); ringBell();
        if (fresh.length > 2) showBanner({ id: newest.id, type: 'GROUP', title: `${fresh.length} new notifications`, body: newest.title, booking_id: null });
        else showBanner(newest);
        window.dispatchEvent(new CustomEvent('trimslot:notifications', { detail: fresh }));
      }
      if (r.unread !== state.unread) { state.unread = r.unread; }
      paintUnread();
    } catch { /* offline: try again next tick */ } finally { inflight = false; }
  }
  function start() {
    stop(); if (!state.user) return;
    registerSW();
    poll(); timer = setInterval(poll, 8000);
  }
  function stop() { if (timer) clearInterval(timer); timer = null; lastId = null; document.title = baseTitle; }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  /* ---------- service worker + push ---------- */
  let swReg = null;
  async function registerSW() {
    if (!('serviceWorker' in navigator)) return null;
    if (swReg) return swReg;
    try { swReg = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { return null; }
    return swReg;
  }
  navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', (ev) => {
    const m = ev.data || {};
    if (m.type === 'go' && m.hash) location.hash = m.hash;
    if (m.type === 'push') poll();       // a push arrived while the app is open: refresh now (banner + sound come from poll)
  });
  const b64 = (s) => { const p = '='.repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map((c) => c.charCodeAt(0))); };
  async function currentSub() { const reg = await registerSW(); if (!reg) return null; await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); }
  async function subscribe() {
    const key = state.cfg && state.cfg.vapid_public_key;
    if (!pushSupported() || !key) throw new Error('Push alerts do not work on this phone or browser.');
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Alerts are blocked. Turn them on in your browser or phone settings. Then try again.' : 'Alerts were not turned on.');
    const reg = await registerSW(); await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    LS.set('trimslot_push', '1');
    return true;
  }
  async function unsubscribe() {
    const sub = await currentSub().catch(() => null);
    if (sub) { await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
    LS.set('trimslot_push', '0');
  }
  /** After login / on load: if this browser already has permission and a subscription, make sure the server ties it to the current account. */
  async function resync() {
    if (!pushSupported() || !state.user || !(state.cfg && state.cfg.vapid_public_key) || Notification.permission !== 'granted' || LS.get('trimslot_push', '1') === '0') return;
    try { const sub = await currentSub(); if (sub) await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } }); else await subscribe(); } catch { /* best effort */ }
  }
  /** On sign-out the device stops receiving this account's pushes. */
  async function detach() { stop(); try { const sub = await currentSub(); if (sub) await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); } catch { /* ignore */ } }

  /* ---------- UI pieces ---------- */
  const snoozed = () => Date.now() < Number(LS.get('trimslot_prompt_snooze', '0'));
  /** A single tasteful card on the main screens. Returns '' when nothing needs asking. */
  function promptCard() {
    if (!state.user) return '';
    if (isIOS && !standalone()) {
      if (snoozed()) return '';
      return `<div class="promo" id="notifcard"><span class="promo-ico">${ic('bell')}</span><div class="grow"><b>Get alerts on your iPhone</b><div class="small muted">Tap <b>Share</b>, then <b>Add to Home Screen</b>. Then open TrimSlot from your home screen. iPhones only give alerts to apps you add.</div></div><button class="promo-x" data-snooze aria-label="Not now">${ic('off', 'sm')}</button></div>`;
    }
    if (!pushSupported() || !(state.cfg && state.cfg.features && state.cfg.features.push) || Notification.permission !== 'default' || snoozed()) return '';
    return `<div class="promo" id="notifcard"><span class="promo-ico">${ic('bell')}</span><div class="grow"><b>Never miss your turn</b><div class="small muted">Get alerts when your booking is confirmed, for reminders, and when you are next in line.</div><div class="btns" style="margin-top:10px"><button class="btn sm" data-enable>Turn on alerts</button><button class="btn sm sec" data-snooze>Not now</button></div></div></div>`;
  }
  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-enable],[data-snooze]'); if (!t) return;
    if (t.hasAttribute('data-snooze')) { LS.set('trimslot_prompt_snooze', String(Date.now() + 7 * 86400000)); const c = document.getElementById('notifcard'); if (c) c.remove(); return; }
    t.disabled = true;
    try { await subscribe(); toast('Alerts are on'); const c = document.getElementById('notifcard'); if (c) c.remove(); }
    catch (e) { t.disabled = false; toast(e.message, true); }
  });

  /** Profile rows: push switch (+ status), sound & vibration switch, test button. */
  function prefsRows() {
    const canPush = pushSupported() && state.cfg && state.cfg.features && state.cfg.features.push;
    const perm = pushSupported() ? Notification.permission : 'unsupported';
    const on = perm === 'granted' && LS.get('trimslot_push', '1') !== '0';
    const sub = !canPush ? (isIOS && !standalone() ? 'On iPhone: tap Share, then Add to Home Screen first' : 'Not available on this browser') : perm === 'denied' ? 'Blocked in your browser settings' : on ? 'On for this device' : 'Off';
    return `<div class="lrow"><span class="ico">${ic('bell', 'sm')}</span><span class="grow">Push alerts<span class="sub">${sub}</span></span><button class="switch" id="pushsw" role="switch" aria-checked="${on}" aria-label="Push alerts" ${canPush && perm !== 'denied' ? '' : 'disabled'}></button></div>
      <div class="lrow"><span class="ico">${ic('clock', 'sm')}</span><span class="grow">Sound &amp; vibration<span class="sub">A soft chime when something happens while the app is open</span></span><button class="switch" id="soundsw" role="switch" aria-checked="${feedbackOn()}" aria-label="Sound and vibration"></button></div>
      ${on ? `<button class="lrow" id="pushtest"><span class="ico">${ic('check', 'sm')}</span><span class="grow">Send a test alert</span><span class="end">${ic('right', 'sm')}</span></button>` : ''}
      ${isIOS && !standalone() ? `<div class="lrow"><span class="ico">${ic('home', 'sm')}</span><span class="grow">Install on iPhone<span class="sub">Tap Share, then Add to Home Screen. Then open TrimSlot from your home screen to get alerts.</span></span></div>` : ''}`;
  }
  function wirePrefs() {
    const p = document.getElementById('pushsw'), s = document.getElementById('soundsw'), t = document.getElementById('pushtest');
    if (s) s.onclick = () => { const v = !feedbackOn(); LS.set('trimslot_alerts', v ? '1' : '0'); s.setAttribute('aria-checked', String(v)); if (v) { unlock(); chime(false); } };
    if (p) p.onclick = async () => {
      const turningOn = p.getAttribute('aria-checked') !== 'true'; p.disabled = true;
      try { if (turningOn) { await subscribe(); toast('Push alerts on'); } else { await unsubscribe(); toast('Push alerts off'); } } catch (e) { toast(e.message, true); }
      p.disabled = false; route();
    };
    if (t) t.onclick = async () => { t.disabled = true; try { await api('/push/test', { method: 'POST' }); toast('Test sent. It should show up in a moment.'); } catch (e) { toast(e.message, true); } t.disabled = false; };
  }
  return { start, stop, poll, paintUnread, promptCard, prefsRows, wirePrefs, resync, detach, iconFor, urlOf, chime, isIOS, standalone, pushSupported, registerSW };
})();
window.Notify = Notify;
