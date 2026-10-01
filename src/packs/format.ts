// Extension packs (`huwaPack` v1, see PLAN.md → "Packs d'extensions"): a shareable list of video
// addons (Stremio manifests) and manhwa repositories (Paperback), installed after confirmation.
// Huwa never ships, hosts or lists packs: users create and share them. Pure module (unit-tested).
import { deflateSync, inflateSync } from 'fflate';

import { base64ToBytes, bytesToBase64, utf8DecodeStrict, utf8Encode } from '../manga-ext/b64';
import { isBlockedHost, parseHttpUrl } from '../manga-ext/net';

export const PACK_VERSION = 1;
export const MAX_ENTRIES = 50;
export const MAX_SOURCES_PER_REPO = 50;
export const MAX_URL = 2048;
/** Decoded JSON size limit (also caps decompression). */
export const MAX_JSON_BYTES = 64 * 1024;
/** Encoded payload (`d=`) length limit. */
export const MAX_PAYLOAD_CHARS = 48 * 1024;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;
const MAX_AUTHOR = 60;
const SOURCE_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export const SITE = 'https://huwa.mciut.fr';

export type PackVideo = { manifest: string; name?: string };
export type PackManga = { repo: string; sources?: string[]; name?: string };
export type Pack = { huwaPack: 1; name: string; description?: string; author?: string; video: PackVideo[]; manga: PackManga[] };

export class PackError extends Error {}

const fail = (msg: string): never => {
  throw new PackError(msg);
};

const text = (v: unknown, max: number, field: string): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') fail(`Pack invalide : « ${field} » doit être un texte`);
  const s = (v as string).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
};

/** http(s) URL, no loopback host, no credentials, bounded length. */
function httpUrl(v: unknown, field: string): string {
  if (typeof v !== 'string') return fail(`Pack invalide : ${field} manquant`);
  const url = v.trim();
  if (url.length > MAX_URL) fail(`Pack invalide : ${field} trop long`);
  const p = parseHttpUrl(url);
  if (!p) return fail(`Pack invalide : ${field} doit être une adresse http(s)`);
  if (isBlockedHost(p.host)) fail(`Pack invalide : ${field} pointe vers une adresse locale`);
  if (/^https?:\/\/[^/?#]*@/i.test(url)) fail(`Pack invalide : ${field} contient un identifiant`);
  return url;
}

/** Canonical Stremio manifest URL (`…/manifest.json`) — same rules as `normalizeAddonUrl`. */
export function canonicalManifest(url: string): string {
  const base = url.trim().replace(/[?#].*$/, '').replace(/\/manifest\.json$/i, '').replace(/\/configure\/?$/i, '').replace(/\/+$/, '');
  return `${base}/manifest.json`;
}

/** Canonical Paperback repository base (no trailing slash, no `versioning.json`) — same as `normalizeRepoUrl`. */
export function canonicalRepo(url: string): string {
  return url.trim().replace(/[?#].*$/, '').replace(/\/(versioning\.json|index\.html)$/i, '').replace(/\/+$/, '');
}

const dedupeKey = (u: string) => u.replace(/^https?:\/\//i, '').toLowerCase();

/** Strict validation of an untrusted pack (parsed JSON). Returns a canonical, deduplicated pack. */
export function validatePack(json: unknown): Pack {
  if (!json || typeof json !== 'object' || Array.isArray(json)) fail('Ce n’est pas un pack Huwa');
  const j = json as Record<string, unknown>;
  if (j.huwaPack !== PACK_VERSION) {
    fail(typeof j.huwaPack === 'number' && j.huwaPack > PACK_VERSION ? 'Pack créé par une version plus récente de Huwa : mets l’app à jour' : 'Ce n’est pas un pack Huwa');
  }
  const name = text(j.name, MAX_NAME, 'name');
  if (!name) fail('Pack invalide : il n’a pas de nom');
  const video = j.video ?? [];
  const manga = j.manga ?? [];
  if (!Array.isArray(video) || !Array.isArray(manga)) fail('Pack invalide : « video » et « manga » doivent être des listes');
  if ((video as unknown[]).length + (manga as unknown[]).length > MAX_ENTRIES * 2) fail(`Pack trop grand (${MAX_ENTRIES} extensions maximum)`);

  const outVideo: PackVideo[] = [];
  const seenVideo = new Set<string>();
  for (const raw of video as unknown[]) {
    if (!raw || typeof raw !== 'object') fail('Pack invalide : entrée vidéo illisible');
    const e = raw as Record<string, unknown>;
    const manifest = canonicalManifest(httpUrl(e.manifest, 'le lien du manifest'));
    const k = dedupeKey(manifest);
    if (seenVideo.has(k)) continue;
    seenVideo.add(k);
    const entryName = text(e.name, MAX_NAME, 'name');
    outVideo.push(entryName ? { manifest, name: entryName } : { manifest });
  }

  const outManga: PackManga[] = [];
  const byRepo = new Map<string, PackManga>();
  for (const raw of manga as unknown[]) {
    if (!raw || typeof raw !== 'object') fail('Pack invalide : entrée manhwa illisible');
    const e = raw as Record<string, unknown>;
    const repo = canonicalRepo(httpUrl(e.repo, 'l’adresse du dépôt'));
    if (!parseHttpUrl(repo)) fail('Pack invalide : adresse du dépôt');
    if (e.sources !== undefined && !Array.isArray(e.sources)) fail('Pack invalide : « sources » doit être une liste');
    const sources: string[] = [];
    for (const s of (e.sources as unknown[] | undefined) ?? []) {
      if (typeof s !== 'string' || !SOURCE_ID.test(s)) fail('Pack invalide : identifiant de source incorrect');
      sources.push(s as string);
    }
    const entryName = text(e.name, MAX_NAME, 'name');
    const k = dedupeKey(repo);
    const prev = byRepo.get(k);
    if (prev) {
      const merged = [...new Set([...(prev.sources ?? []), ...sources])];
      if (merged.length) prev.sources = merged;
      if (!prev.name && entryName) prev.name = entryName;
    } else {
      const entry: PackManga = { repo };
      if (sources.length) entry.sources = [...new Set(sources)];
      if (entryName) entry.name = entryName;
      byRepo.set(k, entry);
      outManga.push(entry);
    }
  }
  for (const m of outManga) {
    if ((m.sources?.length ?? 0) > MAX_SOURCES_PER_REPO) fail(`Pack trop grand (${MAX_SOURCES_PER_REPO} sources maximum par dépôt)`);
  }

  if (outVideo.length + outManga.length > MAX_ENTRIES) fail(`Pack trop grand (${MAX_ENTRIES} extensions maximum)`);
  if (!outVideo.length && !outManga.length) fail('Ce pack ne contient aucune extension');

  const pack: Pack = { huwaPack: 1, name: name!, video: outVideo, manga: outManga };
  const description = text(j.description, MAX_DESCRIPTION, 'description');
  const author = text(j.author, MAX_AUTHOR, 'author');
  if (description) pack.description = description;
  if (author) pack.author = author;
  return pack;
}

/** Parses + validates pack JSON text (size-limited). */
export function parsePackJson(textJson: string): Pack {
  if (textJson.length > MAX_JSON_BYTES) fail('Pack trop volumineux');
  let json: unknown;
  try {
    json = JSON.parse(textJson);
  } catch {
    return fail('Ce n’est pas un pack Huwa (JSON illisible)');
  }
  return validatePack(json);
}

/** Minified JSON, keys in a stable order, optional fields omitted. */
export function packJson(pack: Pack): string {
  const out: Record<string, unknown> = { huwaPack: 1, name: pack.name };
  if (pack.description) out.description = pack.description;
  if (pack.author) out.author = pack.author;
  out.video = pack.video.map((v) => (v.name ? { manifest: v.manifest, name: v.name } : { manifest: v.manifest }));
  out.manga = pack.manga.map((m) => {
    const e: Record<string, unknown> = { repo: m.repo };
    if (m.sources?.length) e.sources = m.sources;
    if (m.name) e.name = m.name;
    return e;
  });
  return JSON.stringify(out);
}

// ---------- payload (`d=`) ----------

const toB64Url = (bytes: Uint8Array) => bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * `d=` payload: base64url of the minified JSON, or `z` + base64url of its raw DEFLATE
 * (whichever is shorter). Plain JSON payloads always start with `ey` (`{"`), never `z`.
 */
export function encodePack(pack: Pack): string {
  const bytes = utf8Encode(packJson(validatePack(pack)));
  const plain = toB64Url(bytes);
  const packed = `z${toB64Url(deflateSync(bytes, { level: 9 }))}`;
  return packed.length < plain.length ? packed : plain;
}

export function decodePack(payload: string): Pack {
  const d = payload.trim();
  if (!d) fail('Lien de pack vide');
  if (d.length > MAX_PAYLOAD_CHARS) fail('Lien de pack trop long');
  if (!/^z?[A-Za-z0-9_-]+$/.test(d)) fail('Lien de pack abîmé (caractères inattendus)');
  let bytes: Uint8Array;
  try {
    if (d[0] === 'z') {
      // Bounded output buffer: a crafted payload cannot inflate past the JSON limit.
      const out = inflateSync(base64ToBytes(d.slice(1)), { out: new Uint8Array(MAX_JSON_BYTES + 1) });
      if (out.length > MAX_JSON_BYTES) return fail('Pack trop volumineux');
      bytes = out;
    } else bytes = base64ToBytes(d);
  } catch (e) {
    if (e instanceof PackError) throw e;
    return fail('Lien de pack abîmé (il a peut-être été coupé)');
  }
  const json = utf8DecodeStrict(bytes);
  if (json === undefined) fail('Lien de pack abîmé (texte illisible)');
  return parsePackJson(json!);
}

// ---------- links ----------

export type PackRef = { d: string } | { url: string };

export const packAppLink = (ref: PackRef) =>
  'd' in ref ? `huwa://pack?d=${ref.d}` : `huwa://pack?url=${encodeURIComponent(ref.url)}`;

/** Web page that shows the pack and opens Huwa. The payload stays in the fragment: never sent to the server. */
export const packWebLink = (ref: PackRef) => ('d' in ref ? `${SITE}/pack.html#${ref.d}` : `${SITE}/pack.html#url=${encodeURIComponent(ref.url)}`);

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

function refFromParams(q: string): PackRef | undefined {
  for (const part of q.split('&')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i);
    const v = part.slice(i + 1);
    if (k === 'd' && v) return { d: v };
    if (k === 'url' && v) {
      const url = safeDecode(v);
      if (url && parseHttpUrl(url)) return { url };
    }
  }
  return undefined;
}

/**
 * Recognizes a pack link: `huwa://pack?d=…` / `huwa://pack?url=…` and the site page
 * `https://huwa.mciut.fr/pack.html#<payload>` (also `#d=…`, `#url=…`, `/pack#…`).
 */
export function parsePackLink(input: string): PackRef | undefined {
  const s = input.trim();
  const app = /^huwa:\/\/\/?pack\/?\?(.*)$/i.exec(s);
  if (app) return refFromParams(app[1].replace(/#.*$/, ''));
  const web = /^https?:\/\/(?:www\.)?huwa\.mciut\.fr\/pack(?:\.html)?\/?(?:\?[^#]*)?#(.+)$/i.exec(s);
  if (web) {
    const frag = web[1];
    if (/^(d|url)=/.test(frag)) return refFromParams(frag);
    return /^z?[A-Za-z0-9_-]+$/.test(frag) ? { d: frag } : undefined;
  }
  return undefined;
}

// ---------- classification of any pasted link ----------

/** Paperback repositories are folders with `versioning.json` (0.8) or a `/<version>` subfolder. */
export const looksLikePaperbackRepo = (u: string) =>
  /versioning\.json$/i.test(u) || /(^|\/\/)[^/]*github\.io\/[^?#]*(extensions|sources|paperback)/i.test(u) || /paperback/i.test(u);

export type PastedLink =
  | { kind: 'pack'; ref: PackRef }
  | { kind: 'addon'; url: string }
  | { kind: 'paperback'; url: string };

function queryParam(q: string, key: string) {
  for (const part of q.split('&')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === key) return safeDecode(part.slice(i + 1).replace(/\+/g, ' '));
  }
  return undefined;
}

/**
 * What a pasted / scanned text designates: a pack (link or JSON URL), a Stremio addon or a
 * Paperback repository. Undefined when it is none of them.
 */
export function classifyLink(input: string): PastedLink | undefined {
  const s = input.trim();
  if (!s || s.length > MAX_PAYLOAD_CHARS + 200) return undefined;
  const ref = parsePackLink(s);
  if (ref) return { kind: 'pack', ref };
  if (/^huwa:\/\/\/?pack\b/i.test(s)) return undefined;

  const huwa = /^huwa:\/\/\/?([a-z-]+)\/?\?([^#]*)/i.exec(s);
  if (huwa) {
    const action = huwa[1].toLowerCase();
    if (action === 'paperback') {
      const repo = queryParam(huwa[2], 'repo') ?? queryParam(huwa[2], 'url');
      return repo ? { kind: 'paperback', url: repo } : undefined;
    }
    if (action === 'addon' || action === 'install') {
      const url = queryParam(huwa[2], 'url');
      if (!url) return undefined;
      const type = queryParam(huwa[2], 'type');
      const pb = action === 'install' && (type === 'paperback' || (type !== 'stremio' && looksLikePaperbackRepo(url)));
      return pb ? { kind: 'paperback', url } : { kind: 'addon', url };
    }
    return undefined;
  }
  if (/^paperback:\/\//i.test(s)) return { kind: 'paperback', url: s };
  if (/^stremio:\/\//i.test(s)) return { kind: 'addon', url: s };

  // Site share link: https://huwa.mciut.fr/extensions?url=…[&type=paperback]
  const site = /^https?:\/\/(?:www\.)?huwa\.mciut\.fr\/extensions(?:\.html)?\/?\?([^#]*)/i.exec(s);
  if (site) {
    const url = queryParam(site[1], 'url');
    if (!url) return undefined;
    const type = queryParam(site[1], 'type');
    return type === 'paperback' || (type !== 'stremio' && looksLikePaperbackRepo(url)) ? { kind: 'paperback', url } : { kind: 'addon', url };
  }

  const url = /^https?:\/\//i.test(s) ? s : /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(s) ? `https://${s}` : undefined;
  if (!url || !parseHttpUrl(url)) return undefined;
  const path = url.replace(/[?#].*$/, '');
  if (/\/manifest\.json$/i.test(path)) return { kind: 'addon', url };
  if (looksLikePaperbackRepo(path)) return { kind: 'paperback', url };
  if (/\.json$/i.test(path)) return { kind: 'pack', ref: { url } };
  return { kind: 'addon', url };
}
