import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Avatar, BadgeGrid, CountBadge, Group, RankCard, Row, WARN } from '@/components/social';
import { IconButton, Press, Txt } from '@/components/ui';
import { useConversations, useMe, useRank, useSecurity } from '@/p2p/hooks';
import { useStore } from '@/store/store';
import { C, R, S } from '@/theme/tokens';

export default function Profile() {
  const me = useMe();
  const r = useRank();
  const { state } = useSecurity();
  const { unread, requestCount } = useConversations();
  const episodes = useStore((s) => s.episodes);
  const chapters = useStore((s) => s.chapters);

  const comments = r.loading ? 0 : r.journal.filter((e) => e.type === 'comment').length;
  const stats = [
    { label: 'Épisodes vus', value: Object.values(episodes).filter((e) => e.done).length, color: C.accentText },
    { label: 'Chapitres lus', value: Object.values(chapters).filter((c) => c.done).length, color: C.accent },
    { label: 'Commentaires', value: comments, color: C.text },
  ];
  // PLAN §2: suggest the recovery phrase after the first uses, not at sign-up.
  const nudge = state && !state.phraseVerified && !r.loading && (r.journal.length >= 3 || r.loadedAt - (me?.createdAt ?? 0) > 86_400_000);

  if (!me) return null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingTop: S.sm, paddingHorizontal: S.lg, gap: S.xl, paddingBottom: S.xxl }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Txt v="display" style={{ fontSize: 28 }}>Profil</Txt>
        <IconButton icon="settings-outline" label="Réglages" tone="solid" onPress={() => router.push('/settings')} />
      </View>

      <Press onPress={() => router.push(`/u/${me.key}`)} accessibilityRole="button" accessibilityLabel={`${me.name}, voir mon profil public`}>
        <View style={styles.card}>
          <Avatar seed={me.key} name={me.name} size={64} />
          <View style={{ flex: 1, gap: 4 }}>
            <Txt v="title" numberOfLines={1} style={{ fontSize: 20 }}>{me.name}</Txt>
            <Txt v="small" style={{ fontVariant: ['tabular-nums'] }}>{me.fingerprint}</Txt>
            <Txt v="small" numberOfLines={2} color={me.bio ? C.body : C.text2}>{me.bio ?? 'Voir mon profil public'}</Txt>
          </View>
          <Ionicons name="chevron-forward" size={16} color={C.text2} />
        </View>
      </Press>

      {nudge && (
        <Press onPress={() => router.push('/settings/phrase')} accessibilityRole="button">
          <View style={styles.nudge}>
            <Ionicons name="key-outline" size={20} color={WARN} />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="label">Sécurise ton compte</Txt>
              <Txt v="small">Note ta phrase de récupération : sans elle, perdre ce téléphone, c’est perdre ton compte.</Txt>
            </View>
            <Ionicons name="chevron-forward" size={16} color={C.text2} />
          </View>
        </Press>
      )}

      {!r.loading && <RankCard rank={r.rank} onPress={() => router.push('/rank')} />}

      <View style={{ flexDirection: 'row', gap: S.md }}>
        {stats.map((s) => (
          <View key={s.label} style={styles.stat}>
            <Txt v="title" color={s.color} style={{ fontVariant: ['tabular-nums'] }}>{s.value}</Txt>
            <Txt v="small">{s.label}</Txt>
          </View>
        ))}
      </View>

      {!r.loading && (
        <View style={{ gap: S.md }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Txt v="section">Succès</Txt>
            <Txt v="small" color={C.accentText} onPress={() => router.push('/rank')} accessibilityRole="button" style={{ padding: S.xs }}>
              {`${r.badges.filter((b) => b.earned).length}/${r.badges.length} · Tout voir`}
            </Txt>
          </View>
          <BadgeGrid badges={r.badges} limit={3} />
        </View>
      )}

      <Group>
        <Row
          icon="chatbubbles-outline"
          label="Messages"
          detail={requestCount ? `${requestCount} demande${requestCount > 1 ? 's' : ''} en attente` : 'Privés, de pair à pair'}
          right={<CountBadge n={unread + requestCount} />}
          onPress={() => router.push('/messages')}
        />
        <Row icon="shield-half-outline" label="Modération" onPress={() => router.push('/settings/moderation')} />
        <Row icon="albums-outline" label="Mes listes" onPress={() => router.push('/lists')} />
        <Row icon="extension-puzzle-outline" label="Extensions" onPress={() => router.push('/addons')} />
        <Row icon="download-outline" label="Téléchargements torrent" onPress={() => router.push('/downloads')} />
        <Row icon="cloud-offline-outline" label="Chapitres hors ligne" onPress={() => router.push('/offline')} />
        <Row icon="settings-outline" label="Réglages" onPress={() => router.push('/settings')} last />
      </Group>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.lg, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  nudge: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: 'rgba(255,200,87,0.08)', borderWidth: 1, borderColor: 'rgba(255,200,87,0.30)',
  },
  stat: { flex: 1, padding: S.md, gap: 4, borderRadius: R.card, backgroundColor: C.surface },
});
