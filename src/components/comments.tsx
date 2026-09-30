import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useThread } from '@/store/derived';
import { addComment, toggleLike, useStore, type Comment } from '@/store/store';
import { C, F, R, S, kindColor, kindFill, kindOnFill, kindSoft, type Kind } from '@/theme/tokens';

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

const AVATARS: [string, string][] = [
  ['#FF7A5C', '#FFC857'], ['#3DDC97', '#4DA3FF'], ['#B04FD1', '#6A58F5'], ['#4DA3FF', '#9DF0E0'], ['#E0445B', '#FFB86B'],
];
function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  const [a, b] = AVATARS[name.length % AVATARS.length];
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: a, borderWidth: size / 6, borderColor: b }} />
  );
}

type Thread = ReturnType<typeof useThread>;
type Row = Thread[number];

function CommentRow({
  c,
  kind,
  hideSpoilers,
  small,
  onReply,
  onSeek,
}: {
  c: Row;
  kind: Kind;
  hideSpoilers: boolean;
  small?: boolean;
  onReply?: (c: Comment) => void;
  onSeek?: (t: number) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const masked = c.spoiler && hideSpoilers && !revealed;
  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <Avatar name={c.author} size={small ? 26 : 34} />
      <View style={{ flex: 1, gap: 6 }}>
        <View style={styles.head}>
          <Txt v="label" style={{ fontSize: 13 }}>{c.author}</Txt>
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
              toggleLike(c.id);
            }}
            accessibilityLabel={c.liked ? 'Retirer le j’aime' : 'J’aime'}
            style={{ flexDirection: 'row', gap: 5, alignItems: 'center' }}>
            <Ionicons name={c.liked ? 'heart' : 'heart-outline'} size={14} color={c.liked ? kindColor(kind) : C.text2} />
            <Txt v="small" color={c.liked ? kindColor(kind) : C.text2} style={{ ...F.semibold }}>
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
    </View>
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
  const thread = useThread(target);
  const userName = useStore((s) => s.userName);
  const [sort, setSort] = useState<'top' | 'new'>('top');
  const [hideSpoilers, setHideSpoilers] = useState(true);
  const [text, setText] = useState('');
  const [spoiler, setSpoiler] = useState(false);
  const [stamp, setStamp] = useState(!!getTime);
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const input = useRef<TextInput>(null);

  const { roots, replies } = useMemo(() => {
    const roots = thread.filter((c) => !c.parentId);
    roots.sort((a, b) => (sort === 'top' ? b.likes - a.likes : b.createdAt - a.createdAt));
    const replies = new Map<string, Row[]>();
    for (const c of thread) {
      if (!c.parentId) continue;
      replies.set(c.parentId, [...(replies.get(c.parentId) ?? []), c].sort((a, b) => a.createdAt - b.createdAt));
    }
    return { roots, replies };
  }, [thread, sort]);

  const send = () => {
    const body = text.trim();
    if (!body) return;
    addComment({
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
              <CommentRow c={c} kind={kind} hideSpoilers={hideSpoilers} onSeek={onSeek}
                onReply={(r) => { setReplyTo(r); input.current?.focus(); }} />
              {(replies.get(c.id) ?? []).map((r) => (
                <View key={r.id} style={{ paddingLeft: 44 }}>
                  <CommentRow c={r} kind={kind} hideSpoilers={hideSpoilers} small onSeek={onSeek}
                    onReply={(x) => { setReplyTo(x); input.current?.focus(); }} />
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, S.md) }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm, flexWrap: 'wrap' }}>
          {replyTo ? (
            <Pressable onPress={() => setReplyTo(null)} style={styles.replyTag} accessibilityLabel="Annuler la réponse">
              <Txt v="small">Réponse à <Txt v="small" color={C.text}>{replyTo.author}</Txt></Txt>
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
          <Avatar name={userName} />
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
            disabled={!text.trim()}
            accessibilityLabel="Envoyer"
            style={[styles.send, { backgroundColor: kindFill(kind), opacity: text.trim() ? 1 : 0.4 }]}>
            <Ionicons name="arrow-up" size={20} color={kindOnFill(kind)} />
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
  replyTag: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 5, paddingHorizontal: 10,
    borderRadius: R.pill, backgroundColor: C.elevated,
  },
});
