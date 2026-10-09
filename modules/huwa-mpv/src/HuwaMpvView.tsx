import { requireNativeView } from 'expo';
import type { Ref } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';

export type MpvTrack = {
  /** mpv track id (per type). */
  id: number;
  type: 'video' | 'audio' | 'sub';
  title: string;
  lang: string;
  codec: string;
  default: boolean;
  /** Matroska "forced" flag (signs / foreign dialogue only). Missing on older builds. */
  forced?: boolean;
  selected: boolean;
  external: boolean;
};

/** `tracks`: JSON array of MpvTrack. */
export type MpvLoadedEvent = { duration: number; tracks: string; videoCodec: string; hwdec: string };
export type MpvProgressEvent = { time: number; duration: number; buffered: number; paused: boolean };
export type MpvStateEvent = {
  paused?: boolean;
  buffering?: boolean;
  seeking?: boolean;
  hwdec?: string;
  videoCodec?: string;
  /** Display size of the video (after reconfig). */
  width?: number;
  height?: number;
  /** First frame of the file on screen (first playback restart after load; iOS). */
  firstFrame?: boolean;
};

/** Imperative API of the native view (ref). All calls are fire-and-forget on the mpv queue. */
export type MpvViewHandle = {
  load(url: string, headers: Record<string, string>, start: number, autoplay: boolean): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  seek(seconds: number): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  /** 0..1 */
  setVolume(volume: number): Promise<void>;
  /** mpv track id, -1 = none. */
  setAudioTrack(id: number): Promise<void>;
  setSubtitleTrack(id: number): Promise<void>;
  setFill(fill: boolean): Promise<void>;
  stop(): Promise<void>;
  /**
   * Preferred audio languages (mpv `alang`, e.g. "ja,jpn"), applied to every file opened next.
   * Missing on builds older than this API.
   */
  setAudioLanguages?(langs: string): Promise<void>;
  /** `sub-…` option (subtitle look and delay). Missing on builds older than this API. */
  setSubtitleOption?(name: string, value: string): Promise<void>;
  /** Adds and selects a local subtitle file (libass), for the current file only. */
  addSubtitleFile?(path: string, title: string, lang: string): Promise<void>;
  removeSubtitle?(id: number): Promise<void>;
};

export type MpvViewProps = ViewProps & {
  ref?: Ref<MpvViewHandle>;
  /** The native view is mounted and accepts calls. */
  onReady?: (e: NativeSyntheticEvent<Record<string, never>>) => void;
  onLoaded?: (e: NativeSyntheticEvent<MpvLoadedEvent>) => void;
  onProgress?: (e: NativeSyntheticEvent<MpvProgressEvent>) => void;
  onStateChange?: (e: NativeSyntheticEvent<MpvStateEvent>) => void;
  onTracks?: (e: NativeSyntheticEvent<{ tracks: string }>) => void;
  onEnd?: (e: NativeSyntheticEvent<Record<string, never>>) => void;
  onMpvError?: (e: NativeSyntheticEvent<{ message: string }>) => void;
};

let NativeView: React.ComponentType<MpvViewProps> | null = null;

/** Lazily resolved so importing this file never throws where the module is absent (web, Expo Go). */
export function getMpvNativeView(): React.ComponentType<MpvViewProps> | null {
  if (NativeView) return NativeView;
  try {
    NativeView = requireNativeView<MpvViewProps>('HuwaMpv');
  } catch {
    NativeView = null;
  }
  return NativeView;
}
