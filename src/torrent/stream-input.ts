// `startStream` arguments for a torrent stream (pure, kept apart from the native binding).
import type { StartStreamInput } from './types';

export type TorrentStreamLike = {
  infoHash?: string;
  fileIdx?: number | null;
  sources?: string[];
  name?: string;
  title?: string;
};

/**
 * Info hash of a URL served by the built-in engine (`http://127.0.0.1:<port>/<hash>/<file>[.ext]`),
 * null for anything else.
 */
export function engineHashOf(url: string | null | undefined): string | null {
  const m = /^http:\/\/127\.0\.0\.1:\d+\/([0-9a-f]{40})\/(?:\d+|auto)(?:\.[a-z0-9]{2,5})?(?:[?#].*)?$/i.exec(url ?? '');
  return m ? m[1].toLowerCase() : null;
}

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
