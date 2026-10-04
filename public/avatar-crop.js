/* TrimSlot: profile-picture cropper. AvatarCrop.open(file, save) shows a round preview (drag / pinch / wheel / slider / keyboard),
   then Save encodes a square JPEG (<= 512 px, <= 100 KB) on the device and hands it to save(blob). Resolves true when saved, false when cancelled.
   Rejects (before showing anything) when the file is not a readable image. Maths lives in cropmath.js. */
'use strict';
(() => {
const CM = window.CropMath, MAX_BYTES = 100 * 1024;   // the server accepts up to 120 KB
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

function loadImage(file) {
  return new Promise((res, rej) => {
    if (!file || !/^image\//.test(file.type || '')) return rej(new Error('Please choose a picture.'));
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => (im.naturalWidth > 0 && im.naturalHeight > 0 ? res({ im, url }) : (URL.revokeObjectURL(url), rej(new Error('We could not read that picture.'))));
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('We could not read that picture. Try a JPEG or PNG.')); };
    im.src = url;
  });
}

/** Draw the chosen square and compress it (quality first, then size) until it fits. */
async function encode(im, rect) {
  const w = im.naturalWidth, h = im.naturalHeight;
  let a = { px: CM.outputSize(rect.side), q: 0.86 };
  while (a) {
    const c = document.createElement('canvas'); c.width = c.height = a.px;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, a.px, a.px); g.imageSmoothingQuality = 'high';
    g.drawImage(im, Math.max(0, rect.sx), Math.max(0, rect.sy), Math.min(rect.side, w), Math.min(rect.side, h), 0, 0, a.px, a.px);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', a.q));
    if (blob && blob.type === 'image/jpeg' && blob.size <= MAX_BYTES) return blob;
    a = CM.nextAttempt(a.px, a.q);
  }
  throw new Error('That photo is too big. Try a different one.');
}

async function open(file, save) {
  const { im, url } = await loadImage(file);
  const W = im.naturalWidth, H = im.naturalHeight;
  const opener = document.activeElement;
  const root = el(`<div class="scrim crop-scrim"><div class="sheet crop" role="dialog" aria-modal="true" aria-labelledby="crop-t" aria-describedby="crop-help">
    <h3 id="crop-t">Adjust your photo</h3>
    <p class="small muted" id="crop-help">Drag to move. Pinch or use the slider to zoom.</p>
    <div class="crop-view" id="crop-view" tabindex="0" role="group" aria-label="Photo preview. Arrow keys move the photo, plus and minus zoom."></div>
    <div class="crop-zoom"><label for="crop-z">Zoom</label><input id="crop-z" type="range" min="0" max="100" step="1" value="0" aria-valuetext="100%"></div>
    <div class="err hidden" id="crop-err" role="alert"></div>
    <div class="btns crop-btns"><button class="btn sec" type="button" data-cancel>Cancel</button><button class="btn" type="button" data-save disabled>Save</button></div></div></div>`);
  const view = root.querySelector('#crop-view'), zin = root.querySelector('#crop-z'), errBox = root.querySelector('#crop-err');
  const bCancel = root.querySelector('[data-cancel]'), bSave = root.querySelector('[data-save]');
  im.alt = ''; im.draggable = false; im.className = 'crop-img'; view.appendChild(im);

  let V = 260, st = CM.initial(W, H), busy = false, closed = false;
  const paint = () => {
    const p = CM.placement(W, H, V, st);
    im.style.transform = `translate(${p.tx}px,${p.ty}px) scale(${p.scale})`;
    zin.value = String(CM.zoomToSlider(st.z)); zin.setAttribute('aria-valuetext', Math.round(st.z * 100) + '%');
    zin.style.setProperty('--fill', zin.value + '%');
  };
  const measure = () => { V = view.clientWidth || V; st = { ...st, ...CM.clampCenter(W, H, V, st.z, st.cx, st.cy) }; paint(); };
  const zoomTo = (z, fx, fy) => { st = CM.zoomAt(W, H, V, st, z, fx, fy); paint(); };

  /* ----- pointers: 1 = drag, 2 = pinch (+ drag with the midpoint) ----- */
  const ptrs = new Map(); let pinch = null;
  const mid = () => { const a = [...ptrs.values()]; return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) }; };
  const rel = (x, y) => { const r = view.getBoundingClientRect(); return { x: x - (r.left + r.width / 2), y: y - (r.top + r.height / 2) }; };
  view.addEventListener('pointerdown', (e) => {
    if (busy || (e.pointerType === 'mouse' && e.button !== 0)) return;
    try { view.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) { const m = mid(); pinch = { z: st.z, d: m.d, x: m.x, y: m.y }; }
    view.classList.add('drag');
  });
  view.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId); if (!p) return;
    if (ptrs.size === 1) { st = CM.pan(W, H, V, st, e.clientX - p.x, e.clientY - p.y); p.x = e.clientX; p.y = e.clientY; paint(); return; }
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 2 && pinch) {
      const m = mid(); st = CM.pan(W, H, V, st, m.x - pinch.x, m.y - pinch.y);
      const f = rel(m.x, m.y); st = CM.zoomAt(W, H, V, st, CM.pinchZoom(pinch.z, pinch.d, m.d), f.x, f.y);
      pinch.x = m.x; pinch.y = m.y; paint();
    }
  });
  const up = (e) => {
    ptrs.delete(e.pointerId); pinch = null;
    if (!ptrs.size) view.classList.remove('drag');
  };
  view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up); view.addEventListener('lostpointercapture', up);
  view.addEventListener('wheel', (e) => { e.preventDefault(); const f = rel(e.clientX, e.clientY); zoomTo(st.z * Math.exp(-e.deltaY * 0.0015), f.x, f.y); }, { passive: false });
  view.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 40 : 12, k = e.key;
    if (k === 'ArrowLeft') st = CM.pan(W, H, V, st, step, 0); else if (k === 'ArrowRight') st = CM.pan(W, H, V, st, -step, 0);
    else if (k === 'ArrowUp') st = CM.pan(W, H, V, st, 0, step); else if (k === 'ArrowDown') st = CM.pan(W, H, V, st, 0, -step);
    else if (k === '+' || k === '=') st = CM.zoomAt(W, H, V, st, st.z + 0.15); else if (k === '-' || k === '_') st = CM.zoomAt(W, H, V, st, st.z - 0.15);
    else return;
    e.preventDefault(); paint();
  });
  zin.addEventListener('input', () => zoomTo(CM.sliderToZoom(zin.value)));

  /* ----- open / close ----- */
  const prevOverflow = document.body.style.overflow;
  return new Promise((resolve) => {
    const close = (saved) => {
      if (closed) return; closed = true;
      document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', measure);
      document.body.style.overflow = prevOverflow; root.remove(); URL.revokeObjectURL(url);
      if (opener && opener.focus && document.contains(opener)) opener.focus();
      resolve(saved);
    };
    const setBusy = (b) => { busy = b; bCancel.disabled = b; bSave.disabled = b; zin.disabled = b; bSave.textContent = b ? 'Saving…' : 'Save'; };
    const showErr = (m) => { errBox.textContent = m || ''; errBox.classList.toggle('hidden', !m); };
    bCancel.onclick = () => { if (!busy) close(false); };
    bSave.onclick = async () => {
      if (busy) return; showErr(''); setBusy(true);
      try { const blob = await encode(im, CM.cropRect(W, H, V, st)); await save(blob); close(true); }
      catch (e) { setBusy(false); showErr((e && e.message) || 'We could not save it. Try again.'); }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busy) close(false); return; }
      if (e.key !== 'Tab') return;
      const f = [...root.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')]; if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true); window.addEventListener('resize', measure);
    document.body.style.overflow = 'hidden'; document.body.appendChild(root);
    measure(); bSave.disabled = false; view.focus({ preventScroll: true });
  });
}
window.AvatarCrop = { open, encode };
})();
