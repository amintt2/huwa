// GIFs in comments: rendering (expo-image, animated, tap to pause), playback policy (always / Wi-Fi
// only / never, Reduce Motion → first frame), hide / blur settings, and the picker sheet.
// URL rules and the GIPHY API parsing: src/social/gif.ts.
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { NetworkStateType, useNetworkState } from 'expo-network';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { usePrefs } from '@/p2p/prefs';
import { giphyEndpoint, normalizeGifLink, parseGiphyResponse, type GifResult } from '@/social/gif';
import { C, F, R, S } from '@/theme/tokens';

import { Sheet } from './sheet';
import { Button, Txt } from './ui';

/** Should GIFs animate right now (setting, network, Reduce Motion)? */
export function useGifAutoplay(): boolean {
  const mode = usePrefs((p) => p.gifAutoplay);
  const reduced = useReducedMotion();
  const net = useNetworkState();
  if (reduced || mode === 'never') return false;
  if (mode === 'wifi') return net.type === NetworkStateType.WIFI || net.type === NetworkStateType.ETHERNET;
  return true;
}

const MAX_W = 240;
const MAX_H = 200;

export function GifView({ url, blurred, onReveal }: { url: string; blurred?: boolean; onReveal?: () => void }) {
  const autoplay = useGifAutoplay();
  const [ratio, setRatio] = useState(1.4);
  // The user's tap overrides the policy for this GIF.
  const [choice, setChoice] = useState<boolean>();
  const playing = choice ?? autoplay;
  const [failed, setFailed] = useState(false);
  const ref = useRef<Image>(null);
  const width = Math.min(MAX_W, MAX_H * ratio);
  const height = width / ratio;

  if (failed) {
    return (
      <View style={[styles.box, styles.center, { width: 160, height: 60 }]}>
        <Txt v="footnote">GIF indisponible</Txt>
      </View>
    );
  }
  const toggle = () => {
    if (blurred) return onReveal?.();
    const next = !playing;
    setChoice(next);
    (next ? ref.current?.startAnimating() : ref.current?.stopAnimating())?.catch?.(() => {});
  };
  return (
    <Pressable
      onPress={toggle}
      accessibilityRole="button"
      accessibilityLabel={blurred ? 'GIF masqué, touche pour l’afficher' : playing ? 'GIF animé, touche pour mettre en pause' : 'GIF en pause, touche pour l’animer'}
      style={[styles.box, { width, height }]}>
      <Image
        ref={ref}
        source={{ uri: url }}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        autoplay={autoplay && !blurred}
        blurRadius={blurred ? 40 : 0}
        transition={150}
        recyclingKey={url}
        accessibilityIgnoresInvertColors
        onLoad={(e) => {
          const { width: w, height: h } = e.source;
          if (w > 0 && h > 0) setRatio(Math.min(2.4, Math.max(0.5, w / h)));
        }}
        onError={() => setFailed(true)}
      />
      {blurred ? (
        <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: 'rgba(5,7,13,0.35)', gap: 4 }]}>
          <Ionicons name="eye-off-outline" size={20} color={C.white} />
          <Txt v="footnote" color={C.white}>GIF non vérifié · toucher</Txt>
        </View>
      ) : (
        <View style={styles.badge} pointerEvents="none">
          {!playing && <Ionicons name="play" size={9} color={C.white} />}
          <Txt v="caption" color={C.white} style={{ fontSize: 9, lineHeight: 11 }}>GIF</Txt>
        </View>
      )}
    </Pressable>
  );
}

/** "Masquer les GIFs": a discreet placeholder keeps the context. */
export function GifPlaceholder() {
  return (
    <View style={styles.placeholder}>
      <Ionicons name="image-outline" size={14} color={C.text3} />
      <Txt v="footnote" color={C.text3}>GIF masqué (réglages de modération)</Txt>
    </View>
  );
}

// ---------- picker ----------

const apiKey = (): string | undefined => {
  const k = Constants.expoConfig?.extra?.gifApiKey;
  return typeof k === 'string' && k.length > 8 ? k : undefined;
};

export function GifPicker({ visible, onClose, onPick }: { visible: boolean; onClose: () => void; onPick: (url: string) => void }) {
  const key = apiKey();
  const [q, setQ] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState<string>();
  const [results, setResults] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);
  const { width } = useWindowDimensions();
  const cell = (Math.min(width, 560) - S.lg * 2 - S.sm) / 2;

  useEffect(() => {
    if (!visible || !key) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      fetch(giphyEndpoint(key, q), { signal: ctrl.signal })
        .then((r) => r.json())
        .then((j) => setResults(parseGiphyResponse(j)))
        .catch(() => {})
        .finally(() => setLoading(false));
    }, q ? 350 : 0);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [visible, key, q]);

  const pickLink = () => {
    const r = normalizeGifLink(link);
    if ('error' in r) return setError(r.error);
    setLink('');
    setError(undefined);
    onPick(r.url);
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="GIF" subtitle={key ? 'Recherche GIPHY · classement PG-13 maximum' : undefined} detents={key ? ['medium', 'large'] : 'fit'}>
      {key && (
        <>
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Rechercher un GIF"
            placeholderTextColor={C.text3}
            style={styles.input}
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Rechercher un GIF"
          />
          <ScrollView contentContainerStyle={styles.grid} keyboardShouldPersistTaps="handled" style={{ maxHeight: 420 }}>
            {loading && !results.length ? <ActivityIndicator color={C.text2} style={{ margin: S.xl }} /> : null}
            {results.map((g) => (
              <Pressable key={g.id} onPress={() => onPick(g.url)} accessibilityRole="button" accessibilityLabel={g.title || 'GIF'}
                style={{ width: cell, height: cell * 0.75, borderRadius: R.control, overflow: 'hidden', backgroundColor: C.elevated }}>
                <Image source={{ uri: g.preview }} style={StyleSheet.absoluteFill} contentFit="cover" recyclingKey={g.id} />
              </Pressable>
            ))}
          </ScrollView>
          <Txt v="footnote" style={{ textAlign: 'center' }}>Propulsé par GIPHY</Txt>
        </>
      )}
      <View style={{ gap: S.sm }}>
        <Txt v="small">{key ? 'Ou colle un lien' : 'Colle un lien GIPHY ou Tenor'}</Txt>
        <TextInput
          value={link}
          onChangeText={(t) => {
            setLink(t);
            setError(undefined);
          }}
          placeholder="https://giphy.com/gifs/…"
          placeholderTextColor={C.text3}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onSubmitEditing={pickLink}
          returnKeyType="done"
          accessibilityLabel="Lien du GIF"
        />
        {error ? <Txt v="footnote" color={C.danger}>{error}</Txt> : null}
        {!key && (
          <Txt v="footnote">
            Sur GIPHY : « Copy link ». Sur Tenor : ouvre le GIF puis copie l’adresse de l’image (media.tenor.com). Les GIFs viennent uniquement de GIPHY, Tenor ou Klipy.
          </Txt>
        )}
        <Button label="Ajouter le GIF" icon="add" onPress={pickLink} disabled={!link.trim()} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: R.control, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: C.elevated, borderWidth: 1, borderColor: C.hairline },
  center: { alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute', left: 6, bottom: 6, flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 5, backgroundColor: 'rgba(0,0,0,0.55)',
  },
  placeholder: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: R.chip, backgroundColor: C.elevated,
  },
  input: {
    minHeight: 44, paddingHorizontal: S.md, borderRadius: R.control, backgroundColor: C.elevated, color: C.text, ...F.regular, fontSize: 15,
    borderWidth: 1, borderColor: C.border,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm },
});
