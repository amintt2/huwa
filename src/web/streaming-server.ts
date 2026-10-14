// Streaming server choice of this browser (docs/WEB_DOCKER_PLAN.md P1, D10, D12).
//
// Like Stremio Web's `?streamingServer=<url>`: a link can propose a server, the user confirms it
// (the server sees what they watch), the choice stays in this browser. Réglages → Serveur de
// streaming shows it with a capability badge from `GET <server>/api/v1/info` (Huwa Server,
// docs/server-api.md §10) or `GET <server>/settings` (stock Stremio streaming server).
import { useEffect, useState, useSyncExternalStore } from 'react';

import { cleanUrl, useWebConfig, webConfig } from './config';

const KEY = 'huwa/web/streaming-server/v1';
const PARAM = 'streamingServer';
const PROBE_TIMEOUT_MS = 5000;

type Stored = { url: string | null; at: number };

function read(): Stored | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Stored;
    return v && (v.url === null || typeof v.url === 'string') ? { url: v.url === null ? null : cleanUrl(v.url), at: Number(v.at) || 0 } : null;
  } catch {
    return null;
  }
}

let stored: Stored | null = read();
let pending: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Saves the user's choice; `null` = explicitly none (ignore the instance default too). */
export function setStreamingServer(url: string | null) {
  const clean = url === null ? null : cleanUrl(url);
  if (url !== null && !clean) throw new Error('Adresse invalide : elle doit commencer par https:// (ou http:// sur ton réseau).');
  stored = { url: clean, at: Date.now() };
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Private mode: the choice lasts for this tab.
  }
  emit();
}

/** Back to the instance default (forget the user's choice). */
export function resetStreamingServer() {
  stored = null;
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    // ignore
  }
  emit();
}

export type ServerChoice = { url: string | null; source: 'user' | 'instance' | 'none' };

export function streamingServer(): ServerChoice {
  if (stored) return { url: stored.url, source: stored.url ? 'user' : 'none' };
  const d = webConfig().defaultStreamingServer;
  return d ? { url: d, source: 'instance' } : { url: null, source: 'none' };
}

let choiceSnap: ServerChoice = streamingServer();
const choiceSnapshot = () => {
  const next = streamingServer();
  if (next.url !== choiceSnap.url || next.source !== choiceSnap.source) choiceSnap = next;
  return choiceSnap;
};

export function useStreamingServer(): ServerChoice {
  useWebConfig(); // the instance default may arrive after the first render
  return useSyncExternalStore(subscribe, choiceSnapshot, choiceSnapshot);
}

// ---------- ?streamingServer= ----------

/**
 * Reads `?streamingServer=` from the current URL (any route), removes it from the address bar so
 * a reload does not ask again, and keeps it as the pending proposal for the confirmation dialog.
 * Returns the proposed URL when it differs from the current choice.
 */
export function takeServerParam(): string | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const raw = url.searchParams.get(PARAM);
  if (raw === null) return null;
  url.searchParams.delete(PARAM);
  window.history.replaceState(window.history.state, '', url.pathname + (url.search === '?' ? '' : url.search) + url.hash);
  const clean = cleanUrl(raw);
  if (!clean || clean === streamingServer().url) return null;
  pending = clean;
  emit();
  return clean;
}

export const pendingServer = () => pending;

export function usePendingServer(): string | null {
  return useSyncExternalStore(subscribe, pendingServer, pendingServer);
}

export function resolvePending(accept: boolean) {
  const url = pending;
  pending = null;
  if (accept && url) setStreamingServer(url);
  else emit();
}

// ---------- capability probe ----------

export type ServerKind = 'huwa' | 'stremio';

export type Probe =
  | { state: 'checking' }
  | { state: 'ok'; kind: ServerKind; name: string; version?: string; features: string[] }
  | { state: 'error'; reason: 'mixed' | 'unreachable' | 'unknown' };

const FEATURE_LABELS: Record<string, string> = {
  torrent: 'Torrents',
  httpProxy: 'Proxy HTTP',
  transcode: 'Transcodage',
  fetchProxy: 'Sources web',
  stremioCompat: 'Compatible Stremio',
  p2pGateway: 'Passerelle P2P',
};

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' }, credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** `https://` page → `http://` server is blocked by the browser, except on localhost. */
export function mixedContent(server: string, page = typeof location === 'undefined' ? '' : location.protocol): boolean {
  try {
    const u = new URL(server);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.hostname.endsWith('.localhost');
    return page === 'https:' && u.protocol === 'http:' && !local;
  } catch {
    return false;
  }
}

/** Interprets `/api/v1/info` (Huwa Server). Missing features count as false. */
export function parseHuwaInfo(body: unknown): Extract<Probe, { state: 'ok' }> | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.api !== 'number' && b.name !== 'huwa-server') return null;
  const feats = (b.features && typeof b.features === 'object' ? b.features : {}) as Record<string, unknown>;
  const features = Object.keys(FEATURE_LABELS).filter((k) => feats[k] === true).map((k) => FEATURE_LABELS[k]);
  return { state: 'ok', kind: 'huwa', name: 'Huwa Server', version: typeof b.version === 'string' ? b.version : undefined, features };
}

/** Interprets `GET /settings` (Stremio streaming server). */
export function parseStremioSettings(body: unknown): Extract<Probe, { state: 'ok' }> | null {
  if (!body || typeof body !== 'object') return null;
  const values = (body as Record<string, unknown>).values;
  if (!values || typeof values !== 'object') return null;
  const v = values as Record<string, unknown>;
  const version = typeof v.serverVersion === 'string' ? v.serverVersion : undefined;
  if (!version && !('cacheSize' in v)) return null;
  return { state: 'ok', kind: 'stremio', name: 'Serveur Stremio', version, features: ['Torrents', 'Transcodage'] };
}

export async function probeServer(url: string, signal?: AbortSignal): Promise<Probe> {
  if (mixedContent(url)) return { state: 'error', reason: 'mixed' };
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal?.addEventListener('abort', abort);
  const timer = setTimeout(abort, PROBE_TIMEOUT_MS);
  let reached = false;
  try {
    try {
      const huwa = parseHuwaInfo(await getJson(`${url}/api/v1/info`, ctrl.signal));
      reached = true;
      if (huwa) return huwa;
    } catch {
      // not a Huwa server, or down: try the Stremio probe
    }
    try {
      const stremio = parseStremioSettings(await getJson(`${url}/settings`, ctrl.signal));
      reached = true;
      if (stremio) return stremio;
    } catch {
      // fall through
    }
    return { state: 'error', reason: reached ? 'unknown' : 'unreachable' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** Probe of `url`, refreshed when it changes or `attempt` is bumped. */
export function useServerProbe(url: string | null, attempt = 0): Probe | null {
  const [probe, setProbe] = useState<{ url: string; attempt: number; probe: Probe } | null>(null);
  useEffect(() => {
    if (!url) return;
    const ctrl = new AbortController();
    probeServer(url, ctrl.signal).then((p) => {
      if (!ctrl.signal.aborted) setProbe({ url, attempt, probe: p });
    });
    return () => ctrl.abort();
  }, [url, attempt]);
  if (!url) return null;
  return probe && probe.url === url && probe.attempt === attempt ? probe.probe : { state: 'checking' };
}

export const _internal = { KEY, PARAM };
