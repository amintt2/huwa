// Passkeys (modules/huwa-passkey) need the app to be associated with the relying party domain:
// `webcredentials:huwa.mciut.fr`, matched by https://huwa.mciut.fr/.well-known/apple-app-site-association
// (site/.well-known/). The App ID must have the Associated Domains capability, or signing fails:
//   HUWA_PASSKEYS=0 npx expo prebuild   → entitlement left out (e.g. a personal team / old profile).
// Merges with any associated domains other plugins add.
const { withEntitlementsPlist } = require('expo/config-plugins');

const KEY = 'com.apple.developer.associated-domains';
const DOMAIN = 'webcredentials:huwa.mciut.fr';

module.exports = function withPasskeys(config) {
  return withEntitlementsPlist(config, (c) => {
    const current = Array.isArray(c.modResults[KEY]) ? c.modResults[KEY] : [];
    const rest = current.filter((d) => d !== DOMAIN);
    const next = process.env.HUWA_PASSKEYS === '0' ? rest : [...rest, DOMAIN];
    if (next.length) c.modResults[KEY] = next;
    else delete c.modResults[KEY];
    return c;
  });
};
