import { requireOptionalNativeModule } from 'expo-modules-core';

type Native = {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
};

/** null on Android / web / builds without the module. */
export const HuwaKeychain = requireOptionalNativeModule<Native>('HuwaKeychain');
