// Network classes and the budgets that depend on them (pure: no expo-network / native module
// here, see ./network.ts and ./net-path.ts for what reads the connection).
//
// "Cellular = metered" was too blunt: a 5G plan is often unlimited and faster than the home
// Wi-Fi. iOS says what the connection costs (NWPath `isExpensive`, `isConstrained` = Low Data
// Mode); the user says what they want ("Données mobiles : économie / équilibré / illimité").
//
//   unmetered  Wi-Fi / Ethernet, or cellular with "illimité": every budget at full.
//   cellular   cellular (or a personal hotspot) without Low Data Mode, "équilibré" (default):
//              near-Wi-Fi race and probe budgets, pre-warm allowed, but the torrent engine keeps
//              only a window ahead of the playhead (capped background download) and background
//              quality upgrades stop at 1080p.
//   metered    Low Data Mode (any interface) or "économie": small budgets, no pre-warm.
//   blocked    "Wi-Fi seulement" on cellular: no stream at all.
//   offline    no connection.
import type { RaceBudget } from '@/addons/race-runner';

export type NetClass = 'unmetered' | 'cellular' | 'metered' | 'blocked' | 'offline';
/** Réglages → Lecture → Données mobiles. */
export type CellularData = 'saver' | 'balanced' | 'unlimited';
export const CELLULAR_DATA: CellularData[] = ['saver', 'balanced', 'unlimited'];

/** What the system says about the connection (expo-network type + NWPath flags when known). */
export type NetSignals = {
  type: 'wifi' | 'ethernet' | 'cellular' | 'other' | 'unknown' | 'none';
  connected: boolean;
  /** NWPath.isExpensive: cellular, or Wi-Fi through a phone's hotspot. Undefined = unknown. */
  expensive?: boolean;
  /** NWPath.isConstrained: Low Data Mode is on for this interface. */
  constrained?: boolean;
};

export function classifyNetwork(sig: NetSignals, prefs: { wifiOnly: boolean; cellularData: CellularData }): NetClass {
  if (sig.type === 'none' || !sig.connected) return 'offline';
  const cellular = sig.type === 'cellular';
  // "Wi-Fi seulement" blocks cellular only (a hotspot is Wi-Fi to the app, as before).
  if (prefs.wifiOnly && (cellular || sig.type === 'other')) return 'blocked';
  // Low Data Mode: the user asked the whole system to save data, whatever the interface.
  if (sig.constrained) return 'metered';
  const costly = cellular || (sig.expensive === true && sig.type === 'wifi');
  if (!costly) return 'unmetered';
  if (prefs.cellularData === 'saver') return 'metered';
  if (prefs.cellularData === 'unlimited') return 'unmetered';
  return 'cellular';
}

/** Streaming allowed at all. */
export const canStream = (c: NetClass) => c === 'unmetered' || c === 'cellular' || c === 'metered';
/** Pre-buffering before a tap (pre-search warm player, torrent pre-warm, next-episode buffer). */
export const allowsPrewarm = (c: NetClass) => c === 'unmetered' || c === 'cellular';
/**
 * The torrent engine downloads only a window of ~60–90 s ahead of the playhead (`metered` in
 * `startStream`) instead of the whole file in the background.
 */
export const torrentWindowed = (c: NetClass) => c !== 'unmetered';

// ---------- source race (HTTP probes) ----------

export const NO_RACE: RaceBudget = { max: 0, concurrency: 0, bytes: 0, timeoutMs: 0 };
/**
 * Every candidate at once (up to 10, ≈1.6 MB per episode). Testing in small batches let dead
 * links (often 5–8 s to fail) hold the slots, so good ones waited their turn.
 */
export const RACE_UNMETERED: RaceBudget = { max: 10, concurrency: 10, bytes: 160 * 1024, timeoutMs: 5000 };
/**
 * Cellular without Low Data Mode: near Wi-Fi. 8 links (≈1 MB per episode): with 4, the best
 * link was often never measured and the start fell back to a slower one.
 */
export const RACE_CELLULAR: RaceBudget = { max: 8, concurrency: 8, bytes: 128 * 1024, timeoutMs: 5000 };
/** Low Data Mode / "économie": 4 links, all at once, smaller probes. */
export const RACE_METERED: RaceBudget = { max: 4, concurrency: 4, bytes: 96 * 1024, timeoutMs: 5000 };

export function raceBudget(c: NetClass): RaceBudget {
  if (c === 'unmetered') return RACE_UNMETERED;
  if (c === 'cellular') return RACE_CELLULAR;
  if (c === 'metered') return RACE_METERED;
  return NO_RACE;
}

// ---------- torrent swarm probes ----------

/**
 * Torrents the on-device engine may probe before one is streamed ("course des torrents",
 * src/torrent/peer-race.ts). `base` at first; `max` once every candidate looks weak (obscure
 * titles: only slow swarms), the race then probes more of them (packs, other qualities).
 * Probes cost metadata + a few handshakes, never a piece; the engine runs 8 at most at once.
 */
export type TorrentProbeBudget = { base: number; max: number };

export const NO_TORRENT_PROBES: TorrentProbeBudget = { base: 0, max: 0 };
export const TORRENT_PROBES_UNMETERED: TorrentProbeBudget = { base: 4, max: 8 };
/**
 * Cellular: the same as Wi-Fi. A probe is a few KB; with 3 probes on 5G the race committed to a
 * torrent it had never probed (metadata from the magnet after 17 s, first byte at 35 s).
 */
export const TORRENT_PROBES_CELLULAR: TorrentProbeBudget = { base: 4, max: 8 };
/** Low Data Mode / "économie": still enough to never start a torrent blind. */
export const TORRENT_PROBES_METERED: TorrentProbeBudget = { base: 3, max: 5 };

export function torrentProbeBudgetFor(c: NetClass): TorrentProbeBudget {
  if (c === 'unmetered') return TORRENT_PROBES_UNMETERED;
  if (c === 'cellular') return TORRENT_PROBES_CELLULAR;
  if (c === 'metered') return TORRENT_PROBES_METERED;
  return NO_TORRENT_PROBES;
}

/** `allowed`: streaming allowed right now; `metered`: Low Data Mode / "économie". */
export function torrentProbeBudget(allowed: boolean, metered: boolean): TorrentProbeBudget {
  if (!allowed) return NO_TORRENT_PROBES;
  return metered ? TORRENT_PROBES_METERED : TORRENT_PROBES_UNMETERED;
}

// ---------- HTTP read-ahead proxy (src/components/player/engines/http-proxy.ts) ----------

/**
 * How far the proxy reads ahead of mpv (bytes; mpv's own cache comes on top), and whether a resume
 * also fetches its estimated target at open (a guess from the mean bitrate: up to 2 MiB wasted
 * when it misses, so not on Low Data Mode / "économie").
 */
export type HttpProxyBudget = { readAhead: number; target: boolean };

const MIB = 1024 * 1024;

export function httpProxyBudget(c: NetClass): HttpProxyBudget {
  if (c === 'unmetered') return { readAhead: 8 * MIB, target: true };
  if (c === 'cellular') return { readAhead: 4 * MIB, target: true };
  return { readAhead: 1 * MIB, target: false };
}

// ---------- background source checks (while playing, see addons/source-controller.ts) ----------

/** Re-probes of the alternatives while a source plays: how often, how many per round. */
export type BackgroundProbes = { everyMs: number; count: number; /** only when the current source struggles */ onlyWhenUnhealthy: boolean };

export function backgroundProbes(c: NetClass): BackgroundProbes {
  if (c === 'unmetered') return { everyMs: 45_000, count: 3, onlyWhenUnhealthy: false };
  if (c === 'cellular') return { everyMs: 90_000, count: 2, onlyWhenUnhealthy: false };
  if (c === 'metered') return { everyMs: 60_000, count: 1, onlyWhenUnhealthy: true };
  return { everyMs: Infinity, count: 0, onlyWhenUnhealthy: true };
}

/** Highest resolution a background upgrade may reach on this connection (device cap applied by the caller). */
export function upgradeCap(c: NetClass): number {
  if (c === 'unmetered') return 2160;
  if (c === 'cellular') return 1080;
  return 0;
}
