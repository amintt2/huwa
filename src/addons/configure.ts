// Configurable Stremio addons (`behaviorHints.configurable` / `configurationRequired`): their
// `/configure` page ends with an "Install" button that navigates to
// `stremio://host/<settings>/manifest.json`. Opened in an auth session whose callback scheme is
// `stremio`, that navigation closes the browser and hands the configured URL back to Huwa
// (iOS: ASWebAuthenticationSession). When a page only offers "copy link" instead, the user
// pastes it (see the install sheet).
import * as WebBrowser from 'expo-web-browser';

import { configureUrl, normalizeAddonUrl } from './protocol';

/** Opens the addon's configuration page; resolves with the configured base URL, or null. */
export async function configureAddon(baseUrl: string): Promise<string | null> {
  const res = await WebBrowser.openAuthSessionAsync(configureUrl(baseUrl), 'stremio://');
  if (res.type !== 'success' || !res.url) return null;
  return /manifest\.json/i.test(res.url) ? normalizeAddonUrl(res.url) : null;
}
