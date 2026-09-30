import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StyleControls, SwitchLine } from '@/components/player/subtitles/StyleControls';
import { StylePreview } from '@/components/player/subtitles/StylePreview';
import { FLAG } from '@/components/language-prefs';
import { FilterChip, Group, ScreenHeader } from '@/components/states';
import { Button, Txt } from '@/components/ui';
import { LANG_CODES, setSetting, useSettings } from '@/settings/settings';
import { langName } from '@/subtitles/lang';
import { resetSubtitleStyle, setSubtitlePrefs, useSubtitlePrefs } from '@/subtitles/prefs';
import { C, S } from '@/theme/tokens';

export default function SubtitleSettings() {
  const insets = useSafeAreaInsets();
  const prefs = useSubtitlePrefs();
  // Same list as onboarding / Général → Langues (`subLangs`, 1 to 5 languages).
  const langs = useSettings().subLangs;
  const setLangs = (v: string[]) => setSetting('subLangs', v);
  const move = (i: number, d: -1 | 1) => {
    const next = [...langs];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setLangs(next);
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingTop: insets.top + S.sm }}>
        <ScreenHeader title="Sous-titres" />
      </View>
      {/* The preview stays on screen while the options scroll under it. */}
      <View style={styles.preview}>
        <StylePreview prefs={prefs} />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: S.lg, paddingTop: S.lg, paddingBottom: insets.bottom + S.xxl, gap: S.xl }}>
        <Group title="Langues préférées">
          <View style={styles.block}>
            <SwitchLine
              label="Afficher les sous-titres"
              hint="Choisit automatiquement la meilleure piste : langue préférée, puis source, puis pistes « forcées »."
              value={prefs.enabled}
              onChange={(enabled) => setSubtitlePrefs({ enabled })}
            />
            {langs.map((l, i) => (
              <View key={l} style={styles.langRow}>
                <Txt v="label" style={{ width: 22, color: C.text2 }}>{i + 1}.</Txt>
                <Txt v="label" style={{ flex: 1 }}>{FLAG[l] ? `${FLAG[l]}  ` : ''}{langName(l)}</Txt>
                <Pressable disabled={i === 0} onPress={() => move(i, -1)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Monter ${langName(l)}`}>
                  <Ionicons name="arrow-up" size={20} color={i === 0 ? C.border : C.accentText} />
                </Pressable>
                <Pressable disabled={i === langs.length - 1} onPress={() => move(i, 1)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Descendre ${langName(l)}`}>
                  <Ionicons name="arrow-down" size={20} color={i === langs.length - 1 ? C.border : C.accentText} />
                </Pressable>
                <Pressable disabled={langs.length === 1} onPress={() => setLangs(langs.filter((x) => x !== l))} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Retirer ${langName(l)}`}>
                  <Ionicons name="close-circle" size={20} color={langs.length === 1 ? C.border : C.text2} />
                </Pressable>
              </View>
            ))}
            {langs.length < 5 && (
              <>
                <Txt v="caption">Ajouter</Txt>
                <View style={styles.wrap}>
                  {LANG_CODES.filter((l) => !langs.includes(l)).map((l) => (
                    <FilterChip key={l} label={`${FLAG[l] ?? ''} ${langName(l)}`.trim()} selected={false} onPress={() => setLangs([...langs, l])} />
                  ))}
                </View>
              </>
            )}
          </View>
        </Group>

        <Group title="Style">
          <View style={styles.block}>
            <StyleControls prefs={prefs} />
          </View>
        </Group>

        <Button small variant="ghost" icon="refresh" label="Rétablir le style par défaut" onPress={resetSubtitleStyle} />
        <Txt v="small" style={{ textAlign: 'center', lineHeight: 18 }}>
          Formats pris en charge : ASS/SSA (styles des fansubs), SRT, WebVTT, fichiers .gz et anciens encodages.
          Le décalage de synchro se règle pendant la lecture et est mémorisé par épisode.
        </Txt>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { paddingHorizontal: S.lg, paddingBottom: S.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  block: { gap: S.md, padding: S.lg },
  langRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 36 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm },
});
