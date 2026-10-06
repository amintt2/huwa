// Dynamic layer over app.json.
// Self-hosted OTA updates (see distribution/ and services/ota/) only switch on once they are
// really configured: a server URL (HUWA_OTA_URL or app.json) and the signing certificate in
// certs/certificate.pem. Until then updates are disabled, so local builds and prebuild work.
const fs = require('fs');
const path = require('path');

module.exports = ({ config }) => {
  const updates = { ...config.updates };
  const url = process.env.HUWA_OTA_URL || updates.url || '';
  const cert = updates.codeSigningCertificate && path.resolve(__dirname, updates.codeSigningCertificate);
  const ready = url && !url.includes('A_RENSEIGNER') && cert && fs.existsSync(cert);

  if (ready) {
    updates.url = url;
  } else {
    updates.enabled = false;
    delete updates.url;
    delete updates.codeSigningCertificate;
    delete updates.codeSigningMetadata;
  }
  // Build flavor read by src/config/channel.ts.
  const channel = process.env.HUWA_LITE === '1' ? 'store' : 'full';
  // Optional GIPHY API key for the comment GIF search (never committed: set HUWA_GIF_API_KEY at build
  // time). Without it, the picker only takes pasted GIPHY / Tenor links.
  const gifApiKey = process.env.HUWA_GIF_API_KEY || undefined;
  // Public key(s) of the Huwa relay(s) (services/blind-peer, printed at start and in
  // /data/public-key.txt): HUWA_RELAY_KEYS (comma separated) wins over app.json `extra.relayKeys`.
  // Not a secret, but empty until a relay is deployed: the app then simply has no default relay.
  const relayKeys = String(process.env.HUWA_RELAY_KEYS ?? (config.extra?.relayKeys || []).join(','))
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  return { ...config, updates, extra: { ...config.extra, channel, gifApiKey, relayKeys } };
};
