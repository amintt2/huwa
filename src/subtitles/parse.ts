// Entry point: raw bytes or text → SubtitleDoc, whatever the format.
//   - ASS/SSA, SRT, WebVTT, and the old frame/decisecond text formats MicroDVD (`{1}{25}…`,
//     usually `.sub`) and MPL2 (`[1][25]…`, `.txt`), converted to SRT cues
//   - gzip (`.srt.gz`) and ZIP archives (OpenSubtitles-style downloads: the subtitle inside)
//   - bitmap formats (VobSub `.idx/.sub`, PGS `.sup`) are refused with a clear message: they are
//     only drawn by mpv when embedded in the video
import { unzipSync } from 'fflate';

import { isAss, parseAss } from './ass';
import { decodeSubtitleBytes, type Encoding } from './decode';
import { isVtt, parseSrt, parseVtt } from './text';
import type { SubtitleDoc, SubtitleFormat } from './types';

/** Format guessed from a URL or file name (`.srt.gz`, `?format=vtt`…), if any. */
export function formatFromName(name: string): SubtitleFormat | undefined {
  const s = name.toLowerCase().split('#')[0];
  const path = s.split('?')[0].replace(/\.(gz|zip)$/, '');
  const ext = /\.([a-z0-9]{2,4})$/.exec(path)?.[1];
  if (ext === 'ass' || ext === 'ssa' || ext === 'srt' || ext === 'vtt') return ext;
  if (ext === 'webvtt') return 'vtt';
  const q = /[?&](?:format|type|ext)=([a-z]+)/.exec(s)?.[1];
  if (q === 'ass' || q === 'ssa' || q === 'srt' || q === 'vtt') return q;
  return undefined;
}

// ---------- MicroDVD / MPL2 ----------

const MICRODVD_LINE = /^\{(\d+)\}\{(\d*)\}(.*)$/;
const MPL2_LINE = /^\[(\d+)\]\[(\d*)\](.*)$/;

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const isMicroDvd = (text: string) => {
  const l = lines(text.slice(0, 4000));
  return l.length > 0 && l.filter((x) => MICRODVD_LINE.test(x)).length >= Math.max(1, l.length * 0.6);
};
const isMpl2 = (text: string) => {
  const l = lines(text.slice(0, 4000));
  return l.length > 0 && l.filter((x) => MPL2_LINE.test(x)).length >= Math.max(1, l.length * 0.6);
};

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/** MicroDVD / MPL2 line text: `|` = new line, `/` (MPL2) or `{y:i}` = italic, `{…}` codes dropped. */
function cueText(raw: string, mpl2: boolean): string {
  return raw
    .split('|')
    .map((part) => {
      let t = part;
      let italic = false;
      if (mpl2 && t.startsWith('/')) {
        italic = true;
        t = t.slice(1);
      }
      if (/\{y:[^}]*i[^}]*\}/i.test(t)) italic = true;
      const bold = /\{y:[^}]*b[^}]*\}/i.test(t);
      t = t.replace(/\{[a-z]:[^}]*\}/gi, '').trim();
      if (bold) t = `<b>${t}</b>`;
      return italic ? `<i>${t}</i>` : t;
    })
    .join('\n');
}

/** MicroDVD (frames; `{1}{1}23.976` sets the frame rate, 23.976 otherwise) → SRT text. */
export function microDvdToSrt(text: string, defaultFps = 23.976): string {
  let fps = defaultFps;
  const out: string[] = [];
  let n = 0;
  for (const line of lines(text)) {
    const m = MICRODVD_LINE.exec(line);
    if (!m) continue;
    const [start, end] = [Number(m[1]), m[2] ? Number(m[2]) : NaN];
    if (n === 0 && start <= 1 && (end <= 1 || isNaN(end)) && /^\d+(\.\d+)?$/.test(m[3].trim())) {
      const f = Number(m[3].trim());
      if (f > 1 && f < 200) fps = f;
      continue;
    }
    const stop = isNaN(end) ? start + fps * 3 : end;
    out.push(`${++n}\n${srtTime(start / fps)} --> ${srtTime(stop / fps)}\n${cueText(m[3], false)}\n`);
  }
  return out.join('\n');
}

/** MPL2 (deciseconds) → SRT text. */
export function mpl2ToSrt(text: string): string {
  const out: string[] = [];
  let n = 0;
  for (const line of lines(text)) {
    const m = MPL2_LINE.exec(line);
    if (!m) continue;
    const start = Number(m[1]) / 10;
    const end = m[2] ? Number(m[2]) / 10 : start + 3;
    out.push(`${++n}\n${srtTime(start)} --> ${srtTime(end)}\n${cueText(m[3], true)}\n`);
  }
  return out.join('\n');
}

/** Parses subtitle text, sniffing the format from the content (the extension is only a hint). */
export function parseSubtitleText(text: string, hint?: SubtitleFormat): SubtitleDoc {
  const body = text.replace(/^﻿/, '');
  if (isVtt(body)) return parseVtt(body);
  if (isAss(body)) return parseAss(body);
  if (body.includes('-->')) return parseSrt(body);
  if (isMicroDvd(body)) return parseSrt(microDvdToSrt(body));
  if (isMpl2(body)) return parseSrt(mpl2ToSrt(body));
  if (hint === 'ass' || hint === 'ssa') return parseAss(body);
  return parseSrt(body);
}

export type ParsedFile = {
  doc: SubtitleDoc;
  encoding: Encoding;
  gzip: boolean;
  /** Decoded text of the file (ASS: handed to mpv's libass renderer, see Player.tsx). */
  text: string;
  /** Name of the subtitle file taken from a ZIP archive. */
  zipEntry?: string;
};

export class SubtitleParseError extends Error {}

const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** Subtitle files inside an archive, best first (text formats only; bitmap pairs are refused). */
const ZIP_PREF = ['ass', 'ssa', 'srt', 'vtt', 'sub', 'txt'];

function fromZip(bytes: Uint8Array, hint?: SubtitleFormat): ParsedFile {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => f.originalSize < 20 * 1024 * 1024 && ZIP_PREF.includes(f.name.toLowerCase().split('.').pop() ?? '') && !/(^|\/)__macosx\//i.test(f.name),
    });
  } catch {
    throw new SubtitleParseError('Fichier archive illisible.');
  }
  const names = Object.keys(files).sort((a, b) => {
    const ea = ZIP_PREF.indexOf(a.toLowerCase().split('.').pop()!);
    const eb = ZIP_PREF.indexOf(b.toLowerCase().split('.').pop()!);
    // Same format: the biggest first (a full track, not a signs-only one).
    return ea - eb || files[b].length - files[a].length;
  });
  let firstError: unknown;
  for (const name of names) {
    try {
      return { ...parseSubtitleBytes(files[name], formatFromName(name) ?? hint), zipEntry: name };
    } catch (e) {
      firstError ??= e;
    }
  }
  if (firstError instanceof SubtitleParseError && names.length) throw firstError;
  throw new SubtitleParseError('Aucun sous-titre dans cette archive.');
}

/** Bytes (maybe gzipped or zipped, any common encoding) → document. Throws when nothing readable is found. */
export function parseSubtitleBytes(bytes: Uint8Array, hint?: SubtitleFormat): ParsedFile {
  if (isZip(bytes)) return fromZip(bytes, hint);
  // VobSub .sub (MPEG-PS packs) / .idx, PGS .sup: pictures, not text.
  if ((bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0xba) || (bytes[0] === 0x50 && bytes[1] === 0x47 && bytes.length > 13 && [0x14, 0x15, 0x16, 0x17, 0x80].includes(bytes[10]))) {
    throw new SubtitleParseError('Sous-titres en images (VobSub / PGS) : lisibles seulement intégrés à la vidéo.');
  }
  let decoded;
  try {
    decoded = decodeSubtitleBytes(bytes);
  } catch {
    throw new SubtitleParseError('Fichier compressé illisible.');
  }
  if (/^# VobSub index file/i.test(decoded.text)) {
    throw new SubtitleParseError('Sous-titres en images (VobSub / PGS) : lisibles seulement intégrés à la vidéo.');
  }
  if (/\u0000/.test(decoded.text.slice(0, 4000)) || /^PK\u0003\u0004|^Rar!/.test(decoded.text)) {
    throw new SubtitleParseError('Ce n’est pas un fichier de sous-titres (archive ou binaire).');
  }
  const doc = parseSubtitleText(decoded.text, hint);
  if (!doc.events.length) throw new SubtitleParseError('Aucun sous-titre lisible dans ce fichier.');
  return { doc, encoding: decoded.encoding, gzip: decoded.gzip, text: decoded.text.replace(/^﻿/, '') };
}
