// Subtitles on the mpv engine: the user's look and sync offset for the tracks mpv draws, and
// styled ASS files from addons drawn by libass (fonts, \clip, \t, karaoke, signs…) instead of the
// overlay. Returns whether libass draws the selected file (the overlay then stays empty).
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { useSubtitlePrefs } from '@/subtitles/prefs';
import type { SubtitleDoc } from '@/subtitles/types';

import type { HybridPlayer } from './hybrid-player';
import { libassRenders, mpvSubtitleOptions } from './mpv-subtitles';

/** FNV-1a of the text: same file → same name, written once. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + text.length.toString(16);
}

/** Writes the decoded subtitle text (UTF-8) to the cache; path for mpv, null on failure. */
function subtitleFile(text: string): string | null {
  try {
    const dir = new Directory(Paths.cache, 'subtitles-mpv');
    dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, `${hash(text)}.ass`);
    if (!file.exists) file.write(text);
    return decodeURI(file.uri.replace(/^file:\/\//, ''));
  } catch {
    return null;
  }
}

export function useMpvSubtitles(player: HybridPlayer, doc: SubtitleDoc | null, docText: string | undefined, lang: string, offset: number): boolean {
  const prefs = useSubtitlePrefs();
  const engine = useSyncExternalStore(player.subscribeEngine, player.getEngine, player.getEngine);

  useEffect(() => {
    player.setMpvSubtitleOptions(mpvSubtitleOptions(prefs, offset));
  }, [player, prefs, offset]);

  const wanted = engine === 'mpv' && !!docText && libassRenders(doc, prefs) && player.canDrawSubtitleFiles();
  const path = useMemo(() => (wanted && docText ? subtitleFile(docText) : null), [wanted, docText]);

  useEffect(() => {
    player.setMpvSubtitleFile(path ? { path, lang } : null);
  }, [player, path, lang]);
  useEffect(() => () => player.setMpvSubtitleFile(null), [player]);

  return !!path;
}
