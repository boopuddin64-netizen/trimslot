/* TrimSlot pull-down to refresh (touch only). Works in iOS home-screen mode and in normal tabs.
   Starts only when the page is at the top, the finger moves clearly downward, and nothing else (sheet, crop screen, text box,
   sideways scroller) is in the way. Refresh = window.refreshFromNetwork() if it exists (it redraws by itself: true = redrawn, false = did nothing, quietly), else route().
   It never adds overscroll rules itself (polish.css owns those); it only cancels a touchmove while its own pull is active. */
'use strict';
(function () {
  var THRESHOLD = 64, MAXD = 120, MIN_SHOW = 500, START = 8;
  var armed = null, pulling = false, ready = false, busy = false, dist = 0, reduce = false, el = null, live = null, hideT = 0;

  function eligibleRoute() {
    try {
      if (typeof state === 'undefined' || !state.user) return false;
      var h = location.hash || '#/';
      return /^#\/(\?.*)?$/.test(h) || /^#\/(bookings|wallet|today|upcoming|customers|plans|notifications|reviews|payouts|balance)(\/\d+)?(\?.*)?$/.test(h) ||
        /^#\/(barber|b)\/\d+$/.test(h) || /^#\/booking\/\d+$/.test(h);
    } catch (e) { return false; }
  }
  function overlayOpen() {
    return !!document.querySelector('.scrim, [role=dialog], [aria-modal=true], dialog[open], .crop-scrim, .crop');
  }
  var STOP = 'input,textarea,select,canvas,iframe,video,[contenteditable],[contenteditable=true],[data-no-ptr],.crop,.map,.leaflet-container,.tabs,.topbar,.toast,.banner,#ptr';
  function blocked(t) {
    if (!t || !t.closest) return true;
    if (t.closest(STOP)) return true;
    for (var x = t; x && x !== document.body && x !== document.documentElement; x = x.parentElement) {
      var s = getComputedStyle(x);
      if (/(auto|scroll)/.test(s.overflowY) && x.scrollHeight > x.clientHeight + 1 && x.scrollTop > 0) return true;
      if (/(auto|scroll)/.test(s.overflowX) && x.scrollWidth > x.clientWidth + 1) return true;   // carousels, wide tables
    }
    return false;
  }
  var top0 = function () { var se = document.scrollingElement || document.documentElement; return (window.pageYOffset || se.scrollTop || 0) <= 0; };

  function build() {
    if (el) return;
    el = document.createElement('div'); el.id = 'ptr'; el.className = 'ptr'; el.setAttribute('aria-hidden', 'true'); el.dataset.state = 'idle';
    el.innerHTML = '<span class="ptr-chip"><svg class="ptr-arrow" viewBox="0 0 24 24" width="18" height="18"><path d="M12 5v14M6 13l6 6 6-6"/></svg><span class="ptr-spin"></span><span class="ptr-txt">Pull to refresh</span></span>';
    live = document.createElement('div'); live.className = 'ptr-live'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
    document.body.appendChild(el); document.body.appendChild(live);
  }
  function say(state, text) { el.dataset.state = state; el.querySelector('.ptr-txt').textContent = text; if (live) live.textContent = state === 'pull' ? '' : text; }
  function place(d, animate) {
    var chip = el.querySelector('.ptr-chip'), tb = document.querySelector('.topbar');
    el.style.setProperty('--ptr-top', (tb ? tb.getBoundingClientRect().bottom : 56) + 'px');
    el.classList.toggle('ptr-anim', !!animate);
    var y = reduce ? 14 : Math.max(0, d) - 44;
    chip.style.transform = 'translate3d(-50%,' + y + 'px,0)';
    el.style.opacity = reduce ? (d > 8 ? 1 : 0) : String(Math.min(1, d / 36));
    el.classList.toggle('ptr-on', d > 0);
  }
  function resist(d) { return MAXD * (1 - Math.exp(-d * 0.8 / MAXD)); }

  function reset(animate) {
    clearTimeout(hideT);
    place(0, animate); pulling = false; ready = false; dist = 0; armed = null;
    hideT = setTimeout(function () { if (el && !busy) { el.classList.remove('ptr-on'); el.dataset.state = 'idle'; } }, animate && !reduce ? 220 : 0);
  }

  function onStart(e) {
    armed = null;
    if (busy || !e.touches || e.touches.length !== 1) return;
    if (!eligibleRoute() || !top0() || overlayOpen() || blocked(e.target)) return;
    if (window.visualViewport && window.visualViewport.scale > 1.01) return;
    var ae = document.activeElement; if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    armed = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  function onMove(e) {
    if (!armed) return;
    if (e.touches.length !== 1) { if (pulling) reset(true); armed = null; return; }
    var dy = e.touches[0].clientY - armed.y, dx = e.touches[0].clientX - armed.x;
    if (!pulling) {
      if (dy < -6 || (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy))) { armed = null; return; }   // upward or sideways: not ours
      if (dy < START || dy < Math.abs(dx) * 1.2) return;                                              // not a clear downward pull yet
      if (!top0() || overlayOpen()) { armed = null; return; }
      build(); reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
      clearTimeout(hideT); pulling = true; say('pull', 'Pull to refresh');
    }
    if (!top0() && (window.pageYOffset || 0) > 0) { reset(true); return; }
    if (e.cancelable) e.preventDefault();
    dist = resist(dy - START);
    var nowReady = dist >= THRESHOLD;
    if (nowReady !== ready) { ready = nowReady; say(ready ? 'ready' : 'pull', ready ? 'Release to refresh' : 'Pull to refresh'); if (ready && window.haptics) haptics.tick(); }
    place(dist, false);
  }
  function onEnd() {
    if (!pulling) { armed = null; return; }
    var go = ready; armed = null;
    if (go) run(); else reset(true);
  }
  function failed() {
    var a = document.getElementById('app');
    return !navigator.onLine || !!(a && a.querySelector(':scope > .err + a.btn'));   // route() shows this box when its own loading fails
  }
  async function run() {
    busy = true; pulling = false; clearTimeout(hideT);
    var t0 = Date.now(), bad = false, quiet = false;
    say('busy', 'Refreshing…'); place(THRESHOLD - 8, true);
    if (window.haptics) haptics.refresh();
    try {
      if (!navigator.onLine) throw new Error('offline');
      // refreshFromNetwork() redraws the screen itself: true = redrawn, false = it chose to do nothing (booking or payment in progress, unsaved typing), reject = failed.
      if (typeof window.refreshFromNetwork === 'function') { if (await window.refreshFromNetwork() === false) quiet = true; }
      else await route();
      if (!quiet && failed()) bad = true;
    } catch (e) { bad = true; }
    var wait = MIN_SHOW - (Date.now() - t0); if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
    if (bad) {
      say('error', 'Could not refresh. Try again.'); if (window.haptics) haptics.error();
      await new Promise(function (r) { setTimeout(r, 1800); });
    }
    busy = false; reset(true);
  }

  document.addEventListener('touchstart', onStart, { passive: true });
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onEnd, { passive: true });
  document.addEventListener('touchcancel', function () { if (pulling) reset(true); armed = null; }, { passive: true });
  window.PullRefresh = { run: run, eligible: eligibleRoute };
})();
