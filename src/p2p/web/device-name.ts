// "Chrome sur macOS": the name a browser gets in the account's device list and in the phone's
// "Lier … ?" prompt. Derived from the user agent only (no fingerprinting beyond that).

const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/CriOS\/|Chrome\/|Chromium\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

export function browserLabel(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? 'Navigateur';
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  return (system ? `${browser} sur ${system}` : browser).slice(0, 40);
}
