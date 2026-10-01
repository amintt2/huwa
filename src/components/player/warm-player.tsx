// Keeps a warm player (./warm-pool.ts) open on `uri` while mounted. Sources that will play with
// mpv are only probed (the probe is cached, so the watch screen picks its engine instantly).
import { useEffect } from 'react';

import { useNativeWarmup } from './engines';
import { warmUp, type WarmMeta } from './warm-pool';

type Props = { uri: string; headers?: Record<string, string>; startAt?: number; meta?: WarmMeta };

export function WarmPlayer(props: Props) {
  return useNativeWarmup(props.uri, props.headers) ? <Warm {...props} /> : null;
}

function Warm({ uri, headers, startAt, meta }: Props) {
  const headersKey = JSON.stringify(headers ?? {});
  useEffect(() => warmUp(uri, headers, { startAt, meta }),
    // Position / metadata only matter when the player is created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uri, headersKey]);
  return null;
}
