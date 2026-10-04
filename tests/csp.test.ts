import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { bootApp } from './httpHelpers';

const parse = (v: string) => Object.fromEntries(v.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...src] = d.split(/\s+/); return [k, src.sort().join(' ')]; }));

test('the Content-Security-Policy that Vercel sends (vercel.json) allows the same sources as the app\'s own, and lets blob: pictures show (profile photo cropper)', async () => {
  const vj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const vercel = parse(vj.headers.flatMap((h: any) => h.headers).find((h: any) => h.key === 'Content-Security-Policy').value);
  const c = await bootApp();
  try {
    const r = await fetch(c.base + '/');
    const app = parse(r.headers.get('content-security-policy')!);
    delete (app as any)['upgrade-insecure-requests'];
    assert.deepEqual(vercel, app, 'production and the app must not drift apart');
    assert.match(vercel['img-src'], /\bblob:/);
  } finally { c.close(); }
});

test('the photo reader never depends on a blob: picture: canvas-based, tries bitmap, blob, data, small bitmap; the pickers use it', () => {
  const pub = path.join(__dirname, '..', 'public');
  const dec = fs.readFileSync(path.join(pub, 'imgdecode.js'), 'utf8');
  for (const w of ['createImageBitmap', "imageOrientation: 'from-image'", 'readAsDataURL', 'resizeWidth', 'maxSide']) assert.ok(dec.includes(w), w);
  for (const f of ['avatar-crop.js', 'account.js', 'app.js']) assert.match(fs.readFileSync(path.join(pub, f), 'utf8'), /ImgDecode/, f + ' uses the shared reader');
  assert.doesNotMatch(fs.readFileSync(path.join(pub, 'avatar-crop.js'), 'utf8'), /createObjectURL/);
  assert.match(fs.readFileSync(path.join(pub, 'index.html'), 'utf8'), /imgdecode\.js[\s\S]*app\.js/, 'loaded before app.js');
  assert.match(fs.readFileSync(path.join(pub, 'account.js'), 'utf8'), /id="av-file" type="file" accept="image\/\*"/);
});
