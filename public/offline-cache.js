/* TrimSlot: last-loaded read-only data on this device (instant first paint + offline), and the service-worker update flow.
   - Stores ONLY the last successful answers of a short allow-list of read-only calls (settings, profile, barbers, bookings, home extras), per signed-in user.
   - NEVER stores logins/tokens (the login is an http-only cookie the page cannot read), one-time codes, passwords, payment links/references, or any answer of a write.
   - Cleared on logout (everything personal; the public /config copy stays), when the account changes, when the server says "not signed in", and on login/signup.
   - On load it shows the saved copy at once, then asks the network and updates the screen only if something changed.
   - Offline: reads fall back to the saved copy (the banner says so); writes stop with a short message.
   The logic is plain functions (unit-tested in Node: tests/offlinecache.test.ts); the browser part below only wires it to app.js (one small hook in apiCall). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.OfflineCache = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  var PREFIX = 'ts_oc1:';                       // every key this file writes starts with this
  var LASTUID = PREFIX + 'uid';
  var MAX_BYTES = 400 * 1024;                   // one saved answer
  var MAX_AGE = 30 * 86400000;                  // a saved answer older than this is dropped
  /* read-only calls that may be saved (exact paths, no query). /config is the same for everyone; the rest belong to the signed-in user. */
  var READ = /^\/(?:config|auth\/me|barbers|me\/barbers|me\/wallet|bookings|me\/rebook|me\/favourites|waitlist)$/;
  var GLOBAL = /^\/config$/;
  /* keys we refuse to keep, anywhere in an answer (belt and braces: the server does not send these to the list/profile calls anyway) */
  var FORBIDDEN = /token|secret|otp|dev_code|passw|passcode|authorization|access_code|reference|signature|cookie|cvv|pan$/i;
  var OFFLINE_MSG = 'You are offline. Try again when you are online.';

  function isReadable(method, path) { return (method || 'GET') === 'GET' && READ.test(path); }
  function strip(v, depth) {
    if (depth > 12) return null;
    if (Array.isArray(v)) return v.map(function (x) { return strip(x, depth + 1); });
    if (v && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { if (!FORBIDDEN.test(k)) o[k] = strip(v[k], depth + 1); }); return o; }
    return v;
  }
  function memoryStorage() {
    var m = {};
    return { getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; },
      key: function (i) { return Object.keys(m)[i] || null; }, get length() { return Object.keys(m).length; } };
  }

  /* The store. `storage` is localStorage in the browser (any object with the same 5 methods in tests). */
  function create(storage, now) {
    now = now || function () { return Date.now(); };
    var current = null;     // user id (string) whose data is in use right now
    function lastUid() { try { return storage.getItem(LASTUID); } catch (e) { return null; } }
    function keyFor(uid, path) { return PREFIX + (GLOBAL.test(path) ? 'g' : uid) + ':' + path; }
    function uidNow() { return current || lastUid(); }
    function clear() {
      current = null;
      try {
        var del = [];
        var keep = PREFIX + 'g:';                    // the public settings (/config) hold nothing personal: kept so the signed-out screens also open offline
        for (var i = 0; i < storage.length; i++) { var k = storage.key(i); if (k && k.indexOf(PREFIX) === 0 && k.indexOf(keep) !== 0) del.push(k); }
        del.forEach(function (k) { storage.removeItem(k); });
      } catch (e) { /* storage blocked: nothing was saved */ }
    }
    function load(path) {
      if (!READ.test(path)) return null;
      var uid = uidNow(); if (!uid && !GLOBAL.test(path)) return null;
      try {
        var raw = storage.getItem(keyFor(uid, path)); if (!raw) return null;
        var e = JSON.parse(raw);
        if (!e || e.v !== 1 || now() - e.t > MAX_AGE) { storage.removeItem(keyFor(uid, path)); return null; }
        return { t: e.t, d: e.d };
      } catch (e) { return null; }
    }
    /* Called with every successful answer of an allow-listed read. Handles who-is-signed-in. Returns true if it was saved. */
    function save(path, data) {
      if (!READ.test(path) || data == null) return false;
      if (path === '/auth/me') {
        var u = data.user;
        if (!u || u.id == null) { clear(); return false; }              // server says: nobody is signed in -> forget everything
        var id = String(u.id);
        if (lastUid() && lastUid() !== id) clear();                     // a different account -> forget the old one's data
        current = id;
        try { storage.setItem(LASTUID, id); } catch (e) { return false; }
      }
      var uid = uidNow(); if (!uid && !GLOBAL.test(path)) return false;
      try {
        var raw = JSON.stringify({ v: 1, t: now(), d: strip(data, 0) });
        if (raw.length > MAX_BYTES) { storage.removeItem(keyFor(uid, path)); return false; }
        storage.setItem(keyFor(uid, path), raw); return true;
      } catch (e) { return false; }                                      // quota / private mode: simply not saved
    }
    function use(uid) { current = uid == null ? null : String(uid); }
    return { load: load, save: save, clear: clear, use: use, lastUid: lastUid, keyFor: keyFor };
  }

  var api = { PREFIX: PREFIX, READ: READ, FORBIDDEN: FORBIDDEN, OFFLINE_MSG: OFFLINE_MSG, isReadable: isReadable, strip: strip, create: create, memoryStorage: memoryStorage };
  if (!root || !root.document) return api;

  /* ---------------- browser wiring ---------------- */
  var store; try { store = create(root.localStorage); root.localStorage.getItem('x'); } catch (e) { store = create(memoryStorage()); }   // blocked storage -> memory only
  var staleSince = 0, bootOn = false, bootUntil = 0, bootHash = '', timer = 0;
  var BOOT_SCREENS = /^(?:|#\/?|#\/bookings|#\/profile)$/;   // read-only screens where we may paint the saved copy first
  var h0 = (root.location.hash || '').split('?')[0];
  if (BOOT_SCREENS.test(h0)) { bootOn = true; bootUntil = Date.now() + 6000; bootHash = root.location.hash || ''; }

  function emit(type, extra) { try { var e = new root.CustomEvent('ts:net', { detail: Object.assign({ type: type }, extra || {}) }); root.dispatchEvent(e); } catch (er) { /* ignore */ } }
  var domReady = root.document.readyState === 'complete', waiters = [];
  if (!domReady) root.document.addEventListener('DOMContentLoaded', function () { domReady = true; waiters.splice(0).forEach(function (f) { f(); }); });   // all deferred scripts have run by then
  var scriptsReady = function () { return domReady ? Promise.resolve() : new Promise(function (r) { waiters.push(r); }); };
  var clone = function (d) { return JSON.parse(JSON.stringify(d)); };
  var offlineNow = function () { return root.navigator && root.navigator.onLine === false; };
  var busy = function () {   // never re-draw under someone who is typing or has a pop-up open
    var a = root.document.activeElement;
    return !!(a && /^(?:INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) || !!root.document.querySelector('dialog[open],.modal:not(.hidden),.sheet:not(.hidden)');
  };
  function refreshSoon() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      bootOn = false;
      if ((root.location.hash || '') === bootHash && !busy() && typeof root.route === 'function') root.route();
    }, 120);
  }
  function fresh(path, data) {                      // a real answer arrived
    var cur = store.load(path);
    store.save(path, data);
    staleSince = 0; emit('ok');
    return cur ? JSON.stringify(cur.d) !== JSON.stringify(strip(data, 0)) : false;
  }

  function call(path, opts, net) {
    opts = opts || {};
    var method = opts.method || 'GET';
    if (method !== 'GET') {
      if (offlineNow()) {                           // writes need the network: say so, never fail silently
        if (typeof root.toast === 'function') root.toast(OFFLINE_MSG, true);
        var er = new Error(OFFLINE_MSG); er.code = 'NETWORK'; er.offline = true; return Promise.reject(er);
      }
      if (path === '/auth/logout') store.clear();   // forget this person's saved data BEFORE asking the server
      var p = net(path, opts);
      if (/^\/auth\/(?:login|signup)$/.test(path) || path === '/me/delete') p.then(function () { store.clear(); }, function () { /* keep */ });
      return p.then(function (d) { emit('ok'); return d; }, function (e) { if (e && e.code === 'NETWORK') emit(e.timeout ? 'timeout' : 'fail'); throw e; });
    }
    if (!READ.test(path)) {
      return net(path, opts).then(function (d) { emit('ok'); return d; }, function (e) { if (e && e.code === 'NETWORK') emit(e.timeout ? 'timeout' : 'fail'); throw e; });
    }
    var hit = store.load(path);
    if (hit && bootOn && Date.now() < bootUntil) {   // saved copy now, real answer in the background
      net(path, opts).then(function (d) { if (fresh(path, d)) refreshSoon(); }, function (e) {
        if (e && e.code === 'NETWORK') { staleSince = hit.t; emit(e.timeout ? 'timeout' : 'fail'); }
        else refreshSoon();                         // a real error (e.g. signed out): draw the screen again so the real message shows
      });
      staleSince = hit.t;                           // until the network answers, what is on screen is the saved copy
      return scriptsReady().then(function () { return clone(hit.d); });   // saved copies answer instantly, but only once every deferred script (Notify, Account…) has run
    }
    return net(path, opts).then(function (d) {
      fresh(path, d);
      return d;
    }, function (e) {
      if (e && e.code === 'NETWORK') {
        emit(e.timeout ? 'timeout' : 'fail');
        if (hit) { staleSince = hit.t; emit('stale', { savedAt: hit.t }); return clone(hit.d); }
      }
      throw e;
    });
  }

  /* Pull-to-refresh / "try again": fetch the current screen's data again from the network. Resolves true if the screen was redrawn. */
  function refreshFromNetwork() {
    bootOn = false;
    if (typeof root.gcache !== 'undefined' && root.gcache && root.gcache.clear) root.gcache.clear();
    var h = root.location.hash || '#/';
    var inProgress = /^#\/book\/|^#\/booking\/[^?]*\/move|[?&]pay=/.test(h);   // never redraw a booking being made or a payment being checked
    var dirty = Array.prototype.some.call(root.document.querySelectorAll('#app input:not([type=hidden]):not([type=checkbox]):not([type=radio]),#app textarea'), function (el) { return el.value !== el.defaultValue; });
    if (inProgress || dirty || typeof root.route !== 'function') return Promise.resolve(false);
    return Promise.resolve(root.route()).then(function () { return true; }, function () { return false; });
  }

  /* ---------------- service worker + safe updates ---------------- */
  var updateReady = false, reg = null;
  function applyUpdate() { if (reg && reg.waiting && root.navigator.serviceWorker.controller) reg.waiting.postMessage({ type: 'SKIP_WAITING' }); }
  function watch(r) {
    reg = r;
    if (r.waiting && root.navigator.serviceWorker.controller) { updateReady = true; applyUpdate(); }   // opened the app and a new version was already waiting: take it for this and the next open (no reload)
    r.addEventListener('updatefound', function () {
      var w = r.installing; if (!w) return;
      w.addEventListener('statechange', function () {
        if (w.state === 'installed' && root.navigator.serviceWorker.controller) { updateReady = true; emit('update'); }   // new version downloaded: it takes over when the app goes to the background or on the next open
      });
    });
  }
  function startSW() {
    if (!('serviceWorker' in root.navigator)) return;
    root.navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(watch, function () { /* no service worker: the app still works online */ });
    root.document.addEventListener('visibilitychange', function () { if (root.document.hidden && updateReady) applyUpdate(); });
    root.addEventListener('pagehide', function () { if (updateReady) applyUpdate(); });
  }
  if (root.document.readyState === 'complete') setTimeout(startSW, 0); else root.addEventListener('load', function () { setTimeout(startSW, 0); });

  root.addEventListener('online', function () { emit('online'); });
  root.addEventListener('offline', function () { emit('offline'); });

  var out = Object.assign({}, api, {
    call: call, store: store, refreshFromNetwork: refreshFromNetwork, clear: function () { store.clear(); },
    isStale: function () { return !!staleSince; }, savedAt: function () { return staleSince || 0; }, updateReady: function () { return updateReady; }, applyUpdate: applyUpdate,
  });
  root.refreshFromNetwork = refreshFromNetwork;
  return out;
});
