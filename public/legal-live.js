/* Fills the published numbers on the legal pages (Terms, Privacy, Refunds, Plans, Cookies, Barber Agreement) from the platform settings,
   so changing a number in the admin Controls page changes the page with no code change. The built-in text in each <span data-s> is the fallback. */
'use strict';
(() => {
  const money = (n) => Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 });
  fetch('/api/public-settings', { credentials: 'omit' }).then((r) => (r.ok ? r.json() : null)).then((j) => {
    const s = j && j.settings; if (!s) return;
    document.querySelectorAll('[data-s]').forEach((el) => {
      const k = el.dataset.s; let v = s[k]; if (v === null || v === undefined || v === '') return;   // unset (e.g. liability cap): keep the placeholder
      if (k === 'liability_cap_naira') v = '₦' + money(v);
      else if (/_naira$/.test(k)) v = money(v);
      el.textContent = String(v);
    });
  }).catch(() => { /* offline: the defaults stay */ });
})();
