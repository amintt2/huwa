// Paperback extension repositories (see docs/PAPERBACK.md). A repository is a static folder:
//   <repo>/versioning.json          index of the sources (+ repository name in 0.9)
//   0.8: <repo>/<Id>/source.js       esbuild IIFE setting `this.Sources = { Id, IdInfo }`
//        <repo>/<Id>/includes/<icon>
//   0.9: <repo>/<Id>/index.js        IIFE `var source = { Id: <instance> }`
//        <repo>/<Id>/static/<icon>, <repo>/<Id>/info.json
import { base64ToBytes, shortHash, utf8DecodeStrict } from './b64';
import { parseHttpUrl } from './net';
import type { PaperbackFormat } from './runtime/protocol';

export type ContentRating = 'EVERYONE' | 'MATURE' | 'ADULT';

export type RepoSource = {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  icon?: string;
  language?: string;
  contentRating: ContentRating;
  tags: string[];
  website?: string;
};

export type RepoIndex = {
  url: string;
  format: PaperbackFormat;
  name: string;
  description?: string;
  types?: string;
  buildTime?: string;
  sources: RepoSource[];
};

export const SOURCE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_SOURCES = 600;

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');

/** Canonical repository base URL (no trailing slash, no `versioning.json`). Throws on anything else than http(s). */
export function normalizeRepoUrl(input: string): string {
  const link = parseRepoLink(input);
  let url = (link?.repo ?? input).trim();
  if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/[?#].*$/, '').replace(/\/(versioning\.json|index\.html)$/i, '').replace(/\/+$/, '');
  const p = parseHttpUrl(url);
  if (!p) throw new Error('Adresse de dépôt invalide');
  return url;
}

export type RepoLink = { repo?: string; name?: string; install?: { id: string; repo: string }[] };

function params(query: string) {
  const out: Record<string, string> = {};
  for (const part of query.split('&')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
    } catch {
      // malformed escape: skip
    }
  }
  return out;
}

function decodeB64Json(s: string): unknown {
  const text = utf8DecodeStrict(base64ToBytes(s.replace(/ /g, '+')));
  return text ? JSON.parse(text) : undefined;
}

/**
 * Links that designate a repository:
 * - `paperback://addRepo?displayName=…&url=<repo>` (Paperback 0.8 and 0.9 repository pages)
 * - `paperback://installExtensions?data=<base64 JSON [[id, repo], …]>` (0.9 pages, selected sources)
 * - `huwa://paperback?repo=<repo>` (Huwa)
 * Returns undefined for a plain URL.
 */
export function parseRepoLink(input: string): RepoLink | undefined {
  const m = /^(paperback|huwa):\/\/\/?([a-z-]+)\??(.*)$/i.exec(input.trim());
  if (!m) return undefined;
  const scheme = m[1].toLowerCase();
  const action = m[2].toLowerCase();
  const q = params(m[3]);
  if (scheme === 'huwa' && action === 'paperback' && q.repo) return { repo: q.repo, name: q.name };
  if (scheme === 'paperback' && action === 'addrepo' && q.url) return { repo: q.url, name: q.displayName };
  if (scheme === 'paperback' && action === 'installextensions' && q.data) {
    try {
      const data = decodeB64Json(q.data);
      if (!Array.isArray(data)) return undefined;
      const install = data
        .filter((x): x is [string, string] => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string' && SOURCE_ID.test(x[0]))
        .slice(0, 50)
        .map(([id, repo]) => ({ id, repo }));
      return install.length ? { repo: install[0].repo, install } : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 0.8 repositories are built with @paperback/types 0.8.x; 0.9 ones with @paperback/types 1.0.0-alpha.x. */
export function detectFormat(json: Record<string, unknown>): PaperbackFormat {
  const built = (json.builtWith ?? {}) as Record<string, unknown>;
  const types = str(built.types ?? built.common, 40);
  if (/^0\.8\./.test(types)) return '0.8';
  if (/^1\./.test(types)) return '0.9';
  if (/^[0-5]\./.test(types)) throw new Error(`Dépôt Paperback trop ancien (types ${types}) : seuls 0.8 et 0.9 sont pris en charge`);
  const first = Array.isArray(json.sources) ? (json.sources[0] as Record<string, unknown> | undefined) : undefined;
  if (first && ('capabilities' in first || 'developers' in first || 'badges' in first)) return '0.9';
  if (first && ('intents' in first || 'desc' in first || 'websiteBaseURL' in first)) return '0.8';
  throw new Error('Format de dépôt inconnu');
}

const rating = (v: unknown): ContentRating => (v === 'ADULT' ? 'ADULT' : v === 'MATURE' ? 'MATURE' : 'EVERYONE');

export function parseVersioning(json: unknown, url: string): RepoIndex {
  if (!json || typeof json !== 'object' || !Array.isArray((json as { sources?: unknown }).sources)) throw new Error('versioning.json invalide');
  const j = json as Record<string, unknown>;
  const format = detectFormat(j);
  const seen = new Set<string>();
  const sources: RepoSource[] = [];
  for (const raw of (j.sources as unknown[]).slice(0, MAX_SOURCES)) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const id = str(s.id, 64);
    if (!SOURCE_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const devs = Array.isArray(s.developers) ? (s.developers as { name?: unknown }[]).map((d) => str(d?.name, 60)).filter(Boolean) : [];
    const tags = format === '0.9' ? (Array.isArray(s.badges) ? s.badges : []) : Array.isArray(s.tags) ? s.tags : [];
    const icon = str(s.icon, 100);
    sources.push({
      id,
      name: str(s.name, 80) || id,
      description: str(format === '0.9' ? s.description : s.desc, 400),
      version: str(s.version, 40) || '0',
      author: format === '0.9' ? devs.join(', ') : str(s.author, 100),
      icon: /^[A-Za-z0-9_.-]{1,100}$/.test(icon) ? icon : undefined,
      language: str(s.language, 16) || undefined,
      contentRating: rating(s.contentRating),
      tags: (tags as { label?: unknown; text?: unknown }[]).map((t) => str(t?.label ?? t?.text, 40)).filter(Boolean).slice(0, 8),
      website: format === '0.8' ? str(s.websiteBaseURL, 200) || undefined : undefined,
    });
  }
  const repo = (j.repository ?? {}) as Record<string, unknown>;
  const base = normalizeRepoUrl(url);
  return {
    url: base,
    format,
    name: str(repo.name, 80) || hostLabel(base),
    description: str(repo.description, 300) || undefined,
    types: str(((j.builtWith ?? {}) as Record<string, unknown>).types, 40) || undefined,
    buildTime: str(j.buildTime, 40) || undefined,
    sources,
  };
}

const hostLabel = (url: string) => {
  const p = parseHttpUrl(url);
  return p ? `${p.host}${p.path === '/' ? '' : p.path}` : url;
};

export const versioningUrl = (repo: string) => `${repo}/versioning.json`;
export const bundleUrl = (repo: string, format: PaperbackFormat, id: string) => `${repo}/${id}/${format === '0.9' ? 'index.js' : 'source.js'}`;
export const iconUrl = (repo: string, format: PaperbackFormat, id: string, icon?: string) =>
  icon ? `${repo}/${id}/${format === '0.9' ? 'static' : 'includes'}/${icon}` : undefined;

/** Stable key of an installed source: `<repo hash>.<id>` (safe for file names and SecureStore). */
export const sourceKey = (repo: string, id: string) => `${shortHash(repo)}.${id}`;

/** Loose semver-ish comparison ("1.0.0-alpha.27" < "1.0.0-alpha.28" < "1.0.0"). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main, pre] = v.split('-', 2);
    return { main: main.split('.').map((x) => parseInt(x, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.main.length, y.main.length); i++) {
    const d = (x.main[i] ?? 0) - (y.main[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const px = x.pre.split('.');
  const py = y.pre.split('.');
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    const [p, q] = [px[i], py[i]];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const [np, nq] = [Number(p), Number(q)];
    if (!Number.isNaN(np) && !Number.isNaN(nq)) return np - nq;
    return p < q ? -1 : 1;
  }
  return 0;
}
