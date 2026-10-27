// Live translation of an embedded subtitle track (mpv engine). Embedded tracks are made for the
// video, so they are always in sync, but their text is inside the video file: mpv gives each line
// as it is shown (`onSubText`, track selected but hidden) and the line is translated on the device
// right away. Only translated lines are drawn (the original never flashes first); translating one
// line takes a fraction of a second. Lines and translations are kept, so seeking back shows them
// at once, and translations are cached on disk per episode and track.
import { useEffect, useMemo, useRef, useState } from 'react';

import { addCue, type LiveCue } from '@/subtitles/live';
import { cuesDoc } from '@/subtitles/text';
import { bcp47, eventSegments, translatedOnly, translationCacheKey } from '@/subtitles/translate';

import type { MpvSubTextEvent } from '../../../../modules/huwa-mpv';
import { HuwaTranslate } from '../../../../modules/huwa-translate';
import { readCache, writeCache } from './translation';

export type LiveTextSource = { subscribe: (l: (line: MpvSubTextEvent) => void) => () => void };

/** Length given to a line mpv reports without an end. */
const DEFAULT_LEN = 4;
/** Segments per native call: the newest first, so the line on screen is never kept waiting. */
const BATCH = 8;

export function useLiveTranslation(source: LiveTextSource | null, id: string | undefined, from: string | undefined, to: string | undefined, active: boolean) {
  const key = active && source && id && from && to && HuwaTranslate ? translationCacheKey(`live:${id}`, from, to) : '';
  const [cues, setCues] = useState<{ key: string; list: LiveCue[] }>({ key: '', list: [] });
  const [dict, setDict] = useState<{ key: string; map: Map<string, string>; ready: boolean }>({ key: '', map: new Map(), ready: false });
  const [error, setError] = useState('');
  const busy = useRef('');
  // Bumped when a batch ends: lines that arrived meanwhile are translated next.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    readCache(key).then((map) => alive && setDict({ key, map, ready: true }));
    return () => {
      alive = false;
    };
  }, [key]);

  useEffect(() => {
    if (!key || !source) return;
    return source.subscribe((line) => {
      const start = line.start >= 0 ? line.start : line.time;
      if (!(start >= 0)) return;
      const end = line.end > start ? line.end : start + DEFAULT_LEN;
      const text = line.text.replace(/\r/g, '').trim();
      if (!text) return;
      setCues((c) => {
        const list = c.key === key ? c.list : [];
        const next = addCue(list, { start, end, text });
        return next === list && c.key === key ? c : { key, list: next };
      });
    });
  }, [key, source]);

  const list = cues.key === key ? cues.list : null;
  const src = useMemo(() => (list ? cuesDoc(list) : null), [list]);
  const cur = dict.key === key && dict.ready ? dict : null;

  useEffect(() => {
    if (!key || !src || !cur || busy.current === key || error === key || !HuwaTranslate) return;
    const missing = [...new Set(src.events.flatMap((e) => eventSegments(e) ?? []))].filter((s) => !cur.map.has(s));
    if (!missing.length) return;
    const segs = missing.slice(-BATCH);
    busy.current = key;
    HuwaTranslate.translateBatch(segs, bcp47(from!), bcp47(to!))
      .then((out) => {
        setDict((d) => {
          if (d.key !== key) return d;
          const map = new Map(d.map);
          segs.forEach((s, i) => map.set(s, (out[i] ?? '').trim() || s));
          writeCache(key, map);
          return { key, map, ready: true };
        });
      })
      .catch(() => setError(key))
      .finally(() => {
        if (busy.current === key) busy.current = '';
        setTick((t) => t + 1);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, src, cur, error, tick]);

  const doc = useMemo(() => (key && src && cur ? translatedOnly(src, cur.map) : null), [key, src, cur]);
  return {
    doc,
    started: !!doc && doc.events.length > 0,
    error: error && error === key ? 'Traduction des sous-titres impossible sur cet appareil.' : undefined,
  };
}
