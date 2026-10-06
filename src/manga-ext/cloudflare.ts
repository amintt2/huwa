// Cloudflare check done by the user, like Paperback's cloud button: when a source call is blocked
// by a challenge, a sheet (`CloudflareSheet`) opens the site in a visible WebView, the user ticks
// the check, and the WebView's cookies (incl. the HttpOnly `cf_clearance`, read natively from the
// WKWebView store by `modules/huwa-cookies`) go into that source's cookie jar. Requests to that site
// then carry the WebView's User-Agent (`clearance.ts`), and the blocked call is retried once.
import { useSyncExternalStore } from 'react';

import { HuwaCookies } from '../../modules/huwa-cookies';
import { callSource, lastSiteOf } from './bridge';
import { dropClearance, getClearance, setClearance } from './clearance';
import {
  clearanceFrom,
  cookiesForHost,
  createVerifyGate,
  hostOf,
  isCloudflareError,
  withVerification,
  type CloudflareError,
  type VerifyOutcome,
  type WebCookie,
} from './cloudflare-core';
import { DEFAULT_USER_AGENT, isBlockedHost } from './net';
import { getInstalled } from './registry';
import { jarFor, loadSourceState } from './state';

/** User-Agent of the verification WebView, shared with the extension network layer. */
export const VERIFIER_USER_AGENT = DEFAULT_USER_AGENT;

/** Cookies can be read from the WebView store (native module present: build made after it was added). */
export const canReadWebCookies = !!HuwaCookies;

export type VerifyRequest = { id: number; sourceKey: string; sourceName: string; host: string; url: string };

let current: (VerifyRequest & { resolve: (o: VerifyOutcome) => void }) | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** The verification the sheet must show (`null`: closed). */
export const useVerifyRequest = (): VerifyRequest | null =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );

const gate = createVerifyGate(
  (host, url, sourceKey) =>
    new Promise<VerifyOutcome>((resolve) => {
      // Another site's sheet still open: it is answered first (rare: one at a time on screen).
      current?.resolve('cancelled');
      current = { id: ++seq, sourceKey, sourceName: getInstalled(sourceKey)?.name ?? 'Source', host, url, resolve };
      emit();
    }),
);

/** Page to open for a source: the URL the error gave, its bypass request, its site. */
async function verifyUrl(key: string, hint?: string): Promise<string | undefined> {
  if (hint && hostOf(hint) && !isBlockedHost(hostOf(hint)!)) return hint;
  try {
    const r = (await callSource(key, 'cfRequest', [], 15_000)) as { url?: unknown } | null;
    if (r && typeof r.url === 'string' && hostOf(r.url) && !isBlockedHost(hostOf(r.url)!)) return r.url;
  } catch {
    // the source may itself be blocked while loading: fall back below
  }
  const site = lastSiteOf(key) ?? getInstalled(key)?.website;
  return site && hostOf(site) ? site : undefined;
}

/**
 * Opens the verification sheet for a source (the "Cloudflare" button, or after a blocked call).
 * Resolves when the user is done: `verified` → retry, otherwise keep the error.
 */
export async function verifySource(key: string, hintUrl?: string): Promise<VerifyOutcome> {
  const url = await verifyUrl(key, hintUrl);
  const host = hostOf(url);
  if (!url || !host) return 'failed';
  // Challenged although cleared: the clearance expired or was revoked (new IP, rotated key).
  if (getClearance(host)) dropClearance(host);
  return gate(host, url, key);
}

/** Copies the WebView cookies of the site into the source's jar; returns them. */
async function importCookies(key: string, url: string, pageCookies: WebCookie[]): Promise<WebCookie[]> {
  const host = hostOf(url)!;
  let cookies: WebCookie[] = pageCookies;
  if (HuwaCookies) {
    try {
      cookies = await HuwaCookies.getCookies(url);
    } catch {
      // keep the ones the page could read
    }
  }
  const usable = cookiesForHost(cookies, host);
  await loadSourceState(key);
  const jar = jarFor(key);
  for (const c of usable) jar.put({ ...c, hostOnly: !c.domain.startsWith('.') && c.domain.toLowerCase() === host });
  return usable;
}

/**
 * Called by the sheet. `verified`: the page is past the challenge (or the user tapped "Terminé"),
 * `pageCookies` = what `document.cookie` showed (fallback when the native module is missing),
 * `userAgent` = the WebView's `navigator.userAgent`.
 */
export async function finishVerification(id: number, outcome: VerifyOutcome, opts: { pageCookies?: WebCookie[]; userAgent?: string } = {}) {
  const req = current;
  if (!req || req.id !== id) return;
  current = null;
  emit();
  if (outcome !== 'verified') return req.resolve(outcome);
  try {
    const cookies = await importCookies(req.sourceKey, req.url, opts.pageCookies ?? []);
    const clearance = clearanceFrom(cookies, req.host, opts.userAgent || VERIFIER_USER_AGENT);
    if (clearance) setClearance(clearance);
    // 0.9 sources that keep their own cookie store (CookieStorageInterceptor) get them too.
    callSource(req.sourceKey, 'cfDone', [{ url: req.url }, cookies.map((c) => ({ ...c, expires: c.expires ? new Date(c.expires).toISOString() : undefined }))], 10_000).catch(() => {});
  } catch {
    // retry anyway: the site may have let the WebView through without a clearance cookie
  }
  req.resolve('verified');
}

/** Has the WebView store already got a valid `cf_clearance` for this site? (automatic close). */
export async function hasClearanceCookie(url: string): Promise<boolean> {
  if (!HuwaCookies) return false;
  const host = hostOf(url);
  if (!host) return false;
  try {
    return cookiesForHost(await HuwaCookies.getCookies(url), host).some((c) => c.name === 'cf_clearance' && !!c.value);
  } catch {
    return false;
  }
}

/**
 * Runs a source call; when Cloudflare blocks it and `interactive` (the user is waiting for it:
 * opening a title, reading), asks for the check then retries once.
 */
export function withCloudflare<T>(run: () => Promise<T>, interactive = true): Promise<T> {
  return withVerification(run, (e: CloudflareError) => verifySource(e.sourceKey, e.url), interactive);
}

export { isCloudflareError };
