// Live translation of an embedded subtitle track (mpv engine). Embedded tracks are made for the
// video, so they are always in sync, but their text is inside the video file: mpv gives each line
// as it is shown (`onSubText`, track selected but hidden) and the line is translated on the device
// right away. Each event comes as a full ASS line with the track's header (@/subtitles/live): spoken
// lines are drawn as subtitles, signs (on-screen text) as small notes where they are. Only
// translated lines are drawn (the original never flashes first); translating one line takes a
// fraction of a second. Lines and translations are kept, so seeking back shows them at once, and
// translations are cached on disk per episode and track.
import { useEffect, useMemo, useRef, useState } from 'react';

import { assLines, liveDoc, plainLine, translatedLive } from '@/subtitles/live';
import { bcp47, eventSegments, translationCacheKey } from '@/subtitles/translate';

import type { MpvSubTextEvent } from '../../../../modules/huwa-mpv';
import { HuwaTranslate } from '../../../../modules/huwa-translate';
import { readCache, writeCache } from './translation';

export type LiveTextSource = { subscribe: (l: (line: MpvSubTextEvent) => void) => () => void };

/** Length given to a line mpv reports without an end. */
const DEFAULT_LEN = 4;
/** Segments per native call: the newest first, so the line on screen is never kept waiting. */
const BATCH = 8;
/** Failed calls in a row before giving up (one failure only skips its lines). */
const MAX_FAILURES = 4;

/** `signs`: on-screen text translated too (Réglages → Sous-titres). */
export function useLiveTranslation(source: LiveTextSource | null, id: string | undefined, from: string | undefined, to: string | undefined, active: boolean, signs = true) {
  const key = active && source && id && from && to && HuwaTranslate ? translationCacheKey(`live:${id}`, from, to) : '';
  const [lines, setLines] = useState<{ key: string; header: string; list: string[] }>({ key: '', header: '', list: [] });
  const [dict, setDict] = useState<{ key: string; map: Map<string, string>; ready: boolean }>({ key: '', map: new Map(), ready: false });
  const [error, setError] = useState('');
  const busy = useRef('');
  // Lines the translator failed on (not retried, not drawn), failed calls in a row, and one line
  // per call after a failed batch (finds the line at fault) until the backlog is empty.
  const failed = useRef<{ key: string; set: Set<string>; row: number; solo: boolean }>({ key: '', set: new Set(), row: 0, solo: false });
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
      let add: string[];
      if (line.ass) add = assLines(line.ass);
      else {
        // Older build: the plain text of everything on screen, signs included.
        const start = line.start >= 0 ? line.start : line.time;
        const text = line.text.replace(/\r/g, '').trim();
        if (!(start >= 0) || !text) return;
        add = [plainLine(start, line.end > start ? line.end : start + DEFAULT_LEN, text)];
      }
      setLines((c) => {
        const cur = c.key === key ? c : { key, header: '', list: [] };
        const seen = new Set(cur.list);
        const fresh = add.filter((l) => !seen.has(l));
        const header = line.header || cur.header;
        if (!fresh.length && header === cur.header) return cur === c ? c : cur;
        return { key, header, list: fresh.length ? [...cur.list, ...fresh] : cur.list };
      });
    });
  }, [key, source]);

  const cur0 = lines.key === key ? lines : null;
  const live = useMemo(() => (cur0 ? liveDoc(cur0.header, cur0.list, signs) : null), [cur0, signs]);
  const src = live?.doc ?? null;
  const cur = dict.key === key && dict.ready ? dict : null;

  useEffect(() => {
    if (!key || !src || !cur || busy.current === key || error === key || !HuwaTranslate) return;
    if (failed.current.key !== key) failed.current = { key, set: new Set(), row: 0, solo: false };
    const fail = failed.current;
    const missing = [...new Set(src.events.flatMap((e) => eventSegments(e) ?? []))].filter((s) => !cur.map.has(s) && !fail.set.has(s));
    if (!missing.length) {
      fail.solo = false;
      return;
    }
    const segs = missing.slice(fail.solo ? -1 : -BATCH);
    busy.current = key;
    HuwaTranslate.translateBatch(segs, bcp47(from!), bcp47(to!))
      .then((out) => {
        fail.row = 0;
        setDict((d) => {
          if (d.key !== key) return d;
          const map = new Map(d.map);
          segs.forEach((s, i) => map.set(s, (out[i] ?? '').trim() || s));
          writeCache(key, map);
          return { key, map, ready: true };
        });
      })
      .catch(() => {
        // A bad line is skipped; the next lines are still translated.
        if (segs.length > 1) fail.solo = true;
        else fail.set.add(segs[0]);
        if (++fail.row >= MAX_FAILURES) setError(key);
      })
      .finally(() => {
        if (busy.current === key) busy.current = '';
        setTick((t) => t + 1);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, src, cur, error, tick]);

  const doc = useMemo(() => (key && live && cur ? translatedLive(live, cur.map) : null), [key, live, cur]);
  return {
    doc,
    started: !!doc && doc.events.length > 0,
    error: error && error === key ? 'Traduction des sous-titres impossible sur cet appareil.' : undefined,
  };
}
