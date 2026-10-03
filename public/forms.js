/* Shared by the app and the admin: the primary submit button of every form stays neutral/disabled until the form is valid
   (native `required` / `pattern` / `min` rules), then becomes the flat solid accent colour. Forms opt out with `novalidate`. */
(function () {
  'use strict';
  var PRIMARY = 'button[type=submit]:not(.sec):not(.ghost):not(.mini):not([data-fv=off]), button:not([type]):not(.sec):not(.ghost):not(.mini):not([data-fv=off])';
  function wire(f) {
    if (f.__fv || f.noValidate || f.getAttribute('data-fv') === 'off') return;
    var btn = f.querySelector(PRIMARY); if (!btn) return;
    f.__fv = true;
    var oneof = (f.getAttribute('data-oneof') || '').split(',').filter(Boolean);
    var sync = function () { var ok = f.checkValidity() && (!oneof.length || oneof.some(function (n) { var e = f.elements[n]; return e && String(e.value).trim() !== ''; })); btn.classList.toggle('is-invalid', !ok); if (!btn.__busy) btn.disabled = !ok; };
    f.addEventListener('input', sync); f.addEventListener('change', sync);
    f.addEventListener('submit', function () { btn.__busy = true; setTimeout(function () { btn.__busy = false; sync(); }, 600); }, true);
    sync();
  }
  function scan(root) { if (root.nodeType !== 1) return; if (root.tagName === 'FORM') wire(root); var l = root.querySelectorAll ? root.querySelectorAll('form') : []; for (var i = 0; i < l.length; i++) wire(l[i]); }
  var queued = false;
  new MutationObserver(function (muts) {
    if (queued) return; queued = true;
    requestAnimationFrame(function () { queued = false; muts.forEach(function (m) { m.addedNodes.forEach(scan); }); });
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', function () { scan(document.body); });
})();
