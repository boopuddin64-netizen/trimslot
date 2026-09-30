/* Applies the saved (or system) colour theme before first paint. */
(function () {
  try {
    var t = localStorage.getItem('trimslot_theme');
    if (!t && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) t = 'dark';
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    var m = document.querySelector('meta[name=theme-color]'); if (m && t === 'dark') m.content = '#0b1220';
  } catch (e) { /* ignore */ }
})();
