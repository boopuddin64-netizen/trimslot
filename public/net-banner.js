/* TrimSlot network banner: a slim, calm strip under the top bar. It never covers the top bar or the bottom tabs and never blocks a tap.
   Words (kept very short):  offline -> "You are offline. Showing saved info."   weak signal -> "Slow connection."   request took too long -> "Taking long. Trying again."
   Uses navigator.onLine + online/offline events, navigator.connection (2g / slow-2g / saveData) and the 'ts:net' events from offline-cache.js.
   While offline or timing out it quietly checks the connection again (2s, 4s, 8s … up to 30s) and hides itself when the network is back. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.NetBanner = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  var TEXT = { offline: 'You are offline. Showing saved info.', slow: 'Slow connection.', retry: 'Taking long. Trying again.' };

  /* pure: which message (or none) for this situation. Offline wins, then a request that took too long, then a weak signal. */
  function pick(s) {
    if (s.online === false) return 'offline';
    if (s.timedOut) return 'retry';
    if (s.slow) return 'slow';
    return null;
  }
  function isSlow(conn) { return !!conn && (conn.saveData === true || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g'); }
  function backoff(n) { return Math.min(30000, 2000 * Math.pow(2, Math.max(0, n))); }   // 2s, 4s, 8s, 16s, 30s, 30s …

  var api = { TEXT: TEXT, pick: pick, isSlow: isSlow, backoff: backoff };
  if (!root || !root.document) return api;

  var doc = root.document, nav = root.navigator;
  var st = { online: nav.onLine !== false, timedOut: false, slow: isSlow(nav.connection || nav.mozConnection || nav.webkitConnection) };
  var el = null, txt = null, shown = null, tries = 0, pingTimer = 0, hideTimer = 0, recovering = false;

  function build() {
    if (el) return;
    el = doc.createElement('div'); el.id = 'netbar'; el.className = 'netbar'; el.hidden = true;
    el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<div class="nb-in"><span class="nb-dot" aria-hidden="true"></span><span class="nb-txt"></span></div>';
    txt = el.querySelector('.nb-txt');
    var top = doc.querySelector('.topbar');
    if (top && top.parentNode) top.parentNode.insertBefore(el, top.nextSibling); else doc.body.insertBefore(el, doc.body.firstChild);
  }
  function place() { var top = doc.querySelector('.topbar'); if (top && el) el.style.setProperty('--netbar-top', top.getBoundingClientRect().height + 'px'); }

  function render() {
    build();
    var kind = pick(st);
    if (kind === shown) return;
    clearTimeout(hideTimer);
    if (kind) {
      shown = kind; place();
      txt.textContent = TEXT[kind]; el.setAttribute('data-kind', kind);
      if (el.hidden) { el.hidden = false; void el.offsetHeight; }
      el.classList.add('on');
    } else {
      shown = null; el.classList.remove('on');
      hideTimer = setTimeout(function () { if (!shown) el.hidden = true; }, 260);
    }
    schedule();
  }

  /* quiet re-check while offline / timing out */
  function schedule() {
    clearTimeout(pingTimer);
    if (shown !== 'offline' && shown !== 'retry') { tries = 0; return; }
    pingTimer = setTimeout(ping, backoff(tries++));
  }
  function ping() {
    if (shown !== 'offline' && shown !== 'retry') return;
    var ac = typeof AbortController === 'function' ? new AbortController() : null; var to = setTimeout(function () { if (ac) ac.abort(); }, 8000);
    root.fetch('/manifest.webmanifest?ping=' + Date.now(), { cache: 'no-store', credentials: 'omit', signal: ac ? ac.signal : undefined })
      .then(function (r) { clearTimeout(to); if (r && r.ok) back(); else schedule(); }, function () { clearTimeout(to); schedule(); });
  }
  function back() {   // the network answered
    var wasDown = shown === 'offline' || shown === 'retry';
    st.online = true; st.timedOut = false; tries = 0; render();
    if (wasDown && !recovering && typeof root.refreshFromNetwork === 'function') { recovering = true; setTimeout(function () { recovering = false; }, 3000); root.refreshFromNetwork(); }   // show fresh data now, quietly
  }

  root.addEventListener('offline', function () { st.online = false; render(); });
  root.addEventListener('online', function () { back(); });
  var conn = nav.connection || nav.mozConnection || nav.webkitConnection;
  if (conn && conn.addEventListener) conn.addEventListener('change', function () { st.slow = isSlow(conn); render(); });
  root.addEventListener('ts:net', function (e) {
    var t = e.detail && e.detail.type;
    if (t === 'timeout') { st.timedOut = true; render(); }
    else if (t === 'fail') { if (nav.onLine === false) st.online = false; else st.timedOut = true; render(); }
    else if (t === 'ok') { if (st.timedOut || !st.online) { back(); } }
  });
  root.addEventListener('resize', function () { if (shown) place(); });
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', render); else render();
  return Object.assign(api, { state: st });
});
