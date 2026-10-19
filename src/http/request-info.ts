/**
 * Connection-level request facts (peer address) shared by the Host check
 * and the device-flow rate limiters.
 */

/** Minimal structural view of a request context (any Hono Context fits). */
interface HasEnv {
  env: unknown;
}

/** Best-effort remote address of the request (never trusts XFF). */
export function remoteAddressOf(c: HasEnv): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

/**
 * Whether a socket address is loopback. Covers the IPv4 127/8 range,
 * ::1 and IPv4-mapped forms like ::ffff:127.0.0.1.
 */
export function isLoopbackAddress(address: string): boolean {
  return (
    address.startsWith('127.') ||
    address === '::1' ||
    address === '[::1]' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('::ffff:127.')
  );
}

/**
 * Whether the request originates from this machine. Requests without
 * socket information fail CLOSED: the check exists to guard
 * remotely-bound deployments, and an adapter that does not provide the
 * peer address must not silently re-open the local-Host bypass. Every
 * real deployment serves through @hono/node-server, which always sets
 * env.incoming.socket.remoteAddress.
 */
export function isLocalConnection(c: HasEnv): boolean {
  return isLoopbackAddress(remoteAddressOf(c));
}
