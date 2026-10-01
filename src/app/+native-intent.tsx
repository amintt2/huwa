// Incoming links (custom scheme, universal links from https://huwa.mciut.fr, notifications):
// site pages become app routes, and the App Store flavor sends extension / pack / debrid /
// torrent links to the home screen. Logic and tests: src/config/links.ts.
import { isStoreBuild } from '@/config/channel';
import { redirectLink } from '@/config/links';

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    return redirectLink(path, { store: isStoreBuild });
  } catch {
    return '/';
  }
}
