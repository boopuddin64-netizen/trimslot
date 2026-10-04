/* TrimSlot haptics: small buzzes through the Vibration API. Works on Android Chrome / Firefox only.
   iOS Safari and the iOS home-screen app have NO web vibration API, so there this file does nothing (the press-scale in style.css still shows).
   Setting: localStorage 'trimslot_haptics' ('0' = off, anything else = on, default on). Never throws. */
'use strict';
(function () {
  var KEY = 'trimslot_haptics', GAP = 40, last = 0;
  var P = { tick: 8, tap: 12, toggle: 10, refresh: 15, success: [14, 40, 14], error: [30, 40, 30, 40, 30] };
  var store = {
    get: function () { try { return localStorage.getItem(KEY); } catch (e) { return null; } },
    set: function (v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private mode */ } }
  };
  function enabled() { return store.get() !== '0'; }
  function setEnabled(on) { store.set(on ? '1' : '0'); return enabled(); }
  function supported() { try { return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'; } catch (e) { return false; } }
  function reduced() { try { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }
  function fire(name) {
    try {
      if (!enabled() || !supported() || document.hidden) return false;
      var p = P[name];
      if (reduced()) { if (name !== 'success' && name !== 'error') return false; p = 20; }   // reduced motion: only one short pulse, only for results
      var now = Date.now();
      if (now - last < GAP) return false;
      last = now;
      return !!navigator.vibrate(p);
    } catch (e) { return false; }
  }
  window.haptics = {
    tap: function () { return fire('tap'); }, tick: function () { return fire('tick'); }, success: function () { return fire('success'); },
    error: function () { return fire('error'); }, toggle: function () { return fire('toggle'); }, refresh: function () { return fire('refresh'); },
    enabled: enabled, setEnabled: setEnabled, supported: supported
  };

  /* iOS only starts :active styles when the page has a touch listener. A passive no-op is enough. */
  document.addEventListener('touchstart', function () {}, { passive: true });

  /* Central hooks (no edits needed in each screen): bottom tab change, switches and tick-boxes. */
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    if (t.closest('#tabs a')) { var a = t.closest('#tabs a'); if (!a.classList.contains('on')) window.haptics.tick(); return; }
    if (t.closest('.switch') || t.closest('input[type=checkbox]')) window.haptics.toggle();
  }, true);

  /* Settings row ("Haptics" on/off), added under the Dark mode row of the customer and barber Profile pages.
     Wraps the page functions from here so no other file has to change. Only the buzz is switched off; the visual press-scale stays. */
  function row() {
    var on = enabled();
    return '<div class="lrow" id="hapticsrow"><span class="ico">' + (typeof ic === 'function' ? ic('phone', 'sm') : '') + '</span>' +
      '<span class="grow">Haptics<span class="sub">Small buzz when you tap. Works on some phones.</span></span>' +
      '<button class="switch" id="hapticsw" type="button" role="switch" aria-checked="' + on + '" aria-label="Haptics"></button></div>';
  }
  function addRow() {
    try {
      if (document.getElementById('hapticsrow')) return;
      var sw = document.getElementById('themesw'), r = sw && sw.closest('.lrow'); if (!r) return;
      r.insertAdjacentHTML('afterend', row());
      var b = document.getElementById('hapticsw');
      b.onclick = function () { var v = !enabled(); setEnabled(v); b.setAttribute('aria-checked', String(v)); if (v) window.haptics.success(); };
    } catch (e) { /* the page itself still works */ }
  }
  function wrap(name) {
    try {
      var f = window[name]; if (typeof f !== 'function' || f.__hx) return;
      var g = async function () { var r = await f.apply(this, arguments); addRow(); return r; };
      g.__hx = true; window[name] = g;
    } catch (e) { /* ignore */ }
  }
  wrap('profile'); wrap('barberProfile');
})();
