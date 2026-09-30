// Thin binding to the `HuwaTorrent` native module (Swift / Kotlin in ../ios and ../android).
// `requireOptionalNativeModule` returns null in Expo Go, on web, or when the module is not
// linked at all; `isAvailable()` additionally returns false when the module is linked but the
// Rust library is not (build without HUWA_TORRENT=1). Callers must handle both.
import { NativeModule, requireOptionalNativeModule } from 'expo';

export type TorrentStatusEvent = { json: string };

export type HuwaTorrentEvents = { onTorrentStatus: (event: TorrentStatusEvent) => void };

export declare class HuwaTorrentNativeModule extends NativeModule<HuwaTorrentEvents> {
  /** "0.1.0+librqbit-9.0.1" when the Rust library is linked, "unlinked" otherwise. */
  nativeVersion: string;
  isAvailable(): boolean;
  isOnCellular(): boolean;
  defaultDataDir(): string;
  /** Starts the engine. Resolves with the JSON envelope `{"ok":{"port":N}}` or `{"error":"…"}`. */
  initialize(configJson: string): Promise<string>;
  /** Generic dispatcher, see native/huwa-torrent-core/src/api.rs. Resolves with a JSON envelope. */
  call(method: string, argsJson: string): Promise<string>;
  shutdown(): Promise<void>;
}

export default requireOptionalNativeModule<HuwaTorrentNativeModule>('HuwaTorrent');
