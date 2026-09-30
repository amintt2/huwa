// Stremio `ytId` streams: YouTube's own embedded player (IFrame API) in a WebView, so playback,
// ads and rights stay YouTube's. The page is loaded with an https base URL because YouTube
// refuses embeds without a referrer (error 153). "Ouvrir dans YouTube" is the fallback.
import { Linking, Modal, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { Button, IconButton, Txt } from '@/components/ui';
import { C, S } from '@/theme/tokens';

const ORIGIN = 'https://huwa.mciut.fr';

const page = (id: string) => `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>html,body{margin:0;height:100%;background:#000}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style>
</head><body>
<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?playsinline=1&autoplay=1&rel=0&origin=${encodeURIComponent(ORIGIN)}"
  allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
</body></html>`;

export const youtubeUrl = (id: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

export function YouTubePlayer({ ytId, title, onClose }: { ytId: string | null; title?: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={!!ytId} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}>
      <View style={{ flex: 1, backgroundColor: C.black, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={styles.bar}>
          <IconButton icon="close" label="Fermer" onPress={onClose} />
          <Txt v="label" numberOfLines={1} style={{ flex: 1 }}>{title ?? 'YouTube'}</Txt>
        </View>
        {!!ytId && (
          <WebView
            source={{ html: page(ytId), baseUrl: ORIGIN }}
            style={{ flex: 1, backgroundColor: C.black }}
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            allowsFullscreenVideo
            allowsPictureInPictureMediaPlayback
            originWhitelist={['*']}
            // Links out of the embed (YouTube logo, "watch on YouTube") open outside Huwa.
            onShouldStartLoadWithRequest={(r) => {
              if (r.url.startsWith(ORIGIN) || r.url.startsWith('about:') || /youtube(-nocookie)?\.com\/embed\//.test(r.url) || !r.isTopFrame) return true;
              Linking.openURL(r.url).catch(() => {});
              return false;
            }}
          />
        )}
        <View style={{ padding: S.lg }}>
          <Button small variant="soft" icon="logo-youtube" label="Ouvrir dans YouTube" onPress={() => ytId && Linking.openURL(youtubeUrl(ytId))} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.md, paddingBottom: S.sm },
});
