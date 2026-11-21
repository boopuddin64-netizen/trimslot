/**
 * Server-side Supabase access-token verification foundation.
 *
 * This is intentionally not wired into request authentication yet. It asks
 * Supabase Auth to validate the bearer token, rather than decoding JWT claims
 * locally or trusting user-editable metadata. The returned UUID is identity
 * only; application roles must still come from public.users.
 */
export interface SupabaseAuthIdentity {
  id: string;
}

export interface SupabaseAuthVerifierOptions {
  url: string;
  publishableKey: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function authUserUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('SUPABASE_URL must be a valid URL.');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('SUPABASE_URL must use HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('SUPABASE_URL must not contain credentials, query parameters or a fragment.');
  }
  return new URL('/auth/v1/user', url).toString();
}

/**
 * Returns the verified Auth UUID, null for a rejected token.
 * Network/server failures throw so callers can fail closed without confusing
 * an Auth outage with an anonymous request.
 */
export async function verifySupabaseAccessToken(
  token: string,
  options: SupabaseAuthVerifierOptions,
): Promise<SupabaseAuthIdentity | null> {
  if (!token || token.length > 16_384 || /\s/.test(token)) return null;
  if (!options.url || !options.publishableKey) {
    throw new Error('Supabase Auth verification is not configured.');
  }

  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const response = await fetcher(authUserUrl(options.url), {
      method: 'GET',
      headers: {
        apikey: options.publishableKey,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error(`Supabase Auth verification failed with HTTP ${response.status}.`);

    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('id' in body) || typeof body.id !== 'string' || !UUID.test(body.id)) {
      throw new Error('Supabase Auth returned an invalid user identity response.');
    }
    return { id: body.id };
  } finally {
    clearTimeout(timeout);
  }
}
