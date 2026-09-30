import { useLocalSearchParams } from 'expo-router';

import { AddonInstallSheet } from '@/components/addon-install';
import { InstallTarget, useInstallParam } from '@/components/install-target';

/**
 * One-click install of a Stremio addon: `huwa://addon?url=<manifest URL>`
 * (the URL may also be `stremio://…` or a web.stremio.com share link).
 */
export default function AddonDeepLink() {
  const params = useLocalSearchParams<{ url?: string }>();
  const url = useInstallParam('addon', params.url ? String(params.url) : undefined);
  return url ? <AddonInstallSheet url={url} /> : <InstallTarget />;
}
