// Stream ranking: playable first, then closest to the preferred quality, then addon priority.
import { isExternal, isPlayable, isTorrent, isYouTube, type AddonStream } from './protocol';

export type Quality = 2160 | 1080 | 720 | 480;
export const QUALITIES: Quality[] = [2160, 1080, 720, 480];

/** Resolution detected in the stream's name/title/filename, or null. */
export function detectQuality(s: AddonStream): Quality | null {
  const text = `${s.name ?? ''} ${s.title ?? ''} ${s.description ?? ''} ${s.behaviorHints?.filename ?? ''}`;
  if (/2160p?|\b4k\b|\buhd\b/i.test(text)) return 2160;
  if (/1080p?|\bfhd\b/i.test(text)) return 1080;
  if (/720p?|\bhd\b/i.test(text)) return 720;
  if (/480p?|576p?|360p?|\bsd\b/i.test(text)) return 480;
  return null;
}

/** 0 = exact match; lower qualities are preferred over higher ones (bandwidth). */
function qualityScore(q: Quality | null, pref: Quality | 'auto') {
  if (pref === 'auto') return q ? QUALITIES.indexOf(q) : 2;
  if (q == null) return 5;
  return q === pref ? 0 : q < pref ? (pref - q) / 1000 + 0.1 : (q - pref) / 500 + 0.5;
}

export type RankContext = {
  preferred: Quality | 'auto';
  /** Addon ids in priority order. */
  addonOrder: string[];
  canResolveTorrents: boolean;
  /** hash → cached on the debrid service (when known). */
  cached?: Record<string, boolean>;
  /** Language fit (lower is better, see ./audio). Sorted right after playability. */
  lang?: (s: AddonStream) => number;
};

/** 0 direct · 1 cached torrent · 2 torrent (unknown cache) · 3 YouTube / external · 4 unusable */
export function playTier(s: AddonStream, ctx: RankContext) {
  if (isPlayable(s)) return 0;
  if (isTorrent(s) && ctx.canResolveTorrents) {
    const c = ctx.cached?.[s.infoHash!.toLowerCase()];
    return c === false ? 2.5 : c ? 1 : 2;
  }
  if (isYouTube(s) || isExternal(s)) return 3;
  return 4;
}

export function rankStreams(streams: AddonStream[], ctx: RankContext): AddonStream[] {
  const order = (id: string) => {
    const i = ctx.addonOrder.indexOf(id);
    return i < 0 ? 99 : i;
  };
  return streams
    .map((s, i) => ({ s, i, t: playTier(s, ctx), l: ctx.lang ? ctx.lang(s) : 0, q: qualityScore(detectQuality(s), ctx.preferred), o: order(s.addonId) }))
    .sort((a, b) => a.t - b.t || a.l - b.l || a.q - b.q || a.o - b.o || a.i - b.i)
    .map((x) => x.s);
}

export const streamKey = (s: AddonStream) =>
  `${s.addonId}|${s.url ?? ''}|${s.infoHash ?? ''}|${s.fileIdx ?? ''}|${s.ytId ?? ''}|${s.externalUrl ?? ''}|${s.name ?? ''}|${s.title ?? ''}`;
