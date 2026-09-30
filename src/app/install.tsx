import { useLocalSearchParams } from 'expo-router';

import { InstallTarget, useInstallParam } from '@/components/install-target';

/**
 * Generic install link: `huwa://install?url=<…>[&type=stremio|paperback]`.
 * Stremio manifests open the addon sheet; Paperback repositories go to the manhwa extensions.
 */
export default function InstallDeepLink() {
  const { url, type } = useLocalSearchParams<{ url?: string; type?: string }>();
  const raw = useInstallParam('install', url ? String(url) : undefined);
  return <InstallTarget url={raw} type={type ? String(type) : undefined} />;
}
