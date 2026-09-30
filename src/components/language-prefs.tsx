// Watching / reading language defaults: onboarding page and Réglages → Général → Langues.
// Languages are picked in order: first tap = primary, second = secondary (numbered chips).
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, View } from 'react-native';

import { setSetting, useSettings, type LangList } from '@/settings/settings';
import { C, F, R, S } from '@/theme/tokens';

import { Press, Txt } from './ui';

const NAMES: Record<string, string> = {
  fr: 'Français', en: 'Anglais', es: 'Espagnol', de: 'Allemand', it: 'Italien',
  pt: 'Portugais', ar: 'Arabe', ja: 'Japonais', ko: 'Coréen',
};
export const FLAG: Record<string, string> = {
  fr: '🇫🇷', en: '🇬🇧', es: '🇪🇸', de: '🇩🇪', it: '🇮🇹', pt: '🇵🇹', ar: '🇸🇦', ja: '🇯🇵', ko: '🇰🇷',
};
const SUB_LANGS = ['fr', 'en', 'es', 'de', 'it', 'pt', 'ar'];
const DUB_LANGS = ['fr', 'en', 'es', 'de', 'it', 'pt'];
const MANGA_LANGS = ['fr', 'en', 'es', 'pt', 'de', 'it', 'ko'];

function Segment<T extends string | boolean>({ value, options, onChange }: { value: T; options: { v: T; label: string; hint: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={{ gap: S.sm }}>
      {options.map((o) => {
        const on = o.v === value;
        return (
          <Press key={String(o.v)} onPress={() => onChange(o.v)} accessibilityRole="radio" accessibilityState={{ selected: on }}
            style={[styles.option, on && styles.optionOn]}>
            <Ionicons name={on ? 'radio-button-on' : 'radio-button-off'} size={20} color={on ? C.accentText : C.text2} />
            <View style={{ flex: 1, gap: 1 }}>
              <Txt v="label">{o.label}</Txt>
              <Txt v="small">{o.hint}</Txt>
            </View>
          </Press>
        );
      })}
    </View>
  );
}

/** Ordered multi-select: tap adds at the end, tap again removes; at least one stays selected. */
function LangPicker({ value, choices, onChange }: { value: LangList; choices: string[]; onChange: (v: LangList) => void }) {
  const toggle = (c: string) => {
    if (value.includes(c)) {
      if (value.length > 1) onChange(value.filter((x) => x !== c));
    } else if (value.length < 3) onChange([...value, c]);
  };
  return (
    <View style={styles.chips}>
      {choices.map((c) => {
        const i = value.indexOf(c);
        const on = i >= 0;
        return (
          <Press key={c} onPress={() => toggle(c)} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
            accessibilityLabel={`${NAMES[c]}${on ? `, choix ${i + 1}` : ''}`} style={[styles.chip, on && styles.chipOn]}>
            {on && (
              <View style={styles.rank}>
                <Txt v="caption" color={C.white} style={{ fontSize: 10 }}>{i + 1}</Txt>
              </View>
            )}
            <Txt style={{ fontSize: 16 }}>{FLAG[c]}</Txt>
            <Txt v="small" color={on ? C.text : C.text2} style={F.semibold}>{NAMES[c]}</Txt>
          </Press>
        );
      })}
    </View>
  );
}

export function LanguagePrefs() {
  const s = useSettings();
  return (
    <View style={{ gap: S.xl, alignSelf: 'stretch' }}>
      <View style={{ gap: S.md }}>
        <Txt v="label" style={{ fontSize: 16 }}>Tu regardes les anime…</Txt>
        <Segment
          value={s.watchMode}
          onChange={(v) => setSetting('watchMode', v)}
          options={[
            { v: 'sub', label: 'En VO sous-titrée', hint: 'Voix japonaises, sous-titres dans ta langue.' },
            { v: 'dub', label: 'Doublés', hint: 'Voix dans ta langue quand une version doublée existe.' },
          ]}
        />
        <Txt v="small">{s.watchMode === 'sub' ? 'Langue des sous-titres (1 = principale)' : 'Langue du doublage (1 = principale)'}</Txt>
        {s.watchMode === 'sub' ? (
          <LangPicker value={s.subLangs} choices={SUB_LANGS} onChange={(v) => setSetting('subLangs', v)} />
        ) : (
          <LangPicker value={s.dubLangs} choices={DUB_LANGS} onChange={(v) => setSetting('dubLangs', v)} />
        )}
      </View>

      <View style={{ gap: S.md }}>
        <Txt v="label" style={{ fontSize: 16 }}>Tu lis des manhwa ?</Txt>
        <Segment
          value={s.readsManhwa}
          onChange={(v) => setSetting('readsManhwa', v)}
          options={[
            { v: true, label: 'Oui', hint: 'Huwa te propose le chapitre où reprendre après l’anime.' },
            { v: false, label: 'Pas pour l’instant', hint: 'Tu pourras l’activer plus tard dans les réglages.' },
          ]}
        />
        {s.readsManhwa && (
          <>
            <Txt v="small">Langue de lecture (1 = principale)</Txt>
            <LangPicker value={s.mangaLangs} choices={MANGA_LANGS} onChange={(v) => setSetting('mangaLangs', v)} />
          </>
        )}
      </View>
      <Txt v="small">Ce ne sont que des valeurs par défaut : tu peux choisir une autre source ou langue à tout moment.</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  option: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  optionOn: { borderColor: C.accentLine, backgroundColor: C.accentSoft },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 12, borderRadius: R.pill,
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  chipOn: { backgroundColor: C.accentSoft, borderColor: C.accentLine },
  rank: { width: 18, height: 18, borderRadius: 9, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
});
