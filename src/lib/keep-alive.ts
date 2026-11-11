import type { Server } from 'node:http';

/**
 * Keep idle connections open longer than the proxy in front of the API (the Next.js / Vercel
 * rewrite) keeps them, so the proxy never reuses a socket this server has just closed — that race
 * shows up as ECONNRESET / "socket hang up" on random requests. Node's default is 5 s.
 */
export function keepAliveBehindProxy(server: Server): Server {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000; // must be longer than keepAliveTimeout
  return server;
}
