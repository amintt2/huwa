// Gateway (WebSocket) the browser P2P node connects to. No other import: loaded by the instance
// config (src/web/config.ts) before the node exists.

/**
 * Gateway from /huwa-config.json (`p2p.gateway`, e.g. "/p2p", relative to `server.url` or the
 * page). Call before the first getP2P(). Accepts http(s), ws(s) or a path.
 */
export function setWebGateway(gateway: string | null | undefined, base: string = typeof location !== 'undefined' ? location.href : 'http://localhost/') {
  if (!gateway) return;
  const u = new URL(gateway, base);
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  (globalThis as { __HUWA_GATEWAY__?: string }).__HUWA_GATEWAY__ = u.href.replace(/\/+$/, '');
}

export function defaultGateway(): string {
  const override = (globalThis as { __HUWA_GATEWAY__?: string }).__HUWA_GATEWAY__ ?? process.env.EXPO_PUBLIC_HUWA_GATEWAY;
  if (override) return override;
  return typeof location !== 'undefined' ? location.origin.replace(/^http/, 'ws') + '/p2p' : '';
}
