import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DANGER, Empty, Loading, ScreenHeader, WARN } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import { social } from '@/p2p/hooks';
import { recoveryPhrase } from '@/p2p/phrase';
import { randomBytes } from '@/p2p/secure';
import { pickVerifyIndices } from '@/social/identity';
import { C, F, R, S } from '@/theme/tokens';

type Step = 'intro' | 'show' | 'verify' | 'done';

function quiz(words: string[]) {
  const rnd = randomBytes(32);
  const indices = pickVerifyIndices(rnd);
  return indices.map((index, q) => {
    const others = words.filter((w, i) => i !== index && w !== words[index]);
    const picks = new Set<string>();
    for (let k = 0; picks.size < 3 && k < 64; k++) picks.add(others[(rnd[(q * 7 + k) % rnd.length] + k * 5) % others.length]);
    const options = [words[index], ...picks];
    // Shuffle deterministically from the random bytes.
    for (let i = options.length - 1; i > 0; i--) {
      const j = rnd[(q * 3 + i) % rnd.length] % (i + 1);
      [options[i], options[j]] = [options[j], options[i]];
    }
    return { index, answer: words[index], options };
  });
}

export default function Phrase() {
  const insets = useSafeAreaInsets();
  const [words, setWords] = useState<string[] | null>();
  const [step, setStep] = useState<Step>('intro');
  const [revealed, setRevealed] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [wrong, setWrong] = useState(false);

  useEffect(() => {
    recoveryPhrase.get().then((w) => setWords(w ?? null));
  }, []);

  const questions = useMemo(() => (words && step === 'verify' ? quiz(words) : []), [words, step]);

  const check = async () => {
    const ok = questions.every((q) => answers[q.index] === q.answer);
    if (!ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setWrong(true);
      return;
    }
    await social.markPhraseVerified();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setStep('done');
  };

  let body;
  if (words === undefined) body = <Loading />;
  else if (words === null)
    body = (
      <Empty
        icon="phone-portrait-outline"
        title="Phrase absente de cet appareil"
        text="Cet appareil a été lié par QR code : la phrase n’y a jamais été copiée. Affiche-la depuis ton appareil d’origine."
      />
    );
  else if (step === 'intro')
    body = (
      <View style={{ gap: S.lg }}>
        {[
          ['create-outline', 'Écris les 24 mots sur papier, dans l’ordre.'],
          ['eye-off-outline', 'Pas de capture d’écran ni de note en ligne : quiconque a ces mots contrôle ton compte.'],
          ['chatbubble-ellipses-outline', 'Huwa ne te demandera jamais ta phrase. Personne d’autre ne doit te la demander.'],
        ].map(([icon, text]) => (
          <View key={text} style={{ flexDirection: 'row', gap: S.md, alignItems: 'center' }}>
            <Ionicons name={icon as 'create-outline'} size={22} color={C.accentText} />
            <Txt v="body" style={{ flex: 1 }}>{text}</Txt>
          </View>
        ))}
        <Button label="Afficher ma phrase" icon="key" onPress={() => setStep('show')} />
      </View>
    );
  else if (step === 'show')
    body = (
      <View style={{ gap: S.lg }}>
        <Pressable
          onPress={() => setRevealed(true)}
          accessibilityRole="button"
          accessibilityLabel={revealed ? 'Phrase affichée' : 'Toucher pour afficher la phrase'}
          style={styles.grid}>
          {words.map((w, i) => (
            <View key={i} style={styles.word}>
              <Txt v="small" style={{ width: 22, fontVariant: ['tabular-nums'] }}>{i + 1}</Txt>
              <Txt v="label" style={{ fontSize: 14 }} selectable={false}>{revealed ? w : '••••••'}</Txt>
            </View>
          ))}
          {!revealed && (
            <View style={styles.veil}>
              <Ionicons name="eye-outline" size={24} color={C.text} />
              <Txt v="label">Touche pour afficher</Txt>
              <Txt v="small">Vérifie que personne ne regarde ton écran.</Txt>
            </View>
          )}
        </Pressable>
        {revealed && <Button label="Je l’ai notée" icon="checkmark" onPress={() => { setAnswers({}); setWrong(false); setStep('verify'); }} />}
      </View>
    );
  else if (step === 'verify')
    body = (
      <View style={{ gap: S.xl }}>
        <Txt v="body">Pour être sûr que ta copie est bonne, choisis ces trois mots.</Txt>
        {questions.map((q) => (
          <View key={q.index} style={{ gap: S.sm }}>
            <Txt v="label">{`Mot n° ${q.index + 1}`}</Txt>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: S.sm }}>
              {q.options.map((o) => {
                const on = answers[q.index] === o;
                return (
                  <Pressable
                    key={o}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setWrong(false);
                      setAnswers((a) => ({ ...a, [q.index]: o }));
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    style={[styles.option, on && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
                    <Txt v="label" color={on ? C.white : C.body} style={{ fontSize: 14 }}>{o}</Txt>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
        {wrong && <Txt v="small" color={DANGER}>Ce n’est pas ça. Relis ta copie, ou reviens à la phrase pour la corriger.</Txt>}
        <Button label="Vérifier" icon="shield-checkmark" onPress={check} />
        <Pressable onPress={() => setStep('show')} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Txt v="label" color={C.accentText} style={F.semibold}>Revoir la phrase</Txt>
        </Pressable>
      </View>
    );
  else
    body = (
      <Empty
        icon="shield-checkmark"
        title="Phrase vérifiée"
        text="Garde ta copie en lieu sûr. Avec elle, tu retrouveras ton compte sur n’importe quel appareil."
        action={<Button label="Terminé" onPress={() => router.back()} />}
      />
    );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <ScreenHeader title="Phrase de récupération" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: S.lg, paddingBottom: insets.bottom + S.xxl, gap: S.xl }}>
        {step !== 'done' && words && (
          <View style={styles.warn}>
            <Ionicons name="warning-outline" size={16} color={WARN} />
            <Txt v="small" style={{ flex: 1 }}>Ces 24 mots sont la seule clé de ton compte.</Txt>
          </View>
        )}
        {body}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: S.sm, padding: S.md, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, overflow: 'hidden',
  },
  word: {
    width: '31.5%', flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: S.sm,
    borderRadius: R.control, backgroundColor: C.elevated,
  },
  veil: {
    ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: S.sm,
    backgroundColor: 'rgba(12,17,28,0.96)',
  },
  option: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: S.lg, borderRadius: R.pill,
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border,
  },
  warn: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm, padding: S.md, borderRadius: R.control,
    backgroundColor: 'rgba(255,200,87,0.10)',
  },
});
