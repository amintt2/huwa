// React Native transport for `net.ts`, on `expo/fetch` (native URLSession / OkHttp) rather than
// RN's XHR-based fetch, because it can do the two things the policy layer needs:
// - `redirect: 'manual'`: the 3xx comes back to `createNet`, which checks every redirect target;
// - a streamed body: bytes are counted while receiving and the request is cancelled past `maxBytes`.
// `credentials: 'omit'` keeps NSURLSession / OkHttp from attaching or storing the app's shared
// cookies: each source only has its own jar.
import { fetch } from 'expo/fetch';

import { readCapped, splitSetCookie, TooLargeError, type RawFetch } from './net';

export const rnFetch: RawFetch = async (url, init) => {
  const body =
    init.body === undefined
      ? undefined
      : typeof init.body === 'string'
        ? init.body
        : (init.body.buffer.slice(init.body.byteOffset, init.body.byteOffset + init.body.byteLength) as ArrayBuffer);
  const res = await fetch(url, { method: init.method, headers: init.headers, body, signal: init.signal, credentials: 'omit', redirect: init.redirect });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const declared = Number(headers['content-length']);
  const stream = res.body;
  if (declared > init.maxBytes) {
    await stream?.cancel('too large').catch(() => {});
    throw new TooLargeError();
  }
  const bytes = stream ? await readCapped(stream.getReader(), init.maxBytes) : new Uint8Array(0);
  return {
    url: res.url || url,
    status: res.status,
    headers,
    setCookies: headers['set-cookie'] ? splitSetCookie(headers['set-cookie']) : [],
    body: bytes,
  };
};
