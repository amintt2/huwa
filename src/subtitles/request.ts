// Exact-file subtitle requests and ranking.
// Stremio subtitle addons (OpenSubtitles v3…) accept the playing file's `videoHash` (OpenSubtitles
// hash), `videoSize` and `filename`: with them the addon can return the files synced to *this*
// release. The streams give them in `behaviorHints`. Results are then ranked: files matching the
// video (hash, then release name) first, then the user's language order, then the addon's order.
import type { StreamItem, SubtitleExtra } from '@/addons/protocol';

import { langMatches, normLang } from './lang';

/** Extras for the playing stream, or null when it says nothing about its file. */
export function subtitleExtraOf(s: StreamItem | null | undefined): SubtitleExtra | null {
  const h = s?.behaviorHints;
  if (!h) return null;
  const out: SubtitleExtra = {};
  if (typeof h.videoHash === 'string' && /^[0-9a-f]{16}$/i.test(h.videoHash)) out.videoHash = h.videoHash.toLowerCase();
  if (typeof h.videoSize === 'number' && h.videoSize > 0 && Number.isFinite(h.videoSize)) out.videoSize = Math.round(h.videoSize);
  if (typeof h.filename === 'string' && h.filename.trim()) out.filename = h.filename.trim().split(/[\\/]/).pop();
  return out.videoHash || out.filename || out.videoSize ? out : null;
}

/** Stable key of an extra (dedupes requests when the source changes to the same file). */
export const extraKey = (x: SubtitleExtra | null | undefined) => (x ? `${x.videoHash ?? ''}|${x.videoSize ?? ''}|${x.filename ?? ''}` : '');

export type SubMatch = 'hash' | 'release';

/** Release tokens of a file name: "[Erai-raws] Frieren - 05 [1080p][HEVC].mkv" → group, episode, resolution, codec. */
export function releaseTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\.(mkv|mp4|avi|webm|m4v|ts|srt|ass|ssa|vtt|sub|gz|zip)$/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !/^(s\d+|e\d+|the|and|sub|subs|vostfr)$/.test(t));
}

/** The subtitle's own release name looks like the video file (same group / source / resolution). */
export function sameRelease(subName: string | undefined, videoName: string | undefined): boolean {
  if (!subName || !videoName) return false;
  const a = new Set(releaseTokens(subName));
  const b = releaseTokens(videoName);
  if (!a.size || !b.length) return false;
  const common = b.filter((t) => a.has(t)).length;
  return common >= 3 && common / Math.max(a.size, b.length) >= 0.6;
}

export type RankInput = {
  url: string;
  lang: string;
  m?: string;
  hashMatch?: boolean;
  release?: string;
  filename?: string;
};

export function matchOf(x: RankInput, video?: SubtitleExtra | null): SubMatch | undefined {
  if (x.hashMatch === true || x.m === 'h') return 'hash';
  if (video?.filename && sameRelease(x.release ?? x.filename, video.filename)) return 'release';
  return undefined;
}

/**
 * Exact matches first (hash, then release name), then languages in `subLangs` order (others
 * after, original order kept), then the order they came in.
 */
export function rankSubtitles<T extends RankInput>(list: T[], subLangs: string[], video?: SubtitleExtra | null): (T & { match?: SubMatch })[] {
  const tier = (m?: SubMatch) => (m === 'hash' ? 0 : m === 'release' ? 1 : 2);
  const langRank = (l: string) => {
    const key = normLang(l);
    const i = subLangs.findIndex((p) => langMatches(key, p));
    return i < 0 ? subLangs.length : i;
  };
  return list
    .map((x, i) => ({ x: { ...x, match: matchOf(x, video) }, i }))
    .sort((a, b) => tier(a.x.match) - tier(b.x.match) || langRank(a.x.lang) - langRank(b.x.lang) || a.i - b.i)
    .map(({ x }) => x);
}
