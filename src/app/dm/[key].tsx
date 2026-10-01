import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { reportAccount } from '@/components/report';
import { Avatar, Empty, shortKey } from '@/components/social';
import { Button, IconButton, Press, Txt } from '@/components/ui';
import type { DirectMessage } from '@/p2p/contract';
import { social, useBlocked, useMe, useMessages, useP2PStatus, usePetname, useProfile } from '@/p2p/hooks';
import { usePrefs } from '@/p2p/prefs';
import { isPublicKey } from '@/social/identity';
import { C, F, S } from '@/theme/tokens';

const time = (t: number) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const day = (t: number) => new Date(t).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

type Item = { kind: 'day'; id: string; label: string } | { kind: 'msg'; id: string; m: DirectMessage; mine: boolean; tail: boolean };

export default function Conversation() {
  const { key: raw } = useLocalSearchParams<{ key: string }>();
  const peer = (raw ?? '').toLowerCase();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const self = peer === me?.key;
  const { profile } = useProfile(peer);
  const name = usePetname(peer, self ? 'Notes pour moi' : (profile?.name ?? shortKey(peer)));
  const messages = useMessages(peer);
  const blocked = useBlocked().includes(peer);
  const following = usePrefs((p) => p.follows.includes(peer));
  const [text, setText] = useState('');
  const [accepted, setAccepted] = useState(false);
  const list = useRef<FlatList<Item>>(null);
  const local = useP2PStatus().peers === 0;

  const isRequest = !self && !following && !accepted && messages.length > 0 && !messages.some((m) => m.from === me?.key);

  useEffect(() => {
    if (messages.length && !isRequest) social.markRead(peer);
  }, [messages.length, peer, isRequest]);

  // Newest at the bottom: the list is inverted, so items are built newest-first.
  const items = useMemo(() => {
    const out: Item[] = [];
    const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt);
    let lastDay = '';
    sorted.forEach((m, i) => {
      const d = new Date(m.createdAt).toDateString();
      if (d !== lastDay) {
        out.push({ kind: 'day', id: `d-${d}`, label: day(m.createdAt) });
        lastDay = d;
      }
      const next = sorted[i + 1];
      const tail = !next || next.from !== m.from || next.createdAt - m.createdAt > 5 * 60_000;
      out.push({ kind: 'msg', id: m.id, m, mine: m.from === me?.key, tail });
    });
    return out.reverse();
  }, [messages, me?.key]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    try {
      await social.sendMessage(peer, body);
      Haptics.selectionAsync();
    } catch (e) {
      setText(body);
      Alert.alert('Message non envoyé', e instanceof Error ? e.message : String(e));
    }
  };

  const report = () => reportAccount({ key: peer, name, where: 'messages privés', blocked, onBlocked: () => router.back() });
  const toggleBlock = () => {
    if (blocked) return void social.setBlocked(peer, false);
    Alert.alert(`Bloquer ${name} ?`, 'Ses messages et commentaires seront masqués et il ne pourra plus t’écrire.', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Bloquer', style: 'destructive', onPress: () => social.setBlocked(peer, true).then(() => router.back()).catch(() => {}) },
    ]);
  };
  const more = () => {
    const actions = [
      { label: 'Voir le profil', run: () => router.push(`/u/${peer}`) },
      { label: 'Signaler', run: report },
      { label: blocked ? 'Débloquer' : 'Bloquer', run: toggleBlock },
    ];
    if (Platform.OS === 'ios')
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...actions.map((a) => a.label), 'Annuler'], cancelButtonIndex: actions.length, destructiveButtonIndex: blocked ? undefined : actions.length - 1, userInterfaceStyle: 'dark' },
        (i) => actions[i]?.run(),
      );
    else Alert.alert(name, undefined, [...actions.map((a) => ({ text: a.label, onPress: a.run })), { text: 'Annuler', style: 'cancel' }]);
  };

  if (!isPublicKey(peer)) return <Empty icon="help-circle-outline" title="Conversation introuvable" />;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={[styles.header, { paddingTop: insets.top + S.sm }]}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        <Pressable
          onPress={() => router.push(`/u/${peer}`)}
          accessibilityRole="button"
          accessibilityLabel={`Profil de ${name}`}
          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
          <Avatar seed={peer} name={name} size={36} />
          <View style={{ flex: 1 }}>
            <Txt v="label" numberOfLines={1}>{name}</Txt>
            <Txt v="small" style={{ fontSize: 11 }}>{self ? 'Visible seulement par toi' : profile?.fingerprint ?? ''}</Txt>
          </View>
        </Pressable>
        {!self && <IconButton icon="ellipsis-horizontal" label="Plus d’options : signaler, bloquer" onPress={more} />}
      </View>

      <FlatList
        ref={list}
        inverted
        data={items}
        keyExtractor={(i) => i.id}
        keyboardDismissMode="interactive"
        contentContainerStyle={{ paddingHorizontal: S.md, paddingVertical: S.md, gap: 2, flexGrow: 1 }}
        ListFooterComponent={
          <View style={{ alignItems: 'center', gap: S.sm, paddingVertical: S.xl }}>
            <Ionicons name="lock-closed" size={14} color={C.text2} />
            <Txt v="small" style={{ textAlign: 'center', fontSize: 12, maxWidth: 280 }}>
              {self
                ? 'Tes notes restent sur tes appareils.'
                : local
                  ? 'Mode local : aucun pair connecté. Les messages partiront, chiffrés de bout en bout, dès que le réseau P2P sera actif.'
                  : 'Messages chiffrés de bout en bout. Ni Huwa ni les relais ne peuvent les lire.'}
            </Txt>
          </View>
        }
        renderItem={({ item }) =>
          item.kind === 'day' ? (
            <Txt v="caption" style={{ textAlign: 'center', paddingVertical: S.md, fontSize: 10 }}>{item.label}</Txt>
          ) : (
            <View style={{ alignItems: item.mine ? 'flex-end' : 'flex-start', marginBottom: item.tail ? S.sm : 0 }}>
              <View
                style={[
                  styles.bubble,
                  item.mine ? styles.mine : styles.theirs,
                  item.tail && (item.mine ? { borderBottomRightRadius: 6 } : { borderBottomLeftRadius: 6 }),
                ]}>
                <Txt v="body" color={item.mine ? C.white : C.text} selectable>{item.m.text}</Txt>
              </View>
              {item.tail && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3, paddingHorizontal: 6 }}>
                  <Txt v="small" style={{ fontSize: 11 }}>{time(item.m.createdAt)}</Txt>
                  {item.mine && !self && (
                    <Ionicons
                      name={item.m.delivered ? 'checkmark-done' : 'time-outline'}
                      size={12}
                      color={item.m.delivered ? C.accentText : C.text2}
                      accessibilityLabel={item.m.delivered ? 'Remis' : 'En attente'}
                    />
                  )}
                </View>
              )}
            </View>
          )
        }
      />

      {blocked ? (
        <View style={[styles.banner, { paddingBottom: insets.bottom + S.md }]}>
          <Txt v="small" style={{ textAlign: 'center' }}>Tu as bloqué ce compte.</Txt>
          <Button variant="ghost" small label="Débloquer" onPress={() => social.setBlocked(peer, false)} />
        </View>
      ) : isRequest ? (
        <View style={[styles.banner, { paddingBottom: insets.bottom + S.md }]}>
          <Txt v="label" style={{ textAlign: 'center' }}>{`${name} veut t’écrire`}</Txt>
          <Txt v="small" style={{ textAlign: 'center' }}>Tu ne suis pas ce compte. Il ne saura pas que tu as lu son message tant que tu n’acceptes pas.</Txt>
          <View style={{ flexDirection: 'row', gap: S.sm }}>
            <Button
              style={{ flex: 1 }}
              variant="ghost"
              small
              label="Bloquer"
              onPress={() => {
                social.setBlocked(peer, true);
                router.back();
              }}
            />
            <Button style={{ flex: 1 }} variant="ghost" small label="Signaler" onPress={report} />
            <Button style={{ flex: 1 }} small label="Accepter" onPress={() => setAccepted(true)} />
          </View>
        </View>
      ) : (
        <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, S.md) }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={self ? 'Écrire une note…' : 'Message'}
            placeholderTextColor="#8A8AA0"
            keyboardAppearance="dark"
            multiline
            maxLength={4000}
            style={styles.input}
            accessibilityLabel="Écrire un message"
          />
          <Press
            onPress={send}
            disabled={!text.trim()}
            accessibilityLabel="Envoyer"
            style={[styles.send, { opacity: text.trim() ? 1 : 0.4 }]}>
            <Ionicons name="arrow-up" size={20} color={C.onAccent} />
          </Press>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingBottom: S.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  bubble: { maxWidth: '80%', paddingVertical: 9, paddingHorizontal: 14, borderRadius: 20, borderCurve: 'continuous' },
  mine: { backgroundColor: C.accent },
  theirs: { backgroundColor: C.elevated },
  banner: {
    gap: S.sm, paddingTop: S.md, paddingHorizontal: S.lg, backgroundColor: C.surface,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border,
  },
  composer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingTop: S.sm, paddingHorizontal: S.lg,
    backgroundColor: C.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border,
  },
  input: {
    flex: 1, minHeight: 44, maxHeight: 130, paddingHorizontal: S.lg, paddingTop: 12, paddingBottom: 12,
    borderRadius: 22, backgroundColor: C.elevated, color: C.text, ...F.regular, fontSize: 15,
  },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: C.accent },
});
