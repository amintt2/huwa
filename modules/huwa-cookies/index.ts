import { requireOptionalNativeModule } from 'expo-modules-core';

export type NativeCookie = { name: string; value: string; domain: string; path?: string; expires?: number; secure?: boolean; httpOnly?: boolean };

type Native = {
  /** Cookies of the default WKWebView store that apply to the URL's host (HttpOnly included). */
  getCookies(url: string): Promise<NativeCookie[]>;
  /** Removes the cookies of a domain and its subdomains, returns how many. */
  clearCookies(domain: string): Promise<number>;
};

/** null on Android / web / builds made before this module existed. */
export const HuwaCookies = requireOptionalNativeModule<Native>('HuwaCookies');
