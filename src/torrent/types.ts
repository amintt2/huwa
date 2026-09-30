// Mirrors native/huwa-torrent-core/src/engine.rs (serde camelCase).

export type TorrentState = 'resolving' | 'initializing' | 'live' | 'paused' | 'finished' | 'error';

export type TorrentFile = { idx: number; name: string; size: number; progressBytes: number };

export type TorrentStatus = {
  id: string;
  infoHash: string;
  name: string | null;
  state: TorrentState;
  error: string | null;
  /** 0..1 of the selected file. */
  progress: number;
  progressBytes: number;
  totalBytes: number;
  downloadBps: number;
  uploadBps: number;
  peersLive: number;
  peersConnecting: number;
  peersSeen: number;
  files: TorrentFile[];
  selectedFile: number | null;
  url: string;
  activeStreams: number;
  addedAt: number;
  lastAccess: number;
  sizeOnDisk: number;
};

export type EngineStats = {
  version: string;
  port: number;
  cacheLimitBytes: number;
  cacheUsedBytes: number;
  seeding: boolean;
  torrents: TorrentStatus[];
};

export type StartStreamInput = {
  infoHash: string;
  fileIdx?: number | null;
  /** Stremio `sources`: `tracker:udp://…`, `dht:<hash>`. */
  sources?: string[];
  name?: string;
};

export type StreamHandle = { id: string; url: string; infoHash: string };

export type TorrentSettings = {
  /** User opt-in. Off by default (PLAN: torrent disabled by default). */
  enabled: boolean;
  wifiOnly: boolean;
  /** On-disk cache quota in bytes. */
  quotaBytes: number;
  /** Legal notice accepted on first use. */
  legalAccepted: boolean;
};
