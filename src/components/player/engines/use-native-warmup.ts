// For the next-episode prefetch: only warm up a hidden native player when the native engine will
// really play the source. An MKV/WebM warmed with AVPlayer would download data for nothing (and fail);
// the probe done here is cached, so the next screen picks its engine instantly.
import { useEffect, useState } from 'react';

import { deviceCaps } from './hybrid-player';
import { decideEngine } from './policy';
import { getEnginePref } from './prefs';
import { cachedProbe, probeSource } from './probe';

export function useNativeWarmup(uri: string, headers?: Record<string, string>): boolean {
  const caps = deviceCaps();
  const pref = getEnginePref();
  const skipProbe = pref !== 'auto' || !caps.mpvAvailable;
  const [probed, setProbed] = useState(() => (skipProbe ? null : cachedProbe(uri) ?? null));
  const headersKey = JSON.stringify(headers ?? {});
  useEffect(() => {
    if (skipProbe || probed) return;
    let alive = true;
    probeSource(uri, headers).then((p) => alive && setProbed(p));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, headersKey, skipProbe]);
  if (skipProbe) return decideEngine(pref, caps, null).engine === 'native';
  return !!probed && decideEngine(pref, caps, probed).engine === 'native';
}
