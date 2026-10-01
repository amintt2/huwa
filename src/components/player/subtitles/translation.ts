// On-device subtitle translation, runtime side: native translator (modules/huwa-translate, Apple
// Translation framework, iOS 18+), model status per language pair, the one-time download prompt,
// the disk cache, and the hook that translates cues in a window ahead of playback.
// Pure logic (what / when / keys) is in @/subtitles/translate. Nothing leaves the device.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { bcp47, nextSegments, translateDoc, translationCacheKey } from '@/subtitles/translate';
import type { SubtitleDoc } from '@/subtitles/types';

import { HuwaTranslate, type TranslateStatus } from '../../../../modules/huwa-translate';
import { registerRehydrate } from '@/settings/rehydrate';

export type { TranslateStatus };

export const translationSupported = () => !!HuwaTranslate;

// ---------- model status per pair ----------

const pairKey = (from: string, to: string) => `${from}>${to}`;
const statuses = new Map<string, TranslateStatus>();
const asking = new Map<string, Promise<TranslateStatus>>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Model status for a pair (cached for the session; `fresh` asks again). */
export function translateStatus(from: string, to: string, fresh = false): Promise<TranslateStatus> {
  const k = pairKey(from, to);
  if (!HuwaTranslate) return Promise.resolve('unsupported');
  if (!fresh && statuses.has(k)) return Promise.resolve(statuses.get(k)!);
  if (!fresh && asking.has(k)) return asking.get(k)!;
  const p = HuwaTranslate.isAvailable(bcp47(from), bcp47(to))
    .catch((): TranslateStatus => 'unsupported')
    .then((s) => {
      asking.delete(k);
      if (statuses.get(k) !== s) {
        statuses.set(k, s);
        emit();
      }
      return s;
    });
  asking.set(k, p);
  return p;
}

/** Known statuses (re-renders when one changes); unknown pairs are asked in the background. */
export function useTranslateStatuses(pairs: [string, string][]): Record<string, TranslateStatus | undefined> {
  useSyncExternalStore(subscribe, () => version, () => version);
  const key = pairs.map(([a, b]) => pairKey(a, b)).join(',');
  useEffect(() => {
    for (const [a, b] of pairs) void translateStatus(a, b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return Object.fromEntries(pairs.map(([a, b]) => [pairKey(a, b), HuwaTranslate ? statuses.get(pairKey(a, b)) : 'unsupported']));
}
export const statusOf = (map: Record<string, TranslateStatus | undefined>, from: string, to: string) => map[pairKey(from, to)];

// ---------- download prompt (system UI), once per pair ----------

const PROMPTED_KEY = 'huwa/translate/prompted/v1';
let prompted: Set<string> | null = null;
let promptedLoad: Promise<void> | null = null;

function loadPrompted() {
  promptedLoad ??= AsyncStorage.getItem(PROMPTED_KEY)
    .then((raw) => {
      const list = raw ? (JSON.parse(raw) as unknown) : [];
      prompted = new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
    })
    .catch(() => {
      prompted = new Set();
    })
    .finally(emit);
  return promptedLoad;
}

registerRehydrate(() => {
  if (!promptedLoad) return;
  promptedLoad = null;
  prompted = null;
  return loadPrompted();
});

/** Already offered the model download for this pair (undefined while loading). */
export function usePrompted(from?: string, to?: string): boolean | undefined {
  useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => {
    void loadPrompted();
  }, []);
  if (!from || !to) return undefined;
  return prompted ? prompted.has(pairKey(from, to)) : undefined;
}

/** Shows the system download sheet for a pair's model; resolves with the new status. */
export async function prepareModel(from: string, to: string): Promise<TranslateStatus> {
  if (!HuwaTranslate) return 'unsupported';
  await loadPrompted();
  prompted!.add(pairKey(from, to));
  AsyncStorage.setItem(PROMPTED_KEY, JSON.stringify([...prompted!])).catch(() => {});
  emit();
  try {
    await HuwaTranslate.prepare(bcp47(from), bcp47(to));
  } catch {
    // Declined or failed: the status says what we have.
  }
  return translateStatus(from, to, true);
}

// ---------- disk cache: source segment → translation, per (subtitle URL, from, to) ----------

const cacheDir = () => new Directory(Paths.cache, 'subtitles-translated');

async function readCache(key: string): Promise<Map<string, string>> {
  try {
    const f = new File(cacheDir(), `${key}.json`);
    if (!f.exists) return new Map();
    const v = JSON.parse(await f.text()) as { items?: Record<string, string> };
    return new Map(Object.entries(v.items ?? {}).filter(([, t]) => typeof t === 'string'));
  } catch {
    return new Map();
  }
}

const writes = new Map<string, ReturnType<typeof setTimeout>>();
function writeCache(key: string, map: Map<string, string>) {
  clearTimeout(writes.get(key));
  writes.set(
    key,
    setTimeout(() => {
      writes.delete(key);
      try {
        const dir = cacheDir();
        dir.create({ intermediates: true, idempotent: true });
        new File(dir, `${key}.json`).write(JSON.stringify({ v: 1, at: Date.now(), items: Object.fromEntries(map) }));
      } catch {
        // cache only
      }
    }, 1500),
  );
}

// ---------- translating ahead of playback ----------

type Dict = { key: string; map: Map<string, string>; ready: boolean };

/**
 * `src` translated `from` → `to`, a window at a time (DEFAULT_WINDOW: 4 min ahead of `time`);
 * cues not translated yet show the original. Inactive (no key) → null doc.
 */
export function useTranslatedDoc(src: SubtitleDoc | null, url: string | undefined, from: string | undefined, to: string | undefined, time: number, active: boolean) {
  const key = active && url && from && to && HuwaTranslate ? translationCacheKey(url, from, to) : '';
  const [dict, setDict] = useState<Dict>({ key: '', map: new Map(), ready: false });
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const busy = useRef('');

  useEffect(() => {
    if (!key) return;
    let alive = true;
    readCache(key).then((map) => alive && setDict({ key, map, ready: true }));
    return () => {
      alive = false;
    };
  }, [key]);

  // Re-check the window every 5 s of playback (and after each batch, as `dict` changes).
  const bucket = Math.floor(time / 5);
  const cur = dict.key === key && dict.ready ? dict : null;
  const failed = !!error && error.key === key;
  useEffect(() => {
    if (!key || !src || !cur || failed || busy.current === key || !HuwaTranslate) return;
    const segs = nextSegments(src.events, time, (s) => cur.map.has(s));
    if (!segs.length) return;
    busy.current = key;
    HuwaTranslate.translateBatch(segs, bcp47(from!), bcp47(to!))
      .then((out) => {
        const map = new Map(cur.map);
        segs.forEach((s, i) => map.set(s, (out[i] ?? '').trim() || s));
        writeCache(key, map);
        setDict((d) => (d.key === key ? { key, map, ready: true } : d));
      })
      .catch((e: unknown) => setError({ key, message: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        if (busy.current === key) busy.current = '';
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, src, cur, bucket, failed]);

  const doc = useMemo(() => (key && src && cur ? translateDoc(src, cur.map) : null), [key, src, cur]);
  return {
    doc,
    /** Something was translated already (the badge waits for it). */
    started: !!cur && cur.map.size > 0,
    error: failed ? 'Traduction des sous-titres impossible sur cet appareil.' : undefined,
  };
}
