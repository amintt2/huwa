// expo-notifications adds the `aps-environment` entitlement (remote push). Huwa only schedules
// local notifications for now; remote push needs the optional push relay (services/push-gateway)
// and an App ID with the Push capability. Without it, a personal/wildcard provisioning profile
// cannot sign the app. So the entitlement is kept only when HUWA_PUSH=1.
// Must stay FIRST in app.json plugins: mods run in reverse order, so it runs after expo-notifications.
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withOptionalPush(config) {
  return withEntitlementsPlist(config, (c) => {
    if (process.env.HUWA_PUSH !== '1') delete c.modResults['aps-environment'];
    return c;
  });
};
