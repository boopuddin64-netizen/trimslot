/* TrimSlot: customer avatar, re-accept prompt, data export, account deletion. Loaded after app.js (uses its helpers). All rendering escapes data. */
'use strict';
(() => {
const SIZE = 256, MAX = 100 * 1024;   // square crop, kept well under the server's 120 KB limit

/** Round avatar: photo as a background (never jumps), initials fallback. c = { name, avatar_url }. */
const av = (c, cls) => {
  if (!c) return '';
  const url = c.avatar_url && /^\/api\/avatars\/\d+/.test(c.avatar_url) ? c.avatar_url : '';
  return `<span class="av ${url ? 'has ' : ''}${cls || ''}" ${url ? `style="background-image:url(&quot;${esc(url)}&quot;)"` : ''} aria-hidden="true">${initials(c.name)}</span>`;
};

/** Centre-crop to a square and compress to a small JPEG, all on the device. */
async function squareJpeg(file) {
  const bmp = (await ImgDecode.load(file, { maxSide: 1600 })).canvas;
  const w = bmp.width, h = bmp.height, side = Math.min(w, h);
  const sx = Math.floor((w - side) / 2), sy = Math.floor((h - side) / 2);
  let px = SIZE, q = 0.82;
  for (let i = 0; i < 8; i++) {
    const c = document.createElement('canvas'); c.width = c.height = px;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, px, px); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, sx, sy, side, side, 0, 0, px, px);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', q));
    if (blob && blob.size <= MAX) return blob;
    if (q > 0.5) q -= 0.1; else px = Math.round(px * 0.8);
  }
  throw new Error('That photo is too big. Try a different one.');
}
async function putBlob(blob) {
  const r = await fetch('/api/me/avatar', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || 'The upload did not work');
  return j.avatar_url;
}

const photoCard = (u) => `<div class="card avatar-edit">${av(u, 'xl')}<div class="grow"><b>Profile photo</b><small>Optional. Barbers you book with see it, so they can tell customers with the same name apart.</small>
  <div class="btns" style="margin-top:8px"><label class="btn sec sm" style="margin:0;cursor:pointer">${ic('camera', 'sm')} Take photo<input id="av-cam" type="file" accept="image/*" capture="user"></label>
  <label class="btn sec sm" style="margin:0;cursor:pointer">${ic('image', 'sm')} Choose<input id="av-file" type="file" accept="image/*"></label>
  ${u.avatar_url ? `<button class="btn ghost sm" id="av-rm" type="button">Remove</button>` : ''}</div><div class="small muted" id="av-msg" style="margin-top:4px"></div></div></div>`;

function wirePhoto() {
  const upload = async (blob) => { state.user.avatar_url = await putBlob(blob); };
  const go1 = async (f, input) => {
    if (!f) return; const m = $('#av-msg'); m.textContent = '';
    try {
      if (window.AvatarCrop && window.CropMath) { if (await AvatarCrop.open(f, upload)) { toast('Photo saved'); route(); } }
      else { m.textContent = 'Saving…'; await upload(await squareJpeg(f)); toast('Photo saved'); route(); }
    } catch (e) { m.textContent = e.message; fail(e); }
    finally { if (input) input.value = ''; }   // lets the same picture be chosen again
  };
  ['#av-cam', '#av-file'].forEach((s) => { const el = $(s); if (el) el.onchange = () => go1(el.files[0], el); });
  const rm = $('#av-rm'); if (rm) rm.onclick = async () => { try { await api('/me/avatar', { method: 'DELETE' }); state.user.avatar_url = null; toast('Photo removed'); route(); } catch (e) { fail(e); } };
}

/* ---------- data + deletion ---------- */
const dataSection = (u) => `<h2>Your data</h2><div class="list">
  <button class="lrow" id="exp"><span class="ico">${ic('list', 'sm')}</span><span class="grow">Download my data<span class="sub">A JSON file with your account, bookings and payments</span></span><span class="end">${ic('right', 'sm')}</span></button>
  <a class="lrow" href="/privacy.html" target="_blank" rel="noopener"><span class="ico">${ic('shield', 'sm')}</span><span class="grow">Privacy Policy</span><span class="end">${ic('right', 'sm')}</span></a>
  ${u.deletion_requested ? `<button class="lrow" id="delcancel"><span class="ico">${ic('refresh', 'sm')}</span><span class="grow">Cancel my deletion request<span class="sub">TrimSlot has not answered yet</span></span></button>`
    : `<button class="lrow danger" id="delacct"><span class="ico">${ic('trash', 'sm')}</span><span class="grow">Delete my account<span class="sub">We remove your personal details. We keep payment records, but without your name</span></span></button>`}</div>`;

async function exportData() {
  const r = await fetch('/api/me/export', { credentials: 'same-origin' });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error?.message || 'We could not get your data ready.'); }
  const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = (/filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '') || [])[1] || 'trimslot-my-data.json';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function deleteDialog(u) {
  const el = document.createElement('div'); el.className = 'scrim';
  el.innerHTML = `<form class="sheet" role="dialog" aria-modal="true" autocomplete="off"><h3 style="margin:0 0 6px">Delete your account</h3>
    <p class="small muted" style="margin:0 0 8px">${u.role === 'barber' ? 'We remove your shop, so customers cannot find it. You may still have upcoming bookings, a balance to pay TrimSlot, or customer plans to honour. If so, we send your request to TrimSlot, and we finish it when those are done.' : 'We remove your name, contact details and picture. You can no longer log in. We keep bookings and payments because the law and our accounts need them, but without your name.'}</p>
    ${u.role === 'customer' ? `<label class="chk"><input type="checkbox" name="forfeit"> <span>I know I lose my unused plan sessions and session credits.</span></label>` : ''}
    <div class="err hidden" id="delerr" role="alert"></div>
    <label>Your password</label><input name="password" type="password" autocomplete="current-password" required>
    <label>Type DELETE to confirm</label><input name="confirm" autocomplete="off" required>
    <div class="btns cta"><button class="btn sec" type="button" id="delno">Keep my account</button><button class="btn red" type="submit">Delete</button></div></form>`;
  document.body.appendChild(el);
  const done = () => el.remove();
  el.querySelector('#delno').onclick = done; el.onclick = (ev) => { if (ev.target === el) done(); };
  el.querySelector('form').onsubmit = async (ev) => {
    ev.preventDefault(); const f = ev.target.elements; const err = el.querySelector('#delerr'); err.classList.add('hidden');
    const b = ev.target.querySelector('button[type=submit]'); b.disabled = true;
    try {
      const r = await api('/me/delete', { method: 'POST', body: { password: f.password.value, confirm: f.confirm.value.trim(), acknowledge_forfeit: !!(f.forfeit && f.forfeit.checked) } });
      done();
      if (r && r.requested) { state.user.deletion_requested = true; toast('Request sent. TrimSlot will contact you.'); route(); }
      else { state.user = null; toast('Your account is deleted'); go('#/login'); }
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); b.disabled = false; }
  };
}
function wireData(u) {
  const e = $('#exp'); if (e) e.onclick = async () => { e.disabled = true; try { await exportData(); toast('Your data is downloaded'); } catch (x) { fail(x); } e.disabled = false; };
  const d = $('#delacct'); if (d) d.onclick = () => deleteDialog(u);
  const c = $('#delcancel'); if (c) c.onclick = async () => { try { await api('/me/delete/cancel', { method: 'POST', body: {} }); state.user.deletion_requested = false; toast('Request cancelled'); route(); } catch (x) { fail(x); } };
}
/** Insert the data section just above the sign-out list (works for customers and barbers). */
function addData() {
  const so = $('#signout'); const list = so && so.closest('.list'); if (!list || $('#exp')) return;
  list.insertAdjacentHTML('beforebegin', dataSection(state.user)); wireData(state.user);
}

/* ---------- wrap the existing profile pages instead of editing them ---------- */
const _profile = profile;
profile = async function (editing) {
  await _profile(editing);
  try {
    const head = $('.prof-head'); const u = state.user;
    if (head && u && u.role === 'customer') {
      const old = head.querySelector('.avatar'); if (old) old.outerHTML = av(u, 'lg');
      head.insertAdjacentHTML('afterend', photoCard(u)); wirePhoto();
    }
    addData();
  } catch { /* the profile page itself is already usable */ }
};
const _barberProfile = barberProfile;
barberProfile = async function () { await _barberProfile(); try { addData(); } catch { /* ignore */ } };

/* ---------- re-accept prompt (shown when a document version was raised, and for accounts from before the tick-box) ---------- */
function reaccept() {
  const need = state.user.consent_required || [];
  app.innerHTML = `<h1>Please review our terms</h1><p class="muted">We updated ${need.length === 1 ? 'a document' : 'some documents'}. To keep using TrimSlot, please read and accept ${need.length === 1 ? 'it' : 'them'}.</p>
    <div class="list">${need.map((d) => `<a class="lrow" href="${esc(d.url)}" target="_blank" rel="noopener"><span class="ico">${ic('list', 'sm')}</span><span class="grow">${esc(d.title)}<span class="sub">Version ${esc(d.version)}</span></span><span class="end">${ic('right', 'sm')}</span></a>`).join('')}</div>
    <form id="rf"><label class="chk accept"><input type="checkbox" name="ok" required> <span>I have read and I accept ${need.length === 1 ? 'this document' : 'these documents'}.</span></label>
    <div class="err hidden" id="rferr" role="alert"></div>
    <div class="btns cta"><button class="btn" type="submit">Accept and continue</button></div></form>
    <div class="list" style="margin-top:16px">${signOutRow()}</div>`;
  wireSignOut();
  $('#rf').onsubmit = async (ev) => {
    ev.preventDefault(); const b = ev.target.querySelector('button[type=submit]'); b.disabled = true;
    try { await api('/me/consent', { method: 'POST', body: { accept: true } }); state.user.consent_required = []; toast('Thank you'); route(); }
    catch (e) { const er = $('#rferr'); er.textContent = e.message; er.classList.remove('hidden'); b.disabled = false; }
  };
}

window.Account = { av, reaccept, squareJpeg };
})();
