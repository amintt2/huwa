// What we know of the real audio / subtitle tracks of the files behind the streams (pure store, no
// network: the reads live in ./track-sniff.ts). Release names are a guess (see ./audio.ts); the
// tracks are the truth, learned from:
//   - the first bytes the source race already reads (HTTP links, ./race-runner.ts body hook),
//   - a light header sniff (a follow-up Range read, the torrent engine's loopback URL),
//   - the player's own track list once a file is loaded.
// Keys: `u:<url>` (HTTP), `t:<infoHash>:<fileIdx|auto:episode>` (torrent file). A release family
// (same torrent / same addon release group, see `releaseFamily`) keeps the last answer so the next
// episode of the same release or pack is known at once (a hint: the player still checks).
import { useSyncExternalStore } from 'react';

import { audioVerdict, type MediaTrack, type TrackList } from '@/components/player/engines/tracks';

import type { VerifiedAudio } from './audio';
import type { StreamItem } from './protocol';

export type KnownTracks = {
  audio: Pick<MediaTrack, 'lang' | 'name' | 'langImplicit' | 'default' | 'forced'>[];
  subs: Pick<MediaTrack, 'lang' | 'name' | 'forced'>[];
  /** Every track of the file is listed. */
  complete: boolean;
  via: 'header' | 'player';
  at: number;
};

export type TrackEntry = { state: 'pending'; at: number } | { state: 'done'; tracks: KnownTracks } | { state: 'failed'; at: number };

const MAX = 400;
/** A failed sniff (timeout, unreadable) is retried after this. */
export const FAILED_TTL_MS = 5 * 60_000;
/** A pending sniff older than this is considered lost. */
export const PENDING_TTL_MS = 20_000;

const entries = new Map<string, TrackEntry>();
const families = new Map<string, KnownTracks>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

export const httpKey = (url: string) => `u:${url}`;
export const torrentKey = (infoHash: string, fileIdx: number | null | undefined, episode?: number) =>
  `t:${infoHash.toLowerCase()}:${fileIdx != null ? fileIdx : `auto:${episode ?? '?'}`}`;

/** Episode markers and checksums out of a release name: the same release for every episode. */
export function releaseStem(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, '')
    .replace(/\[[0-9a-f]{8}\]|\([0-9a-f]{8}\)/g, ' ')
    .replace(/\bs\d{1,2}[ ._-]?e\d{1,4}(?:[ ._-]?e?\d{1,4})?\b/g, ' ')
    .replace(/\b(?:e|ep|episode|épisode)[ ._-]?\d{1,4}(?:v\d)?\b/g, ' ')
    .replace(/(?:^|[ ._])-[ ._]\d{1,4}(?:v\d)?\b/g, ' ')
    .replace(/[ ._-]\d{1,4}(?:v\d)?(?=[ ._-]*(?:\[|\(|$))/g, ' ')
    .replace(/[\s._-]+/g, ' ')
    .trim();
}

/** Release family of a stream (same torrent, same addon release group / file naming), or null. */
export function releaseFamily(s: StreamItem & { addonId?: string }): string | null {
  if (s.infoHash) return `ih:${s.infoHash.toLowerCase()}`;
  const group = s.behaviorHints?.bingeGroup;
  if (group) return `bg:${s.addonId ?? ''}|${group}`;
  const file = s.behaviorHints?.filename;
  if (file) {
    const stem = releaseStem(file);
    if (stem.length >= 6) return `fn:${s.addonId ?? ''}|${stem}`;
  }
  return null;
}

function put(key: string, e: TrackEntry) {
  entries.delete(key);
  entries.set(key, e);
  if (entries.size > MAX) entries.delete(entries.keys().next().value!);
}

export function knownOf(list: TrackList, via: KnownTracks['via'] = 'header', at = Date.now()): KnownTracks {
  return {
    audio: list.tracks.filter((t) => t.kind === 'audio').map(({ lang, name, langImplicit, default: d, forced }) => ({ lang, name, langImplicit, default: d, forced })),
    subs: list.tracks.filter((t) => t.kind === 'sub').map(({ lang, name, forced }) => ({ lang, name, forced })),
    complete: list.complete,
    via,
    at,
  };
}

export function setTracks(key: string, tracks: KnownTracks, family?: string | null) {
  put(key, { state: 'done', tracks });
  if (family && tracks.audio.length) families.set(family, tracks);
  emit();
}

export function setPending(key: string) {
  put(key, { state: 'pending', at: Date.now() });
  emit();
}

export function setFailed(key: string) {
  // Never overwrite an answer with a later failure.
  if (entries.get(key)?.state === 'done') return;
  put(key, { state: 'failed', at: Date.now() });
  emit();
}

/** Current entry, with stale pending / failed entries dropped. */
export function trackEntry(key: string, now = Date.now()): TrackEntry | undefined {
  const e = entries.get(key);
  if (!e) return undefined;
  if (e.state === 'pending' && now - e.at > PENDING_TTL_MS) return undefined;
  if (e.state === 'failed' && now - e.at > FAILED_TTL_MS) return undefined;
  return e;
}

/** Tracks of the first key known, else the release family's (a hint). */
export function tracksFor(keys: string[], family?: string | null): { tracks: KnownTracks; exact: boolean } | null {
  for (const k of keys) {
    const e = entries.get(k);
    if (e?.state === 'done') return { tracks: e.tracks, exact: true };
  }
  const f = family ? families.get(family) : undefined;
  return f ? { tracks: f, exact: false } : null;
}

/** The tracks known for one of `keys` become the release family's (the next episode's hint). */
export function linkFamily(keys: string[], family: string | null | undefined) {
  if (!family) return;
  const hit = tracksFor(keys);
  if (!hit?.exact || !hit.tracks.audio.length || families.get(family) === hit.tracks) return;
  families.set(family, hit.tracks);
  emit();
}

/** Audio languages of the file (for ./audio `classifyDub`), or null when nothing is known. */
export function verifiedAudio(keys: string[], family?: string | null): VerifiedAudio | null {
  const hit = tracksFor(keys, family);
  if (!hit || !hit.tracks.audio.length) return null;
  const v = audioVerdict(hit.tracks.audio, hit.tracks.complete);
  return { langs: v.langs, conclusive: v.conclusive };
}

/** A sniff for one of these keys is in flight. */
export const sniffPending = (keys: string[], now = Date.now()) => keys.some((k) => trackEntry(k, now)?.state === 'pending');
/** A sniff for one of these keys ended without an answer (nothing more to wait for). */
export const sniffFailed = (keys: string[], now = Date.now()) => keys.some((k) => trackEntry(k, now)?.state === 'failed');

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getVersion = () => version;

/** Re-renders when a track list is learned (returns a version number for memo dependencies). */
export function useTrackInfo(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/** Test helper. */
export function clearTrackInfo() {
  entries.clear();
  families.clear();
  emit();
}
