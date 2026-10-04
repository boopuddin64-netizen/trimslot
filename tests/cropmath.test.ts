/* Unit tests for the profile-picture crop maths (public/cropmath.js, pure functions, no DB). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const M: any = createRequire(__filename)('../public/cropmath.js');
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);
const V = 260;

test('zoom 1 covers the viewport with the short side (landscape and portrait)', () => {
  near(M.scaleFor(4000, 3000, V, 1), V / 3000);
  near(M.scaleFor(3000, 4000, V, 1), V / 3000);
  const r = M.cropRect(4000, 3000, V, M.initial(4000, 3000));
  near(r.side, 3000); near(r.sx, 500); near(r.sy, 0);
});

test('zoom 2 halves the source square; max zoom 4 quarters it', () => {
  const st = { z: 2, cx: 2000, cy: 1500 };
  near(M.cropRect(4000, 3000, V, st).side, 1500);
  near(M.cropRect(4000, 3000, V, { ...st, z: 4 }).side, 750);
});

test('zoom is clamped to 1..4 and bad numbers fall back to 1', () => {
  assert.equal(M.clampZoom(0.2), 1); assert.equal(M.clampZoom(9), 4); assert.equal(M.clampZoom(NaN), 1); assert.equal(M.clampZoom(undefined), 1);
  near(M.clampZoom(2.5), 2.5);
});

test('the crop square can never leave the image (no empty corners)', () => {
  for (const [w, h] of [[4000, 3000], [3000, 4000], [800, 800], [1000, 120 * 4]]) {
    for (const z of [1, 1.5, 2, 4]) for (const [cx, cy] of [[-500, -500], [0, 0], [w / 2, h / 2], [w + 900, h + 900]]) {
      const r = M.cropRect(w, h, V, { z, cx, cy });
      assert.ok(r.sx >= -1e-9 && r.sy >= -1e-9, `${w}x${h} z${z}`);
      assert.ok(r.sx + r.side <= w + 1e-9 && r.sy + r.side <= h + 1e-9, `${w}x${h} z${z}`);
    }
  }
});

test('at zoom 1 the long axis can pan but the short axis is pinned', () => {
  const c = M.clampCenter(4000, 3000, V, 1, 0, 0);
  near(c.cx, 1500); near(c.cy, 1500);
  const d = M.clampCenter(4000, 3000, V, 1, 9999, 9999);
  near(d.cx, 2500); near(d.cy, 1500);
});

test('pan: dragging right moves the picture right, i.e. the centre moves left in the image', () => {
  const s = M.scaleFor(4000, 3000, V, 2);
  const st = M.pan(4000, 3000, V, { z: 2, cx: 2000, cy: 1500 }, 26, -13);
  near(st.cx, 2000 - 26 / s); near(st.cy, 1500 + 13 / s);
});

test('pan stops at the image edge', () => {
  const st = M.pan(4000, 3000, V, { z: 2, cx: 2000, cy: 1500 }, 1e6, 1e6);
  const r = M.cropRect(4000, 3000, V, st);
  near(r.sx, 0); near(r.sy, 0);
});

test('zoomAt keeps the point under the focus fixed (when not clamped)', () => {
  const st = { z: 2, cx: 2000, cy: 1500 }, fx = 40, fy = -30;
  const s0 = M.scaleFor(4000, 3000, V, st.z), before = { x: st.cx + fx / s0, y: st.cy + fy / s0 };
  const n = M.zoomAt(4000, 3000, V, st, 3, fx, fy), s1 = M.scaleFor(4000, 3000, V, n.z);
  near(n.cx + fx / s1, before.x, 1e-6); near(n.cy + fy / s1, before.y, 1e-6); near(n.z, 3);
});

test('zooming out to 1 recentres the short axis and keeps the crop inside the image', () => {
  const n = M.zoomAt(4000, 3000, V, { z: 3, cx: 3500, cy: 2600 }, 1, 50, 50);
  near(n.z, 1); near(n.cy, 1500);
  const r = M.cropRect(4000, 3000, V, n); assert.ok(r.sx >= 0 && r.sx + r.side <= 4000);
});

test('square and small images work', () => {
  const r = M.cropRect(300, 300, V, M.initial(300, 300)); near(r.side, 300); near(r.sx, 0);
  const z = M.zoomAt(300, 300, V, M.initial(300, 300), 2); near(M.cropRect(300, 300, V, z).side, 150);
});

test('output size: at most 512, never upscales, never below 64', () => {
  assert.equal(M.outputSize(3000), 512); assert.equal(M.outputSize(512), 512); assert.equal(M.outputSize(300.9), 300);
  assert.equal(M.outputSize(10), 64); assert.equal(M.outputSize(NaN), 512);
});

test('placement maps the centre point to the viewport centre', () => {
  const st = { z: 2.5, cx: 1800, cy: 1400 }, p = M.placement(4000, 3000, V, st);
  near(st.cx * p.scale + p.tx, V / 2); near(st.cy * p.scale + p.ty, V / 2);
});

test('slider <-> zoom mapping is monotonic and round-trips', () => {
  assert.equal(M.zoomToSlider(1), 0); assert.equal(M.zoomToSlider(4), 100); near(M.sliderToZoom(0), 1); near(M.sliderToZoom(100), 4);
  let prev = 0; for (let v = 0; v <= 100; v += 5) { const z = M.sliderToZoom(v); assert.ok(z >= prev); prev = z; assert.equal(M.zoomToSlider(z), v); }
  near(M.sliderToZoom(-5), 1); near(M.sliderToZoom(500), 4); near(M.sliderToZoom('abc'), 1);
});

test('pinch: spreading fingers zooms in, pinching zooms out, clamped, zero distance ignored', () => {
  near(M.pinchZoom(1.5, 100, 200), 3); near(M.pinchZoom(2, 100, 50), 1); near(M.pinchZoom(2, 100, 1000), 4); near(M.pinchZoom(2, 0, 50), 2); near(M.pinchZoom(2, 100, 0), 2);
});

test('encoding ladder drops quality first, then size, then gives up', () => {
  let a: any = { px: 512, q: 0.86 }; const seen: string[] = [];
  for (let i = 0; i < 40 && a; i++) { seen.push(`${a.px}@${a.q}`); a = M.nextAttempt(a.px, a.q); }
  assert.equal(a, null);
  assert.ok(seen.length > 3 && seen.length < 40);
  assert.equal(seen[1], '512@0.76');
  assert.ok(seen.some((s) => /^410@/.test(s)));
});
