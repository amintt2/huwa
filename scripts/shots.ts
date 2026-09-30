/**
 * Store screenshots (App Store Connect + AltStore source), end to end.
 * Adapted from the app factory pipeline (Apps/factory/scripts/shots.ts): same capture, same
 * poster renderer (factory/tools/shots-studio), Huwa's own demo flags and bundle id.
 *
 *   node --experimental-strip-types scripts/shots.ts [--app path/to/Huwa.app] [--sim huwa-shots]
 *        [--skip-capture] [--locales fr,en] [--shots 2,4] [--studio path/to/factory/tools/shots-studio]
 *
 * 1. Capture: boots the simulator (an iPhone 17 Pro Max, native 1320x2868), cleans the status bar,
 *    and for each locale launches Huwa in demo mode on each shot's route
 *    (`-HuwaDemo 1 -HuwaRoute /x -AppleLanguages (fr)`) → store/screens/<locale>/NN.png
 * 2. Render: pushes those screens + the copy into ShotsStudio and pulls the posters
 *    → store/shots/<6.9|6.5>/<locale>/NN.png
 *
 * The app must be a Release build (JS embedded). Config: store/shots.json.
 * `--shots 2,4` recaptures only those shots (1-based) and keeps the other screens.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

type Shot = {
  route: string;
  args?: Record<string, string>;
  layout?: 'hero' | 'duo' | 'zoom' | 'tilt';
  route2?: string;
  zoom?: { x: number; y: number; w: number; h: number };
  appearance?: 'light' | 'dark';
  wait?: number;
  copy: Record<string, { headline: string; sub: string }>;
};
type ShotsConfig = { theme: Record<string, unknown>; device?: string; shots: Shot[] };

const BUNDLE_ID = 'com.amintt2.huwa';
const STUDIO_ID = 'com.factory.tools.shots';
const SIZES = ['6.9', '6.5'];
const cfg: ShotsConfig = JSON.parse(readFileSync(join(root, 'store', 'shots.json'), 'utf8'));
const locales = (flag('locales') ?? Object.keys(cfg.shots[0].copy).join(',')).split(',');
const only = flag('shots')?.split(',').map(Number);
const simName = flag('sim') ?? cfg.device ?? 'huwa-shots';
const studio = flag('studio') ?? join(process.env.HOME ?? '', 'Documents', 'Apps', 'factory', 'tools', 'shots-studio');
const screensDir = join(root, 'store', 'screens');
const outDir = join(root, 'store', 'shots');

const run = (cmd: string, a: string[], quiet = true) =>
  execFileSync(cmd, a, { encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' }) ?? '';
const tryRun = (cmd: string, a: string[]) => {
  try {
    return run(cmd, a);
  } catch {
    return '';
  }
};
const simctl = (...a: string[]) => run('xcrun', ['simctl', ...a]);
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

function device(name: string): string {
  const list = JSON.parse(simctl('list', 'devices', 'available', '-j')) as { devices: Record<string, { name: string; udid: string; state: string }[]> };
  const all = Object.values(list.devices).flat();
  const d = all.find((x) => (x.name === name || x.udid === name) && x.state === 'Booted') ?? all.find((x) => x.name === name || x.udid === name);
  if (!d) throw new Error(`No simulator named ${name} (create it: xcrun simctl create ${name} "iPhone 17 Pro Max")`);
  if (d.state !== 'Booted') simctl('boot', d.udid);
  simctl('bootstatus', d.udid, '-b');
  return d.udid;
}

const appleLang = (l: string) => (['pt-BR', 'zh-Hans', 'zh-Hant'].includes(l) ? l : l.split('-')[0]);

async function capture(udid: string) {
  const appPath = flag('app');
  if (appPath) run('xcrun', ['simctl', 'install', udid, appPath], false);
  simctl('status_bar', udid, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3',
    '--cellularMode', 'active', '--cellularBars', '4', '--batteryState', 'discharging', '--batteryLevel', '100');

  for (const locale of locales) {
    const dir = join(screensDir, locale);
    if (!only) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const lang = appleLang(locale);
    const region = lang === 'fr' ? 'fr_FR' : lang === 'en' ? 'en_US' : lang.replace('-', '_');
    const shoot = async (route: string, file: string, s: Shot) => {
      simctl('ui', udid, 'appearance', s.appearance ?? 'dark');
      tryRun('xcrun', ['simctl', 'terminate', udid, BUNDLE_ID]);
      const extra = Object.entries(s.args ?? {}).flatMap(([k, v]) => [`-${k}`, v]);
      simctl('launch', udid, BUNDLE_ID, '-HuwaDemo', '1', '-HuwaRoute', route, ...extra, '-AppleLanguages', `(${lang})`, '-AppleLocale', region);
      await sleep(s.wait ?? 10); // launch + push transition must be fully settled
      simctl('io', udid, 'screenshot', '--type=png', join(dir, file));
      console.log(`  captured ${locale}/${file}  ${route}`);
    };
    for (const [i, s] of cfg.shots.entries()) {
      if (only && !only.includes(i + 1)) continue;
      const n = String(i + 1).padStart(2, '0');
      await shoot(s.route, `${n}.png`, s);
      if (s.route2) await shoot(s.route2, `${n}b.png`, s);
    }
  }
  tryRun('xcrun', ['simctl', 'terminate', udid, BUNDLE_ID]);
  tryRun('xcrun', ['simctl', 'status_bar', udid, 'clear']);
}

async function render(udid: string) {
  const studioApp = join(studio, 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'ShotsStudio.app');
  if (!existsSync(studioApp)) {
    run('sh', ['-c', `cd "${studio}" && xcodegen generate && xcodebuild -project ShotsStudio.xcodeproj -scheme ShotsStudio -destination "platform=iOS Simulator,id=${udid}" -derivedDataPath build build`], false);
  }
  simctl('install', udid, studioApp);
  const container = simctl('get_app_container', udid, STUDIO_ID, 'data').trim();
  const input = join(container, 'Documents', 'input');
  rmSync(input, { recursive: true, force: true });
  mkdirSync(input, { recursive: true });
  cpSync(screensDir, join(input, 'screens'), { recursive: true });

  const studioConfig = {
    theme: cfg.theme,
    sizes: SIZES,
    locales: Object.fromEntries(
      locales.map((l) => [
        l,
        cfg.shots.map((s, i) => {
          const n = String(i + 1).padStart(2, '0');
          return { ...s.copy[l], screen: `${n}.png`, screen2: s.route2 ? `${n}b.png` : undefined, layout: s.layout ?? 'hero', zoom: s.zoom };
        }),
      ]),
    ),
  };
  writeFileSync(join(input, 'shots.json'), JSON.stringify(studioConfig));

  const shotsOut = join(container, 'Documents', 'shots');
  rmSync(shotsOut, { recursive: true, force: true });
  tryRun('xcrun', ['simctl', 'terminate', udid, STUDIO_ID]);
  simctl('launch', udid, STUDIO_ID);
  for (let t = 0; t < 1800; t++) {
    if (existsSync(join(shotsOut, 'DONE')) || existsSync(join(shotsOut, 'FAILED'))) break;
    await sleep(1);
  }
  const failed = existsSync(join(shotsOut, 'FAILED'));
  if (failed) console.error(readFileSync(join(shotsOut, 'FAILED'), 'utf8'));
  for (const size of SIZES) rmSync(join(outDir, size), { recursive: true, force: true });
  cpSync(shotsOut, outDir, { recursive: true });
  for (const f of ['DONE', 'FAILED']) rmSync(join(outDir, f), { force: true });
  tryRun('xcrun', ['simctl', 'terminate', udid, STUDIO_ID]);
  const count = readdirSync(outDir, { recursive: true }).filter((f) => String(f).endsWith('.png')).length;
  console.log(`${failed ? '✗' : '✓'} ${count} posters → store/shots/`);
  if (failed) process.exitCode = 1;
}

const udid = device(simName);
if (!args.includes('--skip-capture')) await capture(udid);
await render(udid);
