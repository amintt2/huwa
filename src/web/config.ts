// Runtime configuration of a Huwa web instance (docs/WEB_DOCKER_PLAN.md P1, §5).
//
// The same static build serves huwa.mciut.fr and every self-hosted image: what differs comes from
// `/huwa-config.json`, written by the instance (huwa-server builds it from its env, the `-web`
// image ships a static one). Missing, unreachable or malformed → safe defaults: the public catalog
// works, nothing points at a server the operator did not choose.
//
// Schema (version 1; unknown fields are ignored, missing ones take the default):
//   {
//     "v": 1,
//     "instanceName": "Huwa",                  // shown in the shell and the page title
//     "defaultGateway": "wss://host/p2p",      // P2P gateway (dht-relay, rendezvous), or null
//     "defaultStreamingServer": "https://host", // preselected streaming server, or null
//     "relayKeys": ["<64 hex>"],               // blind-peer relays offered to new accounts
//     "operatorContact": "mailto:…",           // shown in Réglages → À propos de l'instance
//     "features": { "p2p": false, "streaming": false, "addons": true, "install": true }
//   }
import { useSyncExternalStore } from 'react';
import { setWebGateway } from '@/p2p/web/gateway';

export type WebFeatures = {
  /** The browser P2P node may use `defaultGateway` (phase 3). */
  p2p: boolean;
  /** The instance itself is a streaming server (huwa-server image, not the `-web` one). */
  streaming: boolean;
  /** Addons / extensions can be installed (an operator may hide them). */
  addons: boolean;
  /** Offer "Installer l'app" (PWA install prompt). */
  install: boolean;
};

export type WebConfig = {
  v: 1;
  instanceName: string;
  defaultGateway: string | null;
  defaultStreamingServer: string | null;
  relayKeys: string[];
  operatorContact: string | null;
  features: WebFeatures;
  /** Where the values came from: the instance file, or the built-in defaults. */
  source: 'instance' | 'defaults';
};

export const DEFAULT_CONFIG: WebConfig = {
  v: 1,
  instanceName: 'Huwa',
  defaultGateway: null,
  defaultStreamingServer: null,
  relayKeys: [],
  operatorContact: null,
  features: { p2p: false, streaming: false, addons: true, install: true },
  source: 'defaults',
};

const CONFIG_URL = '/huwa-config.json';
const TIMEOUT_MS = 4000;

/** http(s) URL without a trailing slash, or null. `ws` allows ws(s) (gateway). */
export function cleanUrl(value: unknown, ws = false): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(value.trim());
    const ok = ws ? ['ws:', 'wss:', 'http:', 'https:'] : ['http:', 'https:'];
    if (!ok.includes(u.protocol) || u.username || u.password) return null;
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Validates a raw `/huwa-config.json` body; anything off falls back field by field. */
export function parseConfig(raw: unknown): WebConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_CONFIG;
  const r = raw as Record<string, unknown>;
  const f = (r.features && typeof r.features === 'object' ? r.features : {}) as Record<string, unknown>;
  // Huwa Server's /huwa-config.json (docs/server-api.md §14) nests these: server, p2p, instance.
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const server = obj(r.server);
  const p2p = obj(r.p2p);
  const instance = obj(r.instance);
  const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
  const absolute = (v: unknown) => {
    if (typeof v !== 'string' || !v.trim()) return null;
    try {
      return new URL(v, typeof server.url === 'string' && server.url ? server.url : base).href;
    } catch {
      return null;
    }
  };
  const serverStreams = f.torrent === true || f.transcode === true;
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const rawName = typeof r.instanceName === 'string' ? r.instanceName : typeof instance.name === 'string' ? instance.name : '';
  const name = rawName.trim() ? rawName.trim().slice(0, 40) : DEFAULT_CONFIG.instanceName;
  const relayKeys = Array.isArray(r.relayKeys) ? r.relayKeys.filter((k): k is string => typeof k === 'string' && /^[0-9a-f]{64}$/i.test(k)).slice(0, 8) : [];
  const rawContact = typeof r.operatorContact === 'string' ? r.operatorContact : typeof instance.operatorContact === 'string' ? instance.operatorContact : '';
  const contact = /^(mailto:|https:\/\/)/.test(rawContact) ? rawContact.slice(0, 200) : null;
  return {
    v: 1,
    instanceName: name,
    defaultGateway: cleanUrl(r.defaultGateway ?? absolute(p2p.gateway), true),
    // A Huwa Server with the engine or ffmpeg streams for its own web app.
    defaultStreamingServer: cleanUrl(r.defaultStreamingServer ?? (serverStreams ? absolute(server.url || '/') : null)),
    relayKeys,
    operatorContact: contact,
    features: {
      p2p: bool(f.p2p ?? f.p2pGateway, DEFAULT_CONFIG.features.p2p),
      streaming: bool(f.streaming ?? (serverStreams || undefined), DEFAULT_CONFIG.features.streaming),
      addons: bool(f.addons, DEFAULT_CONFIG.features.addons),
      install: bool(f.install, DEFAULT_CONFIG.features.install),
    },
    source: 'instance',
  };
}

let current: WebConfig = DEFAULT_CONFIG;
let loading: Promise<WebConfig> | null = null;
const listeners = new Set<() => void>();

/** Fetches the instance config once (no-cache: the service worker revalidates it). */
export function loadWebConfig(): Promise<WebConfig> {
  if (loading) return loading;
  loading = (async () => {
    if (typeof fetch === 'undefined') return current;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(CONFIG_URL, { cache: 'no-cache', signal: ctrl.signal, headers: { accept: 'application/json' } });
      // The SPA fallback answers unknown paths with index.html: only JSON counts.
      if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) current = parseConfig(await res.json());
      // The browser P2P node connects to this instance's gateway (same-origin /p2p otherwise).
      if (current.defaultGateway) setWebGateway(current.defaultGateway);
    } catch {
      // Offline or no file: defaults.
    } finally {
      clearTimeout(timer);
    }
    listeners.forEach((l) => l());
    return current;
  })();
  return loading;
}

export const webConfig = () => current;

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useWebConfig(): WebConfig {
  return useSyncExternalStore(subscribe, webConfig, webConfig);
}
