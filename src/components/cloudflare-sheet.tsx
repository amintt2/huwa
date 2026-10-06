// Cloudflare check, Paperback-style: the source's site in a visible WebView, the user ticks the
// check, then "Terminé" (or it closes by itself once the `cf_clearance` cookie is there). Mounted
// once at the root; opened by `verifySource` (manga-ext/cloudflare.ts). Navigation is limited to
// the source's site and Cloudflare's challenge host.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRef, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { Button, IconButton, Txt } from '@/components/ui';
import { canReadWebCookies, finishVerification, hasClearanceCookie, useVerifyRequest, VERIFIER_USER_AGENT, type VerifyRequest } from '@/manga-ext/cloudflare';
import { allowedInVerifier, type WebCookie } from '@/manga-ext/cloudflare-core';
import { isBlockedHost } from '@/manga-ext/net';
import { C, R, S } from '@/theme/tokens';

// Reports, about every second, whether the page still shows a challenge, plus the readable
// cookies and the real User-Agent of the WebView.
const PROBE = `(function(){
  function probe(){
    try {
      var html = document.documentElement ? document.documentElement.innerHTML.slice(0, 30000) : '';
      var challenge = /challenge-platform|cf-turnstile|cf_chl_opt|__cf_chl_|id="challenge-|cf-browser-verification/i.test(html)
        || /just a moment|un instant|attention required|checking your browser/i.test(document.title || '');
      window.ReactNativeWebView.postMessage(JSON.stringify({ t: 'cf', challenge: challenge, ua: navigator.userAgent, cookies: document.cookie || '', url: location.href }));
    } catch (e) {}
  }
  probe();
  setInterval(probe, 1000);
})(); true;`;

type Probe = { challenge: boolean; ua: string; cookies: string; url: string };

const parseDocumentCookies = (s: string, host: string): WebCookie[] =>
  s
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return { name: i < 0 ? p : p.slice(0, i), value: i < 0 ? '' : p.slice(i + 1), domain: host, path: '/' };
    })
    .filter((c) => c.name);

export function CloudflareSheet() {
  const req = useVerifyRequest();
  // Keyed by request: every verification starts with a fresh state.
  return req ? <Verifier key={req.id} req={req} /> : null;
}

function Verifier({ req }: { req: VerifyRequest }) {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<'checking' | 'challenge' | 'clear'>('checking');
  const last = useRef<Probe | null>(null);
  const sawChallenge = useRef(false);
  const closing = useRef(false);

  const done = (outcome: 'verified' | 'cancelled') => {
    if (closing.current) return;
    closing.current = true;
    const p = last.current;
    finishVerification(req.id, outcome, { userAgent: p?.ua, pageCookies: p ? parseDocumentCookies(p.cookies, req.host) : [] });
  };

  const onMessage = (e: WebViewMessageEvent) => {
    let m: Probe & { t?: string };
    try {
      m = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (m?.t !== 'cf') return;
    last.current = m;
    if (m.challenge) {
      sawChallenge.current = true;
      setState('challenge');
      return;
    }
    setState('clear');
    if (!canReadWebCookies) {
      // Build without the cookie module: the HttpOnly clearance can't be checked, so a challenge
      // that went away counts as passed.
      if (sawChallenge.current) setTimeout(() => last.current && !last.current.challenge && done('verified'), 800);
      return;
    }
    // Past the challenge: close by itself as soon as the clearance cookie is in the store.
    hasClearanceCookie(req.url).then((ok) => {
      if (ok && last.current && !last.current.challenge) done('verified');
    });
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => done('cancelled')}>
      <View style={[styles.root, { paddingBottom: insets.bottom }]}>
        <View style={styles.head}>
          <View style={styles.cloud}>
            <Ionicons name="cloud-outline" size={18} color={C.accentText} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="label" numberOfLines={1}>Vérification Cloudflare</Txt>
            <Txt v="small" numberOfLines={1} style={{ fontSize: 12 }}>{req.sourceName} · {req.host}</Txt>
          </View>
          <IconButton icon="close" tone="solid" size={36} label="Annuler la vérification" onPress={() => done('cancelled')} />
        </View>
        <View style={styles.hint}>
          {state === 'clear' ? (
            <Ionicons name="checkmark-circle" size={16} color={C.success} />
          ) : (
            <Ionicons name="hand-left-outline" size={16} color={C.text2} />
          )}
          <Txt v="small" style={{ flex: 1, fontSize: 13 }}>
            {state === 'clear'
              ? 'Vérification passée. Touche Terminé pour revenir à la source.'
              : 'Coche la vérification si elle s’affiche, puis touche Terminé.'}
          </Txt>
        </View>
        <View style={styles.web}>
          <WebView
            key={req.id}
            source={{ uri: req.url }}
            userAgent={VERIFIER_USER_AGENT}
            originWhitelist={['https://*', 'http://*']}
            onShouldStartLoadWithRequest={(r) => allowedInVerifier(r.url, req.host, isBlockedHost)}
            injectedJavaScript={PROBE}
            onMessage={onMessage}
            onLoadEnd={() => setLoading(false)}
            javaScriptEnabled
            domStorageEnabled
            thirdPartyCookiesEnabled
            sharedCookiesEnabled={false}
            javaScriptCanOpenWindowsAutomatically={false}
            setSupportMultipleWindows={false}
            allowsLinkPreview={false}
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            mediaPlaybackRequiresUserAction
            style={{ backgroundColor: C.bg }}
          />
          {loading && (
            <View style={[StyleSheet.absoluteFill, styles.loading]} pointerEvents="none">
              <ActivityIndicator color={C.text2} />
            </View>
          )}
        </View>
        <View style={styles.foot}>
          <Button label="Terminé" icon="checkmark" onPress={() => done('verified')} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.sheet },
  head: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg, paddingTop: S.lg, paddingBottom: S.md },
  cloud: { width: 36, height: 36, borderRadius: R.control, backgroundColor: C.accentSoft, alignItems: 'center', justifyContent: 'center' },
  hint: { flexDirection: 'row', alignItems: 'center', gap: S.sm, marginHorizontal: S.lg, marginBottom: S.md, padding: S.md, borderRadius: R.control, backgroundColor: C.elevated },
  web: { flex: 1, marginHorizontal: S.sm, borderRadius: R.card, overflow: 'hidden', borderWidth: 1, borderColor: C.border, backgroundColor: C.bg },
  loading: { alignItems: 'center', justifyContent: 'center' },
  foot: { paddingHorizontal: S.lg, paddingTop: S.md, paddingBottom: S.sm },
});
