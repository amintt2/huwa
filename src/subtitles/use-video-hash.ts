// The playing file's OpenSubtitles hash (./hash), computed once per URL a few seconds after
// playback is asked for, so the two range reads never compete with the start of the video.
import { useEffect, useState } from 'react';

import { fetchVideoHash } from './hash';

const DELAY_MS = 4000;
const memo = new Map<string, Promise<{ videoHash: string; videoSize: number } | null>>();

export function useVideoHash(url: string | undefined, headers?: Record<string, string>, sizeHint?: number) {
  const [res, setRes] = useState<{ url: string; value: { videoHash: string; videoSize: number } | null } | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    const t = setTimeout(() => {
      let p = memo.get(url);
      if (!p) {
        p = fetchVideoHash(url, headers, sizeHint);
        memo.set(url, p);
      }
      void p.then((value) => alive && setRes({ url, value }));
    }, DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // Headers / size only matter for the first read of a URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return url && res?.url === url ? res.value : null;
}
