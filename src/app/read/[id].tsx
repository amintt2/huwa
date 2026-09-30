import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Press, Progress, Txt } from '@/components/ui';
import { animeEndChapter, episodeForChapter } from '@/data/bridge';
import { chapterLabel, getChapter, PAGE_ASPECT, pageUrl } from '@/data/catalog';
import { useThread } from '@/store/derived';
import { getState, saveChapterProgress, useStore } from '@/store/store';
import { C, R, S } from '@/theme/tokens';

export default function Read() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!getChapter(id)) return <Txt style={{ padding: S.xl }}>Chapitre introuvable.</Txt>;
  return <Reader key={id} id={id} />;
}

function Reader({ id }: { id: string }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { series, chapter } = getChapter(id)!;
  const chapters = series.manhwa!.chapters;
  const prev = chapters[chapter.number - 2];
  const next = chapters[chapter.number];
  const pageH = width / PAGE_ASPECT;
  const pages = Array.from({ length: chapter.pageCount }, (_, i) => pageUrl(id, i));

  const progress = useStore((s) => s.chapters[id]?.ratio ?? 0);
  const count = useThread(`ch:${id}`).length;
  const [bars, setBars] = useState(true);
  const [toastHidden, setToastHidden] = useState(false);
  const list = useRef<FlatList<string>>(null);
  const lastSave = useRef(0);
  const restored = useRef(false);

  const adaptedBy = episodeForChapter(series, chapter.number);
  const isContinuation = !!series.anime && chapter.number === animeEndChapter(series) + 1;

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    const readable = contentSize.height - pageH; // exclude the end-of-chapter footer
    const ratio = Math.min(1, (contentOffset.y + layoutMeasurement.height) / Math.max(1, readable));
    if (Date.now() - lastSave.current > 800) {
      lastSave.current = Date.now();
      saveChapterProgress(id, ratio);
    }
  };

  const openComments = () => router.push({ pathname: '/comments', params: { target: `ch:${id}`, kind: 'manhwa' } });

  return (
    <View style={{ flex: 1, backgroundColor: C.black }}>
      <FlatList
        ref={list}
        data={pages}
        keyExtractor={(u) => u}
        onScroll={onScroll}
        scrollEventThrottle={100}
        initialNumToRender={3}
        windowSize={5}
        onContentSizeChange={(_, h) => {
          // Resume where you stopped (once).
          const saved = getState().chapters[id];
          if (restored.current || !saved || saved.done || saved.ratio < 0.05) return;
          restored.current = true;
          list.current?.scrollToOffset({ offset: Math.max(0, saved.ratio * (h - pageH) - pageH), animated: false });
        }}
        renderItem={({ item, index }) => (
          <Pressable onPress={() => setBars((b) => !b)} accessibilityLabel={`Page ${index + 1}`}>
            <Image source={item} style={{ width, height: pageH }} contentFit="cover" transition={150} recyclingKey={item} />
          </Pressable>
        )}
        ListFooterComponent={
          <View style={[styles.footer, { minHeight: pageH, paddingBottom: insets.bottom + 140 }]}>
            <Txt v="caption" color={C.accent}>FIN DU CHAPITRE {chapter.number}</Txt>
            <Txt v="title">{chapterLabel(chapter)}</Txt>
            {next ? (
              <Button label={`Chapitre ${next.number}`} icon="arrow-forward" color={C.accent} textColor={C.onAccent}
                style={{ flexDirection: 'row-reverse', alignSelf: 'stretch' }} onPress={() => router.replace(`/read/${next.id}`)} />
            ) : (
              <Txt v="body">Tu es à jour. Le prochain chapitre arrive bientôt.</Txt>
            )}
            <Button variant="soft" icon="chatbubble-outline" label={`${count} commentaires`} style={{ alignSelf: 'stretch' }} onPress={openComments} />
            {adaptedBy && (
              <Press onPress={() => router.push(`/watch/${adaptedBy.id}`)} style={styles.animeLink}>
                <Ionicons name="tv-outline" size={18} color={C.accentText} />
                <Txt v="label" color={C.accentText} style={{ fontSize: 13 }}>Revoir ce passage en anime · Ép. {adaptedBy.number}</Txt>
              </Press>
            )}
          </View>
        }
      />

      {bars && (
        <>
          <View style={[styles.top, { paddingTop: insets.top + S.sm }]}>
            <Press onPress={() => router.back()} style={styles.round} accessibilityLabel="Retour">
              <Ionicons name="chevron-back" size={20} color={C.text} />
            </Press>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="label" numberOfLines={1}>{chapterLabel(chapter)}</Txt>
              <Txt v="small" numberOfLines={1}>{series.title}</Txt>
            </View>
          </View>

          {isContinuation && !toastHidden && (
            <Pressable onPress={() => setToastHidden(true)} style={[styles.toast, { top: insets.top + 72 }]}
              accessibilityLabel="Masquer le message">
              <Txt v="small" color={C.white} style={{ fontSize: 12 }}>
                Suite directe de l’anime (ép. {series.anime!.episodes.length})
              </Txt>
              <Ionicons name="close" size={14} color={C.white} />
            </Pressable>
          )}

          <View style={[styles.bottom, { paddingBottom: insets.bottom + S.md }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Txt v="small" color={C.accent} style={{ width: 38 }}>{Math.round(progress * 100)} %</Txt>
              <View style={{ flex: 1 }}><Progress value={progress} color={C.accent} height={4} /></View>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Button small variant="soft" label={prev ? `Ch. ${prev.number}` : 'Début'} icon="chevron-back"
                onPress={() => prev && router.replace(`/read/${prev.id}`)} />
              <Button small variant="soft" icon="chatbubble-outline" label={`${count}`} onPress={openComments} />
              {next ? (
                <Button small label={`Ch. ${next.number}`} color={C.accent} textColor={C.onAccent}
                  onPress={() => router.replace(`/read/${next.id}`)} />
              ) : (
                <View style={{ width: 80 }} />
              )}
            </View>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    position: 'absolute', left: 0, right: 0, top: 0, flexDirection: 'row', alignItems: 'center', gap: S.md,
    paddingHorizontal: S.lg, paddingBottom: S.md, backgroundColor: 'rgba(10,10,15,0.94)',
  },
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center' },
  toast: {
    position: 'absolute', left: S.lg, flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 7, paddingHorizontal: 12, borderRadius: R.pill, backgroundColor: C.accent,
  },
  bottom: {
    position: 'absolute', left: 0, right: 0, bottom: 0, gap: 14, paddingTop: 14, paddingHorizontal: S.lg,
    borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: 'rgba(10,10,15,0.96)',
  },
  footer: { backgroundColor: C.bg, padding: S.xl, gap: S.lg, alignItems: 'flex-start' },
  animeLink: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm, padding: S.md, borderRadius: R.card,
    backgroundColor: C.accentSoft, alignSelf: 'stretch',
  },
});
