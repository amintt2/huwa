// Which audio track should play, and keeping it there (pure, unit-tested in
// __tests__/audio-pick.test.ts).
//
// The wish, in order: the user's own pick for this series (sticky: next episodes, other sources,
// seeks), else the dub languages when a dubbed source plays, else the work's original language
// (AniList country of origin: JP → ja, KR → ko, CN / TW → zh). Never the file's "default" flag:
// dual-audio releases flag the English dub as default, AVPlayer follows the phone's languages.
//
// The players can move the track on their own after the first pick (a source reloaded by the
// source controller, AVPlayer re-applying its automatic media selection, mpv carrying `aid` over
// to the next file by id): `AudioKeeper` checks every track event against the wish and puts the
// wanted track back, a few times per window at most so it can never fight a player in a loop.
import { audioTrackLangs, langCode, pickAudioTrack, type AudioLike } from './engines/tracks';

/** Audio track as the players report it (expo-video `AudioTrack`, mpv tracks mapped alike). */
export type AudioRef = AudioLike & { id?: string | null };

/** A track the user chose by hand: its language (`und` when unknown) and its title. */
export type AudioPick = { lang: string; label?: string };

export type AudioWish = {
  /** ISO 639-1 codes, preferred first. */
  langs: string[];
  /** The user's own pick: that very track (title + language) when the file has it. */
  manual?: AudioPick | null;
};

const ORIGIN_LANG: Record<string, string> = { JP: 'ja', KR: 'ko', CN: 'zh', TW: 'zh', HK: 'zh' };

/** Original audio language of a work from its AniList country of origin (anime: Japanese). */
export function originalLang(country?: string | null): string {
  return ORIGIN_LANG[(country ?? '').toUpperCase()] ?? 'ja';
}

/**
 * Audio wanted for what plays. `dubbed`: the playing source is a dub in `dubLangs` (dub mode);
 * otherwise (VO mode, or a dub-mode fallback to the original version) the original language.
 */
export function audioWish(o: { dubbed: boolean; dubLangs: string[]; original: string; manual?: AudioPick | null }): AudioWish {
  const base = o.dubbed && o.dubLangs.length ? o.dubLangs : [o.original];
  const manual = o.manual ?? null;
  const first = manual && manual.lang !== 'und' ? [manual.lang] : [];
  return { langs: [...new Set([...first, ...base])], manual };
}

const labelOf = (t: AudioRef) => (t.label ?? t.name ?? '').trim();

/** The same track of one file: by id when both have one, else by title + language. */
export function sameTrack(a: AudioRef, b: AudioRef): boolean {
  if (a.id && b.id) return a.id === b.id;
  return labelOf(a) === labelOf(b) && langCode(a.lang ?? a.language) === langCode(b.lang ?? b.language);
}

/** Index of the track the wish asks for, or -1 (nothing in the file matches). */
export function chooseAudio(tracks: AudioRef[], wish: AudioWish): number {
  const m = wish.manual;
  if (m?.label) {
    const i = tracks.findIndex((t) => labelOf(t) === m.label && (m.lang === 'und' || audioTrackLangs(t).includes(m.lang)));
    if (i >= 0) return i;
  }
  return pickAudioTrack(tracks, wish.langs);
}

/**
 * Track to select now (index) when the current one does not match the wish, else -1. A track
 * already in the wanted language is kept (two Japanese tracks: whichever plays is fine), unless
 * the user picked a precise one.
 */
export function audioCorrection(tracks: AudioRef[], current: AudioRef | null | undefined, wish: AudioWish): number {
  if (tracks.length < 2) return -1;
  const i = chooseAudio(tracks, wish);
  if (i < 0) return -1;
  const want = tracks[i];
  if (!current) return i;
  if (sameTrack(current, want)) return -1;
  const exact = !!wish.manual?.label && labelOf(want) === wish.manual.label;
  if (!exact) {
    const wantLangs = audioTrackLangs(want);
    if (audioTrackLangs(current).some((l) => wantLangs.includes(l))) return -1;
  }
  return i;
}

/** Corrections allowed per source within `WINDOW_MS` (a player that insists wins after that). */
export const MAX_FIXES = 3;
export const WINDOW_MS = 10_000;

/** Puts the wished track back whenever a track event shows another one (see top of file). */
export class AudioKeeper {
  private uri: string | null = null;
  private fixes: number[] = [];
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Index of the track to select for `uri` now, or -1. */
  check(uri: string | null, tracks: AudioRef[], current: AudioRef | null | undefined, wish: AudioWish | null): number {
    if (!wish || !uri) return -1;
    if (uri !== this.uri) {
      this.uri = uri;
      this.fixes = [];
    }
    const i = audioCorrection(tracks, current, wish);
    if (i < 0) return -1;
    const t = this.now();
    this.fixes = this.fixes.filter((x) => t - x < WINDOW_MS);
    if (this.fixes.length >= MAX_FIXES) return -1;
    this.fixes.push(t);
    return i;
  }
}

// ---------- mpv ----------

const ISO2: Record<string, string[]> = {
  ja: ['jpn'], en: ['eng'], fr: ['fre', 'fra'], de: ['ger', 'deu'], es: ['spa'], it: ['ita'], pt: ['por'], ru: ['rus'],
  ko: ['kor'], zh: ['chi', 'zho'], ar: ['ara'], pl: ['pol'], tr: ['tur'], nl: ['dut', 'nld'],
};

/** mpv `alang` value for a wish ("ja,jpn"): mpv then opens each file on the right track itself. */
export function mpvAlang(langs: string[]): string {
  return [...new Set(langs.flatMap((l) => [l, ...(ISO2[l] ?? [])]))].join(',');
}
