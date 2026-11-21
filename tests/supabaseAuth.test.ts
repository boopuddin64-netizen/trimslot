import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySupabaseAccessToken } from '../src/supabaseAuth';

const UUID = 'b7e3b6c4-23c8-4c3e-9b9e-0a9f2f5e8c11';
const options = {
  url: 'https://example.supabase.co',
  publishableKey: 'sb_publishable_test_key',
};

test('verifies through Supabase Auth and returns only the Auth UUID', async () => {
  let requestedUrl = '';
  let headers: HeadersInit | undefined;
  const identity = await verifySupabaseAccessToken('valid-access-token', {
    ...options,
    fetcher: async (input, init) => {
      requestedUrl = String(input);
      headers = init?.headers;
      return new Response(JSON.stringify({ id: UUID, email: 'ignored@example.test', user_metadata: { role: 'admin' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.deepEqual(identity, { id: UUID });
  assert.equal(requestedUrl, 'https://example.supabase.co/auth/v1/user');
  assert.equal(new Headers(headers).get('apikey'), options.publishableKey);
  assert.equal(new Headers(headers).get('authorization'), 'Bearer valid-access-token');
});

test('treats rejected tokens as unauthenticated', async () => {
  const identity = await verifySupabaseAccessToken('expired-token', {
    ...options,
    fetcher: async () => new Response('{}', { status: 401 }),
  });
  assert.equal(identity, null);
});

test('rejects malformed identities from Auth', async () => {
  await assert.rejects(() => verifySupabaseAccessToken('token', {
    ...options,
    fetcher: async () => new Response(JSON.stringify({ id: 'not-a-uuid' }), { status: 200 }),
  }), /invalid user identity/);
});

test('fails closed on Auth service errors', async () => {
  await assert.rejects(() => verifySupabaseAccessToken('token', {
    ...options,
    fetcher: async () => new Response('{}', { status: 503 }),
  }), /HTTP 503/);
});

test('rejects insecure non-local Supabase URLs', async () => {
  await assert.rejects(() => verifySupabaseAccessToken('token', {
    ...options,
    url: 'http://example.supabase.co',
    fetcher: async () => new Response('{}', { status: 200 }),
  }), /must use HTTPS/);
});

test('does not send malformed or oversized bearer tokens', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response('{}', { status: 401 }); };
  assert.equal(await verifySupabaseAccessToken('bad token', { ...options, fetcher }), null);
  assert.equal(await verifySupabaseAccessToken('x'.repeat(16_385), { ...options, fetcher }), null);
  assert.equal(calls, 0);
});
