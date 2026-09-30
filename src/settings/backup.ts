// Export / import of every local Huwa key (JSON file), and cache clearing.
// The file holds raw AsyncStorage values keyed by name, so new stores are covered automatically
// as long as their key starts with `huwa/`. Re-fetchable caches are left out.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import { hydrateExtraSeries } from '@/data/catalog';
import { hydrateLists } from '@/store/lists';
import { rehydrateStore } from '@/store/store';

import { hydrateSettings } from './settings';

const PREFIX = 'huwa/';
/** Caches: rebuilt from the network, not worth exporting. */
const CACHE_KEYS = ['huwa/catalog/v2'];

export type Backup = { app: 'huwa'; format: 1; exportedAt: string; data: Record<string, string> };

export async function buildBackup(): Promise<Backup> {
  const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX) && !CACHE_KEYS.includes(k));
  const pairs = await AsyncStorage.multiGet(keys);
  const data: Record<string, string> = {};
  for (const [k, v] of pairs) if (v != null) data[k] = v;
  return { app: 'huwa', format: 1, exportedAt: new Date().toISOString(), data };
}

/** Writes the backup to a temp file and opens the system share sheet. */
export async function exportData(): Promise<void> {
  const backup = await buildBackup();
  const json = JSON.stringify(backup, null, 2);
  const name = `huwa-backup-${backup.exportedAt.slice(0, 10)}.json`;

  if (Platform.OS === 'web') {
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }

  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  file.write(json);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing unavailable');
  await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: name, UTI: 'public.json' });
}

function parseBackup(text: string): Backup {
  const v = JSON.parse(text) as Partial<Backup>;
  if (v?.app !== 'huwa' || v.format !== 1 || !v.data || typeof v.data !== 'object') throw new Error('invalid');
  for (const [k, val] of Object.entries(v.data)) {
    if (!k.startsWith(PREFIX) || typeof val !== 'string') throw new Error('invalid');
    JSON.parse(val); // every stored value is JSON
  }
  return v as Backup;
}

/** Lets the user pick a backup file. Resolves `null` if cancelled; throws on invalid files. */
export async function pickBackup(): Promise<Backup | null> {
  const res = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain', '*/*'], copyToCacheDirectory: true });
  if (res.canceled || !res.assets?.length) return null;
  const asset = res.assets[0];
  const text = Platform.OS === 'web' && asset.file ? await asset.file.text() : await new File(asset.uri).text();
  return parseBackup(text);
}

/** Replace local data with the backup, then reload every store in memory. */
export async function restoreBackup(backup: Backup) {
  const existing = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX) && !CACHE_KEYS.includes(k));
  await AsyncStorage.multiRemove(existing);
  await AsyncStorage.multiSet(Object.entries(backup.data));
  // Progress, lists, settings and saved series reload live. Installed add-ons are read by their
  // registry at launch only, so they apply on the next start.
  await Promise.all([rehydrateStore(), hydrateLists(true), hydrateSettings(true), hydrateExtraSeries()]);
}

/** Image caches + catalog cache. Progress, lists and settings are untouched. */
export async function clearCache() {
  await Promise.all([
    Image.clearDiskCache().catch(() => false),
    Image.clearMemoryCache().catch(() => false),
    AsyncStorage.multiRemove(CACHE_KEYS),
  ]);
}
