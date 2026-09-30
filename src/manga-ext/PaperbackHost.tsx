// Invisible WebView hosting the extension sandboxes. Mounted by the root layout, but only renders
// once a source is first used (see `bridge.ts`). Navigation is locked to the inline page and its
// srcdoc iframes: an extension can't open a site, a window or an external app.
import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { attachHost, onHostMessage, resetHost, useHostState } from './bridge';
import { hostHtml } from './host-page';

const allowed = (url: string) => url === 'about:blank' || url === 'about:srcdoc';

export function PaperbackHost() {
  const { needed, generation } = useHostState();
  const ref = useRef<WebView>(null);
  const html = useMemo(() => {
    if (!needed) return '';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return hostHtml(require('./runtime/runtime.bundle.js') as string);
  }, [needed]);

  useEffect(() => {
    if (!needed) return;
    attachHost((js) => ref.current?.injectJavaScript(js));
    return () => attachHost(null);
  }, [needed, generation]);

  if (!needed) return null;
  return (
    <View style={styles.hidden} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <WebView
        key={generation}
        ref={ref}
        source={{ html, baseUrl: '' }}
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={(r) => allowed(r.url)}
        onMessage={(e) => onHostMessage(e.nativeEvent.data)}
        onContentProcessDidTerminate={() => resetHost('Moteur d’extensions interrompu')}
        onRenderProcessGone={() => resetHost('Moteur d’extensions interrompu')}
        javaScriptEnabled
        incognito
        cacheEnabled={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        allowsLinkPreview={false}
        allowsInlineMediaPlayback={false}
        mediaPlaybackRequiresUserAction
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        style={styles.web}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', left: -20, top: 0, width: 2, height: 2, opacity: 0, overflow: 'hidden' },
  web: { width: 2, height: 2, backgroundColor: 'transparent' },
});
