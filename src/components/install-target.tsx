// Routes an install link to the right sheet: Stremio addon (video) or Paperback repository
// (manhwa, handled by the `/manga-sources` screen).
import { useLinkingURL } from 'expo-linking';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { AddonInstallSheet, closeSheet } from '@/components/addon-install';
import { Button, Txt } from '@/components/ui';
import { looksLikePaperbackRepo } from '@/packs/format';
import { C, S } from '@/theme/tokens';

/**
 * The `url` parameter as it arrived in the deep link. Expo Router's parsed params lose anything
 * after a `#` inside the value (e.g. wrapped `https://web.stremio.com/#/addons?addon=…` links),
 * so the raw link wins when it targets this route.
 */
export function useInstallParam(route: 'addon' | 'install' | 'pack', parsed?: string) {
  const raw = useLinkingURL();
  // `huwa://<route>?…` or the site's universal link `https://huwa.mciut.fr/<route>?…`.
  const m = raw && new RegExp(`^[a-z][\\w+.-]*://(?:/|(?:www\\.)?huwa\\.mciut\\.fr/)?${route}\\?(?:.*&)?url=([^&]+)`, 'i').exec(raw);
  if (!m) return parsed;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return parsed;
  }
}

export function InstallTarget({ url, type }: { url?: string; type?: string }) {
  const kind = !url ? 'none' : type === 'paperback' || (type !== 'stremio' && looksLikePaperbackRepo(url)) ? 'paperback' : 'stremio';
  useEffect(() => {
    if (kind === 'paperback') router.replace({ pathname: '/manga-sources', params: { repo: url } });
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
