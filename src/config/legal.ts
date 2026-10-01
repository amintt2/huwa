// Support contact and legal pages (same address as site/privacy.html).
import { Linking } from 'react-native';

export const SUPPORT_EMAIL = 'amin2020e@gmail.com';
export const SITE_URL = 'https://huwa.mciut.fr';
export const TERMS_URL = `${SITE_URL}/terms.html`;
export const PRIVACY_URL = `${SITE_URL}/privacy.html`;
export const SOURCE_URL = 'https://github.com/amintt2/huwa';

/** Short reference quoted in a report e-mail, e.g. `HUWA-R-LX3K9A-7Q2F`. */
export function reportReference(now = Date.now()) {
  const rand = Math.floor(Math.random() * 36 ** 4).toString(36).toUpperCase().padStart(4, '0');
  return `HUWA-R-${now.toString(36).toUpperCase()}-${rand}`;
}

/** Opens the mail app on a message to the support; false when no mail app is set up. */
export async function mailSupport(subject: string, body: string): Promise<boolean> {
  const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
