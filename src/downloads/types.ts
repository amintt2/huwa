// Offline episode downloads: shared types (pure, no React Native imports — unit-tested).

/** Quality asked for a download: 'auto' = what the player would pick. */
export type DlQuality = 'auto' | 1080 | 720 | 480;
export const DL_QUALITIES: DlQuality[] = ['auto', 1080, 720, 480];

/** How the bytes are fetched: one HTTP file, an HLS package (native module), the on-device torrent engine. */
export type DlKind = 'file' | 'hls' | 'torrent';

export type DlStatus =
  /** Waiting for a slot. */
  | 'queued'
  /** Wi-Fi only and on cellular / offline. */
  | 'waiting-network'
  /** Asking the addons for this episode and choosing the source. */
  | 'resolving'
  | 'downloading'
  | 'paused'
  /** Gave up (after retries) — the user can retry. */
  | 'failed'
  | 'done';

export type CompressState = 'pending' | 'running' | 'done' | 'skipped' | 'unsupported' | 'failed';

/** Snapshot of the chosen stream: enough to fetch it again without asking the addons. */
export type DlSource = {
  key: string;
  name: string;
  addonName: string;
  quality: number | null;
  /** Direct link (or resolved torrent link). Debrid links expire: re-resolved on failure. */
  url?: string;
  headers?: Record<string, string>;
  infoHash?: string;
  fileIdx?: number;
  filename?: string;
  sources?: string[];
  /** File extension kept on disk (the player picks its engine from it: mkv → mpv). */
  ext: string;
  /** Resolved through a debrid service / the on-device engine (link can expire / needs the app open). */
  via?: string;
};

export type DlSubtitle = { lang: string; file: string; label?: string };

export type DlCompress = {
  state: CompressState;
  progress?: number;
  /** Size before compression. */
  originalBytes?: number;
  reason?: string;
  /** Interrupted runs (battery, background): retried later. */
  attempts?: number;
};

export type DownloadItem = {
  /** Episode id (catalog). */
  id: string;
  seriesId: string;
  episode: number;
  seriesTitle: string;
  title: string;
  durationMin: number;
  image?: string;
  quality: DlQuality;
  wifiOnly: boolean;
  status: DlStatus;
  kind?: DlKind;
  /** Source chosen on the watch screen (auto or manual): preferred when still listed. */
  preferredKey?: string;
  source?: DlSource;
  /** Media file, relative to the episode folder. */
  file?: string;
  bytes: number;
  total: number;
  /** Download attempts since the last manual action. */
  attempts: number;
  error?: string;
  /** Epoch ms before which an automatic retry must not start. */
  retryAt?: number;
  /** Serialized expo-file-system `DownloadPauseState` (resume after pause / relaunch). */
  resume?: string;
  subtitles: DlSubtitle[];
  /** External subtitle files chosen at resolve time, saved once the video is done. */
  subtitleSources?: { url: string; lang: string; label?: string }[];
  /** Real duration (s) once known (probe after download). */
  durationSec?: number;
  width?: number;
  height?: number;
  codec?: string;
  compress?: DlCompress;
  /** Queued by "Télécharger automatiquement l'épisode suivant". */
  auto?: boolean;
  createdAt: number;
  doneAt?: number;
};

export type NetworkKind = 'wifi' | 'cellular' | 'offline';
