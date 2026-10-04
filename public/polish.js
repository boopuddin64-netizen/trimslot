/* Polish: hides the loading splash once the first screen is drawn, and adds a short screen change (180 ms).
   The splash itself lives in index.html so it shows before any script runs. */
(function () {
  'use strict';
  var doc = document, app = doc.getElementById('app');
  if (!app) return;
  var reduce = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  /* ---- splash: fade out when the first screen is in ---- */
  var splash = doc.getElementById('splash');
  function hideSplash() {
    var s = splash; if (!s) return; splash = null;
    requestAnimationFrame(function () {
      s.classList.add('out');
      setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, reduce.matches ? 30 : 420);
    });
  }
  if (app.childElementCount) hideSplash();
  else {
    var first = new MutationObserver(function () { if (app.childElementCount) { first.disconnect(); hideSplash(); } });
    first.observe(app, { childList: true });
    setTimeout(hideSplash, 6000);   // never keep the splash if something goes wrong
  }

  /* ---- keep the browser bar colour in step with the theme ---- */
  function syncThemeColor() {
    var m = doc.querySelector('meta[name=theme-color]'); if (!m) return;
    m.content = doc.documentElement.getAttribute('data-theme') === 'dark' ? '#0b1220' : '#f6f7fb';
  }
  new MutationObserver(syncThemeColor).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  /* ---- short screen change ---- */
  var busy = false;
  function nextDraw(maxMs) {   // resolves when the app draws something new (or after maxMs)
    return new Promise(function (resolve) {
      var done = false, mo = new MutationObserver(finish), t = setTimeout(finish, maxMs);
      function finish() { if (done) return; done = true; mo.disconnect(); clearTimeout(t); resolve(); }
      mo.observe(app, { childList: true });
    });
  }
  window.addEventListener('hashchange', function () {
    if (busy || splash || reduce.matches || doc.hidden || doc.querySelector('.scrim')) return;
    busy = true;
    var drawn = nextDraw(350);
    drawn.then(function () {   // the new screen fades in and rises a little (180 ms). Not the browser's view-transition API: it freezes taps while it runs
      try { if (app.animate) app.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' }); } catch (e) { /* ignore */ }
      setTimeout(function () { busy = false; }, 200);
    });
  });
})();
