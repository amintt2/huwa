// Web: login hub of a logged-out browser (D7). Create and passkey run inline.
import { router, useLocalSearchParams } from 'expo-router';

import { WebLoginHub } from '@/components/web-login';

export default function WebLogin() {
  const { create } = useLocalSearchParams<{ create?: string }>();
  return (
    <WebLoginHub
      startWithCreate={create === '1'}
      onLinkPhone={() => router.push('/onboarding/scan')}
      onPhrase={() => router.push('/onboarding/restore')}
      onDone={() => router.replace('/')}
    />
  );
}
