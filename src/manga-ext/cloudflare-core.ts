// Cloudflare "human check" for extension sources, the pure part (no React Native import, unit-tested):
// - spotting a challenge in a response (status, headers, body) or in an extension's error;
// - which host a verification is for, and which pages the verification WebView may open;
// - the clearance kept per host (User-Agent + expiry of `cf_clearance`) and the cookies copied
//   from the WebView into a source's jar;
// - one verification at a time per host, and a call retried once after it.

/** A source call failed because the site asks for a Cloudflare check (handled by the UI: verification sheet). */
export class CloudflareError extends Error {
  readonly sourceKey: string;
  /** Page to open for the check: the source's own bypass request, else the challenged URL, else its site. */
  readonly url?: string;
  constructor(sourceKey: string, url?: string, message = 'Vérification Cloudflare requise') {
    super(message);
    this.name = 'CloudflareError';
    this.sourceKey = sourceKey;
    this.url = url;
  }
}

export const isCloudflareError = (e: unknown): e is CloudflareError =>
  e instanceof CloudflareError || (!!e && typeof e === 'object' && (e as { name?: unknown }).name === 'CloudflareError');

/** Error of a source call, as a short French sentence for error states. */
export function sourceErrorText(e: unknown): string {
  if (isCloudflareError(e)) return 'Le site demande une vérification Cloudflare.';
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (/délai|ne répond pas|timed? ?out/i.test(m)) return 'La source ne répond pas (délai dépassé).';
  if (/network|réseau|internet|connexion|offline|could not connect|hostname/i.test(m)) return 'Impossible de joindre le site de la source.';
  return m || 'Erreur de la source';
}

// ---------- detection ----------

const CHALLENGE_BODY =
  /<title>\s*(just a moment|attention required|un instant|please wait)|cf-browser-verification|challenge-platform|cf_chl_opt|cf-turnstile|__cf_chl_|cf-challenge|id="challenge-(form|stage|body)"/i;

/**
 * True when a response is a Cloudflare challenge (not a plain 403 from the site):
 * `cf-mitigated: challenge`, or a 403 / 429 / 503 served by Cloudflare whose page is a challenge.
 */
export function isChallengeResponse(r: { status: number; headers: Record<string, string>; body?: string }): boolean {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers ?? {})) h[k.toLowerCase()] = String(v);
  if (/challenge/i.test(h['cf-mitigated'] ?? '')) return true;
  if (r.status !== 403 && r.status !== 503 && r.status !== 429) return false;
  const byCloudflare = /cloudflare/i.test(h.server ?? '') || 'cf-ray' in h;
  if (!byCloudflare) return false;
  if ('cf-chl-bypass' in h) return true;
  return CHALLENGE_BODY.test(r.body ?? '');
}

/** An extension's own error saying the site wants a Cloudflare check (0.9 `CloudflareError`, 0.8 messages). */
export function isCloudflareMessage(message: string): boolean {
  return /cloudflare|cf[\s_-]?clearance|bypass\s+error|challenging requests|\bcf\b.*\bchallenge/i.test(message);
}

/** A call that "worked" but brought back nothing (a challenge page parsed as an empty list). */
export function looksEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  for (const k of ['items', 'results', 'sections', 'pages', 'chapters']) {
    if (k in o) return Array.isArray(o[k]) && (o[k] as unknown[]).length === 0;
  }
  return false;
}

// ---------- hosts ----------

export function hostOf(url: string | undefined): string | undefined {
  const m = /^https?:\/\/(?:[^/?#@\s]*@)?([^/?#:\s]+)/i.exec(url ?? '');
  return m ? m[1].toLowerCase().replace(/\.+$/, '') : undefined;
}

const SECOND_LEVEL = /^(co|com|net|org|gov|edu|ac|or|ne|go)$/;
/** Registrable domain, approximated (`www.asura.gg` → `asura.gg`, `a.b.co.uk` → `b.co.uk`). */
export function baseDomain(host: string): string {
  const parts = host.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2 || /^\d+$/.test(parts[parts.length - 1])) return parts.join('.');
  const n = SECOND_LEVEL.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join('.');
}

/** `host` is `domain` or one of its subdomains. */
export const domainMatch = (host: string, domain: string) => {
  const h = host.toLowerCase();
  const d = domain.toLowerCase().replace(/^\./, '');
  return h === d || h.endsWith(`.${d}`);
};

/** Hosts Cloudflare serves its challenge pages and scripts from. */
const CHALLENGE_HOSTS = ['challenges.cloudflare.com'];

/**
 * Pages the verification WebView may load: http(s) only, the source's site (same registrable
 * domain) and Cloudflare's challenge host. Everything else (ads, other sites, app links) is refused.
 */
export function allowedInVerifier(url: string, siteHost: string, isBlockedHost: (h: string) => boolean): boolean {
  if (url === 'about:blank' || url === 'about:srcdoc') return true;
  if (!/^https?:\/\//i.test(url)) return false;
  const h = hostOf(url);
  if (!h || isBlockedHost(h)) return false;
  return domainMatch(h, baseDomain(siteHost)) || CHALLENGE_HOSTS.some((c) => domainMatch(h, c));
}

// ---------- cookies & clearance ----------

/** A cookie read from the WebView store (native module). `expires` in ms since epoch, absent for session cookies. */
export type WebCookie = { name: string; value: string; domain: string; path?: string; expires?: number; secure?: boolean; httpOnly?: boolean };

/** Cookies of the WebView that apply to `host` (domain-matched, not expired), deduplicated by name/domain/path. */
export function cookiesForHost(cookies: WebCookie[], host: string, now = Date.now()): WebCookie[] {
  const out = new Map<string, WebCookie>();
  for (const c of cookies) {
    if (!c || typeof c.name !== 'string' || !c.name || typeof c.value !== 'string' || typeof c.domain !== 'string') continue;
    if (c.expires && c.expires <= now) continue;
    // A cookie set for a parent domain (`.asura.gg`) also covers `www.asura.gg`; one set for a
    // subdomain of the site (`cdn.asura.gg`) is kept too: the source's requests go there.
    const d = c.domain.replace(/^\./, '').toLowerCase();
    if (!domainMatch(host, d) && !domainMatch(d, baseDomain(host))) continue;
    out.set(`${c.name}|${c.domain}|${c.path ?? '/'}`, c);
  }
  return [...out.values()];
}

export type Clearance = { host: string; userAgent: string; expires?: number; at: number };

/** The clearance that applies to a request host (stored for that host or a parent domain), if not expired. */
export function clearanceFor(list: Record<string, Clearance>, host: string, now = Date.now()): Clearance | undefined {
  let best: Clearance | undefined;
  for (const c of Object.values(list)) {
    if (c.expires && c.expires <= now) continue;
    if (!domainMatch(host, c.host) && !domainMatch(host, baseDomain(c.host))) continue;
    if (!best || c.at > best.at) best = c;
  }
  return best;
}

/** Clearance from the WebView's cookies once the check passed: needs `cf_clearance` for that site. */
export function clearanceFrom(cookies: WebCookie[], host: string, userAgent: string, now = Date.now()): Clearance | undefined {
  const cf = cookiesForHost(cookies, host, now).find((c) => c.name === 'cf_clearance');
  if (!cf) return undefined;
  const domain = cf.domain.replace(/^\./, '').toLowerCase();
  return { host: domainMatch(host, domain) ? domain : host, userAgent, expires: cf.expires, at: now };
}

/** Drops expired clearances (kept small: one per site). */
export function pruneClearances(list: Record<string, Clearance>, now = Date.now()): Record<string, Clearance> {
  const out: Record<string, Clearance> = {};
  for (const [k, c] of Object.entries(list)) if (c && typeof c.host === 'string' && (!c.expires || c.expires > now)) out[k] = c;
  return out;
}

// ---------- one verification per host, one retry per call ----------

export type VerifyOutcome = 'verified' | 'cancelled' | 'failed';

/**
 * Serializes verifications: callers hitting the same host while its sheet is open share the same
 * outcome instead of opening it again. `verify` runs the UI.
 */
export function createVerifyGate(verify: (host: string, url: string, sourceKey: string) => Promise<VerifyOutcome>) {
  const running = new Map<string, Promise<VerifyOutcome>>();
  return (host: string, url: string, sourceKey: string): Promise<VerifyOutcome> => {
    const hit = running.get(host);
    if (hit) return hit;
    const p = verify(host, url, sourceKey).finally(() => running.delete(host));
    running.set(host, p);
    return p;
  };
}

/**
 * Runs a source call; on a Cloudflare error, asks for a verification (`interactive`) and retries
 * once when it passed. A second challenge right after a verification is surfaced as is (no loop).
 */
export async function withVerification<T>(
  run: () => Promise<T>,
  ask: (e: CloudflareError) => Promise<VerifyOutcome>,
  interactive: boolean,
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!interactive || !isCloudflareError(e)) throw e;
    const outcome = await ask(e);
    if (outcome !== 'verified') throw e;
    return run();
  }
}
