import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

// Hardware HEVC re-encoding of downloaded episodes ("compression intelligente"), iOS only.
// The decision (bitrate per resolution, skip when the saving is < 25 %…) is pure TS:
// src/downloads/compress.ts. Inputs must be readable by AVFoundation (MP4 / MOV); MKV / WebM are
// kept as downloaded.
// Android: no native module (null) → compression reports "unsupported" and originals are kept.
// MediaCodec + MediaMuxer would be the way to add it later.

export type MediaProbe = {
  durationSec: number;
  width?: number;
  height?: number;
  codec?: string;
  fps?: number;
  videoBitrate?: number;
  audioTracks: number;
  subtitleTracks: number;
  sizeBytes: number;
  readable: boolean;
};

export type PowerState = { batteryLevel: number; charging: boolean; lowPower: boolean };

type Native = {
  probe(uri: string): Promise<MediaProbe>;
  transcode(id: string, inputUri: string, outputUri: string, options: { videoBitrate: number; audioBitrate: number }): Promise<MediaProbe>;
  cancel(id: string): void;
  powerState(): PowerState;
  addListener(event: 'onProgress', cb: (e: { id: string; progress: number }) => void): EventSubscription;
};

/** null on Android / web / builds without the module. */
export const HuwaTranscode = requireOptionalNativeModule<Native>('HuwaTranscode');
