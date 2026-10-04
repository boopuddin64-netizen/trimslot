/* TrimSlot: reads a photo the user picked and hands back a canvas, shrunk so the long side is at most `maxSide` (default 1600 px).
   Why a canvas: a phone photo can be 12 MP or more, which is heavy to show, crop and draw; and a <canvas> needs no blob: URL, so it cannot be blocked by the page's
   Content-Security-Policy (the old code showed the file through a blob: URL, which production blocked, and every photo then looked "unreadable").
   Order of tries: createImageBitmap (turns the photo upright from its EXIF tag), then <img> from a blob: URL, then <img> from a data: URL, then a smaller bitmap.
   Each failed try is logged with console.warn so the real reason is visible; the user gets one simple sentence. */
'use strict';
(() => {
const MAX_SIDE = 1600;
const HEIC = /heic|heif/i, EXT = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif)$/i;

class PicError extends Error { constructor(message, reason) { super(message); this.name = 'PicError'; this.reason = reason; } }
const why = (e) => String((e && (e.message || e.name)) || e || 'unknown').slice(0, 120);

function viaBitmap(file) {
  if (typeof createImageBitmap !== 'function') return Promise.reject(new Error('createImageBitmap is not available'));
  // 'from-image' = apply the EXIF rotation; older browsers reject the option, so ask again without it.
  return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(file)).then((bmp) => ({ src: bmp, w: bmp.width, h: bmp.height, close: () => { try { bmp.close(); } catch { /* ignore */ } } }));
}
function viaBitmapSmall(file, side) {
  if (typeof createImageBitmap !== 'function') return Promise.reject(new Error('createImageBitmap is not available'));
  return createImageBitmap(file, { resizeWidth: side, resizeQuality: 'medium', imageOrientation: 'from-image' }).then((bmp) => ({ src: bmp, w: bmp.width, h: bmp.height, close: () => { try { bmp.close(); } catch { /* ignore */ } } }));
}
function imgFrom(url, revoke) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => { if (!(im.naturalWidth > 0 && im.naturalHeight > 0)) { if (revoke) URL.revokeObjectURL(url); return rej(new Error('image has no size')); } res({ src: im, w: im.naturalWidth, h: im.naturalHeight, close: () => { if (revoke) URL.revokeObjectURL(url); } }); };
    im.onerror = () => { if (revoke) URL.revokeObjectURL(url); rej(new Error('the browser could not decode it (or the page blocked the image)')); };
    im.src = url;
  });
}
const viaBlobUrl = (file) => imgFrom(URL.createObjectURL(file), true);   // the URL stays alive until the picture is drawn (close() below)
function viaDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => imgFrom(String(r.result), false).then(res, rej);
    r.onerror = () => rej(new Error('FileReader failed'));
    r.readAsDataURL(file);
  });
}

function friendly(file) {
  const t = (file && file.type) || '', n = (file && file.name) || '';
  if (HEIC.test(t) || /\.(heic|heif)$/i.test(n)) return 'This photo is in a format we cannot open here. Take a new photo, or choose a JPEG or PNG.';
  return 'We could not open that photo. Take a new photo, or choose a different picture.';
}

/** Resolves { canvas, width, height, from, original: {w, h} }. Rejects with a PicError (simple-words message, .reason for logs). */
async function load(file, opts) {
  const maxSide = (opts && opts.maxSide) || MAX_SIDE;
  if (!file) throw new PicError('Please choose a picture.', 'no file');
  const type = (file.type || '').toLowerCase();
  if (type && !type.startsWith('image/')) throw new PicError('Please choose a picture.', 'not an image: ' + type);   // an empty type is allowed: some phones send none, decoding decides
  if (file.size === 0) throw new PicError('That file is empty. Please choose another photo.', 'empty file');
  const steps = [['bitmap', viaBitmap], ['blob-url', viaBlobUrl], ['data-url', viaDataUrl], ['small-bitmap', (f) => viaBitmapSmall(f, maxSide)]];
  let got = null, from = '';
  for (const [name, fn] of steps) {
    try { got = await fn(file); from = name; break; }
    catch (e) { steps.failed = (steps.failed || []).concat(name + ': ' + why(e)); }
  }
  if (!got) {
    console.warn('[photo] could not read the picture', { type: file.type || '(none)', size: file.size, name: file.name, tries: steps.failed });
    throw new PicError(friendly(file), (steps.failed || []).join('; '));
  }
  try {
    const long = Math.max(got.w, got.h), k = Math.min(1, maxSide / long);
    const w = Math.max(1, Math.round(got.w * k)), h = Math.max(1, Math.round(got.h * k));
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('no canvas context');
    g.imageSmoothingQuality = 'high'; g.drawImage(got.src, 0, 0, w, h);
    return { canvas, width: w, height: h, from, original: { w: got.w, h: got.h } };
  } catch (e) {
    console.warn('[photo] could not draw the picture', { type: file.type || '(none)', size: file.size, via: from, w: got.w, h: got.h, err: why(e) });
    throw new PicError('That photo is too big for this phone to open. Take a new photo, or choose a smaller one.', 'draw failed: ' + why(e));
  } finally { got.close(); }
}
window.ImgDecode = { load, MAX_SIDE, PicError };
})();
