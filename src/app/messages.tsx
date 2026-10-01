import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ago } from '@/components/comments';
import { Avatar, CountBadge, Empty, Group, Row, ScreenHeader, shortKey } from '@/components/social';
import { IconButton, Txt } from '@/components/ui';
import type { Conversation } from '@/p2p/contract';
import { useConversations, useMe, useP2PStatus, usePetname, useProfile } from '@/p2p/hooks';
import { usePrefs } from '@/p2p/prefs';
import { C, F, R, S } from '@/theme/tokens';

function ConversationRow({ c }: { c: Conversation }) {
  const name = usePetname(c.peer, c.peerName);
  return (
    <Pressable
      onPress={() => router.push(`/dm/${c.peer}`)}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${c.unread ? `${c.unread} non lus, ` : ''}${c.lastText}`}
      style={({ pressed }) => [styles.conv, pressed && { backgroundColor: 'rgba(120,140,180,0.08)' }]}>
      <Avatar seed={c.peer} name={name} size={48} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: S.sm }}>
          <Txt v="label" numberOfLines={1} style={{ flex: 1, ...(c.unread ? F.heavy : null) }}>{name}</Txt>
          <Txt v="small" style={{ fontSize: 12 }}>{ago(c.lastAt)}</Txt>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
          <Txt v="small" numberOfLines={2} color={c.unread ? C.body : C.text2} style={{ flex: 1 }}>{c.lastText}</Txt>
          <CountBadge n={c.unread} />
        </View>
      </View>
    </Pressable>
  );
}

function FollowRow({ k, last }: { k: string; last?: boolean }) {
  const { profile } = useProfile(k);
  const name = usePetname(k, profile?.name ?? shortKey(k));
  return <Row label={name} detail={profile?.fingerprint} onPress={() => router.push(`/dm/${k}`)} last={last} />;
}

export default function Messages() {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const { conversations, requests } = useConversations();
  const follows = usePrefs((p) => p.follows);
  const [tab, setTab] = useState<'inbox' | 'requests'>('inbox');
  const [compose, setCompose] = useState(false);
  const status = useP2PStatus();
  const local = status.peers === 0;
  const list = tab === 'inbox' ? conversations : requests;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <ScreenHeader
        title="Messages"
        right={<IconButton icon={compose ? 'close' : 'create-outline'} label={compose ? 'Fermer' : 'Nouveau message'} onPress={() => setCompose((v) => !v)} />}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + S.xxl, gap: S.lg }}>
        {compose && (
          <View style={{ paddingHorizontal: S.lg }}>
            <Group title="Nouveau message" footer={follows.length ? undefined : 'Suis quelqu’un depuis son profil pour lui écrire d’ici, ou ouvre son profil et touche « Message ».'}>
              {follows.map((k) => <FollowRow key={k} k={k} />)}
              {me && <Row icon="bookmark-outline" label="Notes pour moi" detail="Un espace privé, synchronisé entre tes appareils" onPress={() => router.push(`/dm/${me.key}`)} last />}
            </Group>
          </View>
        )}

        <View style={styles.segment} accessibilityRole="tablist">
          {(['inbox', 'requests'] as const).map((t) => {
            const on = tab === t;
            return (
              <Pressable key={t} onPress={() => setTab(t)} accessibilityRole="tab" accessibilityState={{ selected: on }} style={[styles.segItem, on && styles.segOn]}>
                <Txt v="small" color={on ? C.text : C.text2} style={F.semibold}>
                  {t === 'inbox' ? 'Conversations' : `Demandes${requests.length ? ` (${requests.length})` : ''}`}
                </Txt>
              </Pressable>
            );
          })}
        </View>

        {tab === 'requests' && requests.length > 0 && (
          <Txt v="small" style={{ paddingHorizontal: S.lg, lineHeight: 18 }}>
            Des personnes que tu ne suis pas. Elles ne savent pas si tu as lu leur message tant que tu n’as pas répondu.
          </Txt>
        )}

        {list.length ? (
          <View>{list.map((c) => <ConversationRow key={c.peer} c={c} />)}</View>
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
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  conv: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingVertical: S.md },
  segment: { flexDirection: 'row', marginHorizontal: S.lg, padding: 3, borderRadius: R.control, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  segItem: { flex: 1, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  segOn: { backgroundColor: C.elevated },
  lock: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', gap: 6, paddingTop: S.md, paddingHorizontal: S.lg },
});
