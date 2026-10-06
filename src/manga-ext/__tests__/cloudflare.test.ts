/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  allowedInVerifier,
  baseDomain,
  clearanceFor,
  clearanceFrom,
  CloudflareError,
  cookiesForHost,
  createVerifyGate,
  isChallengeResponse,
  isCloudflareError,
  isCloudflareMessage,
  looksEmpty,
  pruneClearances,
  sourceErrorText,
  withVerification,
  type Clearance,
  type VerifyOutcome,
  type WebCookie,
} from '../cloudflare-core';
import { CookieJar, createNet, isBlockedHost, parseHttpUrl, type RawFetch } from '../net';

const CHALLENGE_PAGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';

test('challenge detection: cf-mitigated, Cloudflare 403/503 challenge pages', () => {
  assert.equal(isChallengeResponse({ status: 403, headers: { 'cf-mitigated': 'challenge', server: 'cloudflare' } }), true);
  assert.equal(isChallengeResponse({ status: 503, headers: { Server: 'cloudflare', 'CF-RAY': 'x' }, body: CHALLENGE_PAGE }), true);
  assert.equal(isChallengeResponse({ status: 403, headers: { server: 'cloudflare' }, body: '<title>Attention Required! | Cloudflare</title>' }), true);
  assert.equal(isChallengeResponse({ status: 429, headers: { 'cf-ray': 'x' }, body: '<div class="cf-turnstile"></div>' }), true);
});

test('challenge detection: plain errors and normal pages are not challenges', () => {
  assert.equal(isChallengeResponse({ status: 200, headers: { server: 'cloudflare' }, body: CHALLENGE_PAGE.replace('Just a moment', 'Home') }), false);
  assert.equal(isChallengeResponse({ status: 403, headers: { server: 'nginx' }, body: CHALLENGE_PAGE }), false);
  assert.equal(isChallengeResponse({ status: 403, headers: { server: 'cloudflare' }, body: '<h1>Forbidden</h1>' }), false);
  assert.equal(isChallengeResponse({ status: 404, headers: { server: 'cloudflare' }, body: CHALLENGE_PAGE }), false);
});

test('extension messages that mean Cloudflare', () => {
  assert.ok(isCloudflareMessage('CLOUDFLARE BYPASS ERROR: Please go to the homepage'));
  assert.ok(isCloudflareMessage('Asura Scans is challenging requests (HTTP 403). Open the site in a browser'));
  assert.ok(!isCloudflareMessage('Chapter 41 is in early access'));
});

test('empty listings', () => {
  assert.ok(looksEmpty(null));
  assert.ok(looksEmpty([]));
  assert.ok(looksEmpty({ items: [] }));
  assert.ok(looksEmpty({ results: [], metadata: {} }));
  assert.ok(!looksEmpty({ items: [{ id: 1 }] }));
  assert.ok(!looksEmpty({ mangaInfo: {} }));
});

test('error class survives a structural check and gets a French text', () => {
  const e = new CloudflareError('repo|Asura', 'https://asura.gg/');
  assert.ok(isCloudflareError(e));
  assert.ok(isCloudflareError({ name: 'CloudflareError' }));
  assert.ok(!isCloudflareError(new Error('x')));
  assert.match(sourceErrorText(e), /Cloudflare/);
  assert.match(sourceErrorText(new Error('Délai réseau dépassé')), /ne répond pas/);
});

test('registrable domain', () => {
  assert.equal(baseDomain('www.asurascans.com'), 'asurascans.com');
  assert.equal(baseDomain('cdn.site.co.uk'), 'site.co.uk');
  assert.equal(baseDomain('asura.gg'), 'asura.gg');
});

test('verification WebView: source site and Cloudflare only', () => {
  const ok = (u: string) => allowedInVerifier(u, 'asurascans.com', isBlockedHost);
  assert.ok(ok('https://asurascans.com/'));
  assert.ok(ok('https://www.asurascans.com/comics/x'));
  assert.ok(ok('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile'));
  assert.ok(ok('about:blank'));
  assert.ok(!ok('https://ads.example.com/'));
  assert.ok(!ok('https://asurascans.com.evil.io/'));
  assert.ok(!ok('itms-apps://apps.apple.com/'));
  assert.ok(!ok('http://127.0.0.1:8081/'));
  assert.ok(!ok('javascript:alert(1)'));
});

const NOW = 1_800_000_000_000;
const cookies: WebCookie[] = [
  { name: 'cf_clearance', value: 'abc', domain: '.asurascans.com', path: '/', expires: NOW + 3600e3, httpOnly: true, secure: true },
  { name: 'session', value: 's', domain: 'asurascans.com' },
  { name: 'old', value: 'o', domain: '.asurascans.com', expires: NOW - 1 },
  { name: 'other', value: 'x', domain: '.example.com' },
  { name: 'img', value: 'i', domain: 'cdn.asurascans.com' },
];

test('cookies for a host: domain-matched, unexpired', () => {
  const names = cookiesForHost(cookies, 'asurascans.com', NOW).map((c) => c.name).sort();
  assert.deepEqual(names, ['cf_clearance', 'img', 'session']);
  // Cookies of sibling hosts of the site are kept too: the jar applies host-only scoping per request.
  assert.deepEqual(cookiesForHost(cookies, 'www.asurascans.com', NOW).map((c) => c.name).sort(), ['cf_clearance', 'img', 'session']);
  assert.deepEqual(cookiesForHost(cookies, 'example.org', NOW), []);
});

test('clearance: from the cf_clearance cookie, scoped to its domain, expiring with it', () => {
  const c = clearanceFrom(cookies, 'www.asurascans.com', 'UA/1', NOW)!;
  assert.equal(c.host, 'asurascans.com');
  assert.equal(c.userAgent, 'UA/1');
  assert.equal(c.expires, NOW + 3600e3);
  assert.equal(clearanceFrom(cookies.filter((x) => x.name !== 'cf_clearance'), 'asurascans.com', 'UA', NOW), undefined);

  const list: Record<string, Clearance> = { [c.host]: c, 'old.io': { host: 'old.io', userAgent: 'x', expires: NOW - 1, at: 0 } };
  assert.equal(clearanceFor(list, 'cdn.asurascans.com', NOW)?.userAgent, 'UA/1');
  assert.equal(clearanceFor(list, 'asurascans.com', NOW + 3600e3 + 1), undefined);
  assert.equal(clearanceFor(list, 'old.io', NOW), undefined);
  assert.equal(clearanceFor(list, 'example.com', NOW), undefined);
  assert.deepEqual(Object.keys(pruneClearances(list, NOW)), ['asurascans.com']);
});

test('jar: WebView cookies are merged with scoping, replacement and expiry', () => {
  const jar = new CookieJar();
  const site = parseHttpUrl('https://asurascans.com/comics/x')!;
  jar.set(site, 'session=old; Path=/');
  for (const c of cookiesForHost(cookies, 'asurascans.com', NOW)) jar.put({ ...c, expires: c.expires ? Date.now() + 60e3 : undefined });
  const h = jar.header(site);
  assert.match(h, /cf_clearance=abc/);
  assert.match(h, /session=s/);
  assert.doesNotMatch(h, /session=old/);
  assert.doesNotMatch(h, /img=/); // host-only cookie of the CDN
  assert.match(jar.header(parseHttpUrl('https://cdn.asurascans.com/a.webp')!), /cf_clearance=abc/);
  assert.equal(jar.header(parseHttpUrl('https://example.com/')!), '');
  jar.put({ name: 'gone', value: '1', domain: '.asurascans.com', expires: Date.now() - 1 });
  assert.doesNotMatch(jar.header(site), /gone/);
  jar.put({ name: 'evil', value: '1', domain: 'localhost' });
  assert.equal(jar.header(parseHttpUrl('http://localhost/')!), '');
});

test('network: forced User-Agent on cleared hosts, challenge reported', async () => {
  const seen: Record<string, string>[] = [];
  const fetcher: RawFetch = async (url, init) => {
    seen.push(init.headers);
    const blocked = url.includes('/blocked');
    return {
      url,
      status: blocked ? 403 : 200,
      headers: blocked ? { server: 'cloudflare', 'cf-ray': '1' } : { 'content-type': 'text/html' },
      setCookies: [],
      body: new TextEncoder().encode(blocked ? CHALLENGE_PAGE : 'ok'),
    };
  };
  const challenges: string[] = [];
  const jar = new CookieJar();
  const net = createNet(fetcher, {
    jar: () => jar,
    userAgentFor: (h) => (h.endsWith('asurascans.com') ? 'WebViewUA' : undefined),
    onChallenge: (_k, u) => challenges.push(u),
  });
  const ok = await net.request('s', { url: 'https://asurascans.com/', method: 'GET', headers: { 'user-agent': 'Source/1' } });
  assert.equal(ok.challenge, undefined);
  assert.equal(seen[0]['User-Agent'], 'WebViewUA');
  assert.ok(!('user-agent' in seen[0]));
  await net.request('s', { url: 'https://other.org/', method: 'GET', headers: { 'User-Agent': 'Source/1' } });
  assert.equal(seen[1]['User-Agent'], 'Source/1');
  const blocked = await net.request('s', { url: 'https://asurascans.com/blocked', method: 'GET', headers: {} });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.challenge, true);
  assert.deepEqual(challenges, ['https://asurascans.com/blocked']);
});

test('retry: one verification shared per host, one retry per call, no loop', async () => {
  let opened = 0;
  let release!: (o: VerifyOutcome) => void;
  const gate = createVerifyGate(() => {
    opened++;
    return new Promise<VerifyOutcome>((r) => (release = r));
  });
  const a = gate('asura.gg', 'https://asura.gg/', 'k');
  const b = gate('asura.gg', 'https://asura.gg/', 'k');
  assert.equal(opened, 1);
  release('verified');
  assert.equal(await a, 'verified');
  assert.equal(await b, 'verified');
  gate('asura.gg', 'https://asura.gg/', 'k');
  assert.equal(opened, 2); // a later block opens it again

  // blocked once, verified, then works
  let calls = 0;
  const flaky = () => (++calls === 1 ? Promise.reject(new CloudflareError('k')) : Promise.resolve('data'));
  assert.equal(await withVerification(flaky, async () => 'verified', true), 'data');
  assert.equal(calls, 2);

  // still blocked after the check: surfaced, not retried forever
  calls = 0;
  const always = () => (calls++, Promise.reject(new CloudflareError('k')));
  await assert.rejects(withVerification(always, async () => 'verified', true), isCloudflareError);
  assert.equal(calls, 2);

  // cancelled, background (not interactive), other errors: no prompt / no retry
  calls = 0;
  await assert.rejects(withVerification(always, async () => 'cancelled', true), isCloudflareError);
  assert.equal(calls, 1);
  let asked = 0;
  await assert.rejects(withVerification(always, async () => (asked++, 'verified'), false), isCloudflareError);
  await assert.rejects(withVerification(() => Promise.reject(new Error('404')), async () => (asked++, 'verified'), true), /404/);
  assert.equal(asked, 0);
});
