import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getChapter, getEpisode } from '@/data/catalog';
import { reportComment, useAuthorWeights, useCommunityThread, type ThreadComment } from '@/p2p/community-hooks';
import { social, useMe, useWarmPow } from '@/p2p/hooks';
import { usePrefs } from '@/p2p/prefs';
import { pageOrRoute, seekOrRoute } from '@/social/anchor-nav';
import { anchorA11y, anchorLabel, commentAnchor, fmtTime as formatTime, withAnchor, type Anchor } from '@/social/anchors';
import { FLAG_REASONS, reasonLabel } from '@/social/community';
import { attachGif, extractGif } from '@/social/gif';
import { fingerprint } from '@/social/identity';
import { plainText } from '@/social/markdown';
import { seriesOfTarget } from '@/social/migrate';
import { laterReference, laterReferenceLabel, type SpoilerContext } from '@/social/spoiler-detect';
import { C, F, R, S, kindColor, kindFill, kindOnFill, kindSoft, type Kind } from '@/theme/tokens';

import { GifPicker, GifPlaceholder, GifView } from './gif';
import { Markdown } from './markdown';
import { Avatar } from './social';
import { Chip, Press, Txt } from './ui';

export const fmtTime = formatTime;

export const ago = (t: number) => {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return 'à l’instant';
  if (d < 3600) return `${Math.floor(d / 60)} min`;
  if (d < 86400) return `${Math.floor(d / 3600)} h`;
  return `${Math.floor(d / 86400)} j`;
};

/** Same bound as the P2P schema (src/p2p/worklet/schema.js). */
const MAX_TEXT = 2000;

type Row = ThreadComment;

const fpCache = new Map<string, string>();
const shortFp = (key: string) => {
  let v = fpCache.get(key);
  if (!v) fpCache.set(key, (v = fingerprint(key).slice(0, 4)));
  return v;
};

// ---------- actions ----------

function showSheet(title: string, message: string | undefined, actions: { label: string; destructive?: boolean; run: () => void }[]) {
  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        message,
        options: [...actions.map((a) => a.label), 'Annuler'],
        cancelButtonIndex: actions.length,
        destructiveButtonIndex: actions.map((a, i) => (a.destructive ? i : -1)).filter((i) => i >= 0),
        userInterfaceStyle: 'dark',
      },
      (i) => actions[i]?.run(),
    );
  } else {
    // Android alerts hold 3 buttons: the first two actions, then a second level for the rest.
    const more = actions.slice(2);
    Alert.alert(title, message, [
      ...actions.slice(0, 2).map((a) => ({ text: a.label, onPress: a.run })),
      ...(more.length
        ? [{ text: 'Plus…', onPress: () => Alert.alert(title, undefined, more.map((a) => ({ text: a.label, onPress: a.run }))) }]
        : [{ text: 'Annuler', style: 'cancel' as const }]),
    ]);
  }
}

/** Report with a reason: hidden for me now, and a weighed report for the community auto-hide. */
export function reportFlow(c: Pick<Row, 'id' | 'target' | 'authorName'>) {
  showSheet(
    'Signaler ce commentaire',
    'Pourquoi ? Il est masqué pour toi tout de suite. Ton signalement est public et signé ; s’il est confirmé par plusieurs membres établis, le commentaire est replié pour tous. Il n’y a pas d’équipe de modération centrale.',
    FLAG_REASONS.map((r) => ({
      label: r.label,
      run: () =>
        reportComment(c, r.val)
          .then(() => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            Alert.alert('Merci', r.val === 'spoiler' ? 'Le commentaire est flouté pour toi comme un spoiler.' : 'Le commentaire est masqué pour toi.');
          })
          .catch((e) => Alert.alert('Signalement impossible', e instanceof Error ? e.message : String(e))),
    })),
  );
}

/** Long press or "…": edit/delete for your own comments, profile/message/report/block for others. */
export function commentActions(
  c: Pick<Row, 'id' | 'author' | 'authorName' | 'text' | 'target'>,
  meKey?: string,
  opts: { onEdit?: () => void; onReply?: () => void } = {},
) {
  const mine = c.author === meKey;
  type Action = { label: string; destructive?: boolean; run: () => void };
  const share: Action = {
    label: 'Partager le texte',
    run: () => Share.share({ message: `« ${plainText(extractGif(c.text).text)} » — ${c.authorName} sur Huwa` }),
  };
  const actions: Action[] = mine
    ? [
        ...(opts.onEdit ? [{ label: 'Modifier', run: opts.onEdit }] : []),
        share,
        { label: 'Voir mon profil', run: () => router.push(`/u/${c.author}`) },
        {
          label: 'Supprimer',
          destructive: true,
          run: () =>
            Alert.alert('Supprimer ce commentaire ?', 'Il disparaît pour tout le monde. Les réponses restent visibles.', [
              { text: 'Annuler', style: 'cancel' },
              {
                text: 'Supprimer',
                style: 'destructive',
                onPress: () =>
                  social
                    .deleteComment(seriesOfTarget(c.target), c.id)
                    .then(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success))
                    .catch((e) => Alert.alert('Suppression impossible', e instanceof Error ? e.message : String(e))),
              },
            ]),
        },
      ]
    : [
        ...(opts.onReply ? [{ label: 'Répondre', run: opts.onReply }] : []),
        share,
        { label: `Voir le profil de ${c.authorName}`, run: () => router.push(`/u/${c.author}`) },
        { label: 'Envoyer un message', run: () => router.push(`/dm/${c.author}`) },
        { label: 'Signaler…', run: () => reportFlow(c) },
        {
          label: `Bloquer ${c.authorName}`,
          destructive: true,
          run: () =>
            Alert.alert(`Bloquer ${c.authorName} ?`, 'Tu ne verras plus ses commentaires, GIFs ni messages. Ton blocage est visible par ceux qui s’abonnent à ta liste.', [
              { text: 'Annuler', style: 'cancel' },
              { text: 'Bloquer', style: 'destructive', onPress: () => social.setBlocked(c.author, true) },
            ]),
        },
      ];
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  showSheet(c.authorName, undefined, actions);
}

// ---------- anchors ----------

export function AnchorChip({ anchor, onPress, compact }: { anchor: Anchor; onPress?: () => void; compact?: boolean }) {
  const icon = anchor.type === 'time' ? (anchor.end !== undefined ? 'repeat' : 'play') : 'book-outline';
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      hitSlop={8}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${anchorA11y(anchor)}${onPress ? anchor.type === 'time' ? ', lire ce moment' : ', ouvrir cette page' : ''}`}
      style={({ pressed }) => [styles.anchor, compact && { paddingVertical: 2 }, pressed && { backgroundColor: 'rgba(47,107,235,0.32)' }]}>
      <Ionicons name={icon} size={anchor.type === 'time' ? 10 : 12} color={C.accentText} />
      <Txt v="small" color={C.accentText} tabular style={{ fontSize: 12, ...F.semibold }}>{anchorLabel(anchor)}</Txt>
    </Pressable>
  );
}

// ---------- one comment ----------

function CommentRow({
  c,
  kind,
  hideSpoilers,
  small,
  meKey,
  gifTrusted,
  onReply,
  onEdit,
  onAnchor,
}: {
  c: Row;
  kind: Kind;
  hideSpoilers: boolean;
  small?: boolean;
  meKey?: string;
  gifTrusted: boolean;
  onReply?: (c: Row) => void;
  onEdit?: (c: Row) => void;
  onAnchor?: (a: Anchor) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [shown, setShown] = useState(false);
  const [gifOk, setGifOk] = useState(false);
  const pet = usePrefs((p) => p.petnames[c.author]);
  const hideGifs = usePrefs((p) => p.hideGifs);
  const blurGifs = usePrefs((p) => p.blurUnverifiedGifs);
  const name = pet || c.authorName;
  const mine = c.author === meKey;
  const masked = c.verdict.spoiler && hideSpoilers && !revealed;
  const { anchor, gif, body } = useMemo(() => {
    const a = commentAnchor(c);
    const g = extractGif(a.body);
    return { anchor: a.anchor, gif: g.gif, body: g.text };
  }, [c]);
  const mdOptions = useMemo(() => ({ times: kind === 'anime', pages: c.target.startsWith('ch:') }), [kind, c.target]);
  const openProfile = () => router.push(`/u/${c.author}`);
  const menu = () =>
    commentActions({ ...c, authorName: name }, meKey, {
      onEdit: onEdit && (() => onEdit(c)),
      onReply: onReply && (() => onReply(c)),
    });
  const av = small ? 26 : 34;

  // Deleted by its author: only a placeholder remains, so replies keep their context.
  if (c.deleted) {
    return (
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <View style={[styles.ghostAvatar, { width: av, height: av, borderRadius: av / 2 }]} />
        <Txt v="small" style={{ fontStyle: 'italic' }}>Commentaire supprimé par son auteur</Txt>
      </View>
    );
  }

  // Collapsed by community reports: still one tap away, never deleted.
  if (c.community?.hidden && !mine && !shown) {
    return (
      <Pressable onPress={() => setShown(true)} accessibilityRole="button" style={styles.collapsed}
        accessibilityLabel="Masqué par la communauté. Touche pour afficher">
        <Ionicons name="people-outline" size={15} color={C.text2} />
        <Txt v="small" style={{ flex: 1 }} numberOfLines={2}>
          Masqué par la communauté{c.community.reasons[0] ? ` · ${reasonLabel(c.community.reasons[0]).toLowerCase()}` : ''}
        </Txt>
        <Txt v="small" color={C.accentText} style={F.semibold}>Afficher</Txt>
      </Pressable>
    );
  }

  return (
    <Pressable onLongPress={menu} delayLongPress={350} accessibilityHint="Appui long pour plus d’options" style={{ flexDirection: 'row', gap: 10 }}>
      <Pressable onPress={openProfile} hitSlop={6} accessibilityRole="link" accessibilityLabel={`Profil de ${name}`}>
        <Avatar seed={c.author} name={name} size={av} />
      </Pressable>
      <View style={{ flex: 1, gap: 6 }}>
        <View style={styles.head}>
          <Pressable onPress={openProfile} hitSlop={6} accessibilityRole="link" style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, flexShrink: 1 }}>
            <Txt v="label" numberOfLines={1} style={{ fontSize: 14, flexShrink: 1 }}>{name}</Txt>
            <Txt v="footnote" color={C.text3} style={{ fontSize: 10 }}>{shortFp(c.author)}</Txt>
          </Pressable>
          {mine && <Chip kind="accent" label="Toi" />}
          {c.fromAnime && <Chip kind="bridge" label="Vient de l’anime" />}
          <Txt v="footnote" color={C.text3}>{ago(c.createdAt)}{c.editedAt ? ' · modifié' : ''}</Txt>
        </View>
        {anchor && (
          <View style={{ flexDirection: 'row' }}>
            <AnchorChip anchor={anchor} onPress={onAnchor && (() => onAnchor(anchor))} />
          </View>
        )}
        {masked ? (
          <Press onPress={() => setRevealed(true)} style={styles.spoiler} accessibilityLabel="Afficher le spoiler">
            <Ionicons name="eye-off-outline" size={18} color={C.text2} />
            <Txt v="body" style={{ fontSize: 13, flex: 1 }}>
              {c.community?.spoiler && !c.spoiler ? 'Signalé comme spoiler — touche pour afficher' : 'Spoiler — touche pour afficher'}
            </Txt>
          </Press>
        ) : (
          <>
            {!!body && <Markdown text={body} options={mdOptions} onAnchor={onAnchor} />}
            {gif && (hideGifs ? <GifPlaceholder /> : <GifView url={gif} blurred={blurGifs && !gifTrusted && !mine && !gifOk} onReveal={() => setGifOk(true)} />)}
          </>
        )}
        {mine && c.community?.hidden && (
          <View style={styles.note}>
            <Ionicons name="people-outline" size={13} color={C.text3} />
            <Txt v="footnote" style={{ flex: 1 }}>Replié pour les autres après plusieurs signalements de membres établis.</Txt>
          </View>
        )}
        <View style={styles.actions}>
          <Pressable
            hitSlop={10}
            onPress={() => {
              Haptics.selectionAsync();
              social.toggleLike(seriesOfTarget(c.target), c.id);
            }}
            accessibilityRole="button"
            accessibilityLabel={c.likedByMe ? `Retirer le j’aime, ${c.likes}` : `J’aime, ${c.likes}`}
            style={[styles.action, c.likedByMe && { backgroundColor: kindSoft(kind) }]}>
            <Ionicons name={c.likedByMe ? 'heart' : 'heart-outline'} size={14} color={c.likedByMe ? kindColor(kind) : C.text2} />
            <Txt v="footnote" tabular color={c.likedByMe ? kindColor(kind) : C.text2} style={F.semibold}>{c.likes}</Txt>
          </Pressable>
          {onReply && (
            <Pressable hitSlop={10} onPress={() => onReply(c)} accessibilityRole="button" style={styles.action}>
              <Ionicons name="arrow-undo-outline" size={14} color={C.text2} />
              <Txt v="footnote" style={F.semibold}>Répondre</Txt>
            </Pressable>
          )}
          <Pressable hitSlop={12} onPress={menu} accessibilityRole="button" accessibilityLabel="Plus d’options" style={[styles.action, { marginLeft: 'auto' }]}>
            <Ionicons name="ellipsis-horizontal" size={16} color={C.text2} />
          </Pressable>
        </View>
      </View>
    </Pressable>
  );
}

/**
 * iOS keyboard height. The panel always reaches the bottom of the screen (page sheet, player side
 * panel), so padding by the full keyboard height is exact; KeyboardAvoidingView is not, because it
 * measures itself relative to its parent and under-pads inside a sheet. Android resizes the window.
 */
function useKeyboardHeight() {
  const [h, setH] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const show = Keyboard.addListener('keyboardWillShow', (e) => setH(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardWillHide', () => setH(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return h;
}

/** What a later episode / chapter is, compared with this thread (spoiler prompt). */
function spoilerContextOf(target: string): SpoilerContext | undefined {
  const [type, id] = target.split(':');
  if (type === 'ep') {
    const f = getEpisode(id);
    if (!f) return undefined;
    const last = f.series.manhwa ? f.episode.chapters?.[1] : undefined;
    return { episode: f.episode.number, chapter: typeof last === 'number' && last > 0 ? last : undefined };
  }
  if (type === 'ch') {
    const f = getChapter(id);
    return f ? { chapter: f.chapter.number } : undefined;
  }
  return undefined;
}

// ---------- formatting toolbar ----------

type Sel = { start: number; end: number };
type Fmt = { icon: React.ComponentProps<typeof Ionicons>['name'] | null; text?: string; label: string; apply: (t: string, s: Sel) => { text: string; sel: Sel } };

const wrap = (before: string, after = before, placeholder = 'texte') => (t: string, s: Sel) => {
  const inner = t.slice(s.start, s.end) || placeholder;
  const text = t.slice(0, s.start) + before + inner + after + t.slice(s.end);
  return { text, sel: { start: s.start + before.length, end: s.start + before.length + inner.length } };
};
const quote = (t: string, s: Sel) => {
  const lineStart = t.lastIndexOf('\n', s.start - 1) + 1;
  const text = `${t.slice(0, lineStart)}> ${t.slice(lineStart)}`;
  return { text, sel: { start: s.start + 2, end: s.end + 2 } };
};
const link = (t: string, s: Sel) => {
  const label = t.slice(s.start, s.end) || 'lien';
  const ins = `[${label}](https://)`;
  const text = t.slice(0, s.start) + ins + t.slice(s.end);
  const at = s.start + label.length + 3 + 'https://'.length;
  return { text, sel: { start: at, end: at } };
};

const FORMATS: Fmt[] = [
  { icon: null, text: 'B', label: 'Gras', apply: wrap('**') },
  { icon: null, text: 'I', label: 'Italique', apply: wrap('*') },
  { icon: null, text: 'S', label: 'Barré', apply: wrap('~~') },
  { icon: 'code-slash', label: 'Code', apply: wrap('`', '`', 'code') },
  { icon: 'chatbox-ellipses-outline', label: 'Citation', apply: quote },
  { icon: 'eye-off-outline', label: 'Spoiler dans le texte', apply: wrap('||', '||', 'spoiler') },
  { icon: 'link', label: 'Lien', apply: link },
];

// ---------- panel ----------

/**
 * Full comment experience: sort, spoiler filter, threaded replies, composer with anchors
 * (moment / range for episodes, page for chapters), Markdown toolbar and preview, GIFs.
 * Episodes: pass `getTime` / `onSeek`. Chapters opened from the reader: pass `page` (1-based).
 */
export function CommentsPanel({
  target,
  kind,
  header,
  getTime,
  onSeek,
  page,
}: {
  target: string;
  kind: Kind;
  header?: ReactNode;
  getTime?: () => number;
  onSeek?: (t: number) => void;
  /** Current page of the reader (chapters). */
  page?: number;
}) {
  const insets = useSafeAreaInsets();
  const me = useMe();
  const { visible: thread, hiddenCount } = useCommunityThread(target);
  const [sort, setSort] = useState<'top' | 'new'>('top');
  const [hideSpoilers, setHideSpoilers] = useState(true);
  const [text, setText] = useState('');
  const [spoiler, setSpoiler] = useState(false);
  const [stamp, setStamp] = useState(!!getTime);
  const [range, setRange] = useState<{ start: number; end?: number } | null>(null);
  const [pageOn, setPageOn] = useState(page !== undefined);
  const [gif, setGif] = useState<string>();
  const [gifOpen, setGifOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState<Sel>({ start: 0, end: 0 });
  const [forcedSel, setForcedSel] = useState<Sel>();
  const [replyTo, setReplyTo] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [sending, setSending] = useState(false);
  const input = useRef<TextInput>(null);
  const kb = useKeyboardHeight();
  const follows = usePrefs((p) => p.follows);

  const [type, targetId] = target.split(':');
  const anchorsTappable = type === 'ep' || type === 'ch';

  // GIF trust: authors I follow, or established ones (rank weight above a fresh identity's).
  const gifAuthors = useMemo(() => thread.filter((c) => !c.deleted && extractGif(c.text).gif).map((c) => c.author), [thread]);
  const weightOf = useAuthorWeights(gifAuthors);
  const trusted = (a: string) => follows.includes(a) || weightOf(a) > 0.1;

  const { roots, replies } = useMemo(() => {
    const ids = new Set(thread.map((c) => c.id));
    const hasReplies = new Set(thread.filter((c) => c.parentId && !c.deleted).map((c) => c.parentId));
    // A deleted comment only stays (as a placeholder) when live replies hang off it.
    const roots = thread.filter((c) => !c.parentId && (!c.deleted || hasReplies.has(c.id)));
    // Collapsed comments sink to the bottom whatever their likes.
    const rank = (c: Row) => (c.community?.hidden ? 1 : 0);
    roots.sort((a, b) => rank(a) - rank(b) || (sort === 'top' ? b.likes - a.likes : b.createdAt - a.createdAt));
    const replies = new Map<string, Row[]>();
    for (const c of thread) {
      // Replies to a masked comment stay masked with it.
      if (!c.parentId || !ids.has(c.parentId) || c.deleted) continue;
      replies.set(c.parentId, [...(replies.get(c.parentId) ?? []), c].sort((a, b) => a.createdAt - b.createdAt));
    }
    return { roots, replies };
  }, [thread, sort]);

  const onAnchor = (a: Anchor) => {
    Haptics.selectionAsync();
    if (a.type === 'time' && type === 'ep') {
      if (onSeek) return onSeek(a.start);
      const r = seekOrRoute(targetId, a.start);
      if (r === true) router.back();
      else router.push(r as never);
    } else if (a.type === 'page' && type === 'ch') {
      const r = pageOrRoute(targetId, a.from);
      if (r === true) router.back();
      else router.push(r as never);
    }
  };

  // ---- composer ----
  const composerAnchor = (): Anchor | undefined => {
    if (editing || replyTo) return undefined;
    if (range && range.end !== undefined) return { type: 'time', start: range.start, end: range.end };
    if (range) return { type: 'time', start: range.start };
    if (getTime && stamp) return { type: 'time', start: getTime() };
    if (page !== undefined && pageOn) return { type: 'page', from: page };
    return undefined;
  };
  const draft = attachGif(text, editing ? undefined : gif);
  const outgoing = withAnchor(draft, composerAnchor());
  const tooLong = outgoing.text.length > MAX_TEXT;
  // Proof of work is solved in the background while typing → sending feels instant. It covers the
  // text as sent (anchor token and GIF link included). A moment taken at send time changes only
  // the `timestamp` field, which the proof does not cover.
  useWarmPow(target, editing ? '' : outgoing.text);

  const resetComposer = () => {
    setText('');
    setSpoiler(false);
    setGif(undefined);
    setRange(null);
    setPreview(false);
  };

  const publish = async (markSpoiler: boolean) => {
    setSending(true);
    try {
      if (editing) {
        await social.editComment(seriesOfTarget(editing.target), editing.id, { text: text.trim(), spoiler: markSpoiler });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        resetComposer();
        setEditing(null);
        return;
      }
      const out = withAnchor(attachGif(text, gif), composerAnchor());
      await social.postComment({
        target,
        text: out.text,
        spoiler: markSpoiler,
        parentId: replyTo ? (replyTo.parentId ?? replyTo.id) : undefined,
        timestamp: out.timestamp,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      resetComposer();
      setReplyTo(null);
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(editing ? 'Modification non enregistrée' : 'Commentaire non publié', e instanceof Error ? e.message : 'Réessaie dans un instant.');
    } finally {
      setSending(false);
    }
  };

  const send = () => {
    if ((!text.trim() && !gif) || sending || tooLong) return;
    const ctx = spoilerContextOf(target);
    const later = !spoiler && ctx ? laterReference(text, ctx) : undefined;
    if (later) {
      Alert.alert('Marquer comme spoiler ?', `Ton commentaire parle de ${laterReferenceLabel(later)}, plus loin que ce fil. Les autres le verront flouté jusqu’à ce qu’ils le touchent.`, [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Publier tel quel', onPress: () => publish(false) },
        { text: 'Marquer spoiler', style: 'default', onPress: () => { setSpoiler(true); publish(true); } },
      ]);
      return;
    }
    publish(spoiler);
  };

  const pressRange = () => {
    if (!getTime) return;
    const now = Math.floor(getTime());
    Haptics.selectionAsync();
    if (!range || range.end !== undefined) return setRange({ start: now });
    if (now > range.start) return setRange({ start: range.start, end: Math.min(now, range.start + 30 * 60) });
    // Not played forward yet: a 10 s range, adjustable by pressing again later.
    setRange({ start: range.start, end: range.start + 10 });
  };

  const startEdit = (c: Row) => {
    setReplyTo(null);
    setEditing(c);
    setText(c.text);
    setSpoiler(c.spoiler);
    setGif(undefined);
    setRange(null);
    input.current?.focus();
  };
  const cancelEdit = () => {
    setEditing(null);
    resetComposer();
  };

  const format = (f: Fmt) => {
    const r = f.apply(text, sel);
    Haptics.selectionAsync();
    setText(r.text);
    setForcedSel(r.sel);
    setSel(r.sel);
    input.current?.focus();
  };

  const pill = (on: boolean) => [styles.pill, on && { backgroundColor: C.text }];
  const toolbar = focused || !!text || !!gif;

  return (
    <View style={{ flex: 1, paddingBottom: kb }}>
      <ScrollView contentContainerStyle={{ paddingBottom: S.xl }} keyboardShouldPersistTaps="handled">
        {header}
        <View style={{ paddingHorizontal: S.lg, gap: 20 }}>
          <View style={{ flexDirection: 'row', gap: S.sm, alignItems: 'center', flexWrap: 'wrap' }}>
            <Pressable onPress={() => setSort('top')} style={pill(sort === 'top')} accessibilityRole="button" accessibilityState={{ selected: sort === 'top' }}>
              <Txt v="small" color={sort === 'top' ? C.bg : C.text2} style={{ ...F.semibold }}>Populaires</Txt>
            </Pressable>
            <Pressable onPress={() => setSort('new')} style={pill(sort === 'new')} accessibilityRole="button" accessibilityState={{ selected: sort === 'new' }}>
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

          {!roots.length && (
            <View style={{ alignItems: 'center', gap: 6, paddingVertical: S.xl }}>
              <Ionicons name="chatbubbles-outline" size={26} color={C.text3} />
              <Txt v="label">Pas encore de commentaire</Txt>
              <Txt v="small" style={{ textAlign: 'center' }}>
                {type === 'ep' ? 'Lance la discussion — tu peux viser un moment précis avec « Horodater » ou « Plage ».' : type === 'ch' ? 'Lance la discussion — tu peux viser une page.' : 'Lance la discussion.'}
              </Txt>
            </View>
          )}

          {roots.map((c) => {
            const rs = replies.get(c.id) ?? [];
            return (
              <View key={c.id} style={{ gap: 12 }}>
                <CommentRow c={c} kind={kind} hideSpoilers={hideSpoilers} meKey={me?.key} gifTrusted={trusted(c.author)}
                  onAnchor={anchorsTappable ? onAnchor : undefined}
                  onReply={(r) => { setEditing(null); setReplyTo(r); input.current?.focus(); }} onEdit={startEdit} />
                {rs.length > 0 && (
                  <View style={styles.thread}>
                    {rs.map((r) => (
                      <CommentRow key={r.id} c={r} kind={kind} hideSpoilers={hideSpoilers} small meKey={me?.key} gifTrusted={trusted(r.author)}
                        onAnchor={anchorsTappable ? onAnchor : undefined}
                        onReply={(x) => { setEditing(null); setReplyTo(x); input.current?.focus(); }} onEdit={startEdit} />
                    ))}
                  </View>
                )}
              </View>
            );
          })}

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

      <View style={[styles.composer, { paddingBottom: kb > 0 ? S.sm : Math.max(insets.bottom, S.md) }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={{ gap: S.sm, alignItems: 'center' }}>
          {editing ? (
            <Pressable onPress={cancelEdit} style={[styles.tag, { backgroundColor: C.accentSoft }]} accessibilityLabel="Annuler la modification">
              <Ionicons name="create-outline" size={14} color={C.accentText} />
              <Txt v="small" color={C.accentText}>Modification</Txt>
              <Ionicons name="close" size={14} color={C.accentText} />
            </Pressable>
          ) : replyTo ? (
            <Pressable onPress={() => setReplyTo(null)} style={styles.tag} accessibilityLabel="Annuler la réponse">
              <Txt v="small">Réponse à <Txt v="small" color={C.text}>{replyTo.authorName}</Txt></Txt>
              <Ionicons name="close" size={14} color={C.text2} />
            </Pressable>
          ) : (
            <>
              {getTime && !range && (
                <Pressable onPress={() => setStamp((v) => !v)} style={[styles.tag, stamp && styles.tagOn]} accessibilityRole="switch" accessibilityState={{ checked: stamp }}
                  accessibilityHint="Ancre le commentaire au moment où tu l’envoies">
                  <Ionicons name={stamp ? 'time' : 'time-outline'} size={14} color={stamp ? C.accentText : C.text2} />
                  <Txt v="small" color={stamp ? C.accentText : C.text2}>Horodater</Txt>
                </Pressable>
              )}
              {getTime && (
                <Pressable onPress={pressRange} style={[styles.tag, range && styles.tagOn]} accessibilityRole="button"
                  accessibilityLabel={!range ? 'Plage : marquer le début' : range.end === undefined ? `Plage depuis ${formatTime(range.start)} : marquer la fin` : `Plage ${anchorLabel({ type: 'time', ...range })}, toucher pour recommencer`}>
                  <Ionicons name="repeat" size={14} color={range ? C.accentText : C.text2} />
                  <Txt v="small" tabular color={range ? C.accentText : C.text2}>
                    {!range ? 'Plage' : range.end === undefined ? `${formatTime(range.start)} → fin ?` : anchorLabel({ type: 'time', start: range.start, end: range.end })}
                  </Txt>
                  {range && (
                    <Pressable onPress={() => setRange(null)} hitSlop={10} accessibilityLabel="Retirer la plage">
                      <Ionicons name="close" size={14} color={C.accentText} />
                    </Pressable>
                  )}
                </Pressable>
              )}
              {page !== undefined && (
                <Pressable onPress={() => setPageOn((v) => !v)} style={[styles.tag, pageOn && styles.tagOn]} accessibilityRole="switch" accessibilityState={{ checked: pageOn }}>
                  <Ionicons name="book-outline" size={14} color={pageOn ? C.accentText : C.text2} />
                  <Txt v="small" color={pageOn ? C.accentText : C.text2}>p. {page}</Txt>
                </Pressable>
              )}
            </>
          )}
          <Pressable onPress={() => setSpoiler((v) => !v)} style={[styles.tag, spoiler && { backgroundColor: kindSoft(kind) }]}
            accessibilityRole="switch" accessibilityState={{ checked: spoiler }} accessibilityLabel="Marquer comme spoiler">
            <Ionicons name={spoiler ? 'eye-off' : 'eye-off-outline'} size={14} color={spoiler ? kindColor(kind) : C.text2} />
            <Txt v="small" color={spoiler ? kindColor(kind) : C.text2}>Spoiler</Txt>
          </Pressable>
          {!editing && (
            <Pressable onPress={() => setGifOpen(true)} style={[styles.tag, !!gif && styles.tagOn]} accessibilityRole="button" accessibilityLabel="Ajouter un GIF">
              <Ionicons name="images-outline" size={14} color={gif ? C.accentText : C.text2} />
              <Txt v="small" color={gif ? C.accentText : C.text2}>GIF</Txt>
            </Pressable>
          )}
        </ScrollView>

        {gif && (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: S.sm }}>
            <GifView url={gif} />
            <Pressable onPress={() => setGif(undefined)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retirer le GIF" style={styles.round}>
              <Ionicons name="close" size={16} color={C.text} />
            </Pressable>
          </View>
        )}

        {preview && !!text.trim() && (
          <View style={styles.preview}>
            <Txt v="caption" style={{ marginBottom: 6 }}>Aperçu</Txt>
            <Markdown text={text} options={{ times: kind === 'anime', pages: type === 'ch' }} />
          </View>
        )}

        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10 }}>
          <View style={{ paddingBottom: 5 }}>
            <Avatar seed={me?.key ?? ''} name={me?.name} />
          </View>
          <TextInput
            ref={input}
            value={text}
            onChangeText={setText}
            selection={forcedSel}
            onSelectionChange={(e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
              setSel(e.nativeEvent.selection);
              if (forcedSel) setForcedSel(undefined);
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={editing ? 'Modifier ton commentaire…' : gif ? 'Ajouter un texte (facultatif)…' : 'Ajouter un commentaire…'}
            placeholderTextColor={C.text3}
            style={styles.input}
            multiline
            accessibilityLabel="Ajouter un commentaire"
          />
          <Press
            onPress={send}
            disabled={(!text.trim() && !gif) || sending || tooLong}
            accessibilityLabel={sending ? 'Publication en cours' : editing ? 'Enregistrer la modification' : 'Envoyer'}
            style={[styles.send, { backgroundColor: kindFill(kind), opacity: (text.trim() || gif) && !tooLong ? 1 : 0.4 }]}>
            {sending ? <ActivityIndicator color={kindOnFill(kind)} /> : <Ionicons name={editing ? 'checkmark' : 'arrow-up'} size={20} color={kindOnFill(kind)} />}
          </Press>
        </View>

        {toolbar && (
          <View style={styles.toolbar}>
            {FORMATS.map((f) => (
              <Pressable key={f.label} onPress={() => format(f)} hitSlop={4} accessibilityRole="button" accessibilityLabel={f.label}
                style={({ pressed }) => [styles.tool, pressed && { backgroundColor: C.elevated }]}>
                {f.icon ? (
                  <Ionicons name={f.icon} size={16} color={C.text2} />
                ) : (
                  <Txt v="label" color={C.text2} style={[{ fontSize: 15 }, f.text === 'B' && F.heavy, f.text === 'I' && { fontStyle: 'italic' }, f.text === 'S' && { textDecorationLine: 'line-through' }]}>
                    {f.text}
                  </Txt>
                )}
              </Pressable>
            ))}
            <Pressable onPress={() => setPreview((v) => !v)} accessibilityRole="switch" accessibilityState={{ checked: preview }} accessibilityLabel="Aperçu"
              style={[styles.previewBtn, preview && { backgroundColor: C.accentSoft }]}>
              <Txt v="footnote" color={preview ? C.accentText : C.text2} style={F.semibold}>Aperçu</Txt>
            </Pressable>
            {outgoing.text.length > MAX_TEXT - 200 && (
              <Txt v="footnote" tabular color={tooLong ? C.danger : C.text3}>{MAX_TEXT - outgoing.text.length}</Txt>
            )}
          </View>
        )}
      </View>
      <GifPicker visible={gifOpen} onClose={() => setGifOpen(false)} onPick={(url) => { setGif(url); setGifOpen(false); }} />
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  anchor: {
    flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 3, paddingHorizontal: 8,
    borderRadius: R.chip, borderCurve: 'continuous', backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine,
  },
  ghostAvatar: { backgroundColor: C.elevated },
  spoiler: {
    minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: S.md,
    borderRadius: R.control, backgroundColor: C.elevated,
  },
  collapsed: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 44, paddingHorizontal: S.md,
    borderRadius: R.control, borderWidth: 1, borderStyle: 'dashed', borderColor: C.border,
  },
  note: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actions: { flexDirection: 'row', gap: 4, alignItems: 'center', marginLeft: -8 },
  action: { flexDirection: 'row', gap: 5, alignItems: 'center', minHeight: 30, paddingHorizontal: 8, borderRadius: R.pill },
  thread: { marginLeft: 16, paddingLeft: 26, gap: 14, borderLeftWidth: 2, borderLeftColor: C.hairline },
  pill: { minHeight: 34, justifyContent: 'center', paddingHorizontal: S.md, borderRadius: R.pill, backgroundColor: C.elevated },
  composer: {
    paddingTop: S.md, paddingHorizontal: S.lg, gap: S.sm, backgroundColor: C.surface,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border,
  },
  input: {
    flex: 1, minHeight: 44, maxHeight: 120, paddingHorizontal: S.lg, paddingTop: 12, paddingBottom: 12,
    borderRadius: 22, backgroundColor: C.elevated, color: C.text, ...F.regular, fontSize: 15,
  },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  hiddenNote: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 44, paddingHorizontal: S.md,
    borderRadius: R.control, backgroundColor: C.elevated,
  },
  tag: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32, paddingHorizontal: 10,
    borderRadius: R.pill, backgroundColor: C.elevated,
  },
  tagOn: { backgroundColor: C.accentSoft },
  round: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: C.elevated },
  preview: { maxHeight: 180, overflow: 'hidden', padding: S.md, borderRadius: R.control, backgroundColor: C.bg, borderWidth: 1, borderColor: C.hairline },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: 44 },
  previewBtn: { marginLeft: 'auto', height: 32, paddingHorizontal: 10, borderRadius: R.chip, alignItems: 'center', justifyContent: 'center' },
  tool: { width: 34, height: 32, borderRadius: R.chip, alignItems: 'center', justifyContent: 'center' },
});
