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
  return { ...config, updates, extra: { ...config.extra, channel } };
};
