// Which engine plays a source: the native one (expo-video: AVPlayer / ExoPlayer — hardware
// decoding, PiP, AirPlay, best battery) unless the source needs mpv. Pure functions, unit-tested.
//
// Signals, cheapest first: URL extension → Content-Type → the first bytes of the file (Range
// request, see probe.ts), down to the MP4 sample entries (video profile, audio codec). A native
// playback failure is the last resort (hybrid-player.ts retries with mpv), but some sources never
// fail natively: AVPlayer plays an MP4 with DTS, TrueHD or MP3 audio as a silent video. Those have
// to be caught here. What AVFoundation does with each format was checked on real files, see
// scripts/format-samples/README.md.

export type Engine = 'native' | 'mpv';
export type EnginePref = 'auto' | 'native' | 'mpv';

export type Container =
  | 'mp4' | 'mov' | 'hls' | 'dash' | 'mkv' | 'webm' | 'avi' | 'flv' | 'ts' | 'mpeg' | 'ogg' | 'wmv' | 'rm' | 'unknown';

/**
 * What we know about a source. `codecs` holds normalized codec tags (see `CODEC_LABEL`): video
 * sample entries / Matroska codec ids, plus profile markers (`h264-hi10`, `hevc-rext`, `av1-high`)
 * and audio / subtitle codecs when the header shows them.
 * `torrent`: served by the built-in torrent engine (loopback), see `decideEngine`.
 */
export type Probe = { container: Container; codecs: string[]; via: 'ext' | 'mime' | 'sniff' | 'none'; torrent?: boolean };

export type DeviceCaps = {
  platform: 'ios' | 'android' | 'web' | string;
  mpvAvailable: boolean;
  /** VideoToolbox / MediaCodec hardware decoders of this device. */
  hw: { av1?: boolean; hevc?: boolean; vp9?: boolean };
};

export type Decision = { engine: Engine; reason: string };

const EXT: Record<string, Container> = {
  mp4: 'mp4', m4v: 'mp4', '3gp': 'mp4', '3g2': 'mp4', f4v: 'mp4', mov: 'mov', qt: 'mov',
  m3u8: 'hls', m3u: 'hls', mpd: 'dash',
  mkv: 'mkv', mk3d: 'mkv', webm: 'webm', avi: 'avi', divx: 'avi', xvid: 'avi', flv: 'flv',
  ts: 'ts', m2ts: 'ts', mts: 'ts', m2t: 'ts', tp: 'ts', trp: 'ts',
  vob: 'mpeg', mpg: 'mpeg', mpeg: 'mpeg', m2v: 'mpeg', evo: 'mpeg',
  ogv: 'ogg', ogg: 'ogg', ogm: 'ogg', wmv: 'wmv', asf: 'wmv', rm: 'rm', rmvb: 'rm',
};

/** Container from a URL path (query and fragment ignored, percent-decoded) or a file name. */
export function containerFromUrl(url: string): Container {
  let path = url.split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep raw
  }
  const m = /\.([a-z0-9]{2,5})$/i.exec(path);
  return (m && EXT[m[1].toLowerCase()]) || 'unknown';
}

export function containerFromMime(contentType: string | null | undefined): Container {
  const t = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!t) return 'unknown';
  if (t.includes('mpegurl')) return 'hls';
  if (t === 'application/dash+xml') return 'dash';
  if (t.includes('matroska')) return 'mkv';
  if (t.endsWith('/webm')) return 'webm';
  if (t === 'video/x-msvideo' || t === 'video/avi' || t === 'video/msvideo' || t === 'video/divx') return 'avi';
  if (t === 'video/x-flv') return 'flv';
  if (t === 'video/mp2t' || t === 'video/vnd.dlna.mpeg-tts') return 'ts';
  if (t === 'video/mpeg' || t === 'video/mp2p' || t === 'video/x-mpeg') return 'mpeg';
  if (t === 'video/ogg' || t === 'application/ogg') return 'ogg';
  if (t.includes('ms-wmv') || t.includes('ms-asf')) return 'wmv';
  if (t.includes('realmedia') || t.includes('rn-realvideo')) return 'rm';
  if (t === 'video/quicktime') return 'mov';
  if (t === 'video/mp4' || t === 'audio/mp4' || t === 'video/x-m4v' || t === 'video/3gpp' || t === 'video/3gpp2') return 'mp4';
  return 'unknown';
}

export const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, Math.min(b.length, at + n)));

function indexOfAscii(b: Uint8Array, s: string, from = 0, to = b.length): number {
  const first = s.charCodeAt(0);
  outer: for (let i = Math.max(0, from); i <= Math.min(to, b.length) - s.length; i++) {
    if (b[i] !== first) continue;
    for (let j = 1; j < s.length; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

export const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];

const push = (list: string[], c: string | null | undefined) => {
  if (c && !list.includes(c)) list.push(c);
};

// ---------- ISO-BMFF (MP4 / MOV) ----------

export type Box = { type: string; start: number; body: number; end: number };

/** Boxes in [from, to) (truncated boxes included: `end` may lie beyond the buffer). */
export function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= Math.min(to, b.length)) {
    let size = u32(b, at);
    const type = ascii(b, at + 4, 4);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > b.length) break;
      size = u32(b, at + 8) * 2 ** 32 + u32(b, at + 12);
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < body - at || !/^[\x00\x20-\x7e\xa9]{4}$/.test(type)) break;
    out.push({ type, start: at, body, end: at + size });
    at += size;
  }
  return out;
}

export const child = (b: Uint8Array, box: Box | undefined, type: string) =>
  box ? boxes(b, box.body, box.end).find((x) => x.type === type) : undefined;

/** Video sample entry → codec tags. */
function videoEntry(b: Uint8Array, e: Box, out: string[]) {
  const t = e.type;
  const inner = (name: string) => indexOfAscii(b, name, e.body + 78, Math.min(e.end, b.length));
  if (t === 'avc1' || t === 'avc3') {
    push(out, t);
    const c = inner('avcC');
    // AVCProfileIndication: 110 High 10 ("Hi10P"), 122 High 4:2:2, 244 High 4:4:4.
    if (c >= 0 && [110, 122, 244].includes(b[c + 5])) push(out, 'h264-hi10');
  } else if (t === 'hvc1' || t === 'hev1' || t === 'dvh1' || t === 'dvhe') {
    push(out, t);
    const c = inner('hvcC');
    // general_profile_idc 4 = format range extensions (4:2:2 / 4:4:4, 12-bit).
    if (c >= 0 && (b[c + 5] & 0x1f) === 4) push(out, 'hevc-rext');
  } else if (t === 'av01') {
    push(out, t);
    const c = inner('av1C');
    if (c >= 0 && b[c + 5] >> 5 > 0) push(out, 'av1-high');
  } else if (t === 'vp09' || t === 'vp08') push(out, t);
  else if (t === 'mp4v') {
    // MPEG-4 visual: Part 2 (DivX/Xvid style) unless the esds says otherwise.
    const oti = esdsObjectType(b, e);
    push(out, oti === 0x60 || oti === 0x61 || oti === 0x62 || oti === 0x63 || oti === 0x64 || oti === 0x65 || oti === 0x6a ? 'mp2v' : 'mp4v');
  } else if (t === 'mp2v' || t === 'm2v1' || t === 'xdvd' || /^xdv/.test(t)) push(out, 'mp2v');
  else if (t === 'jpeg' || t === 'mjpa') push(out, 'mjpeg');
  else if (/^ap[c4hsno]/.test(t) || t === 'apcn') push(out, 'prores');
  else push(out, t);
}

/** objectTypeIndication of the `esds` inside a sample entry (MPEG-4 ES descriptor), or -1. */
function esdsObjectType(b: Uint8Array, e: Box): number {
  const at = indexOfAscii(b, 'esds', e.body, Math.min(e.end, b.length));
  if (at < 0) return -1;
  let p = at + 8; // 'esds' + version/flags
  const len = () => {
    let n = 0;
    for (let k = 0; k < 4 && p < b.length; k++) {
      const c = b[p++];
      n = (n << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return n;
  };
  if (b[p++] !== 0x03) return -1;
  len();
  p += 2; // ES_ID
  const flags = b[p++];
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + b[p];
  if (flags & 0x20) p += 2;
  if (b[p++] !== 0x04) return -1;
  len();
  return p < b.length ? b[p] : -1;
}

/** Audio sample entry → codec tag. */
export function audioEntry(b: Uint8Array, e: Box): string {
  const t = e.type;
  if (t === 'mp4a') {
    const oti = esdsObjectType(b, e);
    if (oti === 0x69 || oti === 0x6b) return 'mp3';
    if (oti === 0xa9 || oti === 0xaa || oti === 0xab || oti === 0xac) return 'dts';
    if (oti === 0xa5) return 'ac3';
    if (oti === 0xa6) return 'eac3';
    if (oti === 0xad) return 'opus';
    if (oti === 0xdd) return 'vorbis';
    return 'aac';
  }
  if (t === '.mp3' || t === 'ms\u0000U') return 'mp3';
  if (t === 'ac-3' || t === 'sac3') return 'ac3';
  if (t === 'ec-3') return 'eac3';
  if (t === 'ac-4') return 'ac4';
  if (/^dts[chlex]$/.test(t) || t === 'dtsx') return 'dts';
  if (t === 'mlpa') return 'truehd';
  if (t === 'Opus') return 'opus';
  if (t === 'fLaC') return 'flac';
  if (t === 'alac') return 'alac';
  if (t === 'samr' || t === 'sawb') return 'amr';
  if (/^(lpcm|sowt|twos|in24|in32|fl32|fl64|raw )$/.test(t)) return 'pcm';
  return t.trim();
}

/**
 * Codecs of every track of an MP4 / MOV, walking moov → trak → mdia → (hdlr, minf → stbl → stsd).
 * `b` may hold the whole file head or only the `moov` (`offset` = its position in `b`). Works on a
 * truncated moov as far as it goes.
 */
export function mp4Codecs(b: Uint8Array, offset = 0): string[] {
  const out: string[] = [];
  const top = boxes(b, offset, b.length);
  const moov = top.find((x) => x.type === 'moov');
  if (!moov) return out;
  for (const trak of boxes(b, moov.body, moov.end).filter((x) => x.type === 'trak')) {
    const mdia = child(b, trak, 'mdia');
    const hdlr = child(b, mdia, 'hdlr');
    const kind = hdlr ? ascii(b, hdlr.body + 8, 4) : '';
    const stsd = child(b, child(b, child(b, mdia, 'minf'), 'stbl'), 'stsd');
    if (!stsd) continue;
    for (const e of boxes(b, stsd.body + 8, stsd.end)) {
      if (kind === 'vide') videoEntry(b, e, out);
      else if (kind === 'soun') push(out, audioEntry(b, e));
      else if (kind === 'sbtl' || kind === 'text' || kind === 'subt') push(out, e.type === 'tx3g' || e.type === 'text' ? 'tx3g' : e.type === 'wvtt' ? 'wvtt' : e.type);
    }
  }
  return out;
}

/**
 * Byte range still needed to read an MP4's `moov`, given the first bytes of the file: the rest of a
 * `moov` that starts in `head` (faststart files with many tracks / long tables), or the box right
 * after the `mdat` when the `moov` sits at the end. null when the head already holds it all, or
 * when the layout is not understood. `max` caps the request (a moov's audio tracks come after the
 * video sample tables, so a capped read usually still reaches every sample entry).
 */
export function mp4MoovRange(head: Uint8Array, max = 2 * 1024 * 1024): { start: number; end: number } | null {
  if (ascii(head, 4, 4) !== 'ftyp') return null;
  let at = 0;
  for (let guard = 0; guard < 16; guard++) {
    if (at + 8 > head.length) return { start: at, end: at + max - 1 };
    const [box] = boxes(head, at, at + 16);
    if (!box) return null;
    if (box.type === 'moov') return box.end <= head.length ? null : { start: box.start, end: Math.min(box.end, box.start + max) - 1 };
    at = box.end;
  }
  return null;
}

// ---------- Matroska ----------

// Matroska CodecID strings → codec tags.
const MKV_CODECS: [string, string][] = [
  ['V_MPEG4/ISO/AVC', 'avc1'], ['V_MPEGH/ISO/HEVC', 'hevc'], ['V_AV1', 'av01'], ['V_VP9', 'vp09'], ['V_VP8', 'vp08'],
  ['V_MPEG4/ISO/ASP', 'mp4v'], ['V_MPEG4/ISO/SP', 'mp4v'], ['V_MS/VFW/FOURCC', 'vfw'], ['V_MPEG2', 'mp2v'], ['V_MPEG1', 'mp2v'],
  ['V_THEORA', 'theora'], ['V_REAL/', 'rv'], ['V_PRORES', 'prores'],
  ['A_AAC', 'aac'], ['A_AC3', 'ac3'], ['A_EAC3', 'eac3'], ['A_DTS', 'dts'], ['A_TRUEHD', 'truehd'], ['A_MLP', 'truehd'],
  ['A_FLAC', 'flac'], ['A_OPUS', 'opus'], ['A_VORBIS', 'vorbis'], ['A_MPEG/L3', 'mp3'], ['A_MPEG/L2', 'mp2'], ['A_PCM/', 'pcm'],
  ['S_TEXT/ASS', 'ass'], ['S_TEXT/SSA', 'ass'], ['S_ASS', 'ass'], ['S_SSA', 'ass'], ['S_TEXT/UTF8', 'srt'], ['S_TEXT/WEBVTT', 'wvtt'],
  ['S_HDMV/PGS', 'pgs'], ['S_VOBSUB', 'vobsub'], ['S_DVBSUB', 'dvbsub'],
];

/** EBML variable-size integer at `at`: [value, length]. */
function vint(b: Uint8Array, at: number): [number, number] {
  const first = b[at];
  if (!first) return [-1, 1];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  let v = first & (0xff >> len);
  for (let k = 1; k < len; k++) v = v * 256 + (b[at + k] ?? 0);
  return [v, len];
}

function mkvCodecs(b: Uint8Array): string[] {
  const out: string[] = [];
  for (const [id, c] of MKV_CODECS) {
    let at = indexOfAscii(b, id);
    while (at >= 0) {
      push(out, c);
      if (c === 'avc1') {
        // CodecPrivate (0x63A2) of this track: the avcC, whose 2nd byte is the profile.
        const cp = indexOfAscii(b, '\x63\xa2', at, at + 256);
        if (cp >= 0) {
          const [, n] = vint(b, cp + 2);
          const p = cp + 2 + n;
          if (b[p] === 1 && [110, 122, 244].includes(b[p + 1])) push(out, 'h264-hi10');
        }
      }
      at = indexOfAscii(b, id, at + id.length);
    }
  }
  return out;
}

// ---------- sniffing ----------

/** Container + codecs from the first bytes of the file (and, for MP4, its `moov` when present). */
export function sniff(b: Uint8Array): Probe {
  const codecs: string[] = [];
  const none: Probe = { container: 'unknown', codecs, via: 'sniff' };
  if (b.length < 12) return none;
  // Matroska / WebM: EBML magic, DocType in the header.
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const webm = indexOfAscii(b, 'webm', 0, 64) >= 0;
    return { container: webm ? 'webm' : 'mkv', codecs: mkvCodecs(b), via: 'sniff' };
  }
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    const parsed = mp4Codecs(b);
    // No moov in these bytes: whatever sample entries a plain scan finds (old behaviour).
    if (!parsed.length) for (const c of ['avc1', 'avc3', 'hvc1', 'hev1', 'dvh1', 'dvhe', 'av01', 'vp09', 'vp08']) if (indexOfAscii(b, c, 12) >= 0) codecs.push(c);
    return { container: brand === 'qt  ' ? 'mov' : 'mp4', codecs: parsed.length ? parsed : codecs, via: 'sniff' };
  }
  const head = ascii(b, 0, 8);
  if (head.startsWith('#EXTM3U')) return { container: 'hls', codecs, via: 'sniff' };
  if (head.startsWith('RIFF') && ascii(b, 8, 4) === 'AVI ') return { container: 'avi', codecs, via: 'sniff' };
  if (head.startsWith('FLV')) return { container: 'flv', codecs, via: 'sniff' };
  if (head.startsWith('OggS')) return { container: 'ogg', codecs, via: 'sniff' };
  if (head.startsWith('.RMF')) return { container: 'rm', codecs, via: 'sniff' };
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return { container: 'wmv', codecs, via: 'sniff' };
  if (b[0] === 0x47 && b.length > 376 && b[188] === 0x47 && b[376] === 0x47) return { container: 'ts', codecs, via: 'sniff' };
  // M2TS (Blu-ray): 4-byte timecode before every 188-byte packet.
  if (b[4] === 0x47 && b.length > 388 && b[196] === 0x47 && b[388] === 0x47) return { container: 'ts', codecs, via: 'sniff' };
  // MPEG program stream (VOB / .mpg): pack header.
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0xba) return { container: 'mpeg', codecs, via: 'sniff' };
  if (indexOfAscii(b, '<MPD', 0, 512) >= 0) return { container: 'dash', codecs, via: 'sniff' };
  return none;
}

// ---------- decision ----------

// Containers the native engine plays, per platform.
// iOS AVPlayer: MP4/MOV/HLS only (a bare .ts opens in AVFoundation on macOS, not reliably through
// AVPlayer on iOS: mpv). Android ExoPlayer (media3): MP4, MKV, WebM, TS, FLV, Ogg, AVI, HLS, DASH.
const NATIVE_CONTAINERS: Record<string, Container[]> = {
  ios: ['mp4', 'mov', 'hls', 'unknown'],
  android: ['mp4', 'mov', 'hls', 'dash', 'mkv', 'webm', 'ts', 'flv', 'ogg', 'avi', 'unknown'],
};

const LABEL: Partial<Record<Container, string>> = {
  mkv: 'MKV', webm: 'WebM', avi: 'AVI', flv: 'FLV', ts: 'MPEG-TS', mpeg: 'MPEG-PS', ogg: 'Ogg', wmv: 'WMV', rm: 'RealMedia', dash: 'DASH',
};

/**
 * Codecs the native engine cannot decode (or only drops: AVPlayer hides a DTS / MP3 track of an
 * MP4 and plays the video silently), per platform, with the reason shown in the engine badge.
 */
const NATIVE_GAPS: Record<string, [string, string][]> = {
  ios: [
    ['vp09', 'codec VP9'], ['vp08', 'codec VP8'],
    ['hev1', 'HEVC hev1'], ['dvhe', 'HEVC hev1'], ['hevc-rext', 'HEVC 4:2:2 / 4:4:4'],
    ['h264-hi10', 'H.264 10 bits (Hi10P)'], ['av1-high', 'AV1 4:4:4'],
    ['mp4v', 'codec MPEG-4 Part 2 (Xvid/DivX)'], ['mp2v', 'codec MPEG-2'], ['vfw', 'codec VfW'], ['theora', 'codec Theora'],
    ['dts', 'audio DTS'], ['truehd', 'audio TrueHD'], ['mp3', 'audio MP3 dans MP4'], ['vorbis', 'audio Vorbis'], ['mp2', 'audio MP2'],
  ],
  // ExoPlayer's MediaCodec: no DTS / TrueHD decoder on phones, 10-bit H.264 almost never.
  android: [['h264-hi10', 'H.264 10 bits (Hi10P)'], ['dts', 'audio DTS'], ['truehd', 'audio TrueHD']],
};

/** Engine for a source. `probe` may be partial (extension only) or absent. */
export function decideEngine(pref: EnginePref, caps: DeviceCaps, probe: Probe | null): Decision {
  if (!caps.mpvAvailable) return { engine: 'native', reason: pref === 'mpv' ? 'mpv indisponible dans cette version' : '' };
  if (pref === 'native') return { engine: 'native', reason: 'réglage' };
  if (pref === 'mpv') return { engine: 'mpv', reason: 'réglage' };
  if (!probe) return { engine: 'native', reason: '' };
  // Built-in torrent engine, container not known yet (no byte of the torrent on the device): mpv
  // plays whatever it turns out to be. Sniffing first meant waiting up to 3.5 s for piece 0, and on
  // a timeout AVPlayer was tried on an MKV it cannot open, for 15 s, before mpv: 18.5 s lost.
  if (probe.torrent && probe.container === 'unknown') return { engine: 'mpv', reason: 'moteur torrent' };

  const nativeOk = NATIVE_CONTAINERS[caps.platform] ?? NATIVE_CONTAINERS.ios;
  if (!nativeOk.includes(probe.container)) return { engine: 'mpv', reason: `conteneur ${LABEL[probe.container] ?? probe.container}` };

  const gap = nativeGap(probe.codecs, caps);
  return gap ? { engine: 'mpv', reason: gap } : { engine: 'native', reason: '' };
}

/**
 * Why the native engine (AVFoundation on iOS) cannot decode one of these codecs, or null. Also
 * what the HEVC re-encoder of downloads cannot read (it decodes with AVFoundation).
 */
export function nativeGap(codecs: string[], caps: Pick<DeviceCaps, 'platform' | 'hw'> = { platform: 'ios', hw: {} }): string | null {
  const has = (c: string) => codecs.includes(c);
  if (caps.platform === 'ios' && has('av01') && !caps.hw.av1) return 'AV1 sans décodeur matériel';
  // AVPlayer only accepts HEVC tagged `hvc1` (parameter sets in the sample entry), not `hev1`/`dvhe`.
  const hevcOk = has('hvc1') || has('dvh1');
  for (const [codec, reason] of NATIVE_GAPS[caps.platform] ?? NATIVE_GAPS.ios) {
    if ((codec === 'hev1' || codec === 'dvhe') && hevcOk) continue;
    if (has(codec)) return reason;
  }
  return null;
}

/**
 * Probe of a file read synchronously (downloaded episode): first bytes, plus the MP4 `moov`
 * wherever it is. `readAt(start, length)` returns fewer bytes at the end of the file, null on error.
 */
export function probeBytes(readAt: (start: number, length: number) => Uint8Array | null): Probe {
  const head = readAt(0, 4096);
  if (!head?.length) return { container: 'unknown', codecs: [], via: 'none' };
  const s = sniff(head);
  if (s.container !== 'mp4' && s.container !== 'mov') return s;
  const range = mp4MoovRange(head);
  const more = range ? readAt(range.start, range.end - range.start + 1) : null;
  const codecs = more?.length ? mp4Codecs(more) : [];
  return codecs.length ? { ...s, codecs: [...new Set([...s.codecs, ...codecs])] } : s;
}

/** Whether a probe is already conclusive without reading the file (skips the Range request). */
// MP4/MOV need their sample entries (AV1, VP9, hev1, Hi10P, DTS…); anything else is decided by
// the container. (A codec ExoPlayer cannot decode inside a native container is caught by the
// error fallback.)
export function conclusiveWithoutSniff(p: Probe): boolean {
  return p.container !== 'unknown' && p.container !== 'mp4' && p.container !== 'mov';
}
