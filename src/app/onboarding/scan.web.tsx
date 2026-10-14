// Web: "Lier avec mon téléphone" — the browser shows the QR code, the phone scans it (D7).
import { router } from 'expo-router';

import { LinkPhoneQR } from '@/components/web-login';

const back = () => (router.canGoBack() ? router.back() : router.replace('/onboarding'));

export default function WebLinkPhone() {
  return <LinkPhoneQR onDone={() => router.replace('/')} onBack={back} onUsePhrase={() => router.replace('/onboarding/restore')} />;
}
