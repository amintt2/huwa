// "Pas de version française pour cet épisode": dub mode found no dubbed source (see addons/dub.ts).
// A short sheet in the app's style (fit-to-content Sheet: from the bottom in portrait, a centered
// card in landscape) with the choices, the best other version first:
//   - "Regarder en VOSTFR" (or whatever the best other version is: "VO", "VA"…),
//   - "Choisir une source" (the sources menu),
//   - "Retour".
// Also used for the next episode ("Ép. 13 non disponible en VF") before leaving this one.
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, View } from 'react-native';

import { C, R, S } from '@/theme/tokens';

import { Sheet } from './sheet';
import { Button, Txt } from './ui';

export function DubSheet({
  visible,
  title,
  message,
  fallback,
  onFallback,
  onSources,
  onBack,
  backLabel = 'Retour',
  onClose,
  onClosed,
}: {
  visible: boolean;
  title: string;
  message: string;
  /** Name of the other version ("VOSTFR"), null when there is none to offer. */
  fallback: string | null;
  onFallback: () => void;
  onSources?: () => void;
  onBack: () => void;
  backLabel?: string;
  /** Dismissed without a choice (swipe down, backdrop). */
  onClose: () => void;
  /** Gone from the screen: another modal (the sources menu) may open. */
  onClosed?: () => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} onClosed={onClosed} contentGap={S.xl}>
      <View style={styles.head} accessibilityRole="alert">
        <View style={styles.badge}>
          <Ionicons name="language-outline" size={26} color={C.star} />
        </View>
        <Txt v="headline" style={styles.center}>{title}</Txt>
        <Txt v="body" style={styles.center}>{message}</Txt>
      </View>
      <View style={{ gap: S.sm }}>
        {!!fallback && <Button icon="play" label={`Regarder en ${fallback}`} onPress={onFallback} />}
        {onSources && <Button variant="ghost" icon="layers-outline" label="Choisir une source" onPress={onSources} />}
        <Button variant="plain" label={backLabel} onPress={onBack} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: { alignItems: 'center', gap: S.sm, paddingTop: S.sm },
  badge: {
    width: 56, height: 56, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center', marginBottom: S.xs,
    backgroundColor: 'rgba(255,200,87,0.12)', borderWidth: 1, borderColor: 'rgba(255,200,87,0.28)',
  },
  center: { textAlign: 'center' },
});
