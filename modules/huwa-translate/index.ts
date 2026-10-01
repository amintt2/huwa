import { requireOptionalNativeModule } from 'expo-modules-core';

// On-device translation (Apple Translation framework, iOS 18+). Text never leaves the device.
// Language identifiers are BCP 47 ("en", "fr", "pt-BR"…).
// Android: no native module (null) → every call reports "unsupported" and the app keeps the
// original subtitles. ML Kit on-device translation would be the way to add it later.

export type TranslateStatus = 'installed' | 'supported' | 'unsupported';

type Native = {
  isAvailable(source: string, target: string): Promise<TranslateStatus>;
  /** Shows the system download prompt when the model is missing; resolves with the new status. */
  prepare(source: string, target: string): Promise<TranslateStatus>;
  /** Same order and length as `texts`. */
  translateBatch(texts: string[], source: string, target: string): Promise<string[]>;
};

/** null on Android / web / builds without the module. */
export const HuwaTranslate = requireOptionalNativeModule<Native>('HuwaTranslate');
