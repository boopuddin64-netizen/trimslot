import test from 'node:test';
import assert from 'node:assert/strict';
import { config, MOCK_SECRET } from '../src/config';
import { fixedDevCode } from '../src/emailOtp';

/** Runs fn with the given env vars set (undefined = unset), then restores the environment exactly. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved = { ...process.env };
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fn();
  } finally { process.env = saved; }
}
const noKey = { PAYSTACK_SECRET_KEY: undefined, RESEND_API_KEY: undefined, ALLOW_MOCK_PAYMENTS: undefined };

test('mock payments are blocked for an unset NODE_ENV (the public-host case)', () => {
  withEnv({ ...noKey, NODE_ENV: undefined }, () => {
    assert.equal(config.mockMode, false);
    assert.notEqual(config.webhookSecret, MOCK_SECRET);
    assert.equal(fixedDevCode(), false);
  });
});

test('mock payments are blocked for an unknown environment such as staging', () => {
  withEnv({ ...noKey, NODE_ENV: 'staging' }, () => {
    assert.equal(config.mockMode, false);
    assert.notEqual(config.webhookSecret, MOCK_SECRET);
    assert.equal(fixedDevCode(), false);
  });
});

test('mock payments and fixed codes are blocked in production even with an opt-in flag', () => {
  withEnv({ ...noKey, NODE_ENV: 'production', ALLOW_MOCK_PAYMENTS: '1' }, () => {
    assert.equal(config.mockMode, false);
    assert.equal(fixedDevCode(), false);
  });
});

test('mock payments are blocked when a Paystack key is set, even in development', () => {
  withEnv({ NODE_ENV: 'development', PAYSTACK_SECRET_KEY: 'sk_test_abc', RESEND_API_KEY: undefined, ALLOW_MOCK_PAYMENTS: undefined }, () => {
    assert.equal(config.mockMode, false);
  });
});

test('local development keeps mock payments and fixed codes (zero-setup workflow)', () => {
  withEnv({ ...noKey, NODE_ENV: 'development' }, () => {
    assert.equal(config.mockMode, true);
    assert.equal(config.webhookSecret, MOCK_SECRET);
    assert.equal(fixedDevCode(), true);
  });
});

test('test environment keeps mock payments and fixed codes', () => {
  withEnv({ ...noKey, NODE_ENV: 'test' }, () => {
    assert.equal(config.mockMode, true);
    assert.equal(fixedDevCode(), true);
  });
});

test('an explicit ALLOW_MOCK_PAYMENTS=1 opt-in enables mock outside development, but not fixed codes', () => {
  withEnv({ ...noKey, NODE_ENV: 'staging', ALLOW_MOCK_PAYMENTS: '1' }, () => {
    assert.equal(config.mockMode, true);
    assert.equal(fixedDevCode(), false);
  });
});

test('a configured email provider disables the fixed reset code even locally', () => {
  withEnv({ ...noKey, NODE_ENV: 'development', RESEND_API_KEY: 're_test_abc' }, () => {
    assert.equal(fixedDevCode(), false);
  });
});
