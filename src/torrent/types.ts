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
  /**
   * Streaming health from the engine's monitor: `searching` = no peer connected, `stalled` = the
   * player has been waiting for data for > 6 s, `recovering` = automatic re-announce (pause +
   * resume) in progress, `idle` = not streamed right now. Absent with an older native build.
   */
  health?: TorrentHealth;
  /** Automatic recoveries since the torrent was added (this app run). */
  recoveries?: number;
};

export type TorrentHealth = 'ok' | 'searching' | 'stalled' | 'recovering' | 'idle';

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
  /**
   * Metered network (cellular): the engine only downloads a window of ~60–90 s ahead of the
   * playhead instead of the whole file in the background. Sent with every call (the network can
   * change between two episodes).
   */
  metered?: boolean;
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

// ---- swarm probes (native/huwa-torrent-core/src/probe.rs) ----

export type ProbeState = 'queued' | 'resolving' | 'healthy' | 'weak' | 'noFile' | 'failed' | 'cancelled';

export type ProbeInput = {
  infoHash: string;
  sources?: string[];
  name?: string;
  fileIdx?: number | null;
  /** Stremio `behaviorHints.filename`. */
  filename?: string;
  /** Finds the file in a season pack without `fileIdx` / `filename`. */
  episode?: number;
  /** 1000..30000, default 8000. */
  timeoutMs?: number;
  /** Answering peers needed for `healthy` (default 3). */
  minPeers?: number;
};

export type ProbeStatus = {
  id: number;
  infoHash: string;
  state: ProbeState;
  /** Time to metadata (0 = already known). */
  metaMs: number | null;
  /** Peers discovered (DHT, trackers). */
  peers: number;
  /** Peers that answered a BitTorrent handshake for this torrent. */
  connected: number;
  fileIdx: number | null;
  fileName: string | null;
  fileSize: number | null;
  fileCount: number | null;
  /** The file is already complete on the device. */
  local: boolean;
  elapsedMs: number;
  error: string | null;
};
