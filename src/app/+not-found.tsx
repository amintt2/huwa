import { router } from 'expo-router';
import { View } from 'react-native';

import { StateView } from '@/components/states';
import { useT } from '@/i18n';
import { C } from '@/theme/tokens';

export default function NotFound() {
  const t = useT();
  return (
    <View style={{ flex: 1, justifyContent: 'center', backgroundColor: C.bg }}>
      <StateView icon="compass-outline" title={t('error.notFound')} body={t('error.notFoundBody')} action={t('error.home')} onAction={() => router.replace('/')} />
    </View>
  );
}
