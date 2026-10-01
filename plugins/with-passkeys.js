// Associated domains for huwa.mciut.fr, matched by https://huwa.mciut.fr/.well-known/apple-app-site-association
// (site/.well-known/):
//  - `webcredentials:` — passkeys (modules/huwa-passkey) use the site as relying party;
//  - `applinks:` — universal links: the site's share links (/addon, /install, /extensions?url=,
//    /pack.html#…) open the app when it is installed (routes: src/app/+native-intent.tsx).
// The App ID must have the Associated Domains capability, or signing fails:
//   HUWA_PASSKEYS=0 npx expo prebuild   → both entitlements left out (e.g. a personal team / old profile).
// Merges with any associated domains other plugins add.
const { withEntitlementsPlist } = require('expo/config-plugins');

const KEY = 'com.apple.developer.associated-domains';
const DOMAINS = ['webcredentials:huwa.mciut.fr', 'applinks:huwa.mciut.fr'];

module.exports = function withPasskeys(config) {
  return withEntitlementsPlist(config, (c) => {
    const current = Array.isArray(c.modResults[KEY]) ? c.modResults[KEY] : [];
    const rest = current.filter((d) => !DOMAINS.includes(d));
    const next = process.env.HUWA_PASSKEYS === '0' ? rest : [...rest, ...DOMAINS];
    if (next.length) c.modResults[KEY] = next;
    else delete c.modResults[KEY];
    return c;
  });
};
