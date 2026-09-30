import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';

import { Avatar, Field, ScreenHeader } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import { social, useMe } from '@/p2p/hooks';
import { C, S } from '@/theme/tokens';

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
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.surface }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title="Modifier le profil" close />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: S.lg, paddingBottom: S.xxl, gap: S.xl }}>
        <View style={{ alignItems: 'center', gap: S.sm }}>
          <Avatar seed={me.key} name={name || me.name} size={72} />
          <Txt v="small">{`Empreinte ${me.fingerprint} · ne change jamais`}</Txt>
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
        <Txt v="small" style={{ lineHeight: 18 }}>Ton profil est signé par ta clé et partagé avec les pairs que tu croises. Les anciennes versions peuvent rester en cache chez eux.</Txt>
        <View style={{ opacity: dirty ? 1 : 0.45 }}>
          <Button label={busy ? 'Enregistrement…' : 'Enregistrer'} icon="checkmark" onPress={dirty ? save : undefined} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
