// Android sideload: a newer APK on GitHub Releases is offered at launch (at most every 12 h, and
// a version the user put off is not offered again). "Mettre à jour" downloads the APK in the
// browser; Android then shows its own install screen. Obtainium users get the same releases.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import { useEffect } from 'react';
import { Alert, Linking, Platform } from 'react-native';

import { isPlayBuild, isStoreBuild } from '@/config/channel';

import { apkUpdate, type LatestRelease } from './release';

declare const __DEV__: boolean;

const LATEST = 'https://api.github.com/repos/amintt2/huwa/releases/latest';
const KEY = 'huwa/update-check/v1';
const EVERY_MS = 12 * 3600_000;
const DELAY_MS = 6000;

type Saved = { at: number; skipped?: string };

async function check() {
  const current = Application.nativeApplicationVersion;
  if (!current) return;
  const saved: Saved = JSON.parse((await AsyncStorage.getItem(KEY).catch(() => null)) ?? '{"at":0}');
  if (Date.now() - saved.at < EVERY_MS) return;
  const res = await fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) return;
  const update = apkUpdate((await res.json()) as LatestRelease, current, Device.supportedCpuArchitectures ?? []);
  await AsyncStorage.setItem(KEY, JSON.stringify({ ...saved, at: Date.now() })).catch(() => {});
  if (!update || update.version === saved.skipped) return;
  Alert.alert(
    `Huwa ${update.version} est disponible`,
    `Tu as la version ${current}. Le téléchargement s'ouvre dans le navigateur, puis Android te propose d'installer la mise à jour (tes données sont conservées).`,
    [
      {
        text: 'Plus tard',
        style: 'cancel',
        onPress: () => {
          AsyncStorage.setItem(KEY, JSON.stringify({ at: Date.now(), skipped: update.version })).catch(() => {});
        },
      },
      { text: 'Mettre à jour', onPress: () => Linking.openURL(update.url).catch(() => {}) },
    ],
  );
}

/** Root layout: looks for a newer APK once the app has settled (Android sideload builds only, not Play). */
export function useApkUpdateCheck(enabled: boolean) {
  useEffect(() => {
    // Google Play forbids an app updating itself outside Play (Device and Network Abuse policy).
    if (!enabled || Platform.OS !== 'android' || isStoreBuild || isPlayBuild || __DEV__) return;
    const t = setTimeout(() => {
      check().catch(() => {});
    }, DELAY_MS);
    return () => clearTimeout(t);
  }, [enabled]);
}
