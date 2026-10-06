import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Avatar, Field, ScreenHeader } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import { social, useMe } from '@/p2p/hooks';
import { C, S, SHADOW } from '@/theme/tokens';

export default function ProfileEdit() {
  const me = useMe();
  const [name, setName] = useState(me?.name ?? '');
  const [bio, setBio] = useState(me?.bio ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await social.updateProfile({ name, bio });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Enregistrement impossible.');
      setBusy(false);
    }
  };

  if (!me) return null;
  const dirty = name.trim() !== me.name || bio.trim() !== (me.bio ?? '');

  return (
    // A form sheet pins its ScrollView to the sheet's edges: the header lives inside it (a sibling
    // above was drawn under the avatar, and RNScreens expects at most 2 subviews).
    <ScrollView
      style={{ flex: 1, backgroundColor: C.surface }}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={{ paddingBottom: S.xxl, gap: S.xl }}>
      <ScreenHeader title="Modifier le profil" close />
      <View style={{ paddingHorizontal: S.lg, gap: S.xl }}>
        <View style={{ alignItems: 'center', gap: S.sm }}>
          <View style={{ borderRadius: 48, padding: 4, backgroundColor: C.elevated, boxShadow: SHADOW.raised }}>
            <Avatar seed={me.key} name={name || me.name} size={80} />
          </View>
          <Txt v="footnote" color={C.text3} tabular>{`Empreinte ${me.fingerprint} · ne change jamais`}</Txt>
        </View>
        <Field
          label="Pseudo"
          value={name}
          onChangeText={(t) => {
            setName(t);
            setError(undefined);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={24}
          counter={name.length}
          error={error}
        />
        <Field
          label="Bio"
          value={bio}
          onChangeText={setBio}
          placeholder="Ce que tu regardes, ce que tu lis…"
          multiline
          maxLength={160}
          counter={bio.length}
        />
        <Txt v="footnote" color={C.text3} style={{ lineHeight: 17 }}>Ton profil est signé par ta clé et partagé avec les pairs que tu croises. Les anciennes versions peuvent rester en cache chez eux.</Txt>
        <Button label="Enregistrer" icon="checkmark" loading={busy} disabled={!dirty} onPress={save} />
      </View>
    </ScrollView>
  );
}
