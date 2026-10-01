import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

// Offline HLS episodes (AVAssetDownloadURLSession → `.movpkg`, played offline by AVPlayer).
// A plain file download can't save a playlist and its segments. iOS device only: the simulator
// has no AVAssetDownloadTask, so `isAvailable()` is false there.
// Android: no native module (null) → HLS downloads report "unsupported" (ExoPlayer's
// DownloadManager would be the way to add it later).

export type HlsActive = { id: string; progress: number; state: 'running' | 'suspended' };

type Native = {
  isAvailable(): boolean;
  start(id: string, url: string, destPath: string, options: { headers?: Record<string, string>; title?: string; minBitrate?: number }): void;
  pause(id: string): void;
  resume(id: string): void;
  cancel(id: string): void;
  active(): Promise<HlsActive[]>;
  addListener(event: 'onProgress', cb: (e: { id: string; progress: number }) => void): EventSubscription;
  addListener(event: 'onDone', cb: (e: { id: string; path: string }) => void): EventSubscription;
  addListener(event: 'onError', cb: (e: { id: string; message: string }) => void): EventSubscription;
};

/** null on Android / web / builds without the module. */
export const HuwaHls = requireOptionalNativeModule<Native>('HuwaHls');
