// Demo mode for store screenshots (scripts/shots.ts). Switched on by iOS launch arguments:
//   xcrun simctl launch <udid> com.amintt2.huwa -HuwaDemo 1 -HuwaRoute /anime/void
// Launch arguments land in the NSUserDefaults argument domain, which react-native's `Settings`
// exposes (RCTSettingsManager → `dictionaryRepresentation`). Nothing else turns it on.
// Kept dependency-free so any module can import it without cycles.
import { Platform, Settings } from 'react-native';

function arg(key: string): unknown {
  if (Platform.OS !== 'ios') return undefined;
  try {
    return Settings.get(key);
  } catch {
    return undefined;
  }
}

const on = (v: unknown) => v === 1 || v === true || ['1', 'true', 'YES', 'yes'].includes(String(v));

export const isDemo = on(arg('HuwaDemo'));

/** Screen to open once the app is ready (e.g. `/anime/void`), demo mode only. */
export const demoRoute: string | undefined = (() => {
  const r = arg('HuwaRoute');
  return isDemo && typeof r === 'string' && r.startsWith('/') ? r : undefined;
})();

/** UI language of the demo run, from `-AppleLanguages (en)`. */
export const demoLang: 'fr' | 'en' = (() => {
  const langs = arg('AppleLanguages');
  const first = Array.isArray(langs) ? String(langs[0] ?? '') : typeof langs === 'string' ? langs.replace(/[()\s"]/g, '') : '';
  return first.startsWith('en') ? 'en' : 'fr';
})();
