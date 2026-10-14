// Acceptance tests of the public web app (docs/WEB_DOCKER_PLAN.md P1), on the exported build.
//
//   npm run build:web
//   npm run test:web          (node --test, Playwright's Chromium)
//
// Playwright is a devDependency of packages/rocksdb-idb (npm ci there once); `HUWA_WEB_URL` tests
// a deployed instance instead of serving dist/ locally.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { serve } from './serve.mjs';

type Page = any;
type Browser = any;

const root = join(import.meta.dirname, '..', '..');

function loadPlaywright() {
  for (const from of [join(root, 'package.json'), join(root, 'packages', 'rocksdb-idb', 'package.json')]) {
    try {
      return createRequire(from)('playwright');
    } catch {
      // next
    }
  }
  return null;
}

const pw = loadPlaywright();
const PORT = 8140 + Math.floor(Math.random() * 50);
const BASE = process.env.HUWA_WEB_URL ?? `http://localhost:${PORT}`;

let server: { close: () => void } | null = null;
let browser: Browser;

/** Console errors of a page, except the network ones of third-party hosts (AniList rate limits). */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m: { type: () => string; text: () => string; location: () => { url?: string } }) => {
    if (m.type() !== 'error') return;
    const where = m.location().url ?? '';
    if (where && !where.startsWith(BASE)) return;
    // AniList rate-limits (429 without CORS headers): third-party, not ours.
    if (/graphql\.anilist\.co|status of 429/.test(m.text())) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e: Error) => errors.push(String(e)));
  return errors;
}

async function open(path: string, viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(BASE + path);
  return { context, page, errors };
}

describe('huwa web', { skip: pw ? false : 'playwright introuvable (npm ci dans packages/rocksdb-idb)' }, () => {
  before(async () => {
    if (!process.env.HUWA_WEB_URL) server = await serve(join(root, 'dist'), PORT);
    browser = await pw.chromium.launch();
  });
  after(async () => {
    await browser?.close();
    server?.close();
  });

  test('desktop: public board with the rail, the top search and no console error', async () => {
    const { context, page, errors } = await open('/');
    await page.getByRole('navigation', { name: 'Navigation principale' }).waitFor({ timeout: 20_000 });
    for (const label of ['Accueil', 'Anime', 'Manhwa', 'Bibliothèque', 'Calendrier', 'Extensions', 'Réglages']) {
      await page.getByRole('link', { name: label, exact: true }).waitFor();
    }
    await page.getByRole('textbox', { name: 'Rechercher' }).waitFor();
    await page.getByText('Prochaines sorties').first().waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('desktop: play while signed out opens the sign-in sheet, Escape closes it', async () => {
    const { context, page } = await open('/');
    const play = page.getByRole('region', { name: 'À la une' }).getByRole('button', { name: /^(Regarder|Reprendre|Commencer|Lecture)/ }).first();
    await play.click({ timeout: 20_000 });
    const sheet = page.getByRole('dialog', { name: 'Connecte-toi pour lire' });
    await sheet.waitFor();
    await sheet.getByRole('button', { name: 'Lier avec mon téléphone (QR)' }).waitFor();
    await sheet.getByRole('button', { name: 'Phrase de récupération' }).waitFor();
    await sheet.getByRole('button', { name: 'Créer un compte dans ce navigateur' }).waitFor();
    assert.match(page.url(), /\/watch\//);
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
    assert.equal(new URL(page.url()).pathname, '/');
    await context.close();
  });

  test('desktop: a direct /watch link shows the sheet, not a blank page', async () => {
    const { context, page, errors } = await open('/watch/al1-e1');
    await page.getByRole('dialog', { name: 'Connecte-toi pour lire' }).waitFor({ timeout: 20_000 });
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('phone: bottom tab bar, no rail, hero art not shifted', async () => {
    const { context, page, errors } = await open('/', { width: 390, height: 844 });
    await page.getByRole('tab', { name: /Accueil/ }).waitFor({ timeout: 20_000 });
    assert.equal(await page.getByRole('navigation', { name: 'Navigation principale' }).count(), 0);
    const hero = page.getByRole('region', { name: 'À la une' });
    await hero.waitFor();
    const box = await hero.boundingBox();
    assert.equal(Math.round(box.x), 0);
    // The visible slide's art starts at the left edge (it used to be shifted 40 % to the right).
    const shift = await page.evaluate(() => {
      const region = document.querySelector('[aria-label="À la une"]');
      const img = [...(region?.querySelectorAll('img') ?? [])].find((i) => !(i.closest('[inert]')));
      return img ? Math.round(img.getBoundingClientRect().left) : 0;
    });
    assert.equal(shift, 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('profile tab signed out = sign-in screen', async () => {
    const { context, page } = await open('/profile');
    await page.getByRole('heading', { name: 'Connecte-toi à Huwa' }).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Lier avec mon téléphone (QR)' }).waitFor();
    await context.close();
  });

  test('?streamingServer= asks, persists, and shows in Réglages', async () => {
    const { context, page } = await open('/calendar?streamingServer=https://stream.example.org:11470/');
    const dialog = page.getByRole('dialog', { name: 'Utiliser ce serveur de streaming ?' });
    await dialog.waitFor({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Utiliser ce serveur' }).click();
    await dialog.waitFor({ state: 'detached' });
    const stored = await page.evaluate(() => localStorage.getItem('huwa/web/streaming-server/v1'));
    assert.equal(JSON.parse(stored).url, 'https://stream.example.org:11470');
    await page.waitForFunction(() => !location.search.includes('streamingServer'));
    await page.reload();
    await page.getByRole('navigation', { name: 'Navigation principale' }).waitFor({ timeout: 20_000 });
    assert.equal(await dialog.count(), 0);
    await page.goto(BASE + '/settings');
    await page.getByText('https://stream.example.org:11470').first().waitFor({ timeout: 20_000 });
    await page.getByText('Ton choix').first().waitFor();
    await context.close();
  });

  test('signed in (local web profile): extensions and the player open, no sheet', async () => {
    const { context, page, errors } = await open('/profile');
    await page.getByRole('button', { name: 'Créer un compte dans ce navigateur' }).click({ timeout: 20_000 });
    await page.getByRole('textbox', { name: 'Choisis un pseudo' }).fill('testweb');
    await page.getByRole('button', { name: 'Créer mon identité' }).click();
    await page.getByRole('link', { name: /testweb, mon profil/ }).waitFor({ timeout: 20_000 });
    await page.goto(BASE + '/addons');
    await page.getByRole('navigation', { name: 'Navigation principale' }).waitFor({ timeout: 20_000 });
    assert.equal(await page.getByRole('dialog', { name: /Connecte-toi/ }).count(), 0);
    await page.goto(BASE + '/watch/al1-e1');
    await page.waitForTimeout(1500);
    assert.equal(await page.getByRole('dialog', { name: /Connecte-toi/ }).count(), 0);
    // The player is full screen: no rail.
    assert.equal(await page.getByRole('navigation', { name: 'Navigation principale' }).count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('PWA: manifest, service worker, offline reload of the shell', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(BASE + '/');
    const manifest = await page.evaluate(async () => {
      const href = document.querySelector('link[rel=manifest]')?.getAttribute('href');
      return href ? (await fetch(href)).json() : null;
    });
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.some((i: { sizes: string }) => i.sizes === '512x512'));
    assert.ok(await page.locator('meta[name="apple-mobile-web-app-capable"]').count());
    assert.ok(await page.locator('link[rel="apple-touch-icon"]').count());
    // Installed and active, then in control after a reload.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20_000 });
    await page.getByRole('navigation', { name: 'Navigation principale' }).waitFor({ timeout: 20_000 });
    await context.setOffline(true);
    await page.goto(BASE + '/calendar');
    await page.getByRole('navigation', { name: 'Navigation principale' }).waitFor({ timeout: 20_000 });
    await context.setOffline(false);
    await context.close();
  });
});
