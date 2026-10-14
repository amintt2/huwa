// "Lier avec mon téléphone" (D7): a browser joins the account of a phone without typing anything.
//
//   1. The browser draws an ephemeral X25519 key pair and a random 32-byte rendezvous topic, and
//      shows   huwa://link-web?k=<pub, base64url>&r=<gateway URL>&t=<topic, hex>&n=<browser name>
//   2. The phone scans it (system camera or Huwa's scanner), asks "Lier Chrome sur macOS ?", runs
//      the existing pairingInvite(), seals the invite to `k` and posts it to <r>/rendezvous/<t>.
//   3. The browser long-polls the rendezvous box, opens the frame and runs acceptPairing(invite):
//      blind pairing over the relay, as two phones do with the in-app QR.
// The gateway only ever stores a sealed frame (2 min TTL); the invite itself expires after 10 min
// and works once. Pure logic (crypto via @noble, AES-GCM injected): the phone uses expo-crypto,
// the browser WebCrypto, tests node:crypto.
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export const LINK_WEB_SCHEME = 'huwa://link-web';
const VERSION = 1;
const LABEL = 'huwa/link-web/v1';
const HEADER = 1 + 32 + 12;
/** The rendezvous box keeps a frame this long (gateway: HUWA_RENDEZVOUS_TTL_MS). */
export const LINK_WEB_TTL_MS = 120_000;

/** AES-256-GCM: `seal` returns ciphertext‖tag(16) (same shape as passkey-core's Aead). */
export type Aead = {
  seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
  open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
};

export type LinkWebRequest = {
  /** Browser's ephemeral X25519 public key. */
  key: Uint8Array;
  /** Gateway base URL, e.g. https://huwa.example.org/p2p (rendezvous at `${relay}/rendezvous/<t>`). */
  relay: string;
  /** Rendezvous topic, 64 lowercase hex characters. */
  topic: string;
  /** "Chrome sur macOS". */
  name?: string;
};

export type LinkWebKeys = { publicKey: Uint8Array; secretKey: Uint8Array };

export class LinkWebError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LinkWebError';
    this.code = code;
  }
}

// ---------- base64url ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

export function fromBase64Url(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (/[^A-Za-z0-9_-]/.test(clean) || clean.length % 4 === 1) throw new LinkWebError('bad-qr', 'Encodage invalide');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let j = 0;
  for (const ch of clean) {
    value = (value << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (value >> bits) & 255;
    }
  }
  return out;
}

// ---------- QR payload ----------

/** http(s) only; plain http only for a local or private-network gateway (self-hosting on a LAN). */
export function isAllowedRelay(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const h = u.hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

export function buildLinkUrl(req: LinkWebRequest): string {
  const q = [`k=${toBase64Url(req.key)}`, `r=${encodeURIComponent(req.relay)}`, `t=${req.topic}`];
  if (req.name) q.push(`n=${encodeURIComponent(req.name.slice(0, 40))}`);
  return `${LINK_WEB_SCHEME}?${q.join('&')}`;
}

/** Validated request from a scanned QR / opened link, or a LinkWebError. */
export function parseLinkUrl(url: string): LinkWebRequest {
  const m = /^huwa:\/\/link-web\/?\?(.*)$/i.exec(url.trim());
  if (!m) throw new LinkWebError('bad-qr', 'Ce QR code n’est pas une demande de liaison Huwa.');
  const q = new Map<string, string>();
  for (const part of m[1].split('&')) {
    const i = part.indexOf('=');
    if (i > 0) q.set(part.slice(0, i), decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' ')));
  }
  const k = q.get('k');
  const relay = q.get('r');
  const topic = q.get('t');
  let key: Uint8Array;
  try {
    key = fromBase64Url(k ?? '');
  } catch {
    throw new LinkWebError('bad-qr', 'Clé invalide dans le QR code.');
  }
  if (key.length !== 32) throw new LinkWebError('bad-qr', 'Clé invalide dans le QR code.');
  if (!topic || !/^[0-9a-f]{64}$/.test(topic)) throw new LinkWebError('bad-qr', 'QR code incomplet.');
  if (!relay || !isAllowedRelay(relay)) throw new LinkWebError('bad-relay', 'Adresse de serveur refusée (https requis).');
  const name = q.get('n')?.replace(/[\u0000-\u001f]/g, '').slice(0, 40) || undefined;
  return { key, relay: relay.replace(/\/+$/, ''), topic, name };
}

export const rendezvousUrl = (relay: string, topic: string) => `${relay.replace(/\/+$/, '')}/rendezvous/${topic}`;

/** Host shown to the user before linking ("huwa.example.org"). */
export function relayHost(relay: string): string {
  try {
    return new URL(relay).host;
  } catch {
    return relay;
  }
}

// ---------- sealing ----------

export function newLinkKeys(random: (n: number) => Uint8Array): LinkWebKeys {
  const secretKey = random(32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export const newTopic = (random: (n: number) => Uint8Array) => bytesToHex(random(32));

function deriveKey(shared: Uint8Array, ephemeral: Uint8Array, recipient: Uint8Array) {
  const salt = new Uint8Array(64);
  salt.set(ephemeral, 0);
  salt.set(recipient, 32);
  return hkdf(sha256, shared, salt, utf8ToBytes(LABEL), 32);
}

function aad(topic: string) {
  const label = utf8ToBytes(LABEL);
  const t = hexToBytes(topic);
  const out = new Uint8Array(label.length + t.length);
  out.set(label, 0);
  out.set(t, label.length);
  return out;
}

export type LinkWebPayload = { invite: string; name?: string; ts: number };

/** Phone side: the invite sealed to the browser's key, as the text posted to the rendezvous box. */
export async function sealLinkFrame(payload: LinkWebPayload, req: LinkWebRequest, opts: { aead: Aead; random: (n: number) => Uint8Array }): Promise<string> {
  const eph = newLinkKeys(opts.random);
  const shared = x25519.getSharedSecret(eph.secretKey, req.key);
  const key = deriveKey(shared, eph.publicKey, req.key);
  const nonce = opts.random(12);
  const sealed = await opts.aead.seal(key, nonce, utf8ToBytes(JSON.stringify(payload)), aad(req.topic));
  const frame = new Uint8Array(HEADER + sealed.length);
  frame[0] = VERSION;
  frame.set(eph.publicKey, 1);
  frame.set(nonce, 33);
  frame.set(sealed, HEADER);
  eph.secretKey.fill(0);
  key.fill(0);
  return toBase64Url(frame);
}

/** Browser side: opens a frame read from the box; null when it is not for us. */
export async function openLinkFrame(text: string, keys: LinkWebKeys, topic: string, opts: { aead: Aead }): Promise<LinkWebPayload | null> {
  let frame: Uint8Array;
  try {
    frame = fromBase64Url(text.trim());
  } catch {
    return null;
  }
  if (frame.length <= HEADER + 16 || frame[0] !== VERSION) return null;
  const ephemeral = frame.subarray(1, 33);
  const key = deriveKey(x25519.getSharedSecret(keys.secretKey, ephemeral), ephemeral, keys.publicKey);
  try {
    const plain = await opts.aead.open(key, frame.subarray(33, HEADER), frame.subarray(HEADER), aad(topic));
    const p = JSON.parse(new TextDecoder().decode(plain)) as LinkWebPayload;
    if (typeof p.invite !== 'string' || !/^huwa-pair:[0-9a-f]{2,1024}$/.test(p.invite)) return null;
    return { invite: p.invite, name: typeof p.name === 'string' ? p.name.slice(0, 40) : undefined, ts: Number(p.ts) || 0 };
  } catch {
    return null;
  } finally {
    key.fill(0);
  }
}

// ---------- rendezvous HTTP ----------

type BoxReply = { frames?: { n: number; data: string }[]; next?: number };
type Fetch = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Phone side: posts the sealed frame. */
export async function postLinkFrame(req: LinkWebRequest, frame: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<void> {
  const res = await fetchFn(rendezvousUrl(req.relay, req.topic), { method: 'POST', body: frame, headers: { 'content-type': 'text/plain' } });
  if (res.status === 429) throw new LinkWebError('busy', 'Trop de tentatives, réessaie dans une minute.');
  if (!res.ok) throw new LinkWebError('relay', `Le serveur a refusé la liaison (${res.status}).`);
}

/**
 * Browser side: waits for frames (long poll) until one opens, `signal` aborts, or `ms` elapse.
 * Frames that do not open (someone else posting to the topic) are skipped.
 */
export async function waitLinkFrame(
  req: { relay: string; topic: string },
  keys: LinkWebKeys,
  opts: { aead: Aead; fetch?: Fetch; signal?: AbortSignal; ms?: number; pollMs?: number },
): Promise<LinkWebPayload> {
  const f = opts.fetch ?? (fetch as unknown as Fetch);
  const deadline = Date.now() + (opts.ms ?? 10 * 60_000);
  let after = -1;
  let failures = 0;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new LinkWebError('cancelled', 'Annulé');
    const started = Date.now();
    let body = null as BoxReply | null;
    try {
      const res = await f(`${rendezvousUrl(req.relay, req.topic)}?after=${after}&wait=${opts.pollMs ?? 25_000}`, { signal: opts.signal });
      if (res.ok) {
        body = (await res.json()) as BoxReply;
        failures = 0;
      } else failures++;
    } catch (e) {
      if (opts.signal?.aborted) throw new LinkWebError('cancelled', 'Annulé');
      failures++;
      void e;
    }
    for (const frame of body?.frames ?? []) {
      after = Math.max(after, frame.n);
      const text = new TextDecoder().decode(base64ToBytes(frame.data));
      const payload = await openLinkFrame(text, keys, req.topic, { aead: opts.aead });
      if (payload) return payload;
    }
    if (typeof body?.next === 'number') after = Math.max(after, body.next);
    if (failures) await new Promise((r) => setTimeout(r, Math.min(10_000, 500 * 2 ** Math.min(failures, 5))));
    // A box that answers at once (no long poll on this gateway): do not spin.
    else if (Date.now() - started < 500) await new Promise((r) => setTimeout(r, 500));
  }
  throw new LinkWebError('expired', 'Le QR code a expiré. Génère-en un nouveau.');
}

function base64ToBytes(s: string): Uint8Array {
  return fromBase64Url(s.replace(/\+/g, '-').replace(/\//g, '_'));
}

/** WebCrypto AES-256-GCM (browsers, Node 20+). */
export const webCryptoAead: Aead = {
  async seal(key, nonce, plaintext, data) {
    const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt']);
    return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: data as BufferSource }, k, plaintext as BufferSource));
  },
  async open(key, nonce, sealed, data) {
    const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource, additionalData: data as BufferSource }, k, sealed as BufferSource));
  },
};
