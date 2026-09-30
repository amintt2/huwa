import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { getSeries } from '@/data/catalog';
import type { JournalEntry } from '@/p2p/contract';
import type { RejectReason } from '@/social/rank';
import { C, S } from '@/theme/tokens';

import { ago } from './comments';
import { Txt, type IconName } from './ui';

const REASONS: Record<RejectReason, string> = {
  doublon: 'déjà compté',
  'trop-rapide': 'trop rapproché du précédent',
  'quota-jour': 'quota du jour atteint',
  'plafond-xp': 'plafond d’XP du jour',
  horodatage: 'date incohérente',
  futur: 'daté dans le futur',
  invalide: 'entrée invalide',
};

export function describeEntry(e: JournalEntry): { icon: IconName; title: string; sub: string; href?: Href } {
  const s = getSeries(e.work);
  const title = s?.title ?? `Œuvre ${e.work}`;
  if (e.type === 'ep') return { icon: 'play-circle-outline', title: `Épisode ${e.unit}`, sub: title, href: s?.anime ? `/anime/${e.work}` : undefined };
  if (e.type === 'ch') return { icon: 'book-outline', title: `Chapitre ${e.unit}`, sub: title, href: s?.manhwa ? `/manhwa/${e.work}` : undefined };
  return { icon: 'chatbubble-outline', title: 'Commentaire', sub: title, href: s?.anime ? `/anime/${e.work}` : s?.manhwa ? `/manhwa/${e.work}` : undefined };
}

export function HistoryRow({ entry, xp, rejected }: { entry: JournalEntry; xp?: number; rejected?: RejectReason }) {
  const d = describeEntry(entry);
  const body = (
    <View style={styles.row}>
      <View style={styles.icon}>
        <Ionicons name={d.icon} size={16} color={rejected ? C.text2 : C.accentText} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="label" numberOfLines={1} style={{ fontSize: 14 }}>{d.title}</Txt>
        <Txt v="small" numberOfLines={1}>{`${d.sub} · ${ago(entry.ts)}`}</Txt>
      </View>
      {rejected ? (
        <Txt v="small" style={{ fontSize: 11, maxWidth: 120, textAlign: 'right' }}>{`non compté : ${REASONS[rejected]}`}</Txt>
      ) : xp != null ? (
        <Txt v="label" color={C.accentText} style={{ fontSize: 13, fontVariant: ['tabular-nums'] }}>{`+${xp} XP`}</Txt>
      ) : null}
    </View>
  );
  if (!d.href) return body;
  return (
    <Pressable onPress={() => router.push(d.href!)} accessibilityRole="link" style={({ pressed }) => pressed && { opacity: 0.7 }}>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 52, paddingVertical: 6 },
  icon: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.accentSoft, alignItems: 'center', justifyContent: 'center' },
});
