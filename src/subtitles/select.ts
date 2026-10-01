// Subtitle track list (embedded + external + local files) and automatic choice.
// Auto choice: full dialogue tracks first — first preferred language that has one; within it the
// best source (embedded in the video, then the stream's own subtitles, then subtitle addons in
// their order, an on-device translation last). "Forced" / "Signs & Songs" tracks only when no
// preferred language has a full track.
import { fromLangPhrase, langMatches, langName, normLang } from './lang';
import { formatFromName } from './parse';
import type { SubtitleFormat } from './types';

export type TrackKind = 'embedded' | 'external' | 'local' | 'translated';

export type Track = {
  key: string;
  kind: TrackKind;
  /** Normalised language (`fr`, `pt-br`…, `und`). */
  lang: string;
  /** Addon name, "Vidéo" (embedded) or the local file name. */
  source: string;
  format?: SubtitleFormat;
  forced: boolean;
  /** Extra label (track name, release name…). */
  name?: string;
  /** Lower = preferred source. */
  sourceRank: number;
  url?: string;
  embeddedIndex?: number;
  /** Translated track: language of the file it is translated from. */
  fromLang?: string;
};

const FORCED = /\b(forced|forcés?|signs?(?:\s*&\s*songs?)?|panneaux)\b/i;

export type ExternalInput = { url: string; lang: string; label?: string; source?: string; format?: SubtitleFormat; forced?: boolean };
export type EmbeddedInput = { language?: string; label?: string; name?: string; isDefault?: boolean; forced?: boolean };

export function buildTracks(embedded: EmbeddedInput[], external: ExternalInput[], local: Track[] = []): Track[] {
  const out: Track[] = [];
  embedded.forEach((e, i) => {
    const name = e.label || e.name || '';
    out.push({
      key: `emb:${i}`,
      kind: 'embedded',
      lang: normLang(e.language),
      source: 'Vidéo',
      forced: !!e.forced || FORCED.test(`${e.name ?? ''} ${e.label ?? ''}`),
      name: name && name.toLowerCase() !== (e.language ?? '').toLowerCase() ? name : undefined,
      sourceRank: 0,
      embeddedIndex: i,
    });
  });
  const sources: string[] = [];
  external.forEach((x) => {
    const source = x.source || 'Externe';
    if (!sources.includes(source)) sources.push(source);
    out.push({
      key: `ext:${x.url}`,
      kind: 'external',
      lang: normLang(x.lang),
      source,
      format: x.format ?? formatFromName(x.url),
      forced: x.forced ?? FORCED.test(`${x.label ?? ''} ${x.url}`),
      name: x.label,
      sourceRank: 1 + sources.indexOf(source),
      url: x.url,
    });
  });
  return [...local, ...out];
}

export type AutoPrefs = {
  enabled: boolean;
  languages: string[];
  /** Watching a dub: only "forced" tracks (signs, foreign dialogue) are picked automatically. */
  forcedOnly?: boolean;
};

/** Best track key for the preferences, or `off`. */
export function chooseTrack(tracks: Track[], prefs: AutoPrefs): string {
  if (!prefs.enabled) return 'off';
  const pick = (ok: (t: Track) => boolean) => {
    for (const pref of prefs.languages) {
      const cands = tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.kind !== 'local' && langMatches(t.lang, pref) && ok(t));
      if (!cands.length) continue;
      // Exact language beats a variant (`pt` pref: `pt` before `pt-br`).
      const p = normLang(pref);
      cands.sort(
        (a, b) =>
          Number(a.t.lang !== p) - Number(b.t.lang !== p) ||
          Number(a.t.forced) - Number(b.t.forced) ||
          a.t.sourceRank - b.t.sourceRank ||
          a.i - b.i,
      );
      return cands[0].t.key;
    }
    return undefined;
  };
  // Watching a dub: only "forced" tracks (signs, foreign dialogue).
  if (prefs.forcedOnly) return pick((t) => t.forced) ?? 'off';
  return pick((t) => !t.forced) ?? pick(() => true) ?? 'off';
}

/** Languages with a full (non-forced) track among `tracks`. */
export const fullTrackLangs = (tracks: Track[]) => [...new Set(tracks.filter((t) => !t.forced && t.kind !== 'local').map((t) => t.lang))];

export type TrackGroup = { lang: string; title: string; tracks: Track[] };

/** Tracks grouped by language: preferred languages first (in order), then alphabetical. */
export function groupTracks(tracks: Track[], languages: string[]): TrackGroup[] {
  const map = new Map<string, Track[]>();
  for (const t of tracks) {
    const k = t.lang;
    map.set(k, [...(map.get(k) ?? []), t]);
  }
  const prefIndex = (lang: string) => {
    const i = languages.findIndex((p) => langMatches(lang, p));
    return i < 0 ? Infinity : i;
  };
  return [...map.entries()]
    .map(([lang, list]) => ({ lang, title: langName(lang), tracks: list.sort((a, b) => a.sourceRank - b.sourceRank || Number(a.forced) - Number(b.forced)) }))
    .sort((a, b) => prefIndex(a.lang) - prefIndex(b.lang) || (a.lang === 'und' ? 1 : 0) - (b.lang === 'und' ? 1 : 0) || a.title.localeCompare(b.title, 'fr'));
}

export const FORMAT_LABEL: Record<SubtitleFormat, string> = { ass: 'ASS', ssa: 'SSA', srt: 'SRT', vtt: 'VTT' };

/** "SRT · OpenSubtitles · forcés" */
export function trackHint(t: Track, loadedFormat?: SubtitleFormat): string {
  const fmt = loadedFormat ?? t.format;
  if (t.kind === 'translated') return `Traduit sur l’appareil ${fromLangPhrase(t.fromLang ?? 'und')}`;
  return [t.kind === 'embedded' ? 'Intégré' : fmt ? FORMAT_LABEL[fmt] : null, t.kind === 'embedded' ? null : t.source, t.forced ? 'Forcés' : null].filter(Boolean).join(' · ');
}
