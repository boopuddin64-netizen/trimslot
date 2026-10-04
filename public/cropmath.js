/* Pure maths for the profile-picture cropper (no DOM). Used by avatar-crop.js in the browser and unit-tested in Node (tests/cropmath.test.ts).
   Model: the image has natural size w x h. The round viewport has diameter V (CSS px). At zoom 1 the image just covers the viewport
   (scale = V / min(w,h)); zoom z multiplies that. The view is described by (z, cx, cy) where (cx, cy) is the image point under the viewport centre.
   The crop square never leaves the image, so there are never empty corners in the saved picture. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.CropMath = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MIN_ZOOM = 1, MAX_ZOOM = 4, OUT_MAX = 512, OUT_MIN = 64;
  var clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };
  var finite = function (n) { return typeof n === 'number' && isFinite(n); };

  /** Pixels on screen per image pixel. */
  function scaleFor(w, h, V, z) { return (V / Math.min(w, h)) * z; }
  function clampZoom(z, max) { return finite(z) ? clamp(z, MIN_ZOOM, max || MAX_ZOOM) : MIN_ZOOM; }
  /** Keep the crop square inside the image. */
  function clampCenter(w, h, V, z, cx, cy) {
    var half = V / (2 * scaleFor(w, h, V, z));
    var x = w <= 2 * half ? w / 2 : clamp(finite(cx) ? cx : w / 2, half, w - half);
    var y = h <= 2 * half ? h / 2 : clamp(finite(cy) ? cy : h / 2, half, h - half);
    return { cx: x, cy: y };
  }
  /** Fresh view: zoom 1, centred. */
  function initial(w, h) { return { z: 1, cx: w / 2, cy: h / 2 }; }
  /** Drag by (dx, dy) screen pixels: the picture follows the finger. */
  function pan(w, h, V, st, dx, dy) {
    var s = scaleFor(w, h, V, st.z), c = clampCenter(w, h, V, st.z, st.cx - dx / s, st.cy - dy / s);
    return { z: st.z, cx: c.cx, cy: c.cy };
  }
  /** Zoom to nz keeping the image point under the screen point (fx, fy) (relative to the viewport centre) fixed. fx = fy = 0 zooms about the centre. */
  function zoomAt(w, h, V, st, nz, fx, fy) {
    var z = clampZoom(nz), s0 = scaleFor(w, h, V, st.z), s1 = scaleFor(w, h, V, z);
    fx = fx || 0; fy = fy || 0;
    var px = st.cx + fx / s0, py = st.cy + fy / s0;           // image point under the focus
    var c = clampCenter(w, h, V, z, px - fx / s1, py - fy / s1);
    return { z: z, cx: c.cx, cy: c.cy };
  }
  /** Source square for drawing: { sx, sy, side } in image pixels. */
  function cropRect(w, h, V, st) {
    var side = V / scaleFor(w, h, V, st.z), c = clampCenter(w, h, V, st.z, st.cx, st.cy);
    side = Math.min(side, w, h);
    return { sx: c.cx - side / 2, sy: c.cy - side / 2, side: side };
  }
  /** Output edge in px: 512 at most, never more than the source pixels available (no pointless upscaling). */
  function outputSize(side) { return clamp(Math.floor(finite(side) ? side : OUT_MAX), OUT_MIN, OUT_MAX); }
  /** CSS transform values for the <img> (transform-origin 0 0). */
  function placement(w, h, V, st) { var s = scaleFor(w, h, V, st.z); return { scale: s, tx: V / 2 - st.cx * s, ty: V / 2 - st.cy * s }; }
  /** Slider (0..100) <-> zoom, linear in zoom. */
  function zoomToSlider(z) { return Math.round(((clampZoom(z) - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100); }
  function sliderToZoom(v) { return MIN_ZOOM + (clamp(Number(v) || 0, 0, 100) / 100) * (MAX_ZOOM - MIN_ZOOM); }
  /** Pinch: new zoom from the start zoom and the finger distance ratio. */
  function pinchZoom(startZ, startDist, dist) { return startDist > 0 && dist > 0 ? clampZoom(startZ * (dist / startDist)) : clampZoom(startZ); }
  /** Encoding ladder: first try (512 px, q .86), then lower quality, then fewer pixels. Returns null when out of options. */
  function nextAttempt(px, q) {
    if (q > 0.55) return { px: px, q: Math.round((q - 0.1) * 100) / 100 };
    var n = Math.round(px * 0.8); return n >= 128 ? { px: n, q: 0.7 } : null;
  }
  return { MIN_ZOOM: MIN_ZOOM, MAX_ZOOM: MAX_ZOOM, OUT_MAX: OUT_MAX, OUT_MIN: OUT_MIN, scaleFor: scaleFor, clampZoom: clampZoom, clampCenter: clampCenter, initial: initial, pan: pan, zoomAt: zoomAt, cropRect: cropRect, outputSize: outputSize, placement: placement, zoomToSlider: zoomToSlider, sliderToZoom: sliderToZoom, pinchZoom: pinchZoom, nextAttempt: nextAttempt };
});
