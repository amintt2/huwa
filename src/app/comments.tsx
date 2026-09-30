import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { CommentsPanel } from '@/components/comments';
import { Chip, IconButton, Txt } from '@/components/ui';
import { chapterLabel, episodeLabel, getChapter, getEpisode } from '@/data/catalog';
import { useThread } from '@/store/derived';
import { C, S, type Kind } from '@/theme/tokens';

/** Bottom sheet with the full thread of an episode or a chapter. */
export default function CommentsSheet() {
  const { target, kind } = useLocalSearchParams<{ target: string; kind: Kind }>();
  const count = useThread(target).length;
  const [type, id] = target.split(':');
  const context =
    type === 'ep'
      ? (() => { const f = getEpisode(id); return f ? episodeLabel(f.episode) : ''; })()
      : (() => { const f = getChapter(id); return f ? chapterLabel(f.chapter) : ''; })();

  return (
    <View style={{ flex: 1, backgroundColor: C.surface }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', padding: S.lg, paddingTop: S.xl }}>
        <View style={{ gap: 6, flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: S.sm }}>
            <Txt v="title" style={{ fontSize: 20 }}>Commentaires</Txt>
            <Txt v="small" style={{ fontSize: 15 }}>{count}</Txt>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Chip kind={kind === 'anime' ? 'anime' : 'manhwa'} />
            <Txt v="small" numberOfLines={1}>{context}</Txt>
          </View>
        </View>
        <IconButton icon="close" label="Fermer" tone="solid" onPress={() => router.back()} />
      </View>
      <CommentsPanel target={target} kind={kind === 'anime' ? 'anime' : 'manhwa'} />
    </View>
  );
}
