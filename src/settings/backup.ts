// Export / import of the local Huwa data (JSON file), and cache clearing.
// The file holds raw AsyncStorage values keyed by name, so new stores are covered automatically
// as long as their key starts with `huwa/`. Caches, cookies, device-bound identity material and
// file indexes are left out (rules in ./backup-core.ts); personal add-on URLs only on request.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import { hydrateExtraSeries } from '@/data/catalog';
import { hasSourceBundle } from '@/manga-ext/registry';
import { hydrateLists } from '@/store/lists';
import { rehydrateStore } from '@/store/store';

import { MANGA_EXT_KEY, PREFIX, dropMissingSources, exportData as exportable, isExportable, personalAddonCount, planRestore, withoutPersonalAddons } from './backup-core';
import { rehydrateAll } from './rehydrate';
import { hydrateSettings } from './settings';

/** Caches: rebuilt from the network, cleared by "Vider le cache". */
const CACHE_KEYS = ['huwa/catalog/v2'];

export type Backup = { app: 'huwa'; format: 1; exportedAt: string; data: Record<string, string> };

export async function buildBackup({ includePersonalAddons = false }: { includePersonalAddons?: boolean } = {}): Promise<Backup> {
  const keys = (await AsyncStorage.getAllKeys()).filter(isExportable);
  const data = exportable(await AsyncStorage.multiGet(keys));
  return { app: 'huwa', format: 1, exportedAt: new Date().toISOString(), data: includePersonalAddons ? data : withoutPersonalAddons(data) };
}

/** Installed add-ons whose URL holds a personal configuration (API keys, tokens…). */
export async function personalAddonsInExport(): Promise<number> {
  const raw = await AsyncStorage.getItem('huwa/addons/v1').catch(() => null);
  return raw ? personalAddonCount({ 'huwa/addons/v1': raw }) : 0;
}

/** Writes the backup to a temp file and opens the system share sheet. */
export async function exportData(opts: { includePersonalAddons?: boolean } = {}): Promise<void> {
  const backup = await buildBackup(opts);
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

/**
 * Replaces this device's data with the backup (writes first, then removes the keys the backup does
 * not have), then makes every store in memory re-read it. Returns the extension sources that must
 * be reinstalled (their code is not part of an export).
 */
export async function restoreBackup(backup: Backup): Promise<{ sourcesToReinstall: string[] }> {
  const data = { ...backup.data };
  let sourcesToReinstall: string[] = [];
  if (data[MANGA_EXT_KEY] != null) {
    const r = dropMissingSources(data[MANGA_EXT_KEY], hasSourceBundle);
    data[MANGA_EXT_KEY] = r.raw;
    sourcesToReinstall = r.dropped;
  }
  const plan = planRestore(await AsyncStorage.getAllKeys(), data);
  await AsyncStorage.multiSet(plan.set);
  if (plan.remove.length) await AsyncStorage.multiRemove(plan.remove);
  await Promise.all([rehydrateStore(), hydrateLists(true), hydrateSettings(true), hydrateExtraSeries(), rehydrateAll()]);
  return { sourcesToReinstall };
}

/** Image caches + catalog cache. Progress, lists and settings are untouched. */
export async function clearCache() {
  await Promise.all([
    Image.clearDiskCache().catch(() => false),
    Image.clearMemoryCache().catch(() => false),
    AsyncStorage.multiRemove(CACHE_KEYS),
  ]);
}
