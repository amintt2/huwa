import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Callout } from '@/components/feedback';
import { Screen } from '@/components/screen';
import { Field, Group, PillAction, Row, SwitchRow, shortKey } from '@/components/social';
import { Button, Press, Txt } from '@/components/ui';
import { social, useBlocked, useLabels, useMe, useProfile } from '@/p2p/hooks';
import { setPrefs, usePrefs } from '@/p2p/prefs';
import { isPublicKey } from '@/social/identity';
import { activeLabels } from '@/social/moderation';
import { C, R, S, SHADOW } from '@/theme/tokens';

function LabelerRow({ k, on, count, last }: { k: string; on: boolean; count: number; last?: boolean }) {
  const { profile } = useProfile(k);
  return (
    <SwitchRow
      icon="list-outline"
      label={profile?.name ?? shortKey(k)}
      detail={`${count} compte${count > 1 ? 's' : ''} signalé${count > 1 ? 's' : ''}${profile?.bio ? ` · ${profile.bio}` : ''}`}
      value={on}
      onChange={(v) => {
        Haptics.selectionAsync();
        social.setSubscribed(k, v);
      }}
      last={last}
    />
  );
}

function BlockedRow({ k, last }: { k: string; last?: boolean }) {
  const { profile } = useProfile(k);
  const name = profile?.name ?? shortKey(k);
  return (
    <Row
      label={name}
      detail={profile?.fingerprint}
      onPress={() => router.push(`/u/${k}`)}
      chevron={false}
      last={last}
      right={
        <PillAction label="Débloquer" accessibilityLabel={`Débloquer ${name}`} onPress={() => social.setBlocked(k, false)} />
      }
    />
  );
}

export default function Moderation() {
  const me = useMe();
  const labels = useLabels();
  const blocked = useBlocked();
  const subscriptions = usePrefs((p) => p.subscriptions);
  const known = usePrefs((p) => p.knownLabelers);
  const words = usePrefs((p) => p.words);
  const [listInput, setListInput] = useState('');
  const [listError, setListError] = useState<string>();
  const [word, setWord] = useState('');

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of activeLabels(labels)) if (l.by !== me?.key) m.set(l.by, (m.get(l.by) ?? 0) + 1);
    return m;
  }, [labels, me?.key]);

  const addList = () => {
    const key = /([0-9a-f]{64})/.exec(listInput.trim().toLowerCase())?.[1];
    if (!key || !isPublicKey(key)) return setListError('Colle une clé publique ou un lien huwa://u/…');
    if (key === me?.key) return setListError('Ta propre liste s’applique déjà.');
    setListError(undefined);
    setListInput('');
    social.setSubscribed(key, true);
  };

  const addWord = () => {
    const w = word.trim();
    if (!w) return;
    setPrefs((p) => ({ ...p, words: [...new Set([...p.words, w])] }));
    setWord('');
  };

  return (
    <Screen title="Modération">
        <Callout icon="shield-half-outline">
          <Txt v="small" color={C.body} style={{ lineHeight: 18 }}>
            Rien n’est supprimé du réseau : Huwa masque sur ton appareil. Un compte est masqué si tu le bloques, ou si{' '}
            <Txt v="small" color={C.text} style={{ fontWeight: '600' }}>au moins 2 de tes listes</Txt> le bloquent.
          </Txt>
        </Callout>

        <Group title="Listes de blocage" footer="Une liste est publiée par une personne ou un groupe de bénévoles. Tu choisis à qui tu fais confiance.">
          {known.map((k, i) => (
            <LabelerRow key={k} k={k} on={subscriptions.includes(k)} count={counts.get(k) ?? 0} last={i === known.length - 1} />
          ))}
          {!known.length && <Row label="Aucune liste" detail="Ajoute une liste ci-dessous." last />}
        </Group>

        <View style={{ gap: S.sm }}>
          <Field
            label="S’abonner à une liste"
            value={listInput}
            onChangeText={(t) => {
              setListInput(t);
              setListError(undefined);
            }}
            placeholder="huwa://u/… ou clé publique"
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={addList}
            returnKeyType="done"
            error={listError}
          />
          <Button variant="soft" small label="Ajouter la liste" icon="add" onPress={addList} />
        </View>

        <Group title={`Comptes bloqués (${blocked.length})`} footer="Les comptes bloqués ne peuvent plus t’écrire et leurs commentaires sont masqués.">
          {blocked.length ? (
            blocked.map((k, i) => <BlockedRow key={k} k={k} last={i === blocked.length - 1} />)
          ) : (
            <Row label="Personne" detail="Appui long sur un commentaire pour bloquer son auteur." last />
          )}
        </Group>

        <View style={{ gap: S.sm }}>
          <Txt v="caption" accessibilityRole="header" style={{ paddingHorizontal: S.md }}>Mots masqués</Txt>
          <View style={styles.words}>
            {words.map((w) => (
              <Pressable
                key={w}
                onPress={() => setPrefs((p) => ({ ...p, words: p.words.filter((x) => x !== w) }))}
                accessibilityRole="button"
                accessibilityLabel={`Retirer ${w}`}
                style={styles.word}>
                <Txt v="small" color={C.text}>{w}</Txt>
                <Ionicons name="close" size={14} color={C.text2} />
              </Pressable>
            ))}
            {!words.length && <Txt v="small">Aucun mot. Les commentaires contenant un mot de la liste sont masqués (majuscules et accents ignorés).</Txt>}
          </View>
          <View style={{ flexDirection: 'row', gap: S.sm, alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <Field
                value={word}
                onChangeText={setWord}
                placeholder="Mot ou expression"
                autoCapitalize="none"
                onSubmitEditing={addWord}
                returnKeyType="done"
                accessibilityLabel="Ajouter un mot masqué"
                maxLength={40}
              />
            </View>
            <Press onPress={addWord} haptics="light" accessibilityRole="button" accessibilityLabel="Ajouter le mot" style={styles.add}>
              <Ionicons name="add" size={22} color={C.white} />
            </Press>
          </View>
        </View>

        {me && (
          <Group footer="Tes blocages forment une liste à laquelle d’autres peuvent s’abonner depuis ton profil.">
            <Row icon="share-outline" label="Ma liste de blocage" onPress={() => router.push(`/u/${me.key}`)} last />
          </Group>
        )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  words: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm, paddingHorizontal: S.xs },
  word: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 34, paddingHorizontal: S.md,
    borderRadius: R.pill, backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border,
  },
  add: { width: 50, height: 50, borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', boxShadow: `${SHADOW.primary}, ${SHADOW.insetStrong}` },
});
