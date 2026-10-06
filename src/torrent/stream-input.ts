// `startStream` arguments for a torrent stream (pure, kept apart from the native binding).
import type { StartStreamInput } from './types';

export type TorrentStreamLike = {
  infoHash?: string;
  fileIdx?: number | null;
  sources?: string[];
  name?: string;
  title?: string;
};

/** `metered`: cellular right now: the engine keeps only a ~60–90 s window ahead of the playhead. */
export function startStreamInput(stream: TorrentStreamLike & { infoHash: string }, metered: boolean): StartStreamInput {
  return {
    infoHash: stream.infoHash,
    fileIdx: stream.fileIdx ?? null,
    sources: stream.sources ?? [],
    name: stream.name ?? stream.title?.split('\n')[0],
    metered,
  };
}
