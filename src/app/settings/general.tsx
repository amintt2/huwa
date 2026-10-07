import Constants from 'expo-constants';
import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Switch, View } from 'react-native';

import { LanguagePrefs } from '@/components/language-prefs';
import { EngineSetting } from '@/components/player/engines/EngineSetting';
import { Screen } from '@/components/screen';
import { Field } from '@/components/social';
import { Group, Row, Segmented } from '@/components/states';
import { Button, Txt } from '@/components/ui';
import { useT } from '@/i18n';
import { enableNotifications, notificationsSupported } from '@/notifications/episodes';
import { importAniList, loginWithAniList, oauthAvailable } from '@/settings/anilist-sync';
import { clearCache, exportData, personalAddonsInExport, pickBackup, restoreBackup } from '@/settings/backup';
import { CELLULAR_DATA } from '@/settings/network-budget';
import { setSetting, useSettings, type Quality } from '@/settings/settings';
import { C, S } from '@/theme/tokens';

const QUALITIES: Quality[] = ['auto', '1080p', '720p', '480p'];

export default function Settings() {
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

  const doExport = (includePersonalAddons: boolean) =>
    run('export', async () => {
      try {
        await exportData({ includePersonalAddons });
      } catch (e) {
        Alert.alert(t('settings.export'), t('settings.exportError', { e: e instanceof Error ? e.message : String(e) }));
      }
    });

  // Add-on URLs can carry debrid keys / tokens: never exported silently.
  const onExport = async () => {
    if (busy) return;
    const n = await personalAddonsInExport().catch(() => 0);
    if (!n) return doExport(false);
    Alert.alert(t('settings.exportSecretsTitle'), t('settings.exportSecrets', { n }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('settings.exportWith'), style: 'destructive', onPress: () => doExport(true) },
      { text: t('settings.exportWithout'), style: 'default', onPress: () => doExport(false) },
    ]);
  };

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
              .then(({ sourcesToReinstall: s }) =>
                Alert.alert(t('settings.import'), s.length ? t('settings.importSources', { names: s.join(', ') }) : t('settings.importDone')),
              )
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
    <Screen title={t('settings.general')}>
        <Group title="Interface">
          <Row
            icon="language-outline"
            label={t('settings.language')}
            last
            right={
              <Segmented
                accessibilityLabel={t('settings.language')}
                style={{ width: 112 }}
                value={s.lang}
                onChange={(v) => setSetting('lang', v)}
                options={[{ value: 'fr', label: 'FR' }, { value: 'en', label: 'EN' }]}
              />
            }
          />
        </Group>

        <Group title="Langues">
          <View style={{ padding: S.md }}>
            <LanguagePrefs />
          </View>
          {s.watchMode === 'dub' && (
            <Row
              icon="language-outline"
              label={t('settings.dubAutoFallback')}
              hint={t('settings.dubAutoFallbackHint')}
              right={<Switch value={s.dubAutoFallback} onValueChange={(v) => setSetting('dubAutoFallback', v)} accessibilityLabel={t('settings.dubAutoFallback')} {...switchProps} />}
            />
          )}
        </Group>

        <Group title={t('settings.playback')}>
          <Row
            icon="wifi-outline"
            label={t('settings.wifiOnly')}
            hint={t('settings.wifiOnlyHint')}
            right={<Switch value={s.wifiOnly} onValueChange={(v) => setSetting('wifiOnly', v)} accessibilityLabel={t('settings.wifiOnly')} {...switchProps} />}
          />
          {!s.wifiOnly && (
            <View style={styles.block}>
              <Txt v="label">{t('settings.cellularData')}</Txt>
              <Segmented
                accessibilityLabel={t('settings.cellularData')}
                value={s.cellularData}
                onChange={(v) => setSetting('cellularData', v)}
                options={CELLULAR_DATA.map((v) => ({ value: v, label: t(`settings.cellularData.${v}`) }))}
              />
              <Txt v="small">{t(`settings.cellularDataHint.${s.cellularData}`)}</Txt>
            </View>
          )}
          <Row
            icon="swap-horizontal-outline"
            label={t('settings.autoSwitch')}
            hint={t('settings.autoSwitchHint')}
            right={<Switch value={s.autoSwitchSource} onValueChange={(v) => setSetting('autoSwitchSource', v)} accessibilityLabel={t('settings.autoSwitch')} {...switchProps} />}
          />
          {s.autoSwitchSource && (
            <Row
              icon="chatbox-ellipses-outline"
              label={t('settings.switchToast')}
              hint={t('settings.switchToastHint')}
              right={<Switch value={s.switchToast} onValueChange={(v) => setSetting('switchToast', v)} accessibilityLabel={t('settings.switchToast')} {...switchProps} />}
            />
          )}
          <EngineSetting />
          <View style={styles.block}>
            <Txt v="label">{t('settings.quality')}</Txt>
            <Segmented
              accessibilityLabel={t('settings.quality')}
              value={s.quality}
              onChange={(q) => setSetting('quality', q)}
              options={QUALITIES.map((q) => ({ value: q, label: q === 'auto' ? t('settings.quality.auto') : q }))}
            />
          </View>
          <Row icon="speedometer-outline" label="Statistiques de lecture" hint="Temps de démarrage, coupures, sources — reste sur l’appareil" onPress={() => router.push('/settings/stats')} />
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
            <Txt v="small" style={{ lineHeight: 18 }}>{t('anilist.body')}</Txt>
            <Field
              value={userName}
              onChangeText={setUserName}
              placeholder={t('anilist.username')}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={() => userName.trim() && onImportAniList()}
              accessibilityLabel={t('anilist.username')}
              style={{ backgroundColor: C.elevated }}
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  inline: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm },
  block: { gap: S.md, padding: S.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hairline },
});
