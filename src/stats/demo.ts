// Plausible figures for the store screenshots (demo mode only, never stored).
import type { CommunityStats } from './community';
import type { AddonStat, PlaybackEvent, PlayPath } from './model';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE: Record<PlayPath, number> = { 'http-direct': 1300, debrid: 1900, 'torrent-engine': 5200, 'web-player': 3400, 'aggregator-playback': 2400 };

export const DEMO_EVENTS: PlaybackEvent[] = (() => {
  const r = rng(11);
  const paths: PlayPath[] = ['http-direct', 'http-direct', 'debrid', 'debrid', 'http-direct', 'torrent-engine', 'aggregator-playback', 'web-player'];
  const out: PlaybackEvent[] = [];
  for (let i = 0; i < 64; i++) {
    const path = paths[Math.floor(r() * paths.length)];
    const warm = path !== 'web-player' && path !== 'torrent-engine' && r() < 0.35;
    const failed = r() < 0.06 ? (path === 'torrent-engine' ? 'timeout' : 'http') : undefined;
    const t = Math.round(BASE[path] * (warm ? 0.45 : 1) * (0.6 + r() * 0.9));
    const stalls = !failed && r() < 0.18 ? 1 + Math.floor(r() * 2) : 0;
    out.push({
      at: Date.now() - (64 - i) * 9 * 3600e3,
      kind: r() < 0.3 ? 'resume' : r() < 0.3 ? 'next' : 'start',
      path,
      engine: path === 'web-player' ? undefined : r() < 0.15 ? 'mpv' : 'native',
      warm,
      tSources: Math.round(250 + r() * 500),
      tDecision: Math.round(600 + r() * 700),
      tUrl: Math.round(650 + r() * 900),
      tFirstFrame: failed ? undefined : t,
      stalls,
      stalledMs: stalls * Math.round(800 + r() * 2500),
      failed,
      fallbackToMpv: r() < 0.05,
      network: r() < 0.8 ? 'wifi' : 'cellular',
    });
  }
  return out;
})();

export const DEMO_ADDONS: Record<string, AddonStat> = {
  'community.anime.kitsu': { name: 'Anime Kitsu', ok: 58, fail: 1, ms: [420, 380, 510, 460, 390, 610] },
  'org.stremio.torrentio': { name: 'Torrentio', ok: 61, fail: 3, ms: [880, 940, 1210, 760, 1020] },
  'com.huwa.vostfr': { name: 'VOSTFR Direct', ok: 44, fail: 6, ms: [650, 720, 1900, 540, 610] },
};

export const DEMO_COMMUNITY: CommunityStats = {
  contributions: 143,
  h: {
    'http-direct': [40, 260, 410, 330, 260, 120, 70, 30, 14, 8, 4],
    debrid: [10, 90, 220, 310, 330, 190, 110, 45, 20, 8, 4],
    'torrent-engine': [0, 4, 10, 18, 40, 60, 80, 70, 60, 30, 18],
    'web-player': [2, 20, 40, 70, 110, 90, 60, 30, 12, 6, 3],
  },
  s: [4890, 312, 640],
};
