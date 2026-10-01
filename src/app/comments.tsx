import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { CommentsPanel } from '@/components/comments';
import { StateView } from '@/components/states';
import { Chip, IconButton, Txt } from '@/components/ui';
import { chapterLabel, episodeLabel, getChapter, getEpisode, getSeries } from '@/data/catalog';
import { useThread } from '@/store/derived';
import { C, S, type Kind } from '@/theme/tokens';

/** Bottom sheet with the full thread of an episode or a chapter. */
export default function CommentsSheet() {
  const params = useLocalSearchParams<{ target?: string; kind?: Kind }>();
  const target = typeof params.target === 'string' && /^(ep|ch|series):.+/.test(params.target) ? params.target : '';
  if (!target) {
    // Shared / hand-typed link without a valid thread.
    return (
      <View style={{ flex: 1, backgroundColor: C.surface, justifyContent: 'center' }}>
        <StateView icon="chatbubbles-outline" title="Fil introuvable" body="Ce lien ne désigne aucun fil de commentaires." action="Fermer" onAction={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      </View>
    );
  }
  return <Thread target={target} kindParam={params.kind} />;
}

/** The thread's kind: the link's `kind` when given, else what the target points to. */
function kindOf(target: string, param?: string): Kind {
  if (param === 'anime' || param === 'manhwa') return param;
  const [type, id] = target.split(':');
  if (type === 'ep') return 'anime';
  if (type === 'ch') return 'manhwa';
  const s = getSeries(id);
  return s?.anime || !s?.manhwa ? 'anime' : 'manhwa';
}

function Thread({ target, kindParam }: { target: string; kindParam?: string }) {
  const kind = kindOf(target, kindParam);
  const count = useThread(target).length;
  const [type, id] = target.split(':');
  const context =
    type === 'ep'
      ? (() => { const f = getEpisode(id); return f ? episodeLabel(f.episode) : ''; })()
      : type === 'ch'
        ? (() => { const f = getChapter(id); return f ? chapterLabel(f.chapter) : ''; })()
        : getSeries(id)?.title ?? '';

  // The header lives inside the panel's ScrollView: in an iOS form sheet the ScrollView is pinned to
  // the sheet's edges, so a sibling header above it ends up drawn underneath the list.
  const header = (
    <>
    <View style={{ alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: C.borderStrong, marginTop: S.sm }} />
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: S.lg, paddingTop: S.md, paddingBottom: S.md }}>
      <View style={{ gap: 6, flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: S.sm }}>
          <Txt v="title" style={{ fontSize: 20 }}>Commentaires</Txt>
          <Txt v="small" style={{ fontSize: 15 }}>{count}</Txt>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Chip kind={kind} />
          <Txt v="small" numberOfLines={1} style={{ flexShrink: 1 }}>{context}</Txt>
        </View>
      </View>
      <IconButton icon="close" label="Fermer" tone="solid" onPress={() => router.back()} />
    </View>
    </>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.surface }}>
      <CommentsPanel target={target} kind={kind} header={header} />
    </View>
  );
}
