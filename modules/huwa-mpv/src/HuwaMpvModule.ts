// Binding to the `HuwaMpv` native module (../ios, ../android).
// `requireOptionalNativeModule` returns null in Expo Go, on web or when the module is not linked;
// `isAvailable()` is false when the module is linked without libmpv (Android today, or an iOS build
// without scripts/fetch-mpvkit.sh). Callers must handle both.
import { NativeModule, requireOptionalNativeModule } from 'expo';

export type HardwareDecoders = { av1?: boolean; hevc?: boolean; vp9?: boolean; h264?: boolean };

export declare class HuwaMpvNativeModule extends NativeModule<Record<never, never>> {
  mpvVersion: string;
  isAvailable(): boolean;
  hardwareDecoders(): HardwareDecoders;
}

export default requireOptionalNativeModule<HuwaMpvNativeModule>('HuwaMpv');
