// Web: restore with the recovery phrase (never stored in the browser, D7).
import { router } from 'expo-router';

import { RestorePhrase } from '@/components/web-login';

const back = () => (router.canGoBack() ? router.back() : router.replace('/onboarding'));

export default function WebRestore() {
  return <RestorePhrase onDone={() => router.replace('/')} onBack={back} onCreate={() => router.replace('/onboarding?create=1')} />;
}
