// Cells of the reader list: a page (placeholder sized by its known ratio, retry on error) and the
// divider between two chapters ("Fin · Ch. 41" / "Début · Ch. 42"), Paperback-style.
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Press, Txt } from '@/components/ui';
import { episodeForChapter } from '@/data/bridge';
import { getChapter } from '@/data/catalog';
import { useThread } from '@/store/derived';
import { C, F, R, S } from '@/theme/tokens';

import type { LoadState } from './useChapterFeed';

/** Height of a divider in the vertical reader (fixed: the list layout is computed ahead). */
export const DIVIDER_H = 248;

export function PageView({
  uri,
  headers,
  boxW,
  boxH,
  w,
  h,
  number,
  downsample,
  flip,
  light,
  top,
  onAspect,
}: {
  uri: string;
  headers?: Record<string, string>;
  /** Cell size along both axes. */
  boxW: number;
  boxH: number;
  /** Page size inside the cell (top-aligned in the vertical reader, centered when paged). */
  w: number;
  h: number;
  number: number;
  downsample: boolean;
  /** Right-to-left paged list: the list is mirrored, each cell mirrors back. */
  flip?: boolean;
  /** Light reader background: darker placeholder text. */
  light?: boolean;
  /** Page at the top of its cell (vertical reader: the spacing goes below it). */
  top?: boolean;
  onAspect: (uri: string, ratio: number) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const muted = light ? 'rgba(0,0,0,0.38)' : 'rgba(255,255,255,0.32)';
  const source = headers && /^https?:/i.test(uri) ? { uri, headers } : { uri };
  return (
    <View
      accessible
      accessibilityLabel={`Page ${number}`}
      style={{ width: boxW, height: boxH, alignItems: 'center', justifyContent: top ? 'flex-start' : 'center', transform: flip ? [{ scaleX: -1 }] : undefined }}>
      <View style={{ width: w, height: h }}>
        {state !== 'ok' && (
          <View style={[StyleSheet.absoluteFill, styles.placeholder]}>
            <Txt v="headline" color={muted} tabular style={{ fontSize: 28, lineHeight: 34, ...F.bold }}>{number}</Txt>
            {state === 'loading' ? (
              <ActivityIndicator color={muted} />
            ) : (
              <Press onPress={() => {
                setState('loading');
                setAttempt((a) => a + 1);
              }} style={styles.retry} accessibilityRole="button" accessibilityLabel={`Recharger la page ${number}`}>
                <Ionicons name="refresh" size={16} color={C.text} />
                <Txt v="label" style={{ fontSize: 14 }}>Réessayer</Txt>
              </Press>
            )}
          </View>
        )}
        {state !== 'error' && (
          <Image
            key={attempt}
            source={source}
            style={{ width: w, height: h }}
            contentFit="contain"
            transition={120}
            cachePolicy="memory-disk"
            recyclingKey={uri}
            allowDownscaling={downsample}
            onLoad={(e) => {
              setState('ok');
              if (e.source.width && e.source.height) onAspect(uri, e.source.width / e.source.height);
            }}
            onError={() => setState('error')}
          />
        )}
      </View>
    </View>
  );
}

const chapterName = (id?: string) => {
  const c = id ? getChapter(id)?.chapter : undefined;
  return c ? { number: c.number, title: c.title } : undefined;
};

function CommentsButton({ chapterId }: { chapterId: string }) {
  const count = useThread(`ch:${chapterId}`).length;
  return (
    <Press onPress={() => router.push({ pathname: '/comments', params: { target: `ch:${chapterId}`, kind: 'manhwa' } })}
      style={styles.action} accessibilityRole="button" accessibilityLabel={`${count} commentaires sur ce chapitre`}>
      <Ionicons name="chatbubble-outline" size={15} color={C.text} />
      <Txt v="small" color={C.text} tabular>{count ? `${count} commentaire${count > 1 ? 's' : ''}` : 'Commenter'}</Txt>
    </Press>
  );
}

export function DividerView({
  before,
  after,
  beforeLoaded,
  afterLoaded,
  afterLoad,
  boxW,
  boxH,
  paged,
  flip,
  flag,
  onRetry,
}: {
  before?: string;
  after?: string;
  /** `before` is in the list (false: the previous chapter, above the window, not loaded yet). */
  beforeLoaded: boolean;
  /** `after` is in the list. */
  afterLoaded?: boolean;
  /** Load state of the chapter that is not in the list yet, if any. */
  afterLoad?: LoadState;
  boxW: number;
  boxH: number;
  paged: boolean;
  flip?: boolean;
  flag?: string;
  onRetry: (chapterId: string) => void;
}) {
  const b = chapterName(before);
  const a = chapterName(after);
  const found = before ? getChapter(before) : after ? getChapter(after) : undefined;
  const ep = beforeLoaded && found && b ? episodeForChapter(found.series, b.number) : undefined;
  const pending = !beforeLoaded ? before : after;
  const status = afterLoad?.status;

  const row = (label: string, c: { number: number; title: string } | undefined, right: ReactNode, strong: boolean) => (
    <View style={styles.row}>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="caption" color={strong ? C.accentText : C.text3} maxFontSizeMultiplier={1.2}>{label}</Txt>
        <Txt v="label" numberOfLines={1} maxFontSizeMultiplier={1.2} color={strong ? C.text : C.body}>
          {c ? (c.title ? `Chapitre ${c.number} · ${c.title}` : `Chapitre ${c.number}`) : 'Tu es à jour'}
        </Txt>
      </View>
      {right}
    </View>
  );

  const state = (
    status === 'loading' ? (
      <ActivityIndicator color={C.text2} />
    ) : status === 'error' && pending ? (
      <Press onPress={() => onRetry(pending)} style={styles.action} accessibilityRole="button" accessibilityLabel="Réessayer de charger le chapitre">
        <Ionicons name="refresh" size={15} color={C.text} />
        <Txt v="small" color={C.text}>Réessayer</Txt>
      </Press>
    ) : flag ? (
      <Txt style={{ fontSize: 18 }} accessibilityElementsHidden>{flag}</Txt>
    ) : null
  );

  return (
    <View style={{ width: boxW, height: boxH, justifyContent: 'center', alignItems: 'center', backgroundColor: C.bg, transform: flip ? [{ scaleX: -1 }] : undefined }}>
      <View style={[styles.card, { width: Math.min(boxW - 2 * S.lg, 460) }]}>
        {row(beforeLoaded ? 'Fin' : 'Chapitre précédent', b, !beforeLoaded ? state : <Ionicons name="checkmark-circle" size={20} color={C.accentText} />, false)}
        <View style={styles.line} />
        {row(a ? (beforeLoaded && !afterLoaded ? 'À suivre' : 'Début') : 'Fin de la série disponible', a, beforeLoaded ? state : null, true)}
        {!a && <Txt v="small" style={{ paddingHorizontal: S.lg, marginTop: -6 }}>Le prochain chapitre arrive bientôt.</Txt>}
        {beforeLoaded && before && (
          <View style={styles.actions}>
            <CommentsButton chapterId={before} />
            {ep && (
              <Press onPress={() => router.push(`/watch/${ep.id}`)} style={styles.action} accessibilityRole="button" accessibilityLabel={`Revoir ce passage en anime, épisode ${ep.number}`}>
                <Ionicons name="tv-outline" size={15} color={C.accentText} />
                <Txt v="small" color={C.accentText} tabular>En anime · Ép. {ep.number}</Txt>
              </Press>
            )}
          </View>
        )}
        {paged && (
          <Txt v="footnote" style={{ textAlign: 'center', paddingBottom: S.sm }} color={C.text3}>
            {a ? (beforeLoaded ? 'Continue pour passer au chapitre suivant' : 'Continue pour lire le chapitre') : ''}
          </Txt>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: { alignItems: 'center', justifyContent: 'center', gap: S.md },
  retry: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 44, paddingHorizontal: S.lg, borderRadius: R.pill,
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border,
  },
  card: {
    borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
    paddingVertical: S.sm, gap: S.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingVertical: S.sm, minHeight: 56 },
  line: { height: StyleSheet.hairlineWidth, backgroundColor: C.hairline, marginHorizontal: S.lg },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm, paddingHorizontal: S.md, paddingBottom: S.xs },
  action: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: S.md, borderRadius: R.pill,
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border,
  },
});
