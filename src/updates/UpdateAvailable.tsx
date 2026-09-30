// Écran « Mise à jour disponible » : feuille non bloquante, affichée quand une update est téléchargée.
// L'utilisateur choisit « Redémarrer » ou « Plus tard » ; jamais de redémarrage forcé.
//
// Montage prévu dans src/app/_layout.tsx (par l'agent qui possède src/app) :
//   const update = useUpdateCheck();
//   <UpdateAvailable state={update} />   // après le <Stack>, dans le ThemeProvider
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import Animated, { Easing, FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Txt } from '@/components/ui';
import { C, EASE_OUT, R, S } from '@/theme/tokens';

import type { UpdateState } from './useUpdateCheck';

const ease = Easing.bezier(...EASE_OUT);

export function UpdateAvailable({ state }: { state: UpdateState }) {
  const insets = useSafeAreaInsets();
  const [dismissed, setDismissed] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const visible = state.ready && !dismissed;

  useEffect(() => {
    if (state.ready) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }, [state.ready]);

  if (!visible) return null;

  const onApply = async () => {
    setRestarting(true);
    try {
      await state.apply();
    } finally {
      setRestarting(false);
    }
  };

  return (
    <Modal transparent visible animationType="none" onRequestClose={() => setDismissed(true)} statusBarTranslucent>
      <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(160)} style={styles.scrim} />
      <View style={styles.host} pointerEvents="box-none">
        <Animated.View
          entering={SlideInDown.duration(320).easing(ease)}
          exiting={SlideOutDown.duration(220).easing(ease)}
          accessibilityViewIsModal
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, S.lg) + S.sm }]}>
          <View style={styles.grabber} />
          <View style={styles.iconWrap}>
            <Ionicons name="arrow-down-circle" size={28} color={C.accentText} />
          </View>
          <Txt v="title" style={styles.title}>
            Mise à jour disponible
          </Txt>
          <Txt v="body" style={styles.body}>
            {(state.version ? `La version ${state.version} est téléchargée.` : 'Une nouvelle version est téléchargée.') +
              " Elle s'applique au redémarrage de l'app, en quelques secondes. Votre progression et vos réglages sont conservés."}
          </Txt>
          <View style={styles.actions}>
            <Button label={restarting ? 'Redémarrage…' : 'Redémarrer maintenant'} icon="refresh" onPress={restarting ? undefined : onApply} />
            <Button label="Plus tard" variant="ghost" onPress={() => setDismissed(true)} />
          </View>
          <Txt v="small" style={styles.foot}>
            {"Mise à jour signée et vérifiée sur l'appareil avant installation."}
          </Txt>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.55)' },
  host: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: R.sheet,
    borderTopRightRadius: R.sheet,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: S.xl,
    paddingTop: S.md,
    gap: S.md,
  },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: R.pill, backgroundColor: C.borderStrong, marginBottom: S.xs },
  iconWrap: {
    alignSelf: 'flex-start',
    width: 48,
    height: 48,
    borderRadius: R.card,
    borderCurve: 'continuous',
    backgroundColor: C.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { marginTop: S.xs },
  body: { color: C.body },
  actions: { gap: S.sm, marginTop: S.xs },
  foot: { textAlign: 'center' },
});
