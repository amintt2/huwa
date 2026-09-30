// Playback engines: expo-video (AVPlayer / ExoPlayer) by default, libmpv as a fallback for the
// formats the native engine cannot play (MKV/WebM/AVI…, VP9, AV1 without hardware decoder) or when
// it fails. See policy.ts for the rules and modules/huwa-mpv for the native side.
export { EngineView, useEnginePlayer } from './EngineView';
export { EngineBadge } from './EngineBadge';
export { HybridPlayer as EnginePlayer, deviceCaps } from './hybrid-player';
export { decideEngine, type Engine, type EnginePref } from './policy';
export { useNativeWarmup } from './use-native-warmup';
export { getEnginePref, setEnginePref, useActiveEngine, useEnginePref } from './prefs';
