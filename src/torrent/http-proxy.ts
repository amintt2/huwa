// Binding of the HTTP read-ahead proxy (native/huwa-torrent-core/src/http_proxy.rs) for the player
// (src/components/player/engines/http-proxy.ts). Goes through the torrent module's generic `call`
// but never starts the torrent engine: the proxy has its own runtime and loopback listener.
//
// iOS only for now: on Android the Rust TLS verifier (rustls-platform-verifier) needs a JNI init
// that is not wired, HTTPS links would fail there.
import { Platform } from 'react-native';

import { setHttpProxy, type HttpProxyPort, type ProxyHandle, type ProxyPrefetch, type ProxyStatus } from '@/components/player/engines/http-proxy';
import { httpProxyBudget } from '@/settings/network-budget';
import { currentNetClass } from '@/settings/net-path';
import { getSettings } from '@/settings/settings';

import Native from '../../modules/huwa-torrent';

type Envelope<T> = { ok: T } | { error: string };

/** The bridge answers in a few ms; past this the source plays directly. */
const OPEN_TIMEOUT_MS = 1500;

async function call<T>(method: string, args: object): Promise<T> {
  if (!Native) throw new Error('module absent');
  const env = JSON.parse(await Native.call(method, JSON.stringify(args))) as Envelope<T>;
  if ('error' in env) throw new Error(env.error);
  return env.ok;
}

function linked(): boolean {
  try {
    return !!Native && Native.isAvailable();
  } catch {
    return false;
  }
}

/** `httpOpen` / `httpPrefetch` arguments: the caller's hints plus the budget of this network. */
function prefetchArgs(p: ProxyPrefetch) {
  const b = httpProxyBudget(currentNetClass());
  return {
    startAt: p.startAt && p.startAt > 1 ? p.startAt : undefined,
    duration: p.duration && isFinite(p.duration) && p.duration > 0 ? p.duration : undefined,
    size: p.size && p.size > 0 ? Math.round(p.size) : undefined,
    container: p.container && p.container !== 'unknown' ? p.container : undefined,
    readAhead: b.readAhead,
    target: b.target,
  };
}

type OpenResult = { id?: number; url?: string; reused: boolean; fallback?: string };

function handle(id: number, url: string): ProxyHandle {
  let released = false;
  return {
    id,
    url,
    prefetch(p) {
      if (!released) void call('httpPrefetch', { id, ...prefetchArgs(p) }).catch(() => {});
    },
    status: () =>
      released
        ? Promise.resolve(null)
        : Promise.race([call<ProxyStatus>('httpStatus', { id }).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 400))]),
    release() {
      if (released) return;
      released = true;
      void call('httpRelease', { id }).catch(() => {});
    },
  };
}

const port: HttpProxyPort = {
  enabled: () => Platform.OS === 'ios' && getSettings().httpProxy && linked(),
  async open(url, headers, prefetch) {
    const args = { url, headers: headers ?? {}, prefetch: prefetch ? prefetchArgs(prefetch) : undefined };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), OPEN_TIMEOUT_MS)));
    const opening = call<OpenResult>('httpOpen', args).catch(() => null);
    const res = await Promise.race([opening, timeout]);
    clearTimeout(timer);
    if (!res) {
      // Too slow: a session opened afterwards must not keep downloading.
      void opening.then((late) => late?.id != null && call('httpRelease', { id: late.id }).catch(() => {}));
      return null;
    }
    return res.id != null && res.url ? handle(res.id, res.url) : null;
  },
};

let registered = false;
/** Called once at startup (src/app/_layout.tsx). */
export function registerHttpProxy() {
  if (registered) return;
  registered = true;
  setHttpProxy(port);
}
