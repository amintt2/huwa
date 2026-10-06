// "Compression intelligente": should a downloaded episode be re-encoded, and at which bitrate?
// Pure, unit-tested in __tests__/compress.test.ts. The encoding itself is native
// (modules/huwa-transcode: AVAssetReader/Writer, hardware HEVC encoder).
//
// Flat-shaded animation compresses extremely well: HEVC at ~2.2 Mb/s for 1080p (≈ 0.044 bits per
// pixel at 24 fps) is visually near-lossless on a phone; "Économie maximale" goes to ~1.5 Mb/s.
// Web releases are often H.264 at 4–8 Mb/s, so the saving is typically 50–70 %. Re-encoding a
// file that is already lean costs battery for nothing (and loses a generation), so a file is
// only touched when the expected saving is at least 25 %.
//
// Files the encoder cannot read (MKV, AVI…, or an MP4 with DTS / TrueHD / MP3 audio, Hi10P,
// MPEG-4 Part 2, hev1…) keep their original, which the player opens with mpv.
import { nativeGap } from '@/components/player/engines/policy';

export type CompressMode = 'off' | 'balanced' | 'max';

export const COMPRESS_LABEL: Record<CompressMode, string> = {
  off: 'Désactivée',
  balanced: 'Équilibrée',
  max: 'Économie maximale',
};

export type MediaInfo = {
  /** 'mp4' | 'mov' | 'mkv' | 'webm' | 'movpkg' | … (file extension / probe). */
  container: string;
  /** Video FourCC: avc1 / hvc1 / hev1 / av01 / vp09… (lowercase). */
  codec: string | null;
  width: number;
  height: number;
  durationSec: number;
  sizeBytes: number;
  fps?: number | null;
  /** Codec tags of the engine policy (`sniffLocalFile`): audio included, unlike `codec`. */
  codecs?: string[];
};

/** Inputs AVFoundation reads (MKV / WebM / AVI are not). HLS packages keep their downloaded variant. */
export const READABLE = new Set(['mp4', 'm4v', 'mov']);
const EFFICIENT = new Set(['hvc1', 'hev1', 'av01', 'vp09']);
export const MIN_SAVING = 0.25;

/** Target HEVC video bitrate (bit/s) for a resolution class, at 24 fps. */
const TARGET_KBPS: Record<Exclude<CompressMode, 'off'>, [number, number][]> = {
  // [max height, kb/s] — first row whose height ≥ the video's.
  balanced: [[480, 800], [576, 1000], [720, 1300], [1080, 2200], [1440, 3600], [2160, 6000]],
  max: [[480, 550], [576, 700], [720, 900], [1080, 1500], [1440, 2500], [2160, 4000]],
};
const AUDIO_BPS: Record<Exclude<CompressMode, 'off'>, number> = { balanced: 160_000, max: 128_000 };

export function targetVideoBps(height: number, mode: Exclude<CompressMode, 'off'>, fps?: number | null): number {
  const rows = TARGET_KBPS[mode];
  const kbps = (rows.find(([h]) => height <= h) ?? rows[rows.length - 1])[1];
  // More frames need more bits, sub-linearly (motion between frames is smaller).
  const f = Math.min(Math.max((fps || 24) / 24, 1), 2.5) ** 0.75;
  return Math.round(kbps * 1000 * f);
}

export const bitrateBps = (m: Pick<MediaInfo, 'sizeBytes' | 'durationSec'>) => (m.durationSec > 0 ? (m.sizeBytes * 8) / m.durationSec : 0);

/** Bits per pixel per frame of the whole file (audio included, so slightly pessimistic). */
export function bitsPerPixel(m: MediaInfo): number {
  const px = m.width * m.height * (m.fps || 24);
  return px > 0 ? bitrateBps(m) / px : 0;
}

export type CompressDecision =
  | { compress: true; videoBps: number; audioBps: number; estimatedBytes: number; saving: number; reason: string }
  | { compress: false; reason: string; unsupported?: boolean; estimatedBytes?: number; saving?: number };

const pct = (x: number) => `${Math.round(x * 100)} %`;

export function decideCompression(m: MediaInfo, mode: CompressMode): CompressDecision {
  if (mode === 'off') return { compress: false, reason: 'Compression désactivée.' };
  const c = m.container.toLowerCase();
  if (c === 'movpkg' || c === 'hls') return { compress: false, reason: 'HLS : la qualité est déjà choisie au téléchargement, l’original est gardé.' };
  if (!READABLE.has(c)) {
    return { compress: false, unsupported: true, reason: `${c.toUpperCase()} : format non lu par l’encodeur de l’iPhone, l’original est gardé.` };
  }
  // AVAssetReader skips a DTS / MP3 track (the result would be silent) and fails on Hi10P & co.
  const gap = m.codecs?.length ? nativeGap(m.codecs) : null;
  if (gap) return { compress: false, unsupported: true, reason: `${gap} : non lu par l’encodeur de l’iPhone, l’original est gardé (lu avec mpv).` };
  if (!(m.durationSec > 0) || !(m.sizeBytes > 0) || !(m.width > 0) || !(m.height > 0)) {
    return { compress: false, reason: 'Durée ou taille inconnue : l’original est gardé.' };
  }
  const videoBps = targetVideoBps(m.height, mode, m.fps);
  const audioBps = AUDIO_BPS[mode];
  // Container overhead ≈ 1 %.
  const estimatedBytes = Math.round((((videoBps + audioBps) * m.durationSec) / 8) * 1.01);
  const saving = 1 - estimatedBytes / m.sizeBytes;
  const codec = (m.codec ?? '').toLowerCase();
  const bpp = bitsPerPixel(m);
  // Already HEVC / AV1 / VP9 at a low bitrate: re-encoding would only lose quality.
  if (EFFICIENT.has(codec) && bpp < 0.08) {
    return { compress: false, reason: `Déjà en ${codec === 'av01' ? 'AV1' : codec === 'vp09' ? 'VP9' : 'HEVC'} à faible débit : rien à gagner.`, estimatedBytes, saving };
  }
  if (saving < MIN_SAVING) {
    return { compress: false, reason: `Gain estimé trop faible (${pct(Math.max(saving, 0))}) : l’original est gardé.`, estimatedBytes, saving };
  }
  return { compress: true, videoBps, audioBps, estimatedBytes, saving, reason: `≈ ${pct(saving)} d’espace gagné.` };
}

export type PowerState = { batteryLevel: number; charging: boolean; lowPower: boolean };

/** Encoding runs only on power or with more than half the battery, never in Low Power Mode. */
export const canCompressNow = (p: PowerState | null) =>
  !!p && !p.lowPower && (p.charging || p.batteryLevel < 0 /* unknown (simulator) */ || p.batteryLevel > 0.5);

export function powerReason(p: PowerState | null): string | null {
  if (!p) return 'Encodeur indisponible dans ce build.';
  if (p.lowPower) return 'En attente : mode économie d’énergie activé.';
  if (!canCompressNow(p)) return 'En attente : branche l’appareil ou attends plus de 50 % de batterie.';
  return null;
}

/** The encoded file is kept only when it plays to the same length and is really smaller. */
export function verifyOutput(input: { durationSec: number; sizeBytes: number }, output: { durationSec: number; sizeBytes: number }): string | null {
  if (!(output.sizeBytes > 0)) return 'fichier vide';
  if (output.sizeBytes >= input.sizeBytes) return 'pas plus petit que l’original';
  const tolerance = Math.max(0.5, input.durationSec * 0.005);
  if (Math.abs(output.durationSec - input.durationSec) > tolerance) {
    return `durée différente (${output.durationSec.toFixed(1)} s au lieu de ${input.durationSec.toFixed(1)} s)`;
  }
  return null;
}

/**
 * Space a mode would save on the given downloads (settings estimate). Episodes whose media is not
 * known yet are assumed to be 1080p H.264 MP4 at their size and duration.
 */
export function estimateSaving(items: { container: string; codec?: string | null; width?: number; height?: number; durationSec?: number; sizeBytes: number; compressed?: boolean }[], mode: CompressMode): number {
  let saved = 0;
  for (const i of items) {
    if (i.compressed || !i.durationSec) continue;
    const d = decideCompression(
      { container: i.container, codec: i.codec ?? 'avc1', width: i.width || 1920, height: i.height || 1080, durationSec: i.durationSec, sizeBytes: i.sizeBytes },
      mode,
    );
    if (d.compress) saved += i.sizeBytes - d.estimatedBytes;
  }
  return saved;
}
