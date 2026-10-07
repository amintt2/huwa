// Audio / subtitle tracks of a video file read from its first bytes (pure, unit-tested on real
// headers in __tests__/tracks.test.ts): which languages a release really carries, whatever its
// name says ("MULTI" without French, an untagged file with a French track…).
//
// Matroska / WebM: Segment → Tracks → TrackEntry (TrackType, Language, LanguageBCP47, Name,
// FlagDefault, FlagForced, CodecID). The Tracks element sits near the start (within the first
// 64–300 KiB); a fansub's font attachments usually come after it. When it is further away (the
// SeekHead says where) or cut by the end of the buffer, `need` is the byte range to read next.
// MP4 / MOV: moov → trak → mdia → (mdhd language, hdlr handler + name, elng), udta → name; the
// moov may be at the end of the file (`mp4MoovRange`).
//
// Also used for the tracks the players report once a file is loaded (`audioVerdict`,
// `pickAudioTrack`): track language tag first, the track title ("VF", "Français") second.
import { ascii, audioEntry, boxes, child, mp4MoovRange, type Box } from './policy';

export type TrackKind = 'video' | 'audio' | 'sub';

export type MediaTrack = {
  kind: TrackKind;
  /** ISO 639-1 when known (`fr`, `ja`…, BCP 47 region dropped), `und` otherwise. */
  lang: string;
  /** Matroska track without a Language element: `eng` by the spec, not a real statement. */
  langImplicit?: boolean;
  /** Track title ("VF", "Japonais", "Signs & Songs"). */
  name?: string;
  codec?: string;
  default?: boolean;
  forced?: boolean;
};

export type TrackList = {
  container: 'mkv' | 'webm' | 'mp4' | 'mov';
  tracks: MediaTrack[];
  /** Every track of the file is listed (the whole Tracks element / moov was read). */
  complete: boolean;
};

export type ByteRange = { start: number; end: number };

/** What the first bytes tell: the tracks (when found) and the range still needed, if any. */
export type TrackSniff = { list: TrackList | null; need?: ByteRange };

/** Head read for a track sniff (Tracks of an MKV, faststart moov of an MP4). */
export const TRACK_HEAD_BYTES = 256 * 1024;
/** Largest follow-up read (a Tracks element / moov further in the file). */
export const TRACK_MORE_MAX = 1024 * 1024;

// ---------- languages ----------

const ISO3: Record<string, string> = {
  fre: 'fr', fra: 'fr', eng: 'en', jpn: 'ja', ger: 'de', deu: 'de', spa: 'es', ita: 'it', por: 'pt', rus: 'ru',
  ara: 'ar', chi: 'zh', zho: 'zh', kor: 'ko', pol: 'pl', tur: 'tr', dut: 'nl', nld: 'nl', swe: 'sv', vie: 'vi',
  tha: 'th', ind: 'id', hin: 'hi', heb: 'he', gre: 'el', ell: 'el', cze: 'cs', ces: 'cs', hun: 'hu', rum: 'ro',
  ron: 'ro', ukr: 'uk', may: 'ms', msa: 'ms', fil: 'tl', tgl: 'tl', dan: 'da', fin: 'fi', nor: 'no', nob: 'nb',
  cat: 'ca', glg: 'gl', baq: 'eu', eus: 'eu',
};

/** "fre", "fra", "fr-FR", "FR", "es-419" → ISO 639-1; "", "und", "mul", "zxx" → `und`. */
export function langCode(raw: string | null | undefined): string {
  const x = (raw ?? '').trim().toLowerCase();
  if (!x || x === 'und' || x === 'mul' || x === 'zxx' || x === 'mis' || x === 'qaa') return 'und';
  if (ISO3[x]) return ISO3[x];
  const base = x.split(/[-_]/)[0];
  if (ISO3[base]) return ISO3[base];
  return /^[a-z]{2}$/.test(base) ? base : 'und';
}

// Track titles that say the language ("VF", "Français", "English Dub", "Latino", "Dublado"…).
const TITLE_LANGS: [RegExp, string][] = [
  [/\b(?:vf[fqi2]?|vof|truefrench|french|fran[cç]ais(?:e)?|fr)\b/i, 'fr'],
  [/\b(?:english|anglais|eng|va)\b/i, 'en'],
  [/\b(?:japanese|japonais|jap|jpn|vo|original)\b|日本語/i, 'ja'],
  [/\b(?:latino|castellano|espa[nñ]ol|spanish)\b/i, 'es'],
  [/\b(?:german|deutsch|allemand)\b/i, 'de'],
  [/\b(?:italian[oa]?|italien)\b/i, 'it'],
  [/\b(?:portugu[eê]se?|portugais|dublado|brasil(?:eiro)?)\b/i, 'pt'],
];

/** Language a track title states ("VF" → fr), or null. */
export function langFromTitle(title: string | null | undefined): string | null {
  const t = title ?? '';
  if (!t.trim()) return null;
  for (const [re, code] of TITLE_LANGS) if (re.test(t)) return code;
  return null;
}

const FORCED_TITLE = /\b(forced|forcés?|signs?(?:\s*(?:&|and|et)\s*songs?)?|panneaux)\b/i;

// ---------- Matroska ----------

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackType: 0x83,
  CodecID: 0x86,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  Name: 0x536e,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  Cluster: 0x1f43b675,
} as const;

type El = { id: number; start: number; data: number; end: number; unknown: boolean };

/** EBML element header at `at` (ID with its marker bits, size without), or null when cut. */
function element(b: Uint8Array, at: number): El | null {
  if (at >= b.length) return null;
  const first = b[at];
  let idLen = 1;
  while (idLen <= 4 && !(first & (0x80 >> (idLen - 1)))) idLen++;
  if (idLen > 4 || at + idLen >= b.length) return null;
  let id = 0;
  for (let k = 0; k < idLen; k++) id = id * 256 + b[at + k];
  const s0 = b[at + idLen];
  let sLen = 1;
  while (sLen <= 8 && !(s0 & (0x80 >> (sLen - 1)))) sLen++;
  if (sLen > 8 || at + idLen + sLen > b.length) return null;
  let size = s0 & (0xff >> sLen);
  let allOnes = size === 0xff >> sLen;
  for (let k = 1; k < sLen; k++) {
    const v = b[at + idLen + k];
    if (v !== 0xff) allOnes = false;
    size = size * 256 + v;
  }
  const data = at + idLen + sLen;
  return { id, start: at, data, end: allOnes ? Infinity : data + size, unknown: allOnes };
}

const uint = (b: Uint8Array, e: El) => {
  let v = 0;
  for (let i = e.data; i < Math.min(e.end, b.length); i++) v = v * 256 + b[i];
  return v;
};
const str = (b: Uint8Array, e: El) => new TextDecoder('utf-8').decode(b.subarray(e.data, Math.min(e.end, b.length))).replace(/\0+$/, '');

/** Children of [from, to) (stops at a cut element). */
function children(b: Uint8Array, from: number, to: number): El[] {
  const out: El[] = [];
  let at = from;
  while (at < Math.min(to, b.length)) {
    const e = element(b, at);
    if (!e) break;
    out.push(e);
    if (!isFinite(e.end)) break;
    at = e.end;
  }
  return out;
}

const MKV_CODEC: [string, string][] = [
  ['A_AAC', 'aac'], ['A_AC3', 'ac3'], ['A_EAC3', 'eac3'], ['A_DTS', 'dts'], ['A_TRUEHD', 'truehd'], ['A_FLAC', 'flac'],
  ['A_OPUS', 'opus'], ['A_VORBIS', 'vorbis'], ['A_MPEG/L3', 'mp3'], ['A_PCM', 'pcm'],
  ['S_TEXT/ASS', 'ass'], ['S_TEXT/SSA', 'ass'], ['S_TEXT/UTF8', 'srt'], ['S_TEXT/WEBVTT', 'wvtt'], ['S_HDMV/PGS', 'pgs'], ['S_VOBSUB', 'vobsub'],
];

function trackEntry(b: Uint8Array, e: El): MediaTrack | null {
  let type = 0;
  let codec: string | undefined;
  let lang: string | undefined;
  let bcp: string | undefined;
  let name: string | undefined;
  let def = true;
  let forced = false;
  for (const c of children(b, e.data, e.end)) {
    if (c.id === ID.TrackType) type = uint(b, c);
    else if (c.id === ID.CodecID) codec = str(b, c);
    else if (c.id === ID.Language) lang = str(b, c);
    else if (c.id === ID.LanguageBCP47) bcp = str(b, c);
    else if (c.id === ID.Name) name = str(b, c);
    else if (c.id === ID.FlagDefault) def = uint(b, c) !== 0;
    else if (c.id === ID.FlagForced) forced = uint(b, c) !== 0;
  }
  const kind: TrackKind | null = type === 1 ? 'video' : type === 2 ? 'audio' : type === 0x11 ? 'sub' : null;
  if (!kind) return null;
  // LanguageBCP47 wins over Language (the spec); no Language element at all means "eng".
  const implicit = bcp == null && lang == null;
  const code = bcp != null ? langCode(bcp) : langCode(lang ?? 'eng');
  const codecTag = codec ? MKV_CODEC.find(([id]) => codec!.startsWith(id))?.[1] ?? codec : undefined;
  return {
    kind,
    lang: code,
    ...(implicit ? { langImplicit: true } : null),
    ...(name ? { name } : null),
    ...(codecTag ? { codec: codecTag } : null),
    default: def,
    forced: forced || (kind === 'sub' && FORCED_TITLE.test(name ?? '')),
  };
}

function parseTracksElement(b: Uint8Array, t: El): { tracks: MediaTrack[]; complete: boolean } {
  const tracks: MediaTrack[] = [];
  for (const c of children(b, t.data, t.end)) {
    if (c.id !== ID.TrackEntry) continue;
    // A TrackEntry cut by the end of the buffer is left out (its fields may be missing).
    if (c.end > b.length) break;
    const tr = trackEntry(b, c);
    if (tr) tracks.push(tr);
  }
  return { tracks, complete: t.end <= b.length };
}

const cap = (start: number, end: number): ByteRange => ({ start, end: Math.min(end, start + TRACK_MORE_MAX) - 1 });

/**
 * Tracks of a Matroska / WebM file. `b` holds the file from byte `base` on: 0 for the head, or a
 * follow-up read that starts on a level-1 element (`need.start` of an earlier call), in which
 * case `segData` is the Segment's data offset learned from the head.
 */
export function mkvTracks(b: Uint8Array, base = 0, segData?: number): TrackSniff {
  const webm = base === 0 && ascii(b, 0, 64).includes('webm');
  const container = webm ? 'webm' : 'mkv';
  let from = 0;
  let segEnd = Infinity;
  if (base === 0) {
    const head = element(b, 0);
    if (!head || head.id !== ID.EBML) return { list: null };
    const seg = element(b, head.end);
    if (!seg || seg.id !== ID.Segment) return { list: null };
    from = seg.data;
    segData = seg.data;
    segEnd = seg.end;
  }
  let tracksAt: number | undefined;
  let at = from;
  while (at < Math.min(b.length, segEnd)) {
    const e = element(b, at);
    if (!e) {
      // Cut in the middle of an element header: read on from here.
      return { list: null, need: tracksAt != null ? cap(tracksAt, tracksAt + TRACK_HEAD_BYTES) : cap(base + at, base + at + TRACK_HEAD_BYTES) };
    }
    if (e.id === ID.Tracks) {
      const { tracks, complete } = parseTracksElement(b, e);
      const list: TrackList = { container, tracks, complete };
      return complete ? { list } : { list, need: cap(base + e.start, base + e.end) };
    }
    if (e.id === ID.SeekHead && e.end <= b.length && segData != null) {
      for (const seek of children(b, e.data, e.end)) {
        if (seek.id !== ID.Seek) continue;
        let sid = -1;
        let pos = -1;
        for (const f of children(b, seek.data, seek.end)) {
          if (f.id === ID.SeekID) sid = uint(b, f);
          else if (f.id === ID.SeekPosition) pos = uint(b, f);
        }
        if (sid === ID.Tracks && pos >= 0) tracksAt = segData + pos;
      }
    }
    // First cluster: the Tracks element was not before it.
    if (e.id === ID.Cluster || e.unknown) {
      return tracksAt != null && tracksAt > base + at ? { list: null, need: cap(tracksAt, tracksAt + TRACK_HEAD_BYTES) } : { list: null };
    }
    if (e.end > b.length) {
      // A large element (attachments, a big Void) runs past the buffer: jump to the Tracks the
      // SeekHead pointed at, else read on after this element.
      const next = tracksAt != null && tracksAt >= base + e.end ? tracksAt : tracksAt != null && tracksAt > base + at ? tracksAt : base + e.end;
      return { list: null, need: cap(next, next + TRACK_HEAD_BYTES) };
    }
    at = e.end;
  }
  return tracksAt != null && tracksAt >= base + b.length ? { list: null, need: cap(tracksAt, tracksAt + TRACK_HEAD_BYTES) } : { list: null };
}

/** Data offset of the Segment (for a follow-up read of `mkvTracks`), or undefined. */
export function mkvSegmentData(head: Uint8Array): number | undefined {
  const h = element(head, 0);
  if (!h || h.id !== ID.EBML) return undefined;
  const seg = element(head, h.end);
  return seg && seg.id === ID.Segment ? seg.data : undefined;
}

// ---------- MP4 / MOV ----------

/** ISO-639-2/T packed in 15 bits (mdhd), e.g. 0x15c7 → "fra". */
function packedLang(v: number): string {
  const c = (n: number) => String.fromCharCode(((v >> n) & 0x1f) + 0x60);
  return c(10) + c(5) + c(0);
}

function cString(b: Uint8Array, from: number, to: number): string {
  let end = from;
  while (end < Math.min(to, b.length) && b[end] !== 0) end++;
  return new TextDecoder('utf-8').decode(b.subarray(from, end)).trim();
}

const GENERIC_HANDLER = /^(?:sound|video|subtitle|text|core media \w+|apple \w+|gpac \w+|l-smash \w+|isomedia \w+|mainconcept \w+)\s*(?:handler|media handler)?$/i;

function mp4Track(b: Uint8Array, trak: Box): MediaTrack | null {
  const mdia = child(b, trak, 'mdia');
  const hdlr = child(b, mdia, 'hdlr');
  const kindTag = hdlr ? ascii(b, hdlr.body + 8, 4) : '';
  const kind: TrackKind | null = kindTag === 'vide' ? 'video' : kindTag === 'soun' ? 'audio' : ['sbtl', 'text', 'subt', 'clcp'].includes(kindTag) ? 'sub' : null;
  if (!kind) return null;
  const mdhd = child(b, mdia, 'mdhd');
  let lang = 'und';
  if (mdhd && mdhd.body + 34 <= b.length) {
    const v1 = b[mdhd.body] === 1;
    const at = mdhd.body + (v1 ? 32 : 20);
    const raw = (b[at] << 8) | b[at + 1];
    // 0x7fff / 0 = unspecified; values < 0x400 are Macintosh language codes (0 = English).
    lang = raw >= 0x400 && raw !== 0x7fff ? langCode(packedLang(raw)) : 'und';
  }
  const elng = child(b, mdia, 'elng');
  if (elng) {
    const bcp = cString(b, elng.body + 4, elng.end);
    if (bcp) lang = langCode(bcp);
  }
  const handlerName = hdlr ? cString(b, hdlr.body + 24, hdlr.end).replace(/^[\x00-\x1f]+/, '') : '';
  const udta = child(b, trak, 'udta');
  const nameBox = child(b, udta, 'name');
  const title = nameBox ? cString(b, nameBox.body, nameBox.end) : '';
  const name = title || (handlerName && !GENERIC_HANDLER.test(handlerName) ? handlerName : '');
  const tkhd = child(b, trak, 'tkhd');
  const enabled = tkhd ? (b[tkhd.body + 3] & 1) === 1 : true;
  const stsd = child(b, child(b, child(b, mdia, 'minf'), 'stbl'), 'stsd');
  const entry = stsd ? boxes(b, stsd.body + 8, stsd.end)[0] : undefined;
  const codec = entry ? (kind === 'audio' ? audioEntry(b, entry) : entry.type.trim()) : undefined;
  return {
    kind,
    lang,
    ...(name ? { name } : null),
    ...(codec ? { codec } : null),
    default: enabled,
    forced: kind === 'sub' && FORCED_TITLE.test(name),
  };
}

/** Tracks of an MP4 / MOV from its `moov` (in `b` at `offset`, or found among the top boxes). */
export function mp4Tracks(b: Uint8Array, offset = 0): TrackList | null {
  const top = boxes(b, offset, b.length);
  const moov = top.find((x) => x.type === 'moov');
  if (!moov) return null;
  const tracks: MediaTrack[] = [];
  for (const trak of boxes(b, moov.body, Math.min(moov.end, b.length)).filter((x) => x.type === 'trak')) {
    if (trak.end > b.length) break;
    const t = mp4Track(b, trak);
    if (t) tracks.push(t);
  }
  const brand = ascii(b, 8, 4);
  return { container: brand === 'qt  ' ? 'mov' : 'mp4', tracks, complete: moov.end <= b.length };
}

// ---------- entry point ----------

/** Tracks from the first bytes of a file (and the range to read next when they are not all there). */
export function sniffTracks(head: Uint8Array): TrackSniff {
  if (head.length < 12) return { list: null };
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return mkvTracks(head);
  if (ascii(head, 4, 4) === 'ftyp') {
    const list = mp4Tracks(head);
    if (list?.complete) return { list };
    const range = mp4MoovRange(head, TRACK_MORE_MAX);
    return range ? { list, need: range } : { list };
  }
  return { list: null };
}

/**
 * Tracks from a follow-up read (`need` of `sniffTracks`) that starts at `start` in the file.
 * `head` is the first read (Matroska segment offset).
 */
export function sniffMore(head: Uint8Array, more: Uint8Array, start: number): TrackSniff {
  if (head[0] === 0x1a && head[1] === 0x45) return mkvTracks(more, start, mkvSegmentData(head));
  if (ascii(head, 4, 4) === 'ftyp') {
    const list = mp4Tracks(more);
    if (!list) return { list: null };
    // The moov may be capped (`TRACK_MORE_MAX`): its sample tables are not needed for the list.
    return { list: { ...list, container: ascii(head, 8, 4) === 'qt  ' ? 'mov' : 'mp4' } };
  }
  return { list: null };
}

// ---------- verdicts on track lists (header sniff or the player's own list) ----------

/** Minimal shape of a track for the verdicts: header tracks and player tracks alike. */
export type AudioLike = { lang?: string | null; language?: string | null; name?: string | null; label?: string | null; langImplicit?: boolean };

/** Languages an audio track carries: its tag (when stated), else its title. */
export function audioTrackLangs(t: AudioLike): string[] {
  const tag = t.langImplicit ? 'und' : langCode(t.lang ?? t.language);
  const title = langFromTitle(t.name ?? t.label);
  return [...new Set([tag, title].filter((x): x is string => !!x && x !== 'und'))];
}

export type AudioVerdict = {
  /** Every language some audio track states. */
  langs: string[];
  /** Every audio track states its language: a missing one is really missing. */
  conclusive: boolean;
};

export function audioVerdict(audio: AudioLike[], complete = true): AudioVerdict {
  const per = audio.map(audioTrackLangs);
  return { langs: [...new Set(per.flat())], conclusive: complete && audio.length > 0 && per.every((l) => l.length > 0) };
}

/**
 * Index of the audio track in the first preferred language (tag first, then title), or -1.
 * `langs`: ISO 639-1 codes in preference order.
 */
export function pickAudioTrack(audio: AudioLike[], langs: string[]): number {
  for (const lang of langs) {
    const byTag = audio.findIndex((t) => !t.langImplicit && langCode(t.lang ?? t.language) === lang);
    if (byTag >= 0) return byTag;
    const byTitle = audio.findIndex((t) => langFromTitle(t.name ?? t.label) === lang);
    if (byTitle >= 0) return byTitle;
  }
  return -1;
}
