import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { ChapterReader } from '@/components/reader/ChapterReader';
import { Txt } from '@/components/ui';
import { getChapter } from '@/data/catalog';
import { numericParam } from '@/social/anchor-nav';
import { S } from '@/theme/tokens';

export default function Read() {
  // `page` (1-based): open at this page (comment anchors, huwa://read/<ch>?page=12 links).
  const { id, page } = useLocalSearchParams<{ id: string; page?: string }>();
  if (!getChapter(id)) return <Txt style={{ padding: S.xl }}>Chapitre introuvable.</Txt>;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Session key={id} id={id} startPage={numericParam(page, 9999)} />
    </GestureHandlerRootView>
  );
}

/**
 * The reader moves from chapter to chapter by itself (continuous scroll); jumping to a chapter
 * outside the loaded window, or sources registering late, restarts it on that chapter.
 */
function Session({ id, startPage }: { id: string; startPage?: number }) {
  const [run, setRun] = useState({ start: id, n: 0 });
  return (
    <ChapterReader
      key={`${run.start}#${run.n}`}
      startId={run.start}
      startPage={run.n === 0 ? startPage : undefined}
      onRestart={(chapterId) => setRun((r) => ({ start: getChapter(chapterId) ? chapterId : r.start, n: r.n + 1 }))}
    />
  );
}

// A reader crash stays on this route (retry / back) instead of taking the whole app down.
export { ErrorScreen as ErrorBoundary } from '@/components/error-screen';
