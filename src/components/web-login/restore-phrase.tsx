// "Utiliser ma phrase de récupération" on the web: one field per word (pasting the whole phrase in
// any field fills them all). The words live in this component's state only and are dropped on
// success and on unmount; they are never written anywhere (src/p2p/phrase.web.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';

import { RestoreOfflineNotice } from '@/components/restore-offline';
import { DANGER } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import type { Profile, RestoreOptions } from '@/p2p/contract';
import { isRestoreNotFound } from '@/p2p/errors';
import { restoreWithPhrase } from '@/p2p/web/login';
import { PHRASE_WORDS, isValidPhrase, normalizePhraseInput, unknownWords } from '@/social/identity';
import { C, R, S } from '@/theme/tokens';

import { useLoginMode } from './login-mode';
import { ErrorLine, LinkButton, LoginFrame, LoginTitle, errorText, useAbandonOnUnmount } from './parts';

const EMPTY: string[] = Array.from({ length: PHRASE_WORDS }, () => '');

export type RestorePhraseProps = {
  onDone: (profile: Profile) => void;
  onBack?: () => void;
  /** "Créer un nouveau compte à la place", offered when no device of the account answers. */
  onCreate?: () => void;
};

export function RestorePhrase({ onDone, onBack, onCreate }: RestorePhraseProps) {
  const { mode } = useLoginMode();
  const { width } = useWindowDimensions();
  const [words, setWords] = useState<string[]>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** None of the account's devices answered: nothing was changed. */
  const [notFound, setNotFound] = useState(false);
  const inputs = useRef<(TextInput | null)[]>([]);
  const flow = useAbandonOnUnmount();

  // Never keep the words longer than the screen.
  useEffect(() => () => setWords(EMPTY), []);

  const unknown = useMemo(() => new Set(unknownWords(words).filter((i) => words[i])), [words]);
  const filled = words.filter(Boolean).length;
  const complete = filled === PHRASE_WORDS;
  const valid = complete && isValidPhrase(words);
  const columns = width < 420 ? 3 : 4;

  const focus = (i: number) => inputs.current[Math.min(i, PHRASE_WORDS - 1)]?.focus();

  const change = (i: number, text: string) => {
    setError(undefined);
    setNotFound(false);
    const parts = normalizePhraseInput(text);
    if (parts.length > 1) {
      // A pasted phrase (or several words): fill from this field on.
      setWords((w) => {
        const next = [...w];
        parts.slice(0, PHRASE_WORDS - i).forEach((p, k) => (next[i + k] = p));
        return next;
      });
      focus(i + parts.length);
      return;
    }
    const word = parts[0] ?? '';
    setWords((w) => w.map((x, k) => (k === i ? word : x)));
    if (word && /\s$/.test(text)) focus(i + 1);
  };

  const run = async (restore?: RestoreOptions) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    flow.start();
    try {
      const profile = await restoreWithPhrase(words, { mode, restore });
      flow.finish();
      setWords(EMPTY);
      setNotFound(false);
      onDone(profile);
    } catch (e) {
      if (isRestoreNotFound(e)) setNotFound(true);
      else setError(errorText(e, 'Restauration impossible.'));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (valid) run();
  };

  const hint = unknown.size
    ? `Mot${unknown.size > 1 ? 's' : ''} inconnu${unknown.size > 1 ? 's' : ''} : ${[...unknown].map((i) => `n° ${i + 1}`).join(', ')}`
    : complete && !valid
      ? `Les ${PHRASE_WORDS} mots sont reconnus mais la phrase ne correspond pas : vérifie leur ordre.`
      : undefined;

  return (
    <LoginFrame onBack={onBack} center={false}>
      <LoginTitle title="Phrase de récupération" subtitle={`Saisis tes ${PHRASE_WORDS} mots dans l’ordre. Tu peux coller toute la phrase dans la première case.`} />

      {notFound ? (
        <RestoreOfflineNotice
          busy={busy}
          onRetry={() => run()}
          onRestoreWithoutData={(name) => run({ allowNewHome: true, name })}
          onNewAccount={onCreate}
        />
      ) : null}

      <View style={styles.grid} accessibilityRole="none">
        {words.map((w, i) => {
          const bad = unknown.has(i);
          return (
            <View key={i} style={[styles.cell, { width: columns === 3 ? '31.5%' : '23.5%' }, bad && { borderColor: DANGER }]}>
              <Txt v="footnote" color={C.text3} tabular style={styles.index}>{i + 1}</Txt>
              <TextInput
                ref={(r) => {
                  inputs.current[i] = r;
                }}
                value={w}
                onChangeText={(t) => change(i, t)}
                onSubmitEditing={() => (i === PHRASE_WORDS - 1 ? submit() : focus(i + 1))}
                onKeyPress={(e) => {
                  if (e.nativeEvent.key === 'Backspace' && !w && i > 0) focus(i - 1);
                }}
                returnKeyType={i === PHRASE_WORDS - 1 ? 'done' : 'next'}
                submitBehavior={i === PHRASE_WORDS - 1 ? 'blurAndSubmit' : 'submit'}
                autoFocus={i === 0}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                importantForAutofill="no"
                spellCheck={false}
                editable={!busy}
                accessibilityLabel={`Mot ${i + 1}`}
                accessibilityHint={bad ? 'Mot inconnu' : undefined}
                placeholderTextColor={C.text3}
                selectionColor={C.accentText}
                style={styles.input}
              />
            </View>
          );
        })}
      </View>

      <View style={{ gap: S.sm }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: S.md }}>
          <Txt v="small" color={hint ? DANGER : C.text2} style={{ flex: 1, lineHeight: 18 }}>
            {hint ?? 'Ta phrase reste dans ce navigateur : elle n’est envoyée à aucun serveur ni enregistrée.'}
          </Txt>
          <Txt v="small" tabular color={complete ? C.accentText : C.text2}>{`${filled}/${PHRASE_WORDS}`}</Txt>
        </View>
        <ErrorLine text={error} />
      </View>

      <View style={{ gap: S.sm }}>
        <Button label="Restaurer mon compte" icon="key" loading={busy && !notFound} disabled={!valid} onPress={submit} />
        {filled ? (
          <LinkButton
            label="Effacer les mots"
            disabled={busy}
            onPress={() => {
              setWords(EMPTY);
              setError(undefined);
              setNotFound(false);
              focus(0);
            }}
          />
        ) : null}
      </View>

      <Txt v="footnote" color={C.text3} style={{ lineHeight: 17 }}>
        Sans phrase, sans téléphone connecté et sans clé d’accès, un compte ne peut pas être récupéré : personne d’autre ne détient ta clé.
      </Txt>
    </LoginFrame>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm, justifyContent: 'space-between' },
  cell: {
    flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingLeft: S.sm, borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  index: { width: 20 },
  input: { flex: 1, minWidth: 0, height: 42, color: C.text, fontSize: 15, paddingHorizontal: 4 },
});
