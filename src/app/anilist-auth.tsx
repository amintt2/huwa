import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect } from 'react';
import { View } from 'react-native';

import { C } from '@/theme/tokens';

// OAuth redirect target (`huwa://anilist-auth#access_token=…`). The auth session reads the URL
// itself; this route only exists so the deep link doesn't land on "unmatched route".
WebBrowser.maybeCompleteAuthSession();

export default function AniListAuthRedirect() {
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  }, []);
  return <View style={{ flex: 1, backgroundColor: C.bg }} />;
}
