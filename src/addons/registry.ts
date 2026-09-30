// Installed addons (persisted) + stream aggregation across all of them.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  type AddonStream,
  fetchManifest,
  fetchStreams,
  type Manifest,
  normalizeAddonUrl,
  supportsStream,
} from './protocol';

export type InstalledAddon = { baseUrl: string; manifest: Manifest; enabled: boolean };

const KEY = 'huwa/addons/v1';
export const BUILTIN_ID = 'huwa.demo';

// Built-in demo source: open Blender / Apple test streams, so the player works with zero setup.
const DEMO_STREAMS = [
  { name: 'HLS 720p', title: 'Flux de test (Mux)', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
  { name: 'MP4 480p', title: 'Sintel trailer (Blender, CC-BY)', url: 'https://download.blender.org/durian/trailer/sintel_trailer-480p.mp4' },
  { name: 'HLS adaptatif', title: 'Apple bipbop', url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8' },
];

const builtin: InstalledAddon = {
  baseUrl: 'builtin:demo',
  enabled: true,
  manifest: {
    id: BUILTIN_ID,
    name: 'Démo Huwa',
    description: 'Flux de démonstration libres de droits. Installe un addon pour de vrais contenus.',
    resources: ['stream'],
    types: ['series'],
  },
};

let addons: InstalledAddon[] = [builtin];
let hydrated = false;
const listeners = new Set<() => void>();

function commit(next: InstalledAddon[]) {
  addons = next;
  listeners.forEach((l) => l());
  AsyncStorage.setItem(KEY, JSON.stringify(next.filter((a) => a.baseUrl !== builtin.baseUrl || !a.enabled))).catch(() => {});
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useAddons() {
  return useSyncExternalStore(subscribe, () => addons, () => addons);
}

export async function hydrateAddons() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as InstalledAddon[];
    const demo = saved.find((a) => a.baseUrl === builtin.baseUrl);
    addons = [{ ...builtin, enabled: demo ? demo.enabled : true }, ...saved.filter((a) => a.baseUrl !== builtin.baseUrl)];
    listeners.forEach((l) => l());
  } catch {
    // keep defaults
  }
}

export async function installAddon(input: string) {
  const baseUrl = normalizeAddonUrl(input);
  const manifest = await fetchManifest(baseUrl);
  if (addons.some((a) => a.manifest.id === manifest.id)) throw new Error('Addon déjà installé');
  commit([...addons, { baseUrl, manifest, enabled: true }]);
  return manifest;
}

export const removeAddon = (baseUrl: string) => commit(addons.filter((a) => a.baseUrl !== baseUrl || a.baseUrl === builtin.baseUrl));
export const toggleAddon = (baseUrl: string) =>
  commit(addons.map((a) => (a.baseUrl === baseUrl ? { ...a, enabled: !a.enabled } : a)));

/** Stremio-style video id. AniList ids are `al<id>` in our catalog. */
export function videoId(seriesId: string, episode: number) {
  return `anilist:${seriesId.replace(/^al/, '')}:${episode}`;
}

/** Queries every enabled addon in parallel; results appear as each addon answers. */
export function useStreams(seriesId: string, episode: number) {
  const list = useAddons();
  const id = videoId(seriesId, episode);
  const key = `${id}|${list.map((a) => `${a.baseUrl}:${a.enabled}`).join('|')}`;
  const active = list.filter((a) => a.enabled && supportsStream(a.manifest, 'series', id));
  // Results are tagged with the request key, so stale answers are ignored without resetting state in an effect.
  const [res, setRes] = useState<{ key: string; streams: AddonStream[]; done: number; failed: string[] }>({
    key: '', streams: [], done: 0, failed: [],
  });

  useEffect(() => {
    let cancelled = false;
    for (const a of list.filter((x) => x.enabled && supportsStream(x.manifest, 'series', id))) {
      const job =
        a.baseUrl === builtin.baseUrl ? Promise.resolve(DEMO_STREAMS) : fetchStreams(a.baseUrl, 'series', id);
      job
        .then((items) => {
          if (cancelled) return;
          const tagged = items.map((s) => ({ ...s, addonId: a.manifest.id, addonName: a.manifest.name }));
          setRes((p) => {
            const base = p.key === key ? p : { key, streams: [], done: 0, failed: [] };
            return { ...base, streams: [...base.streams, ...tagged], done: base.done + 1 };
          });
        })
        .catch(() => {
          if (cancelled) return;
          setRes((p) => {
            const base = p.key === key ? p : { key, streams: [], done: 0, failed: [] };
            return { ...base, done: base.done + 1, failed: [...base.failed, a.manifest.name] };
          });
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const cur = res.key === key ? res : { streams: [], done: 0, failed: [] as string[] };
  return { streams: cur.streams, pending: active.length - cur.done, failed: cur.failed };
}
