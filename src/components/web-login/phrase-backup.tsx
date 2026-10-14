// Backup of the recovery phrase right after "Créer un compte dans ce navigateur". The phrase is
// shown once (no copy button: no clipboard), then three random words are checked.
//
// The account exists as soon as it is created, so the root layout's `!me` guard may unmount the
// onboarding route that created it: the words are kept in this in-memory store until the backup
// is finished or postponed, and `PhraseBackupHost` (mounted once in the root layout) takes over
// whenever no inline `PhraseBackup` is on screen.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';

import { DANGER, WARN } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import { social } from '@/p2p/hooks';
import { normalizePhraseInput, pickVerifyIndices } from '@/social/identity';
import { C, R, S } from '@/theme/tokens';

import { Checkbox, ConfirmBox, ErrorLine, LinkButton, LoginFrame, LoginTitle, errorText } from './parts';

// ---------- pending backup (memory only) ----------

let pending: string[] | null = null;
let inline = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
let snapshot: { words: string[] | null; inline: boolean } = { words: null, inline: false };
const read = () => {
  if (snapshot.words !== pending || snapshot.inline !== inline > 0) snapshot = { words: pending, inline: inline > 0 };
  return snapshot;
};

export function setPendingBackup(words: string[] | null) {
  pending = words ? [...words] : null;
  emit();
}

const usePending = () => useSyncExternalStore(subscribe, read, read);

// ---------- the backup steps ----------

type Step = 'show' | 'later' | 'verify';

export type PhraseBackupProps = {
  words: string[];
  /** `verified`: the three words matched (markPhraseVerified done); false = "Plus tard". */
  onFinish: (verified: boolean) => void;
  /** Rendered by a screen (default): hides `PhraseBackupHost` meanwhile. The host passes false. */
  inline?: boolean;
};

export function PhraseBackup({ words, onFinish, inline: isInline = true }: PhraseBackupProps) {
  const { width } = useWindowDimensions();
  const [step, setStep] = useState<Step>('show');
  const [revealed, setRevealed] = useState(false);
  const [noted, setNoted] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [indices, setIndices] = useState<number[]>([]);
  const inputs = useRef<(TextInput | null)[]>([]);

  // While on screen, the root host stays hidden.
  useEffect(() => {
    if (!isInline) return;
    inline++;
    emit();
    return () => {
      inline--;
      emit();
    };
  }, [isInline]);

  const columns = width < 420 ? 3 : 4;

  const check = async () => {
    const ok = indices.every((i) => normalizePhraseInput(answers[i] ?? '')[0] === words[i]);
    if (!ok) {
      setWrong(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await social.markPhraseVerified();
      onFinish(true);
    } catch (e) {
      setError(errorText(e, 'Impossible d’enregistrer la vérification.'));
      setBusy(false);
    }
  };

  if (step === 'verify')
    return (
      <View style={{ gap: S.xl }}>
        <LoginTitle title="Vérifie ta copie" subtitle="Saisis ces trois mots de ta phrase, tels que tu les as notés." />
        <View style={{ gap: S.md }}>
          {indices.map((index, k) => (
            <View key={index} style={{ gap: S.xs }}>
              <Txt v="small" color={C.body} style={{ paddingHorizontal: 2 }}>{`Mot n° ${index + 1}`}</Txt>
              <TextInput
                ref={(r) => {
                  inputs.current[k] = r;
                }}
                value={answers[index] ?? ''}
                onChangeText={(t) => {
                  setWrong(false);
                  setAnswers((a) => ({ ...a, [index]: t }));
                }}
                onSubmitEditing={() => (k === indices.length - 1 ? check() : inputs.current[k + 1]?.focus())}
                returnKeyType={k === indices.length - 1 ? 'done' : 'next'}
                submitBehavior={k === indices.length - 1 ? 'blurAndSubmit' : 'submit'}
                autoFocus={k === 0}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                importantForAutofill="no"
                spellCheck={false}
                accessibilityLabel={`Mot numéro ${index + 1}`}
                selectionColor={C.accentText}
                style={[styles.field, wrong && { borderColor: DANGER }]}
              />
            </View>
          ))}
        </View>
        {wrong ? <ErrorLine text="Ce n’est pas ça. Relis ta copie, ou reviens à la phrase pour la corriger." /> : null}
        <ErrorLine text={error} />
        <View style={{ gap: S.sm }}>
          <Button label="Vérifier" icon="shield-checkmark" loading={busy} disabled={indices.some((i) => !answers[i]?.trim())} onPress={check} />
          <LinkButton label="Revoir la phrase" disabled={busy} onPress={() => setStep('show')} />
        </View>
      </View>
    );

  return (
    <View style={{ gap: S.xl }}>
      <LoginTitle title="Ta phrase de récupération" subtitle={`Ces ${words.length} mots sont la seule clé de ton compte. Écris-les sur papier, dans l’ordre.`} />

      <View style={styles.warn}>
        <Ionicons name="warning-outline" size={16} color={WARN} style={{ marginTop: 1 }} />
        <Txt v="small" style={{ flex: 1, lineHeight: 18 }}>
          Pas de capture d’écran ni de note en ligne : quiconque a ces mots contrôle ton compte. Huwa ne te la demandera jamais.
        </Txt>
      </View>

      <Pressable
        onPress={() => setRevealed(true)}
        disabled={revealed}
        accessibilityRole={revealed ? 'none' : 'button'}
        accessibilityLabel={revealed ? undefined : 'Afficher la phrase'}
        style={styles.grid}>
        {words.map((w, i) => (
          <View key={i} style={[styles.word, { width: columns === 3 ? '31.5%' : '23.5%' }]}>
            <Txt v="footnote" color={C.text3} tabular style={{ width: 20 }}>{i + 1}</Txt>
            <Txt v="label" style={{ fontSize: 14, flexShrink: 1 }} selectable={false}>{revealed ? w : '••••••'}</Txt>
          </View>
        ))}
        {!revealed ? (
          <View style={styles.veil}>
            <Ionicons name="eye-outline" size={24} color={C.text} />
            <Txt v="label">Afficher la phrase</Txt>
            <Txt v="small">Vérifie que personne ne regarde ton écran.</Txt>
          </View>
        ) : null}
      </Pressable>

      {step === 'later' ? (
        <ConfirmBox
          title="Noter ta phrase plus tard ?"
          confirmLabel="Plus tard"
          onConfirm={() => onFinish(false)}
          onCancel={() => setStep('show')}
          destructive>
          Dans ce navigateur, ta phrase n’est gardée que jusqu’au prochain rechargement de la page : ensuite, elle ne pourra plus être affichée ici. Si tu perds ce navigateur sans l’avoir notée, ton compte est perdu.
        </ConfirmBox>
      ) : (
        <View style={{ gap: S.md }}>
          <Checkbox checked={noted} onChange={setNoted} label="J’ai noté ma phrase" />
          <Button
            label="Vérifier ma copie"
            icon="arrow-forward"
            iconRight
            disabled={!revealed || !noted}
            onPress={() => {
              setAnswers({});
              setWrong(false);
              setIndices(pickVerifyIndices(crypto.getRandomValues(new Uint8Array(32)), 3, words.length));
              setStep('verify');
            }}
          />
          <LinkButton label="Plus tard" onPress={() => setStep('later')} />
        </View>
      )}
    </View>
  );
}

/**
 * Mount once in the web root layout, above the navigator: shows the pending phrase backup when the
 * route that created the account is gone (the `!me` guard switched to the app).
 */
export function PhraseBackupHost() {
  const { words, inline: shown } = usePending();
  if (!words || shown) return null;
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: C.bg, zIndex: 1000 }]}>
      <LoginFrame>
        <PhraseBackup words={words} inline={false} onFinish={() => setPendingBackup(null)} />
      </LoginFrame>
    </View>
  );
}

/** Words waiting for their backup (to keep a CreateAccount step in sync with the host). */
export const usePendingBackup = () => usePending().words;

const styles = StyleSheet.create({
  warn: {
    flexDirection: 'row', alignItems: 'flex-start', gap: S.sm, padding: S.md, borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: 'rgba(255,200,87,0.10)',
  },
  grid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: S.sm, justifyContent: 'space-between', padding: S.md, borderRadius: R.card,
    borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, overflow: 'hidden',
  },
  word: {
    flexDirection: 'row', alignItems: 'center', minHeight: 40, paddingHorizontal: S.sm, borderRadius: R.control, backgroundColor: C.elevated,
  },
  veil: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: S.sm, backgroundColor: 'rgba(12,17,28,0.96)' },
  field: {
    minHeight: 50, paddingHorizontal: S.lg, borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.surface,
    borderWidth: 1, borderColor: C.border, color: C.text, fontSize: 16,
  },
});
