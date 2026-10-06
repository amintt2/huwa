// Cloudflare clearances obtained by a human check (see `cloudflare.ts`), one per site: the
// User-Agent of the verification WebView and the expiry of its `cf_clearance` cookie. While one is
// valid, every extension request to that site is sent with that User-Agent (Cloudflare ties the
// clearance to it). Persisted in AsyncStorage; the cookies themselves live in each source's jar.
import AsyncStorage from '@react-native-async-storage/async-storage';

import { clearanceFor, pruneClearances, type Clearance } from './cloudflare-core';

const KEY = 'huwa/pb/cf/v1';

let list: Record<string, Clearance> = {};
let hydration: Promise<void> | undefined;

export function hydrateClearances() {
  hydration ??= AsyncStorage.getItem(KEY)
    .then((raw) => {
      if (raw) list = { ...pruneClearances(JSON.parse(raw) as Record<string, Clearance>), ...list };
    })
    .catch(() => {});
  return hydration;
}

const save = () => AsyncStorage.setItem(KEY, JSON.stringify(pruneClearances(list))).catch(() => {});

/** User-Agent to send to `host` (synchronous: the network layer asks on every request). */
export const userAgentFor = (host: string) => clearanceFor(list, host)?.userAgent;
export const getClearance = (host: string) => clearanceFor(list, host);

export function setClearance(c: Clearance) {
  list = { ...pruneClearances(list), [c.host]: c };
  save();
}

/** The site challenged us again although we had a clearance: it is no longer valid. */
export function dropClearance(host: string) {
  const hit = clearanceFor(list, host);
  if (!hit) return;
  const { [hit.host]: _gone, ...rest } = list;
  list = rest;
  save();
}
