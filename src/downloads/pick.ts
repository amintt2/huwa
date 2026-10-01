// Which source an episode download uses (pure, unit-tested in __tests__/pick.test.ts).
// Input: the addon streams already ranked like the player ranks them (`rankStreams`: playable
// first, language fit, preferred quality, addon order). A download wants the same source the
// player would play ("Auto"), or the closest match to the asked resolution.
import { containerFromUrl } from '@/components/player/engines/policy';
import { isExternal, isPlayable, isTorrent, isYouTube, type AddonStream } from '@/addons/protocol';
import { detectQuality, streamKey } from '@/addons/quality';
import { webPlayerUrl, type MediaGuess } from '@/addons/web-player';
import { langMatches, normLang } from '@/subtitles/lang';

import type { DlKind, DlQuality, DlSource } from './types';

export type DlContext = {
  /** A debrid service is configured: torrents become HTTPS files. */
  debrid: boolean;
  /** The on-device torrent engine is linked and switched on (whole file through its HTTP server). */
  engine: boolean;
  probed?: Record<string, MediaGuess>;
  /** HLS offline download exists here (native module, real device). Default true. */
  hls?: boolean;
};

export type Downloadability = { ok: true; kind: DlKind } | { ok: false; reason: string };

export const REASONS = {
  web: 'Lecteur web : la vidéo est dans une page hébergée, elle ne peut pas être téléchargée.',
  youtube: 'YouTube : lecture en ligne uniquement.',
  external: 'Lien externe : s’ouvre hors de Huwa.',
  torrent: 'Torrent : configure un service débrid ou active le moteur torrent pour le télécharger.',
  hls: 'HLS : le téléchargement hors ligne demande un iPhone (pas le simulateur) et la dernière version de l’app.',
  none: 'Aucune source téléchargeable pour cet épisode.',
} as const;

export function downloadability(s: AddonStream, ctx: DlContext): Downloadability {
  if (webPlayerUrl(s, ctx.probed)) return { ok: false, reason: REASONS.web };
  if (isPlayable(s)) {
    const hls = containerFromUrl(s.url!) === 'hls';
    if (hls && ctx.hls === false) return { ok: false, reason: REASONS.hls };
    return { ok: true, kind: hls ? 'hls' : 'file' };
  }
  if (isTorrent(s)) {
    // Debrid turns it into a plain HTTPS file; the engine serves it over loopback HTTP.
    if (ctx.debrid) return { ok: true, kind: 'file' };
    if (ctx.engine) return { ok: true, kind: 'torrent' };
    return { ok: false, reason: REASONS.torrent };
  }
  if (isYouTube(s)) return { ok: false, reason: REASONS.youtube };
  if (isExternal(s)) return { ok: false, reason: REASONS.external };
  return { ok: false, reason: REASONS.none };
}

export type Pick = { stream: AddonStream; kind: DlKind; quality: number | null; exact: boolean };

/**
 * - 'auto': the source the watch screen plays (`preferredKey`) when downloadable, otherwise the
 *   first downloadable one in ranking order;
 * - a resolution: first exact match in ranking order, else the closest lower one (smaller file),
 *   else the closest higher one, else one of unknown resolution.
 * Direct files are preferred over HLS at equal rank (one request, resumable, compressible).
 */
export function pickForDownload(ranked: AddonStream[], quality: DlQuality, ctx: DlContext, preferredKey?: string): Pick | null {
  const ok = ranked
    .map((s, i) => ({ s, i, d: downloadability(s, ctx), q: detectQuality(s) }))
    .filter((x): x is { s: AddonStream; i: number; d: { ok: true; kind: DlKind }; q: ReturnType<typeof detectQuality> } => x.d.ok);
  if (!ok.length) return null;
  const out = (x: (typeof ok)[number], exact: boolean): Pick => ({ stream: x.s, kind: x.d.kind, quality: x.q, exact });

  if (quality === 'auto') {
    const pref = preferredKey ? ok.find((x) => streamKey(x.s) === preferredKey) : undefined;
    if (pref) return out(pref, true);
    return out(ok[0], true);
  }
  const byKind = (a: (typeof ok)[number], b: (typeof ok)[number]) => (a.d.kind === 'hls' ? 1 : 0) - (b.d.kind === 'hls' ? 1 : 0) || a.i - b.i;
  const exact = ok.filter((x) => x.q === quality).sort(byKind);
  if (exact.length) return out(exact[0], true);
  const lower = ok.filter((x) => x.q != null && x.q < quality).sort((a, b) => b.q! - a.q! || byKind(a, b));
  if (lower.length) return out(lower[0], false);
  const higher = ok.filter((x) => x.q != null && x.q > quality).sort((a, b) => a.q! - b.q! || byKind(a, b));
  if (higher.length) return out(higher[0], false);
  return out(ok.sort(byKind)[0], false);
}

/** Why nothing can be downloaded (the most telling reason among the listed streams). */
export function whyNotDownloadable(ranked: AddonStream[], ctx: DlContext): string {
  const reasons = ranked.map((s) => downloadability(s, ctx)).filter((d): d is { ok: false; reason: string } => !d.ok).map((d) => d.reason);
  for (const r of [REASONS.torrent, REASONS.hls, REASONS.web, REASONS.youtube, REASONS.external]) if (reasons.includes(r)) return r;
  return REASONS.none;
}

/** File extension to keep on disk: from the URL, the addon's file name, or mp4 by default. */
export function extensionOf(url: string | undefined, filename?: string): string {
  const fromName = filename ? /\.([a-z0-9]{2,4})$/i.exec(filename)?.[1] : undefined;
  const c = url ? containerFromUrl(url) : 'unknown';
  if (c === 'hls') return 'movpkg';
  if (c !== 'unknown') return c === 'mov' ? 'mov' : c === 'mkv' ? 'mkv' : c === 'webm' ? 'webm' : c === 'ts' ? 'ts' : c === 'avi' ? 'avi' : 'mp4';
  const ext = fromName?.toLowerCase();
  return ext && ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'ts'].includes(ext) ? ext : 'mp4';
}

/** Snapshot stored with the download. */
export function sourceOf(s: AddonStream, url?: string, via?: string): DlSource {
  const u = url ?? s.url;
  return {
    key: streamKey(s),
    name: (s.name ?? 'Source').split('\n')[0].trim(),
    addonName: s.addonName,
    quality: detectQuality(s),
    url: u,
    headers: s.behaviorHints?.proxyHeaders?.request,
    infoHash: s.infoHash,
    fileIdx: s.fileIdx,
    filename: s.behaviorHints?.filename,
    sources: s.sources,
    ext: extensionOf(u, s.behaviorHints?.filename),
    via,
  };
}

/** Download failure that means "the link expired" (debrid / signed URLs): re-resolve. */
export const isExpiredError = (status: number | undefined, message = '') =>
  status === 401 || status === 403 || status === 404 || status === 410 || /\b(401|403|404|410)\b|expired|forbidden|not found/i.test(message);

// ---------- subtitles saved with the episode ----------

export type SubtitleLike = { url: string; lang: string; match?: string; addonName?: string };

/**
 * External subtitle files to save with an episode: the best file (list already ranked: synced to
 * the file first) of each of the user's first `max` subtitle languages.
 */
export function pickSubtitles<T extends SubtitleLike>(ranked: T[], subLangs: string[], max = 2): T[] {
  const out: T[] = [];
  for (const want of subLangs.slice(0, max)) {
    const hit = ranked.find((s) => /^https?:\/\//i.test(s.url) && langMatches(normLang(s.lang), want) && !out.includes(s));
    if (hit) out.push(hit);
  }
  return out;
}

/** Extension of a subtitle file (the parser sniffs the content anyway). */
export const subtitleExt = (url: string) => {
  const m = /\.(srt|vtt|ass|ssa|sub)(?:[?#]|$)/i.exec(url);
  return m ? m[1].toLowerCase() : 'srt';
};
