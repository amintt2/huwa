// Build flavor. "store" = App Store Connect build (HUWA_LITE=1, see eas.json): no extension
// prompts in the onboarding. Every other build (AltStore PAL, sideload, Google Play, dev) is "full".
import Constants from 'expo-constants';

export const channel: 'store' | 'full' = Constants.expoConfig?.extra?.channel === 'store' ? 'store' : 'full';
export const isStoreBuild = channel === 'store';
/** Google Play AAB (HUWA_PLAY=1): updates come from Play only, never from GitHub Releases. */
export const isPlayBuild = Constants.expoConfig?.extra?.distribution === 'play';
