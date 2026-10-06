import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { StyleControls, SwitchLine } from '@/components/player/subtitles/StyleControls';
import { StylePreview } from '@/components/player/subtitles/StylePreview';
import { FLAG } from '@/components/language-prefs';
import { BAR_H, NavBar } from '@/components/screen';
import { FilterChip, Group } from '@/components/states';
import { Button, Txt } from '@/components/ui';
import { prepareModel, statusOf, translationSupported, useTranslateStatuses } from '@/components/player/subtitles/translation';
import { LANG_CODES, setSetting, useSettings } from '@/settings/settings';
import { langName } from '@/subtitles/lang';
import { resetSubtitleStyle, setSubtitlePrefs, useSubtitlePrefs } from '@/subtitles/prefs';
import { C, S } from '@/theme/tokens';

export default function SubtitleSettings() {
  const insets = useSafeAreaInsets();
  const prefs = useSubtitlePrefs();
  // Same list as onboarding / Général → Langues (`subLangs`, 1 to 5 languages).
  const { subLangs: langs, autoTranslateSubs } = useSettings();
  const setLangs = (v: string[]) => setSetting('subLangs', v);
  const move = (i: number, d: -1 | 1) => {
    const next = [...langs];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setLangs(next);
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top + BAR_H }}>
      {/* The preview stays on screen while the options scroll under it. */}
      <View style={styles.preview}>
        <StylePreview prefs={prefs} />
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: S.lg, paddingTop: S.lg, paddingBottom: insets.bottom + S.xxl, gap: S.xl }}>
        <Group title="Langues préférées">
          <View style={styles.block}>
            <SwitchLine
              label="Afficher les sous-titres"
              hint="Choisit automatiquement la meilleure piste : dialogues complets dans ta langue préférée, puis la meilleure source ; pistes « forcées » (panneaux, chansons) seulement s’il n’y a rien d’autre."
              value={prefs.enabled}
              onChange={(enabled) => setSubtitlePrefs({ enabled })}
            />
            {langs.map((l, i) => (
              <View key={l} style={styles.langRow}>
                <View style={styles.rank}><Txt v="footnote" color={C.white} tabular style={{ fontWeight: '700' }}>{i + 1}</Txt></View>
                <Txt v="label" style={{ flex: 1 }}>{FLAG[l] ? `${FLAG[l]}  ` : ''}{langName(l)}</Txt>
                <Pressable disabled={i === 0} onPress={() => move(i, -1)} hitSlop={4} accessibilityRole="button" accessibilityLabel={`Monter ${langName(l)}`}
                  style={({ pressed }) => [styles.mini, pressed && { opacity: 0.6 }]}>
                  <Ionicons name="chevron-up" size={18} color={i === 0 ? C.text3 : C.text} style={{ opacity: i === 0 ? 0.5 : 1 }} />
                </Pressable>
                <Pressable disabled={i === langs.length - 1} onPress={() => move(i, 1)} hitSlop={4} accessibilityRole="button" accessibilityLabel={`Descendre ${langName(l)}`}
                  style={({ pressed }) => [styles.mini, pressed && { opacity: 0.6 }]}>
                  <Ionicons name="chevron-down" size={18} color={i === langs.length - 1 ? C.text3 : C.text} style={{ opacity: i === langs.length - 1 ? 0.5 : 1 }} />
                </Pressable>
                <Pressable disabled={langs.length === 1} onPress={() => setLangs(langs.filter((x) => x !== l))} hitSlop={4} accessibilityRole="button" accessibilityLabel={`Retirer ${langName(l)}`}
                  style={({ pressed }) => [styles.mini, pressed && { opacity: 0.6 }]}>
                  <Ionicons name="close" size={18} color={langs.length === 1 ? C.text3 : C.text2} style={{ opacity: langs.length === 1 ? 0.5 : 1 }} />
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

        <Group title="Traduction automatique">
          <View style={styles.block}>
            <SwitchLine
              label="Traduire automatiquement si ta langue manque"
              hint={`Pas de sous-titres en ${langName(langs[0]).toLowerCase()} mais en anglais (ou une autre langue) : ils sont traduits sur ton iPhone pendant la lecture. Rien n’est envoyé en ligne.`}
              value={autoTranslateSubs}
              onChange={(v) => setSetting('autoTranslateSubs', v)}
            />
            <TranslationModels target={langs[0]} />
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
      <NavBar title="Sous-titres" alwaysSolid />
    </View>
  );
}

const MODEL_SOURCES = ['en', 'es', 'pt', 'de', 'it', 'ja'];
const STATUS_LABEL = { installed: 'Installé', supported: 'À télécharger', unsupported: 'Non disponible' } as const;

/** Language models of the on-device translator into the primary language (status + download). */
function TranslationModels({ target }: { target: string }) {
  const sources = MODEL_SOURCES.filter((l) => l !== target);
  const statuses = useTranslateStatuses(sources.map((l) => [l, target]));
  if (!translationSupported()) {
    return <Txt v="small">Traduction sur l’appareil : iPhone avec iOS 18 ou plus récent (et une version d’Huwa qui l’inclut).</Txt>;
  }
  return (
    <View style={{ gap: S.sm }}>
      <Txt v="caption">Modèles vers {langName(target).toLowerCase()}</Txt>
      {sources.map((l) => {
        const st = statusOf(statuses, l, target);
        return (
          <View key={l} style={styles.langRow}>
            <Txt v="label" style={{ flex: 1 }}>{FLAG[l] ? `${FLAG[l]}  ` : ''}{langName(l)}</Txt>
            {st === 'supported' ? (
              <Button small variant="soft" icon="download-outline" label="Télécharger" onPress={() => void prepareModel(l, target)} />
            ) : (
              <Txt v="small" style={{ color: st === 'installed' ? C.accentText : C.text2 }}>{st ? STATUS_LABEL[st] : '…'}</Txt>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { paddingHorizontal: S.lg, paddingTop: S.sm, paddingBottom: S.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hairline },
  block: { gap: S.md, padding: S.md },
  langRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 44 },
  rank: { width: 22, height: 22, borderRadius: 11, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  mini: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: C.pill },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm },
});
