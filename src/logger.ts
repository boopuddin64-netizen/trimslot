import { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { config } from './config';

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SENSITIVE = /pass|secret|token|authorization|cookie|signature|api[-_]?key|sk_(live|test)/i;

/** Recursively redact sensitive keys / secret-looking strings from a log payload. */
export function redact(v: unknown, depth = 0): unknown {
  if (v == null || depth > 4) return v;
  if (typeof v === 'string') return v.replace(/sk_(live|test)_[A-Za-z0-9]+/g, 'sk_$1_[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]').slice(0, 500);
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(val, depth + 1);
    return out;
  }
  return v;
}

function emit(level: string, msg: string, fields: Record<string, unknown> = {}) {
  if ((LEVELS[level] ?? 20) < (LEVELS[config.logLevel] ?? 20)) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact(fields) as object) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}
export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
};

/** One JSON line per request: method, path WITHOUT query string, status, latency, user id. Never headers, cookies or bodies. */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const rid = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64).replace(/[^\w.-]/g, '') || crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', rid);
  (req as any).rid = rid;
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path === '/healthz') return;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const lvl = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    emit(lvl, 'request', { rid, method: req.method, path: req.originalUrl.split('?')[0].slice(0, 200), status: res.statusCode, ms: Math.round(ms * 10) / 10, ip: req.ip, uid: req.user?.id ?? null });
  });
  next();
}
