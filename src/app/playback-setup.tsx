// Shown once, right after the first extension that plays in Huwa is added (full flavor): the
// watching questions that used to be in the first-launch onboarding (VO / VF, subtitle and chapter
// languages, stats opt-in). Changeable later in Réglages → Général.
import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LanguagePrefs } from '@/components/language-prefs';
import { SheetTitle } from '@/components/screen';
import { StatsOptIn } from '@/components/stats-opt-in';
import { Button, Txt } from '@/components/ui';
import { setSetting } from '@/settings/settings';
import { C, S } from '@/theme/tokens';

export default function PlaybackSetup() {
  const insets = useSafeAreaInsets();
  const done = () => {
    setSetting('playbackSetupDone', true);
    if (router.canGoBack()) router.back();
  };
  return (
    <View style={{ flex: 1, backgroundColor: C.surface }}>
      <SheetTitle title="Ton extension est prête" subtitle="Deux réglages pour la lecture" onClose={done} />
      <ScrollView contentContainerStyle={{ padding: S.lg, gap: S.xl, paddingBottom: insets.bottom + S.xl }}>
        <View style={{ gap: S.md }}>
          <Txt v="title">Tes langues</Txt>
          <Txt v="body" color={C.body}>Huwa choisira les versions et les sous-titres qui te conviennent dans ce que proposent tes extensions.</Txt>
          <LanguagePrefs />
        </View>
        <View style={{ gap: S.md }}>
          <Txt v="title">Aider à rendre Huwa plus rapide ?</Txt>
          <Txt v="body" color={C.body}>Huwa mesure sur ton téléphone le temps que met chaque épisode à démarrer. Tu peux partager ces mesures de façon anonyme pour comparer avec la communauté.</Txt>
          <StatsOptIn />
        </View>
        <Button large label="C’est parti" icon="arrow-forward" iconRight onPress={done} />
      </ScrollView>
    </View>
  );
}
