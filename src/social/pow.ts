// Invisible proof of work (PLAN §3): find `nonce` such that H(payload ‖ nonce) starts with
// `bits` zero bits. Difficulty decreases as a key earns trust. React Native has no worker
// threads without native code, so the solver runs in batches and yields to the event loop
// between them: the UI keeps its 60 fps while a comment "prepares" in the background.
import { blake2b } from '@noble/hashes/blake2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

export type PowAlgo = 'blake2b' | 'sha256';
export type PowProof = { nonce: number; bits: number; algo: PowAlgo };

export const POW = {
  /** Unknown key. ~65k hashes on average (≈0.3–1 s on a phone). */
  base: 16,
  /** After this many accepted messages the key is "known". */
  knownAfter: 5,
  knownDiscount: 4,
  /** Vouched by an established writer (QR/link invite). */
  vouchDiscount: 2,
  /** Long-standing contributor. */
  trustedAfter: 50,
  trustedDiscount: 2,
  floor: 8,
} as const;

/** Degressive difficulty: strong for strangers, lighter for known or vouched keys. */
export function powDifficulty({ accepted = 0, vouched = false }: { accepted?: number; vouched?: boolean } = {}): number {
  let bits: number = POW.base;
  if (accepted >= POW.knownAfter) bits -= POW.knownDiscount;
  if (accepted >= POW.trustedAfter) bits -= POW.trustedDiscount;
  if (vouched) bits -= POW.vouchDiscount;
  return Math.max(POW.floor, bits);
}

/** Canonical payload of a comment. No timestamp, so it can be solved while the user types. */
export const commentPowPayload = (author: string, target: string, text: string) =>
  `huwa/comment/v1\n${author}\n${target}\n${text}`;

export function leadingZeroBits(hash: Uint8Array): number {
  let n = 0;
  for (const byte of hash) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

function hasher(algo: PowAlgo, payload: string) {
  const head = utf8ToBytes(payload);
  const buf = new Uint8Array(head.length + 4);
  buf.set(head);
  const view = new DataView(buf.buffer);
  const h = algo === 'sha256' ? (m: Uint8Array) => sha256(m) : (m: Uint8Array) => blake2b(m, { dkLen: 32 });
  return (nonce: number) => {
    view.setUint32(head.length, nonce >>> 0);
    return h(buf);
  };
}

export function verifyPow(payload: string, proof: PowProof, minBits = proof.bits): boolean {
  if (!Number.isInteger(proof.nonce) || proof.nonce < 0 || proof.nonce > 0xffffffff) return false;
  if (proof.bits < minBits) return false;
  return leadingZeroBits(hasher(proof.algo, payload)(proof.nonce)) >= proof.bits;
}

export function solvePowSync(payload: string, bits: number, algo: PowAlgo = 'blake2b', start = 0): PowProof {
  const hash = hasher(algo, payload);
  for (let nonce = start; nonce <= 0xffffffff; nonce++) {
    if (leadingZeroBits(hash(nonce)) >= bits) return { nonce, bits, algo };
  }
  throw new Error('Aucun nonce trouvé');
}

export type SolveOptions = {
  algo?: PowAlgo;
  /** Hashes per batch before yielding (≈ 5–15 ms on a phone). */
  batch?: number;
  signal?: AbortSignal;
  onProgress?: (tried: number) => void;
  /** How to yield between batches; defaults to a macrotask. */
  yieldFn?: () => Promise<void>;
};

const defaultYield = () => new Promise<void>((r) => setTimeout(r, 0));

export async function solvePow(payload: string, bits: number, opts: SolveOptions = {}): Promise<PowProof> {
  const { algo = 'blake2b', batch = 1500, signal, onProgress, yieldFn = defaultYield } = opts;
  const hash = hasher(algo, payload);
  let nonce = 0;
  while (nonce <= 0xffffffff) {
    if (signal?.aborted) throw new Error('aborted');
    const end = Math.min(nonce + batch, 0x100000000);
    for (; nonce < end; nonce++) {
      if (leadingZeroBits(hash(nonce)) >= bits) return { nonce, bits, algo };
    }
    onProgress?.(nonce);
    await yieldFn();
  }
  throw new Error('Aucun nonce trouvé');
}

// ---------- pre-computation while typing ----------

type Job = { promise: Promise<PowProof>; ctrl: AbortController };
const cache = new Map<string, Job>();
const keyOf = (payload: string, bits: number, algo: PowAlgo) => `${algo}:${bits}:${payload}`;

/**
 * Start (or reuse) a background solve. Only the two latest payloads are kept: older
 * in-flight solves (stale drafts) are aborted so typing never piles up CPU work.
 */
export function warmPow(payload: string, bits: number, algo: PowAlgo = 'blake2b'): Promise<PowProof> {
  const k = keyOf(payload, bits, algo);
  const hit = cache.get(k);
  if (hit) {
    // Refresh recency.
    cache.delete(k);
    cache.set(k, hit);
    return hit.promise;
  }
  const ctrl = new AbortController();
  const promise = solvePow(payload, bits, { algo, signal: ctrl.signal });
  promise.catch(() => {
    if (cache.get(k)?.promise === promise) cache.delete(k);
  });
  cache.set(k, { promise, ctrl });
  while (cache.size > 2) {
    const oldest = cache.keys().next().value!;
    cache.get(oldest)?.ctrl.abort();
    cache.delete(oldest);
  }
  return promise;
}

/** Proof for `payload`, reusing a warm solve when the text did not change since typing. */
export const getPow = warmPow;
