// Native torrent engine (PLAN 7c): librqbit session + loopback Range server in Rust, exposed by
// the local Expo module `modules/huwa-torrent`. Everything degrades to "unavailable" when the
// Rust library is not linked (build without HUWA_TORRENT=1), in Expo Go and on web.
//
// Plugging into the stream resolver (owned by the addons/debrid agent, NOT modified here):
//
//   import { resolveTorrent } from '@/torrent';
//   // 1. native engine if linked, enabled by the user, legal notice accepted, network allowed
//   const native = await resolveTorrent(stream);      // { url, id } | null
//   if (native) return { uri: native.url };
//   // 2. otherwise debrid (TorBox / AllDebrid / Premiumize / Real-Debrid)
//   return resolveViaDebrid(stream);
//
// The URL is a plain http://127.0.0.1:<port>/<infoHash>/<fileIdx> that expo-video plays directly
// (Range requests → 206). Progress/peers/speed come through `useTorrentList()` (native events).
import { useEffect, useState } from 'react';
import { Alert } from 'react-native';

import Native from '../../modules/huwa-torrent';
import { getTorrentSettings, hydrateTorrentSettings, setTorrentSettings } from './settings';
import type { EngineStats, ProbeInput, ProbeStatus, StartStreamInput, StreamHandle, TorrentStatus } from './types';

export * from './settings';
export * from './types';

type Envelope<T> = { ok: T } | { error: string };

function unwrap<T>(json: string): T {
  const env = JSON.parse(json) as Envelope<T>;
  if ('error' in env) throw new Error(env.error);
  return env.ok;
}

/** True only when the native module is linked AND the Rust library is present. */
export function isAvailable(): boolean {
  try {
    return !!Native && Native.isAvailable();
  } catch {
    return false;
  }
}

export const nativeVersion = () => Native?.nativeVersion ?? 'unlinked';

let engineReady: Promise<number> | undefined;

/** Starts the engine once (idempotent). Resolves with the loopback port. */
export function ensureEngine(): Promise<number> {
  if (!engineReady) {
    engineReady = (async () => {
      if (!Native || !Native.isAvailable()) throw new Error('Moteur torrent indisponible dans ce build');
      await hydrateTorrentSettings();
      const s = getTorrentSettings();
      const res = unwrap<{ port: number }>(
        await Native.initialize(
          JSON.stringify({ dataDir: Native.defaultDataDir(), cacheLimitBytes: s.quotaBytes, seeding: false, maxPeers: 60, resolveTimeoutSecs: 90 }),
        ),
      );
      return res.port;
    })();
    engineReady.catch(() => {
      engineReady = undefined;
    });
  }
  return engineReady;
}

async function call<T>(method: string, args: object = {}): Promise<T> {
  if (!Native) throw new Error('Moteur torrent indisponible');
  await ensureEngine();
  return unwrap<T>(await Native.call(method, JSON.stringify(args)));
}

export function startStream(input: StartStreamInput): Promise<StreamHandle> {
  return call<StreamHandle>('startStream', input);
}
export const status = (id: string) => call<TorrentStatus>('status', { id });
export const list = () => call<TorrentStatus[]>('list');
export const stats = () => call<EngineStats>('stats');
export const pause = (id: string) => call<boolean>('pause', { id });
export const resume = (id: string) => call<boolean>('resume', { id });
/** Removes the torrent and its files. */
export const stop = (id: string) => call<boolean>('remove', { id });
export const clearCache = () => call<{ freedBytes: number }>('clearCache');
export const setQuota = async (quotaBytes: number) => {
  setTorrentSettings({ quotaBytes });
  if (isAvailable()) {
    await call('setConfig', { cacheLimitBytes: quotaBytes });
    await call('enforceQuota');
  }
};

// ---- swarm probes ("course des torrents", see ./peer-race.ts) ----
// Metadata + peers answering a handshake, never a piece; the call returns at once and the probe
// runs in the engine (bounded: 6 at a time, 8 s by default). A stream started afterwards on a
// probed torrent reuses its metadata and peers.

export const probeStart = (input: ProbeInput) => call<ProbeStatus>('probeStart', input);
/** Statuses of the given probes (unknown / expired ids are left out). */
export const probeStatuses = (ids: number[]) => call<ProbeStatus[]>('probeStatus', { ids });
export const probeCancel = (ids: number[]) => (ids.length ? call<boolean>('probeCancel', { ids }) : Promise.resolve(true));

/**
 * May the engine probe swarms right now? Same conditions as playing through it (linked, switched
 * on, legal notice already accepted — never asked from here —, not on cellular in "Wi-Fi only").
 */
export function canProbeTorrents(): boolean {
  if (!isAvailable()) return false;
  const s = getTorrentSettings();
  if (!s.enabled || !s.legalAccepted) return false;
  try {
    if (s.wifiOnly && Native?.isOnCellular()) return false;
  } catch {
    return false;
  }
  return true;
}

/** Subscribes to the native 1 Hz status feed. No-op when unavailable. */
export function addStatusListener(cb: (torrents: TorrentStatus[]) => void): () => void {
  if (!Native || !isAvailable()) return () => {};
  const sub = Native.addListener('onTorrentStatus', (e) => {
    try {
      // Same `{ok}` / `{error}` envelope as `call`: the native side forwards `list` as is.
      const l = unwrap<TorrentStatus[]>(e.json);
      if (Array.isArray(l)) cb(l);
    } catch {
      // malformed event, ignore
    }
  });
  return () => sub.remove();
}

/** Live list of torrents (empty when the engine is unavailable or not started). */
export function useTorrentList() {
  const [items, setItems] = useState<TorrentStatus[]>([]);
  useEffect(() => {
    if (!isAvailable()) return;
    let cancelled = false;
    list().then((l) => !cancelled && Array.isArray(l) && setItems(l)).catch(() => {});
    const off = addStatusListener((l) => !cancelled && setItems(l));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return items;
}

/** Legal notice shown once before the first torrent use. Resolves false when declined. */
export async function ensureLegalAccepted(): Promise<boolean> {
  await hydrateTorrentSettings();
  if (getTorrentSettings().legalAccepted) return true;
  return new Promise((resolve) => {
    Alert.alert(
      'Avant d’utiliser le torrent',
      'Le pair-à-pair échange des données avec d’autres personnes. Télécharger ou partager des œuvres protégées ' +
        'sans autorisation est illégal dans de nombreux pays et peut entraîner des poursuites. Huwa ne fournit aucun ' +
        'contenu ni aucune source : tu es responsable de ce que tu lis avec les addons que tu installes. ' +
        'Le partage (seeding) est désactivé et le cache est limité.',
      [
        { text: 'Refuser', style: 'cancel', onPress: () => resolve(false) },
        {
          text: 'J’ai compris',
          onPress: () => {
            setTorrentSettings({ legalAccepted: true });
            resolve(true);
          },
        },
      ],
      { cancelable: false },
    );
  });
}

/** Turns the built-in engine on from anywhere (sources menu, player), after the one-time notice. */
export async function enableTorrentEngine(): Promise<boolean> {
  if (!isAvailable()) return false;
  if (!(await ensureLegalAccepted())) return false;
  setTorrentSettings({ enabled: true });
  return true;
}

export type TorrentStreamLike = {
  infoHash?: string;
  fileIdx?: number | null;
  sources?: string[];
  name?: string;
  title?: string;
};

/**
 * Extension point for the stream resolver: returns a playable loopback URL for a torrent
 * stream, or `null` when the caller should fall back to debrid (engine not linked, disabled by
 * the user, legal notice declined, Wi-Fi-only on cellular, or no infoHash).
 */
export async function resolveTorrent(stream: TorrentStreamLike): Promise<StreamHandle | null> {
  if (!stream.infoHash || !isAvailable()) return null;
  await hydrateTorrentSettings();
  const s = getTorrentSettings();
  if (!s.enabled) return null;
  if (s.wifiOnly && Native?.isOnCellular()) return null;
  if (!(await ensureLegalAccepted())) return null;
  return startStream({
    infoHash: stream.infoHash,
    fileIdx: stream.fileIdx ?? null,
    sources: stream.sources ?? [],
    name: stream.name ?? stream.title?.split('\n')[0],
  });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
