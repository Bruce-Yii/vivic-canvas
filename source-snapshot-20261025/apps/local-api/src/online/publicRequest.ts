/**
 * The loopback HTTP listener sits behind TLS termination. Normalize only to
 * the operator's fixed origin, after checking Host; never trust forwarded
 * origin/scheme headers supplied by a client. Origin/Sec-Fetch/Cookie remain
 * untouched for the domain handler's own checks.
 */
export function publicRequest(request: Request, configuredOrigin: string): Request {
  const incoming = new URL(request.url), fixed = new URL(configuredOrigin);
  const host = request.headers.get("host");
  if (incoming.host !== fixed.host || host !== null && host !== fixed.host
    || incoming.username || incoming.password) throw new Error("Unexpected service host.");
  if (incoming.origin === fixed.origin) return request;
  if (fixed.protocol !== "https:" || incoming.protocol !== "http:") throw new Error("Unexpected service scheme.");
  return new Request(`${fixed.origin}${incoming.pathname}${incoming.search}`, request);
}
