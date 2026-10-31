/** The built local UI never receives the bearer; only browser-enforced same-origin fetches get it internally. */
export function createBrowserFetch(handler: (request: Request) => Response | Promise<Response>, port: number, token: string) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") && hosts.has(url.host) && url.protocol === "http:"
      && request.headers.get("sec-fetch-site") === "same-origin"
      && (!request.headers.get("origin") || request.headers.get("origin") === url.origin)) {
      const headers = new Headers(request.headers); headers.set("authorization", `Bearer ${token}`);
      return handler(new Request(request, { headers }));
    }
    return handler(request);
  };
}
