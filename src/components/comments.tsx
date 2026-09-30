import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { social, useComments, useMe, useWarmPow, type CommentView } from '@/p2p/hooks';
import { usePrefs } from '@/p2p/prefs';
import { fingerprint } from '@/social/identity';
import { seriesOfTarget } from '@/social/migrate';
import { C, F, R, S, kindColor, kindFill, kindOnFill, kindSoft, type Kind } from '@/theme/tokens';

import { Avatar } from './social';
import { Chip, Press, Txt } from './ui';

export const fmtTime = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};

export const ago = (t: number) => {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return 'à l’instant';
  if (d < 3600) return `${Math.floor(d / 60)} min`;
  if (d < 86400) return `${Math.floor(d / 3600)} h`;
  return `${Math.floor(d / 86400)} j`;
};

type Row = CommentView;

const fpCache = new Map<string, string>();
const shortFp = (key: string) => {
  let v = fpCache.get(key);
  if (!v) fpCache.set(key, (v = fingerprint(key).slice(0, 4)));
  return v;
};

/** Long press: profile, message, report, block — native action sheet on iOS. */
export function commentActions(c: Pick<Row, 'id' | 'author' | 'authorName'>, meKey?: string) {
  const mine = c.author === meKey;
  const actions: { label: string; destructive?: boolean; run: () => void }[] = [
    { label: mine ? 'Voir mon profil' : `Voir le profil de ${c.authorName}`, run: () => router.push(`/u/${c.author}`) },
  ];
  if (!mine) {
    actions.push(
      { label: 'Envoyer un message', run: () => router.push(`/dm/${c.author}`) },
      {
        label: 'Signaler (spam)',
        run: () => social.report(c.id, 'spam').then(() => Alert.alert('Merci', 'Ce commentaire est masqué pour toi et ton signalement est publié.')),
      },
      { label: 'Signaler un spoiler non marqué', run: () => social.report(c.id, 'spoiler') },
      {
        label: `Bloquer ${c.authorName}`,
        destructive: true,
        run: () =>
          Alert.alert(`Bloquer ${c.authorName} ?`, 'Tu ne verras plus ses commentaires ni ses messages. Ton blocage est visible par ceux qui s’abonnent à ta liste.', [
            { text: 'Annuler', style: 'cancel' },
            { text: 'Bloquer', style: 'destructive', onPress: () => social.setBlocked(c.author, true) },
          ]),
      },
    );
  }
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [...actions.map((a) => a.label), 'Annuler'],
        cancelButtonIndex: actions.length,
        destructiveButtonIndex: mine ? undefined : actions.length - 1,
        userInterfaceStyle: 'dark',
      },
      (i) => actions[i]?.run(),
    );
  } else {
    // Android alerts hold 3 buttons: profile, message, then a second level for moderation.
    const more = actions.slice(2);
    Alert.alert(c.authorName, undefined, [
      ...actions.slice(0, 2).map((a) => ({ text: a.label, onPress: a.run })),
      ...(more.length
        ? [{ text: 'Signaler / bloquer…', onPress: () => Alert.alert(c.authorName, undefined, more.map((a) => ({ text: a.label, onPress: a.run }))) }]
        : [{ text: 'Annuler', style: 'cancel' as const }]),
    ]);
  }
}

function CommentRow({
  c,
  kind,
  hideSpoilers,
  small,
  meKey,
  onReply,
  onSeek,
}: {
  c: Row;
  kind: Kind;
  hideSpoilers: boolean;
  small?: boolean;
  meKey?: string;
  onReply?: (c: Row) => void;
  onSeek?: (t: number) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const pet = usePrefs((p) => p.petnames[c.author]);
  const name = pet || c.authorName;
  const masked = c.verdict.spoiler && hideSpoilers && !revealed;
  const openProfile = () => router.push(`/u/${c.author}`);
  return (
    <Pressable
      onLongPress={() => commentActions({ ...c, authorName: name }, meKey)}
      delayLongPress={350}
      accessibilityHint="Appui long pour signaler, bloquer ou écrire à l’auteur"
      style={{ flexDirection: 'row', gap: 10 }}>
      <Pressable onPress={openProfile} hitSlop={6} accessibilityRole="link" accessibilityLabel={`Profil de ${name}`}>
        <Avatar seed={c.author} name={name} size={small ? 26 : 34} />
      </Pressable>
      <View style={{ flex: 1, gap: 6 }}>
        <View style={styles.head}>
          <Pressable onPress={openProfile} hitSlop={6} accessibilityRole="link" style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
            <Txt v="label" style={{ fontSize: 13 }}>{name}</Txt>
            <Txt v="small" style={{ fontSize: 10 }}>{shortFp(c.author)}</Txt>
          </Pressable>
          {c.author === meKey && <Chip kind="accent" label="TOI" />}
          {c.fromAnime && <Chip kind="anime" label="VIENT DE L’ANIME" />}
          {c.timestamp != null && (
            <Pressable
              onPress={() => onSeek?.(c.timestamp!)}
              disabled={!onSeek}
              accessibilityLabel={`Aller à ${fmtTime(c.timestamp)}`}
              style={styles.stamp}>
              <Ionicons name="play" size={9} color={C.accentText} />
              <Txt v="caption" color={C.accentText} style={{ fontSize: 11 }}>{fmtTime(c.timestamp)}</Txt>
            </Pressable>
          )}
          <Txt v="small">· {ago(c.createdAt)}</Txt>
        </View>
        {masked ? (
          <Press onPress={() => setRevealed(true)} style={styles.spoiler} accessibilityLabel="Afficher le spoiler">
            <Ionicons name="eye-off-outline" size={18} color={C.text2} />
            <Txt v="body" style={{ fontSize: 13 }}>Spoiler — touche pour afficher</Txt>
          </Press>
        ) : (
          <Txt v="body" color={C.body}>{c.text}</Txt>
        )}
        <View style={{ flexDirection: 'row', gap: S.lg, alignItems: 'center' }}>
          <Pressable
            hitSlop={10}
            onPress={() => {
              Haptics.selectionAsync();
              social.toggleLike(seriesOfTarget(c.target), c.id);
            }}
            accessibilityLabel={c.likedByMe ? 'Retirer le j’aime' : 'J’aime'}
            style={{ flexDirection: 'row', gap: 5, alignItems: 'center' }}>
            <Ionicons name={c.likedByMe ? 'heart' : 'heart-outline'} size={14} color={c.likedByMe ? kindColor(kind) : C.text2} />
            <Txt v="small" color={c.likedByMe ? kindColor(kind) : C.text2} style={{ ...F.semibold }}>
              {c.likes}
            </Txt>
          </Pressable>
          {onReply && (
            <Pressable hitSlop={10} onPress={() => onReply(c)}>
              <Txt v="small" style={{ ...F.semibold }}>Répondre</Txt>
            </Pressable>
          )}
        </View>
      </View>
    </Pressable>
  );
}

/**
 * Full comment experience: sort, spoiler filter, threaded replies, composer.
 * For episodes, pass `getTime`/`onSeek` to get time-anchored comments.
 */
export function CommentsPanel({
  target,
  kind,
  header,
  getTime,
  onSeek,
}: {
  target: string;
  kind: Kind;
  header?: ReactNode;
  getTime?: () => number;
  onSeek?: (t: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const { visible: thread, hiddenCount } = useComments(seriesOfTarget(target), target);
  const [sort, setSort] = useState<'top' | 'new'>('top');
  const [hideSpoilers, setHideSpoilers] = useState(true);
  const [text, setText] = useState('');
  const [spoiler, setSpoiler] = useState(false);
  const [stamp, setStamp] = useState(!!getTime);
  const [replyTo, setReplyTo] = useState<Row | null>(null);
  const [sending, setSending] = useState(false);
  const input = useRef<TextInput>(null);
  // Proof of work is solved in the background while typing → sending feels instant.
  useWarmPow(target, text);

  const { roots, replies } = useMemo(() => {
    const ids = new Set(thread.map((c) => c.id));
    const roots = thread.filter((c) => !c.parentId);
    roots.sort((a, b) => (sort === 'top' ? b.likes - a.likes : b.createdAt - a.createdAt));
    const replies = new Map<string, Row[]>();
    for (const c of thread) {
      // Replies to a masked comment stay masked with it.
      if (!c.parentId || !ids.has(c.parentId)) continue;
      replies.set(c.parentId, [...(replies.get(c.parentId) ?? []), c].sort((a, b) => a.createdAt - b.createdAt));
    }
    return { roots, replies };
  }, [thread, sort]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await social.postComment({
        target,
        text: body,
        spoiler,
        parentId: replyTo ? (replyTo.parentId ?? replyTo.id) : undefined,
        timestamp: getTime && stamp && !replyTo ? getTime() : undefined,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setText('');
      setSpoiler(false);
      setReplyTo(null);
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Commentaire non publié', e instanceof Error ? e.message : 'Réessaie dans un instant.');
    } finally {
      setSending(false);
    }
  };

  const pill = (on: boolean) => [styles.pill, on && { backgroundColor: C.text }];

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ paddingBottom: S.xl }} keyboardShouldPersistTaps="handled">
        {header}
        <View style={{ paddingHorizontal: S.lg, gap: 18 }}>
          <View style={{ flexDirection: 'row', gap: S.sm, alignItems: 'center' }}>
            <Pressable onPress={() => setSort('top')} style={pill(sort === 'top')}>
              <Txt v="small" color={sort === 'top' ? C.bg : C.text2} style={{ ...F.semibold }}>Populaires</Txt>
            </Pressable>
            <Pressable onPress={() => setSort('new')} style={pill(sort === 'new')}>
              <Txt v="small" color={sort === 'new' ? C.bg : C.text2} style={{ ...F.semibold }}>Récents</Txt>
            </Pressable>
            <Pressable
              onPress={() => setHideSpoilers((v) => !v)}
              accessibilityRole="switch"
              accessibilityState={{ checked: hideSpoilers }}
              style={[styles.pill, { flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
              <Ionicons name={hideSpoilers ? 'eye-off-outline' : 'eye-outline'} size={14} color={C.text2} />
              <Txt v="small" style={{ ...F.semibold }}>{hideSpoilers ? 'Spoilers masqués' : 'Spoilers visibles'}</Txt>
            </Pressable>
          </View>

          {roots.map((c) => (
            <View key={c.id} style={{ gap: 10 }}>
              <CommentRow c={c} kind={kind} hideSpoilers={hideSpoilers} onSeek={onSeek} meKey={me?.key}
                onReply={(r) => { setReplyTo(r); input.current?.focus(); }} />
              {(replies.get(c.id) ?? []).map((r) => (
                <View key={r.id} style={{ paddingLeft: 44 }}>
                  <CommentRow c={r} kind={kind} hideSpoilers={hideSpoilers} small onSeek={onSeek} meKey={me?.key}
                    onReply={(x) => { setReplyTo(x); input.current?.focus(); }} />
                </View>
              ))}
            </View>
          ))}

          {hiddenCount > 0 && (
            <Pressable onPress={() => router.push('/settings/moderation')} accessibilityRole="button" style={styles.hiddenNote}>
              <Ionicons name="shield-checkmark-outline" size={14} color={C.text2} />
              <Txt v="small" style={{ flex: 1 }}>
                {hiddenCount === 1 ? '1 commentaire masqué par tes filtres' : `${hiddenCount} commentaires masqués par tes filtres`}
              </Txt>
              <Txt v="small" color={C.accentText} style={F.semibold}>Gérer</Txt>
            </Pressable>
          )}
        </View>
      </ScrollView>

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, S.md) }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm, flexWrap: 'wrap' }}>
          {replyTo ? (
            <Pressable onPress={() => setReplyTo(null)} style={styles.replyTag} accessibilityLabel="Annuler la réponse">
              <Txt v="small">Réponse à <Txt v="small" color={C.text}>{replyTo.authorName}</Txt></Txt>
              <Ionicons name="close" size={14} color={C.text2} />
            </Pressable>
          ) : getTime ? (
            <Pressable onPress={() => setStamp((v) => !v)} style={styles.replyTag} accessibilityRole="switch" accessibilityState={{ checked: stamp }}>
              <Ionicons name={stamp ? 'time' : 'time-outline'} size={14} color={stamp ? C.accentText : C.text2} />
              <Txt v="small" color={stamp ? C.accentText : C.text2}>Horodater</Txt>
            </Pressable>
          ) : null}
          <Pressable onPress={() => setSpoiler((v) => !v)} style={[styles.replyTag, spoiler && { backgroundColor: kindSoft(kind) }]}
            accessibilityRole="switch" accessibilityState={{ checked: spoiler }} accessibilityLabel="Marquer comme spoiler">
            <Ionicons name={spoiler ? 'eye-off' : 'eye-off-outline'} size={14} color={spoiler ? kindColor(kind) : C.text2} />
            <Txt v="small" color={spoiler ? kindColor(kind) : C.text2}>Spoiler</Txt>
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Avatar seed={me?.key ?? ''} name={me?.name} />
          <TextInput
            ref={input}
            value={text}
            onChangeText={setText}
            placeholder="Ajouter un commentaire…"
            placeholderTextColor="#8A8AA0"
            style={styles.input}
            multiline
            accessibilityLabel="Ajouter un commentaire"
          />
          <Press
            onPress={send}
            disabled={!text.trim() || sending}
            accessibilityLabel={sending ? 'Publication en cours' : 'Envoyer'}
            style={[styles.send, { backgroundColor: kindFill(kind), opacity: text.trim() ? 1 : 0.4 }]}>
            {sending ? <ActivityIndicator color={kindOnFill(kind)} /> : <Ionicons name="arrow-up" size={20} color={kindOnFill(kind)} />}
          </Press>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  stamp: {
    flexDirection: 'row', alignItems: 'center', gap: 3, paddingVertical: 2, paddingHorizontal: 6,
    borderRadius: 5, backgroundColor: C.accentSoft,
  },
  spoiler: {
    minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: S.md,
    borderRadius: 12, backgroundColor: C.elevated,
  },
  pill: { minHeight: 34, justifyContent: 'center', paddingHorizontal: S.md, borderRadius: R.pill, backgroundColor: C.elevated },
  composer: {
    paddingTop: S.md, paddingHorizontal: S.lg, gap: S.sm, backgroundColor: C.surface,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border,
  },
  input: {
    flex: 1, minHeight: 44, maxHeight: 110, paddingHorizontal: S.lg, paddingTop: 12, paddingBottom: 12,
    borderRadius: 22, backgroundColor: C.elevated, color: C.text, ...F.regular, fontSize: 14,
  },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  hiddenNote: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 44, paddingHorizontal: S.md,
    borderRadius: R.control, backgroundColor: C.elevated,
  },
  replyTag: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 5, paddingHorizontal: 10,
    borderRadius: R.pill, backgroundColor: C.elevated,
  },
});
