import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEmail } from '../src/emailTemplate';

test('renders the code in both text and HTML', () => {
  const { text, html } = renderEmail({ eyebrow: 'X', title: 'T', intro: 'I', code: '123456', expiry: 'Expires soon.', note: 'N' });
  assert.match(text, /123456/);
  assert.match(html, />123456</);
  assert.match(html, /<!doctype html>/);
});

test('escapes values so user-supplied text cannot inject markup', () => {
  const { html } = renderEmail({ eyebrow: 'E', title: '<img src=x onerror=alert(1)>', intro: '"quoted" & <b>', note: "'n'" });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;quoted&quot; &amp; &lt;b&gt;/);
  assert.match(html, /&#39;n&#39;/);
});

test('omits the code block when there is no code', () => {
  const { html } = renderEmail({ eyebrow: 'E', title: 'T', intro: 'I', note: 'N' });
  assert.doesNotMatch(html, /letter-spacing:9px/);
});
