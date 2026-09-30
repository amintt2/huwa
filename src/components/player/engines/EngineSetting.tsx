// Settings → Lecture → "Moteur de lecture": Automatique / Natif / mpv, with the LGPL notice.
import { Linking, StyleSheet, Text, View } from 'react-native';

import { FilterChip } from '@/components/states';
import { Txt } from '@/components/ui';
import { C, S } from '@/theme/tokens';

import { deviceCaps } from './hybrid-player';
import type { EnginePref } from './policy';
import { setEnginePref, useEnginePref } from './prefs';

const OPTIONS: { key: EnginePref; label: string }[] = [
  { key: 'auto', label: 'Automatique' },
  { key: 'native', label: 'Natif' },
  { key: 'mpv', label: 'mpv' },
];

const HINT: Record<EnginePref, string> = {
  auto: 'Lecteur du système (décodage matériel, PiP, AirPlay) ; mpv prend le relais pour MKV, WebM, AVI, VP9, AV1 sans décodeur matériel ou en cas d’échec.',
  native: 'Toujours le lecteur du système. Certains fichiers (MKV, WebM…) ne pourront pas être lus sur iPhone.',
  mpv: 'Toujours mpv : sous-titres ASS stylés, pistes intégrées. Pas de PiP ni d’AirPlay vidéo, consommation un peu plus élevée.',
};

const SOURCES = 'https://github.com/mpvkit/MPVKit';

export function EngineSetting() {
  const pref = useEnginePref();
  const { mpvAvailable } = deviceCaps();
  return (
    <View style={styles.block}>
      <Txt v="label">Moteur de lecture</Txt>
      <View style={styles.inline}>
        {OPTIONS.map((o) => (
          <FilterChip key={o.key} label={o.label} selected={pref === o.key} onPress={() => setEnginePref(o.key)} />
        ))}
      </View>
      <Txt v="small" style={{ lineHeight: 19 }}>
        {mpvAvailable ? HINT[pref] : 'mpv n’est pas inclus dans cette version : le lecteur du système est toujours utilisé.'}
      </Txt>
      {mpvAvailable && (
        <Txt v="small" style={{ fontSize: 12, lineHeight: 17 }}>
          mpv (libmpv) et FFmpeg sont des logiciels libres sous licence LGPL, liés dynamiquement (Libmpv.framework, remplaçable).{' '}
          <Text style={{ color: C.accentText }} onPress={() => Linking.openURL(SOURCES).catch(() => {})} accessibilityRole="link">
            Sources et licences
          </Text>
        </Txt>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  inline: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm },
  block: { gap: S.md, padding: S.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
});
