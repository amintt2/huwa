// `addon_catalog` resource: a list of addons published by one of the user's addons
// (e.g. a community list). Huwa shows it as-is; each install still goes through the sheet.
import { Image } from 'expo-image';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchAddonCatalog, normalizeAddonUrl, type AddonDescriptor } from '@/addons/protocol';
import { useAddons } from '@/addons/registry';
import { Button, IconButton, Txt } from '@/components/ui';
import { C, R, S } from '@/theme/tokens';

export default function AddonCatalog() {
  const insets = useSafeAreaInsets();
  const { addon, type, id, name } = useLocalSearchParams<{ addon: string; type: string; id: string; name?: string }>();
  const installed = new Set(useAddons().map((a) => a.manifest.id));
  const key = `${addon}|${type}|${id}`;
  const [res, setRes] = useState<{ key: string; list?: AddonDescriptor[]; error?: string }>({ key: '' });

  useEffect(() => {
    let cancelled = false;
    fetchAddonCatalog(String(addon), String(type), String(id))
      .then((list) => !cancelled && setRes({ key, list }))
      .catch((e) => !cancelled && setRes({ key, error: e instanceof Error ? e.message : 'Injoignable' }));
    return () => {
      cancelled = true;
    };
  }, [key, addon, type, id]);

  const cur: { list?: AddonDescriptor[]; error?: string } = res.key === key ? res : {};

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top + S.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingBottom: S.md }}>
        <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        <Txt v="title" numberOfLines={1} style={{ flex: 1 }}>{name ?? id}</Txt>
      </View>
      <Txt v="small" style={{ paddingHorizontal: S.lg, paddingBottom: S.md }}>
        Liste fournie par un de tes addons, pas par Huwa. Vérifie chaque extension avant de l’ajouter.
      </Txt>
      {!cur.list && !cur.error && <ActivityIndicator color={C.accentText} />}
      {!!cur.error && <Txt v="small" style={{ paddingHorizontal: S.lg }}>Catalogue injoignable ({cur.error}).</Txt>}
      <FlatList
        data={cur.list ?? []}
        keyExtractor={(a) => a.transportUrl}
        contentContainerStyle={{ paddingHorizontal: S.lg, gap: S.sm, paddingBottom: S.xxl + insets.bottom }}
        renderItem={({ item }) => {
          const m = item.manifest;
          const has = installed.has(m.id);
          return (
            <View style={styles.row}>
              {m.logo ? <Image source={{ uri: m.logo }} style={styles.logo} contentFit="contain" /> : <View style={styles.logo} />}
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="label" numberOfLines={1}>{m.name}</Txt>
                <Txt v="small" numberOfLines={2}>{m.description ?? item.transportUrl}</Txt>
              </View>
              <Button
                small
                variant={has ? 'ghost' : 'soft'}
                label={has ? 'Installé' : 'Voir'}
                onPress={() => router.push({ pathname: '/addon', params: { url: `${normalizeAddonUrl(item.transportUrl)}/manifest.json` } } as unknown as Href)}
              />
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: R.card, backgroundColor: C.surface },
  logo: { width: 40, height: 40, borderRadius: 10, backgroundColor: C.elevated },
});
