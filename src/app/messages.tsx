import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ago } from '@/components/comments';
import { Screen } from '@/components/screen';
import { Avatar, CountBadge, Empty, Group, Row, shortKey } from '@/components/social';
import { Segmented } from '@/components/states';
import { IconButton, Txt } from '@/components/ui';
import type { Conversation } from '@/p2p/contract';
import { useConversations, useMe, useP2PStatus, usePetname, useProfile } from '@/p2p/hooks';
import { usePrefs } from '@/p2p/prefs';
import { C, F, S } from '@/theme/tokens';

function ConversationRow({ c, last }: { c: Conversation; last?: boolean }) {
  const name = usePetname(c.peer, c.peerName);
  return (
    <Pressable
      onPress={() => router.push(`/dm/${c.peer}`)}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${c.unread ? `${c.unread} non lus, ` : ''}${c.lastText}`}
      style={({ pressed }) => [styles.conv, pressed && { backgroundColor: 'rgba(255,255,255,0.05)' }]}>
      {c.unread ? <View style={styles.unreadDot} /> : null}
      <Avatar seed={c.peer} name={name} size={50} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: S.sm }}>
          <Txt v="label" numberOfLines={1} style={{ flex: 1, ...(c.unread ? F.heavy : null) }}>{name}</Txt>
          <Txt v="footnote" tabular color={c.unread ? C.accentText : C.text3}>{ago(c.lastAt)}</Txt>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
          <Txt v="small" numberOfLines={2} color={c.unread ? C.body : C.text2} style={{ flex: 1 }}>{c.lastText}</Txt>
          <CountBadge n={c.unread} />
        </View>
      </View>
      {!last && <View style={styles.convLine} />}
    </Pressable>
  );
}

function FollowRow({ k, last }: { k: string; last?: boolean }) {
  const { profile } = useProfile(k);
  const name = usePetname(k, profile?.name ?? shortKey(k));
  return <Row label={name} detail={profile?.fingerprint} onPress={() => router.push(`/dm/${k}`)} last={last} />;
}

export default function Messages() {
  const me = useMe();
  const { conversations, requests } = useConversations();
  const follows = usePrefs((p) => p.follows);
  const [tab, setTab] = useState<'inbox' | 'requests'>('inbox');
  const [compose, setCompose] = useState(false);
  const status = useP2PStatus();
  const local = status.peers === 0;
  const list = tab === 'inbox' ? conversations : requests;

  return (
    <Screen
      title="Messages"
      padded={false}
      gap={S.lg}
      barRight={<IconButton icon={compose ? 'close' : 'create-outline'} label={compose ? 'Fermer' : 'Nouveau message'} size={40} onPress={() => setCompose((v) => !v)} />}>
        {compose && (
          <View style={{ paddingHorizontal: S.lg }}>
            <Group title="Nouveau message" footer={follows.length ? undefined : 'Suis quelqu’un depuis son profil pour lui écrire d’ici, ou ouvre son profil et touche « Message ».'}>
              {follows.map((k) => <FollowRow key={k} k={k} />)}
              {me && <Row icon="bookmark-outline" label="Notes pour moi" detail="Un espace privé, synchronisé entre tes appareils" onPress={() => router.push(`/dm/${me.key}`)} last />}
            </Group>
          </View>
        )}

        <Segmented
          style={{ marginHorizontal: S.lg }}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'inbox', label: 'Conversations' },
            { value: 'requests', label: `Demandes${requests.length ? ` (${requests.length})` : ''}` },
          ]}
        />

        {tab === 'requests' && requests.length > 0 && (
          <Txt v="small" style={{ paddingHorizontal: S.lg, lineHeight: 18 }}>
            Des personnes que tu ne suis pas. Elles ne savent pas si tu as lu leur message tant que tu n’as pas répondu.
          </Txt>
        )}

        {list.length ? (
          <View>{list.map((c, i) => <ConversationRow key={c.peer} c={c} last={i === list.length - 1} />)}</View>
        ) : tab === 'inbox' ? (
          <Empty
            icon="chatbubbles-outline"
            title="Aucune conversation"
            text="Tes messages sont chiffrés de bout en bout et passent directement de ton appareil à celui de ton contact."
          />
        ) : (
          <Empty icon="mail-unread-outline" title="Aucune demande" text="Les messages de personnes que tu ne suis pas arrivent ici." />
        )}

        <View style={styles.lock}>
          <Ionicons name="lock-closed" size={12} color={C.text2} style={{ marginTop: 2 }} />
          {/* Wraps instead of running off the screen (the long "mode local" sentence). */}
          <Txt v="small" style={{ fontSize: 12, flexShrink: 1, textAlign: 'center', lineHeight: 17 }}>
            {local ? 'Mode local : aucun pair connecté, les envois partiront avec le réseau P2P' : 'Chiffrement de bout en bout · aucun serveur'}
          </Txt>
        </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  conv: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingVertical: S.md },
  convLine: { position: 'absolute', left: S.lg + 50 + S.md, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: C.hairline },
  unreadDot: { position: 'absolute', left: 6, width: 6, height: 6, borderRadius: 3, backgroundColor: C.accentText },
  lock: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', gap: 6, paddingTop: S.md, paddingHorizontal: S.lg },
});
