/**
 * Extract client IP from request headers.
 * Checks x-forwarded-for (first IP), then x-real-ip, falls back to '127.0.0.1'.
 *
 * NOTE: In local development without a reverse proxy, all requests will share
 * the same IP key ('127.0.0.1'). In production, ensure your reverse proxy
 * sets x-forwarded-for or x-real-ip headers.
 */
export function getClientIp(req: { headers: { get(name: string): string | null } }): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const ip = forwarded.split(',')[0]?.trim();
    if (ip) return ip;
  }
  return req.headers.get('x-real-ip') ?? '127.0.0.1';
}
