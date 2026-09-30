// React Native transport for `net.ts`. `credentials: 'omit'` keeps NSURLSession / OkHttp from
// attaching or storing the app's shared cookies: each source only has its own jar.
import { splitSetCookie, type RawFetch } from './net';

export const rnFetch: RawFetch = async (url, init) => {
  const body =
    init.body === undefined
      ? undefined
      : typeof init.body === 'string'
        ? init.body
        : (init.body.buffer.slice(init.body.byteOffset, init.body.byteOffset + init.body.byteLength) as ArrayBuffer);
  const res = await fetch(url, { method: init.method, headers: init.headers, body, signal: init.signal, credentials: 'omit' });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const declared = Number(headers['content-length']);
  if (declared > init.maxBytes) throw new Error('Réponse trop volumineuse');
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    url: res.url || url,
    status: res.status,
    headers,
    setCookies: headers['set-cookie'] ? splitSetCookie(headers['set-cookie']) : [],
    body: bytes,
  };
};
