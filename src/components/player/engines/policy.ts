// Which engine plays a source: the native one (expo-video: AVPlayer / ExoPlayer — hardware
// decoding, PiP, AirPlay, best battery) unless the source needs mpv. Pure functions, unit-tested.
//
// Signals, cheapest first: URL extension → Content-Type → first 4 KiB of the file (Range request,
// see probe.ts). A native playback failure is the last resort (hybrid-player.ts retries with mpv).

export type Engine = 'native' | 'mpv';
export type EnginePref = 'auto' | 'native' | 'mpv';

export type Container =
  | 'mp4' | 'mov' | 'hls' | 'dash' | 'mkv' | 'webm' | 'avi' | 'flv' | 'ts' | 'ogg' | 'wmv' | 'rm' | 'unknown';

/** What we know about a source. `codecs` holds sample-entry FourCCs / Matroska codec ids seen. */
export type Probe = { container: Container; codecs: string[]; via: 'ext' | 'mime' | 'sniff' | 'none' };

export type DeviceCaps = {
  platform: 'ios' | 'android' | 'web' | string;
  mpvAvailable: boolean;
  /** VideoToolbox / MediaCodec hardware decoders of this device. */
  hw: { av1?: boolean; hevc?: boolean; vp9?: boolean };
};

export type Decision = { engine: Engine; reason: string };

const EXT: Record<string, Container> = {
  mp4: 'mp4', m4v: 'mp4', mov: 'mov', m3u8: 'hls', m3u: 'hls', mpd: 'dash',
  mkv: 'mkv', mk3d: 'mkv', webm: 'webm', avi: 'avi', divx: 'avi', flv: 'flv',
  ts: 'ts', m2ts: 'ts', mts: 'ts', vob: 'ts', mpg: 'ts', mpeg: 'ts',
  ogv: 'ogg', ogg: 'ogg', wmv: 'wmv', asf: 'wmv', rm: 'rm', rmvb: 'rm',
};

/** Container from the URL path extension (query and fragment ignored, percent-decoded). */
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
  if (t === 'video/x-msvideo' || t === 'video/avi' || t === 'video/msvideo') return 'avi';
  if (t === 'video/x-flv') return 'flv';
  if (t === 'video/mp2t') return 'ts';
  if (t === 'video/ogg' || t === 'application/ogg') return 'ogg';
  if (t.includes('ms-wmv') || t.includes('ms-asf')) return 'wmv';
  if (t.includes('realmedia')) return 'rm';
  if (t === 'video/quicktime') return 'mov';
  if (t === 'video/mp4' || t === 'audio/mp4' || t === 'video/x-m4v') return 'mp4';
  return 'unknown';
}

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

function indexOfAscii(b: Uint8Array, s: string, from = 0, to = b.length): number {
  const first = s.charCodeAt(0);
  outer: for (let i = from; i <= Math.min(to, b.length) - s.length; i++) {
    if (b[i] !== first) continue;
    for (let j = 1; j < s.length; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

// ISO-BMFF sample entries worth knowing for the decision (video only).
const MP4_CODECS = ['avc1', 'avc3', 'hvc1', 'hev1', 'dvh1', 'dvhe', 'av01', 'vp09', 'vp08'];
// Matroska CodecID strings.
const MKV_CODECS: [string, string][] = [
  ['V_MPEG4/ISO/AVC', 'avc1'], ['V_MPEGH/ISO/HEVC', 'hevc'], ['V_AV1', 'av01'], ['V_VP9', 'vp09'], ['V_VP8', 'vp08'],
  ['S_TEXT/ASS', 'ass'], ['S_TEXT/SSA', 'ass'], ['S_HDMV/PGS', 'pgs'],
];

/** Container + codecs from the first bytes of the file. */
export function sniff(b: Uint8Array): Probe {
  const codecs: string[] = [];
  const none: Probe = { container: 'unknown', codecs, via: 'sniff' };
  if (b.length < 12) return none;
  // Matroska / WebM: EBML magic, DocType in the header.
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const webm = indexOfAscii(b, 'webm', 0, 64) >= 0;
    for (const [id, c] of MKV_CODECS) if (indexOfAscii(b, id) >= 0 && !codecs.includes(c)) codecs.push(c);
    return { container: webm ? 'webm' : 'mkv', codecs, via: 'sniff' };
  }
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    for (const c of MP4_CODECS) if (indexOfAscii(b, c, 12) >= 0) codecs.push(c);
    return { container: brand === 'qt  ' ? 'mov' : 'mp4', codecs, via: 'sniff' };
  }
  const head = ascii(b, 0, 8);
  if (head.startsWith('#EXTM3U')) return { container: 'hls', codecs, via: 'sniff' };
  if (head.startsWith('RIFF') && ascii(b, 8, 4) === 'AVI ') return { container: 'avi', codecs, via: 'sniff' };
  if (head.startsWith('FLV')) return { container: 'flv', codecs, via: 'sniff' };
  if (head.startsWith('OggS')) return { container: 'ogg', codecs, via: 'sniff' };
  if (head.startsWith('.RMF')) return { container: 'rm', codecs, via: 'sniff' };
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return { container: 'wmv', codecs, via: 'sniff' };
  if (b[0] === 0x47 && b.length > 376 && b[188] === 0x47 && b[376] === 0x47) return { container: 'ts', codecs, via: 'sniff' };
  if (indexOfAscii(b, '<MPD', 0, 512) >= 0) return { container: 'dash', codecs, via: 'sniff' };
  return none;
}

// Containers the native engine plays, per platform.
// iOS AVPlayer: MP4/MOV/HLS only. Android ExoPlayer (media3): MP4, MKV, WebM, TS, FLV, Ogg, AVI, HLS, DASH.
const NATIVE_CONTAINERS: Record<string, Container[]> = {
  ios: ['mp4', 'mov', 'hls', 'unknown'],
  android: ['mp4', 'mov', 'hls', 'dash', 'mkv', 'webm', 'ts', 'flv', 'ogg', 'avi', 'unknown'],
};

const LABEL: Partial<Record<Container, string>> = {
  mkv: 'MKV', webm: 'WebM', avi: 'AVI', flv: 'FLV', ts: 'MPEG-TS', ogg: 'Ogg', wmv: 'WMV', rm: 'RealMedia', dash: 'DASH',
};

/** Engine for a source. `probe` may be partial (extension only) or absent. */
export function decideEngine(pref: EnginePref, caps: DeviceCaps, probe: Probe | null): Decision {
  if (!caps.mpvAvailable) return { engine: 'native', reason: pref === 'mpv' ? 'mpv indisponible dans cette version' : '' };
  if (pref === 'native') return { engine: 'native', reason: 'réglage' };
  if (pref === 'mpv') return { engine: 'mpv', reason: 'réglage' };
  if (!probe) return { engine: 'native', reason: '' };

  const nativeOk = NATIVE_CONTAINERS[caps.platform] ?? NATIVE_CONTAINERS.ios;
  if (!nativeOk.includes(probe.container)) return { engine: 'mpv', reason: `conteneur ${LABEL[probe.container] ?? probe.container}` };

  const has = (c: string) => probe.codecs.includes(c);
  if (caps.platform === 'ios') {
    if (has('vp09') || has('vp08')) return { engine: 'mpv', reason: has('vp09') ? 'codec VP9' : 'codec VP8' };
    if (has('av01') && !caps.hw.av1) return { engine: 'mpv', reason: 'AV1 sans décodeur matériel' };
    // AVPlayer only accepts HEVC tagged `hvc1` (parameter sets in the sample entry), not `hev1`/`dvhe`.
    if ((has('hev1') || has('dvhe')) && !has('hvc1') && !has('dvh1')) return { engine: 'mpv', reason: 'HEVC hev1' };
  }
  return { engine: 'native', reason: '' };
}

/** Whether a probe is already conclusive without reading the file (skips the Range request). */
// MP4/MOV need their sample entries (AV1, VP9, hev1…); anything else is decided by the container.
// (A codec ExoPlayer cannot decode inside a native container is caught by the error fallback.)
export function conclusiveWithoutSniff(p: Probe): boolean {
  return p.container !== 'unknown' && p.container !== 'mp4' && p.container !== 'mov';
}
