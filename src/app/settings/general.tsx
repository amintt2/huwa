import Constants from 'expo-constants';
import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LanguagePrefs } from '@/components/language-prefs';
import { EngineSetting } from '@/components/player/engines/EngineSetting';
import { FilterChip, Group, Row, ScreenHeader } from '@/components/states';
import { Button, Txt } from '@/components/ui';
import { useT } from '@/i18n';
import { enableNotifications, notificationsSupported } from '@/notifications/episodes';
import { importAniList, loginWithAniList, oauthAvailable } from '@/settings/anilist-sync';
import { clearCache, exportData, pickBackup, restoreBackup } from '@/settings/backup';
import { setSetting, useSettings, type Quality } from '@/settings/settings';
import { C, F, R, S } from '@/theme/tokens';

const QUALITIES: Quality[] = ['auto', '1080p', '720p', '480p'];

export default function Settings() {
  const insets = useSafeAreaInsets();
  const t = useT();
  const s = useSettings();
  const [busy, setBusy] = useState<string | null>(null);
  const [userName, setUserName] = useState('');

  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const spinner = (key: string) => (busy === key ? <ActivityIndicator color={C.text2} /> : undefined);

  const onExport = () =>
    run('export', async () => {
      try {
        await exportData();
      } catch (e) {
        Alert.alert(t('settings.export'), t('settings.exportError', { e: e instanceof Error ? e.message : String(e) }));
      }
    });

  const onImport = () =>
    run('import', async () => {
      let backup;
      try {
        backup = await pickBackup();
      } catch {
        Alert.alert(t('settings.import'), t('settings.importInvalid'));
        return;
      }
      if (!backup) return;
      const b = backup;
      Alert.alert(t('settings.import'), t('settings.importConfirm'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.import'),
          style: 'destructive',
          onPress: () =>
            restoreBackup(b)
              .then(() => Alert.alert(t('settings.import'), t('settings.importDone')))
              .catch(() => Alert.alert(t('settings.import'), t('settings.importInvalid'))),
        },
      ]);
    });

  const onClearCache = () =>
    run('cache', async () => {
      await clearCache();
      Alert.alert(t('settings.clearCache'), t('settings.cacheCleared'));
    });

  const onImportAniList = (token?: string) =>
    run('anilist', async () => {
      try {
        const n = await importAniList({ userName, token });
        Alert.alert(t('anilist.title'), t('anilist.done', { n }));
      } catch (e) {
        Alert.alert(t('anilist.title'), t('anilist.error', { e: e instanceof Error ? e.message : String(e) }));
      }
    });

  const onLogin = async () => {
    if (!oauthAvailable()) {
      Alert.alert(t('anilist.title'), t('anilist.noClient'));
      return;
    }
    try {
      const token = await loginWithAniList();
      if (token) await onImportAniList(token);
    } catch (e) {
      Alert.alert(t('anilist.title'), t('anilist.error', { e: e instanceof Error ? e.message : String(e) }));
    }
  };

  const toggleNotifications = (on: boolean) => {
    if (on) void enableNotifications();
    else setSetting('notifications', false);
  };

  const switchProps = { trackColor: { true: C.accent, false: C.elevated }, thumbColor: C.white } as const;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: insets.top + S.sm, paddingBottom: insets.bottom + S.xxl }}>
      <ScreenHeader title={t('settings.title')} />

      <View style={{ paddingHorizontal: S.lg, gap: S.xl }}>
        <Group title={t('settings.general')}>
          <Row
            icon="language-outline"
            label={t('settings.language')}
            last
            right={
              <View style={styles.inline}>
                <FilterChip label="FR" selected={s.lang === 'fr'} onPress={() => setSetting('lang', 'fr')} />
                <FilterChip label="EN" selected={s.lang === 'en'} onPress={() => setSetting('lang', 'en')} />
              </View>
            }
          />
        </Group>

        <Group title="LANGUES">
          <View style={{ padding: S.md }}>
            <LanguagePrefs />
          </View>
        </Group>

        <Group title={t('settings.playback')}>
          <Row
            icon="wifi-outline"
            label={t('settings.wifiOnly')}
            hint={t('settings.wifiOnlyHint')}
            right={<Switch value={s.wifiOnly} onValueChange={(v) => setSetting('wifiOnly', v)} accessibilityLabel={t('settings.wifiOnly')} {...switchProps} />}
          />
          <EngineSetting />
          <View style={styles.block}>
            <Txt v="label">{t('settings.quality')}</Txt>
            <View style={styles.inline}>
              {QUALITIES.map((q) => (
                <FilterChip key={q} label={q === 'auto' ? t('settings.quality.auto') : q} selected={s.quality === q} onPress={() => setSetting('quality', q)} />
              ))}
            </View>
          </View>
          <Row icon="text" label="Sous-titres" hint="Langues, police, taille, contour, style ASS" onPress={() => router.push('/settings/subtitles')} last />
        </Group>

        <Group title={t('settings.notifications')}>
          <Row
            icon="notifications-outline"
            label={t('settings.notifEpisodes')}
            hint={notificationsSupported ? t('settings.notifHint') : t('notif.unsupported')}
            last
            right={
              <Switch
                value={s.notifications}
                disabled={!notificationsSupported}
                onValueChange={toggleNotifications}
                accessibilityLabel={t('settings.notifEpisodes')}
                {...switchProps}
              />
            }
          />
        </Group>

        <Group title={t('settings.anilist')}>
          <View style={[styles.block, { borderBottomWidth: 0 }]}>
            <Txt v="small">{t('anilist.body')}</Txt>
            <TextInput
              value={userName}
              onChangeText={setUserName}
              placeholder={t('anilist.username')}
              placeholderTextColor={C.text2}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={() => userName.trim() && onImportAniList()}
              accessibilityLabel={t('anilist.username')}
              style={styles.input}
            />
            <Button
              small
              variant="soft"
              icon="cloud-download-outline"
              label={busy === 'anilist' ? t('anilist.importing') : t('anilist.importPublic')}
              onPress={() => userName.trim() && onImportAniList()}
            />
            <Button small variant="ghost" icon="log-in-outline" label={t('anilist.login')} onPress={onLogin} />
            {!oauthAvailable() && <Txt v="small" style={{ fontSize: 12 }}>{t('anilist.noClient')}</Txt>}
            <Button small variant="ghost" icon="download-outline" label="Importer depuis Stremio ou anime-sama" onPress={() => router.push('/import' as Href)} />
          </View>
        </Group>

        <Group title={t('settings.data')}>
          <Row icon="albums-outline" label={t('lists.manage')} onPress={() => router.push('/lists')} />
          <Row icon="share-outline" label={t('settings.export')} hint={t('settings.exportHint')} onPress={onExport} right={spinner('export')} />
          <Row icon="download-outline" label={t('settings.import')} onPress={onImport} right={spinner('import')} />
          <Row icon="trash-bin-outline" label={t('settings.clearCache')} hint={t('settings.clearCacheHint')} onPress={onClearCache} right={spinner('cache')} last />
        </Group>

        <Group title={t('settings.privacy')}>
          <View style={[styles.block, { borderBottomWidth: 0 }]}>
            <Txt v="small" style={{ lineHeight: 19 }}>{t('settings.privacyBody')}</Txt>
          </View>
        </Group>

        <Group title={t('settings.about')}>
          <View style={styles.block}>
            <Txt v="label">Huwa · {t('settings.version', { v: Constants.expoConfig?.version ?? '—' })}</Txt>
            <Txt v="small" style={{ lineHeight: 19 }}>{t('settings.legal')}</Txt>
          </View>
          <Row icon="sparkles-outline" label={t('settings.onboardingAgain')} onPress={() => setSetting('onboarded', false)} last />
        </Group>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  inline: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm },
  block: { gap: S.md, padding: S.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border },
  input: {
    minHeight: 44, paddingHorizontal: S.md, borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border, color: C.text, ...F.medium, fontSize: 15,
  },
});
