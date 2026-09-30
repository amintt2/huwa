// Entry point: raw bytes or text → SubtitleDoc, whatever the format.
import { isAss, parseAss } from './ass';
import { decodeSubtitleBytes, type Encoding } from './decode';
import { isVtt, parseSrt, parseVtt } from './text';
import type { SubtitleDoc, SubtitleFormat } from './types';

/** Format guessed from a URL or file name (`.srt.gz`, `?format=vtt`…), if any. */
export function formatFromName(name: string): SubtitleFormat | undefined {
  const s = name.toLowerCase().split('#')[0];
  const path = s.split('?')[0].replace(/\.gz$/, '');
  const ext = /\.([a-z0-9]{2,4})$/.exec(path)?.[1];
  if (ext === 'ass' || ext === 'ssa' || ext === 'srt' || ext === 'vtt') return ext;
  if (ext === 'webvtt') return 'vtt';
  const q = /[?&](?:format|type|ext)=([a-z]+)/.exec(s)?.[1];
  if (q === 'ass' || q === 'ssa' || q === 'srt' || q === 'vtt') return q;
  return undefined;
}

/** Parses subtitle text, sniffing the format from the content (the extension is only a hint). */
export function parseSubtitleText(text: string, hint?: SubtitleFormat): SubtitleDoc {
  const body = text.replace(/^﻿/, '');
  if (isVtt(body)) return parseVtt(body);
  if (isAss(body)) return parseAss(body);
  if (body.includes('-->')) return parseSrt(body);
  if (hint === 'ass' || hint === 'ssa') return parseAss(body);
  return parseSrt(body);
}

export type ParsedFile = { doc: SubtitleDoc; encoding: Encoding; gzip: boolean };

export class SubtitleParseError extends Error {}

/** Bytes (maybe gzipped, any common encoding) → document. Throws when nothing readable is found. */
export function parseSubtitleBytes(bytes: Uint8Array, hint?: SubtitleFormat): ParsedFile {
  let decoded;
  try {
    decoded = decodeSubtitleBytes(bytes);
  } catch {
    throw new SubtitleParseError('Fichier compressé illisible.');
  }
  if (/\u0000/.test(decoded.text.slice(0, 4000)) || /^PK\u0003\u0004|^Rar!/.test(decoded.text)) {
    throw new SubtitleParseError('Ce n’est pas un fichier de sous-titres (archive ou binaire).');
  }
  const doc = parseSubtitleText(decoded.text, hint);
  if (!doc.events.length) throw new SubtitleParseError('Aucun sous-titre lisible dans ce fichier.');
  return { doc, encoding: decoded.encoding, gzip: decoded.gzip };
}
