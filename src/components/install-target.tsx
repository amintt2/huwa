// Routes an install link to the right sheet: Stremio addon (video) or Paperback repository
// (manhwa, handled by the `/manga-extensions` screen).
import { useLinkingURL } from 'expo-linking';
import { router, type Href } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { AddonInstallSheet, closeSheet } from '@/components/addon-install';
import { Button, Txt } from '@/components/ui';
import { C, S } from '@/theme/tokens';

/**
 * The `url` parameter as it arrived in the deep link. Expo Router's parsed params lose anything
 * after a `#` inside the value (e.g. wrapped `https://web.stremio.com/#/addons?addon=…` links),
 * so the raw link wins when it targets this route.
 */
export function useInstallParam(route: 'addon' | 'install', parsed?: string) {
  const raw = useLinkingURL();
  const m = raw && new RegExp(`^[a-z][\\w+.-]*://(?:/)?${route}\\?(?:.*&)?url=([^&]+)`, 'i').exec(raw);
  if (!m) return parsed;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return parsed;
  }
}

/** Paperback repositories are folders with `versioning.json` (0.8) or a `/<version>` subfolder. */
export const looksLikePaperbackRepo = (u: string) =>
  /versioning\.json$/i.test(u) || /(^|\/\/)[^/]*github\.io\/[^?#]*(extensions|sources|paperback)/i.test(u) || /paperback/i.test(u);

export function InstallTarget({ url, type }: { url?: string; type?: string }) {
  const kind = !url ? 'none' : type === 'paperback' || (type !== 'stremio' && looksLikePaperbackRepo(url)) ? 'paperback' : 'stremio';
  useEffect(() => {
    if (kind === 'paperback') router.replace({ pathname: '/manga-extensions', params: { repo: url } } as unknown as Href);
  }, [kind, url]);

  if (kind === 'stremio') return <AddonInstallSheet url={url!} />;
  if (kind === 'paperback') return <View style={{ flex: 1, backgroundColor: C.surface, justifyContent: 'center' }}><ActivityIndicator color={C.accentText} /></View>;
  return (
    <View style={{ flex: 1, backgroundColor: C.surface, padding: S.lg, gap: S.md, justifyContent: 'center' }}>
      <Txt v="label">Lien d’installation incomplet : il manque l’adresse de l’extension.</Txt>
      <Button label="Fermer" onPress={closeSheet} />
    </View>
  );
}
