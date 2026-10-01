// Jumping to a comment's anchor from anywhere (pure module state, no React):
// - the watch screen / reader of that episode or chapter registers itself while mounted, so a chip
//   tapped in the comments sheet seeks / turns the page in place and closes the sheet;
// - otherwise the episode / chapter is opened at that moment (`/watch/<ep>?t=767`,
//   `/read/<ch>?page=12`, also reachable as huwa://watch/<ep>?t=767 deep links).
type Handler = (value: number) => void;

const seekers = new Map<string, Handler>();
const pagers = new Map<string, Handler>();

function register(map: Map<string, Handler>, id: string, fn: Handler) {
  map.set(id, fn);
  return () => {
    if (map.get(id) === fn) map.delete(id);
  };
}

/** The player of episode `epId` is on screen: it handles seeks (seconds). */
export const registerSeekTarget = (epId: string, fn: Handler) => register(seekers, epId, fn);
/** The reader of chapter `chId` is on screen: it handles jumps (1-based page). */
export const registerPageTarget = (chId: string, fn: Handler) => register(pagers, chId, fn);

export const watchPath = (epId: string, t: number) => `/watch/${encodeURIComponent(epId)}?t=${Math.max(0, Math.floor(t))}`;
export const readPath = (chId: string, page: number) => `/read/${encodeURIComponent(chId)}?page=${Math.max(1, Math.floor(page))}`;

/**
 * Seek the mounted player, else return the route to open. `true` = handled in place.
 */
export function seekOrRoute(epId: string, t: number): true | string {
  const fn = seekers.get(epId);
  if (fn) {
    fn(t);
    return true;
  }
  return watchPath(epId, t);
}

export function pageOrRoute(chId: string, page: number): true | string {
  const fn = pagers.get(chId);
  if (fn) {
    fn(page);
    return true;
  }
  return readPath(chId, page);
}

/** `?t=767` / `?page=12` route params → number, or undefined. */
export function numericParam(v: string | string[] | undefined, max: number): number | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  if (!s || !/^\d{1,6}$/.test(s)) return undefined;
  const n = Number(s);
  return n <= max ? n : undefined;
}
