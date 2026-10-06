// Network-dependent budgets of the torrent engine (pure: no expo-network here, see ./network.ts
// for the hooks that read the connection).

/**
 * Torrents the on-device engine may probe before one is streamed ("course des torrents",
 * src/torrent/peer-race.ts). `base` at first; `max` once every candidate looks weak (obscure
 * titles: only slow swarms), the race then probes more of them (packs, other qualities).
 * Probes cost metadata + a few handshakes, never a piece; the engine runs 8 at most at once.
 */
export type TorrentProbeBudget = { base: number; max: number };

export const NO_TORRENT_PROBES: TorrentProbeBudget = { base: 0, max: 0 };
export const TORRENT_PROBES_UNMETERED: TorrentProbeBudget = { base: 4, max: 8 };
/** Cellular: probes are small, but every one is data and battery. */
export const TORRENT_PROBES_METERED: TorrentProbeBudget = { base: 2, max: 3 };

/** `allowed`: streaming allowed right now (online, not "Wi-Fi seulement" on cellular). */
export function torrentProbeBudget(allowed: boolean, metered: boolean): TorrentProbeBudget {
  if (!allowed) return NO_TORRENT_PROBES;
  return metered ? TORRENT_PROBES_METERED : TORRENT_PROBES_UNMETERED;
}
