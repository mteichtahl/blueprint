/**
 * The app's public endpoints (/public/*: newsletter sign-up, recovery codes).
 * They sit behind CloudFront's origin access control for Lambda, which signs
 * each request; for a body, CloudFront needs its SHA-256 in
 * `x-amz-content-sha256`, so the browser sends it.
 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function postPublic<T = { ok: boolean }>(path: string, body: unknown): Promise<T> {
  const text = JSON.stringify(body);
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-amz-content-sha256': await sha256Hex(text) },
    body: text,
  });
  const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      typeof out.detail === 'string' ? out.detail : 'Something went wrong. Try again in a minute.',
    );
  }
  return out as T;
}
