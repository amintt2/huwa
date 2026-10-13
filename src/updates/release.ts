// Newer APK on GitHub Releases (Android sideload): what to offer, from the "latest release" API
// answer. Pure, so it is unit-tested under Node (src/updates/__tests__).

export type ReleaseAsset = { name: string; browser_download_url: string };
export type LatestRelease = { tag_name: string; draft?: boolean; prerelease?: boolean; html_url?: string; assets: ReleaseAsset[] };
export type ApkUpdate = { version: string; url: string; page?: string };

/** "v1.0.2" / "1.0.2" → [1, 0, 2]; null when not a plain version. */
export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** a > b */
export function isNewer(a: string, b: string): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * The APK to download when the latest release is newer than `current`: the build for the
 * device's ABI (`Huwa-<v>-arm64-v8a.apk`…) when published, else the universal one.
 */
export function apkUpdate(release: LatestRelease, current: string, abis: readonly string[]): ApkUpdate | null {
  if (release.draft || release.prerelease) return null;
  const version = release.tag_name.replace(/^v/, '');
  if (!isNewer(version, current)) return null;
  const apks = release.assets.filter((a) => a.name.endsWith('.apk'));
  const forAbi = abis.map((abi) => apks.find((a) => a.name === `Huwa-${version}-${abi}.apk`)).find(Boolean);
  const universal = apks.find((a) => a.name === `Huwa-${version}.apk`);
  const asset = forAbi ?? universal;
  return asset ? { version, url: asset.browser_download_url, page: release.html_url } : null;
}
