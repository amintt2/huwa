// Build flavor. "store" = App Store Connect build (HUWA_LITE=1, see eas.json): no extension
// prompts in the onboarding. Every other build (AltStore PAL, sideload, dev) is "full".
import Constants from 'expo-constants';

export const channel: 'store' | 'full' = Constants.expoConfig?.extra?.channel === 'store' ? 'store' : 'full';
export const isStoreBuild = channel === 'store';
