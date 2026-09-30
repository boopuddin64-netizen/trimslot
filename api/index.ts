/**
 * Vercel serverless entrypoint. vercel.json rewrites /api/* and /healthz to this single function, which wraps the
 * same Express app used everywhere else. The static frontend in /public is served by Vercel's CDN.
 *
 * Cold start: config is validated (production refuses unsafe config -> 500 with a clear log line instead of insecure behaviour),
 * the small pg pool is created lazily, and (optionally) migrations are NOT run here - run `npm run migrate` from your machine/CI.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { assertProductionConfig } from '../src/config';
import { createApp } from '../src/app';
import { getDb } from '../src/db';
import { initClockFromEnv } from '../src/time';
import { logger } from '../src/logger';

let app: ReturnType<typeof createApp> | undefined;
let bootError: Error | undefined;

function boot() {
  if (app || bootError) return;
  try {
    const { warnings } = assertProductionConfig();
    warnings.forEach((w) => logger.warn('config_warning', { warning: w }));
    initClockFromEnv();
    app = createApp(getDb());
  } catch (e: any) {
    bootError = e;
    logger.error('boot_failed', { err: e.message });
  }
}

/**
 * Body handling on Vercel. Two facts matter:
 *  1. Paystack signs the EXACT bytes of the webhook body, so they must never pass through a JSON parser first.
 *  2. Vercel's Node "helpers" (on unless NODEJS_HELPERS=0) read the whole stream up-front and then REPLAY the bytes through a PassThrough
 *     (req.read / req.on('data'|'end') are re-pointed at it) while req.readable is already false - which makes body-parser fail with
 *     "stream is not readable" in some setups.
 * So we read the body ourselves with plain 'data'/'end' events (works with AND without helpers), keep the bytes on req.rawBody, mark the
 * request as already parsed (req._body) so body-parser stays out of the way, and let src/app.ts turn rawBody into req.body for JSON routes.
 */
const MAX_BODY = 400 * 1024; // shop photo uploads (<= 300 KB, checked in the route); JSON bodies are capped at 50 KB in src/app.ts
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, over = false;
    req.on('data', (c: Buffer | string) => {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += b.length;
      if (size > MAX_BODY) over = true; else chunks.push(b);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function preserveRawBody(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const raw = await readBody(req);
  if (raw === null) {
    res.statusCode = 413; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } }));
    return false;
  }
  Object.defineProperty(req, 'body', { value: raw, writable: true, configurable: true, enumerable: true });
  (req as any).rawBody = raw;
  (req as any)._body = true;
  return true;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  boot();
  if (!app) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'MISCONFIGURED', message: 'Server is not configured correctly. See the deployment logs.' } }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !(await preserveRawBody(req, res))) return;
  return (app as any)(req, res);
}
