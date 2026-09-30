import { type Href, router } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { useAddons } from '@/addons/registry';
import { Button, Txt } from '@/components/ui';
import { resetAll, setUserName, useStore } from '@/store/store';
import { C, F, R, S } from '@/theme/tokens';

export default function Profile() {
  const userName = useStore((s) => s.userName);
  const episodes = useStore((s) => s.episodes);
  const chapters = useStore((s) => s.chapters);
  const comments = useStore((s) => s.comments);
  const addonCount = useAddons().filter((a) => a.enabled).length;
  const [name, setName] = useState(userName);

  const stats = [
    { label: 'Épisodes vus', value: Object.values(episodes).filter((e) => e.done).length, color: C.accentText },
    { label: 'Chapitres lus', value: Object.values(chapters).filter((c) => c.done).length, color: C.accent },
    { label: 'Commentaires', value: comments.length, color: C.text },
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingTop: S.sm, paddingHorizontal: S.lg, gap: S.xl, paddingBottom: S.xxl }}>
      <Txt v="display" style={{ fontSize: 28 }}>Profil</Txt>

      <View style={{ gap: S.sm }}>
        <Txt v="small" nativeID="pseudo">Pseudo affiché dans les commentaires</Txt>
        <TextInput
          value={name}
          onChangeText={setName}
          onEndEditing={() => setUserName(name)}
          style={styles.input}
          accessibilityLabelledBy="pseudo"
          autoCapitalize="none"
          maxLength={24}
        />
      </View>

      <View style={{ flexDirection: 'row', gap: S.md }}>
        {stats.map((s) => (
          <View key={s.label} style={styles.stat}>
            <Txt v="title" color={s.color}>{s.value}</Txt>
            <Txt v="small">{s.label}</Txt>
          </View>
        ))}
      </View>

      <Button variant="soft" icon="extension-puzzle-outline" label={`Addons (${addonCount} actifs)`} onPress={() => router.push('/addons' as Href)} />

      <Button variant="soft" icon="download-outline" label="Téléchargements" onPress={() => router.push('/downloads' as Href)} />

      <Button
        variant="soft"
        icon="refresh"
        label="Réinitialiser la progression"
        onPress={() =>
          Alert.alert('Tout réinitialiser ?', 'Progression, liste et commentaires seront effacés de cet appareil.', [
            { text: 'Annuler', style: 'cancel' },
            { text: 'Réinitialiser', style: 'destructive', onPress: resetAll },
          ])
        }
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 48, paddingHorizontal: S.lg, borderRadius: R.card, backgroundColor: C.surface,
    color: C.text, ...F.medium, fontSize: 16,
  },
  stat: { flex: 1, padding: S.md, gap: 4, borderRadius: R.card, backgroundColor: C.surface },
});
