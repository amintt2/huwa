// Pure identity helpers: recovery phrase (BIP39, 24 words), root key derivation,
// fingerprints and signatures. No storage, no randomness source: callers pass entropy
// (expo-crypto in the app, node:crypto in tests).
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export const PHRASE_WORDS = 24;
const DERIVE_KEY = utf8ToBytes('huwa/identity/root/v1');

export { bytesToHex, hexToBytes, utf8ToBytes };

/** 32 bytes of entropy → 24 English BIP39 words. */
export function phraseFromEntropy(entropy: Uint8Array): string[] {
  if (entropy.length !== 32) throw new Error('32 octets d’entropie requis');
  return entropyToMnemonic(entropy, wordlist).split(' ');
}

/** Split whatever the user pasted ("1. abandon 2. ability…", commas, new lines) into words. */
export function normalizePhraseInput(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[0-9]+[.)]/g, ' ')
    .split(/[^a-z]+/)
    .filter(Boolean);
}

export function isValidPhrase(words: string[]): boolean {
  return words.length === PHRASE_WORDS && validateMnemonic(words.join(' '), wordlist);
}

/** Index of each word that is not in the BIP39 list (for inline hints while typing). */
export function unknownWords(words: string[]): number[] {
  const set = new Set(wordlist);
  return words.flatMap((w, i) => (set.has(w) ? [] : [i]));
}

export type RootKeys = { secretKey: Uint8Array; publicKey: string };

/** Deterministic root key: ed25519 seed = blake2b(entropy, key = domain tag). */
export function rootKeysFromPhrase(words: string[]): RootKeys {
  if (!isValidPhrase(words)) throw new Error('Phrase de récupération invalide');
  const entropy = mnemonicToEntropy(words.join(' '), wordlist);
  const secretKey = blake2b(entropy, { dkLen: 32, key: DERIVE_KEY });
  return { secretKey, publicKey: bytesToHex(ed25519.getPublicKey(secretKey)) };
}

/** Fresh device key (from 32 random bytes). */
export function deviceKeysFromSeed(seed: Uint8Array): RootKeys {
  return { secretKey: seed, publicKey: bytesToHex(ed25519.getPublicKey(seed)) };
}

const Z32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';

/** Short, human-comparable fingerprint of a public key: `k3xa·9fmo`. */
export function fingerprint(publicKey: string): string {
  const h = blake2b(utf8ToBytes(publicKey), { dkLen: 5 });
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of h) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += Z32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `${out.slice(0, 4)}·${out.slice(4, 8)}`;
}

export function sign(message: string, secretKey: Uint8Array): string {
  return bytesToHex(ed25519.sign(utf8ToBytes(message), secretKey));
}

export function verify(message: string, signature: string, publicKey: string): boolean {
  try {
    return ed25519.verify(hexToBytes(signature), utf8ToBytes(message), hexToBytes(publicKey));
  } catch {
    return false;
  }
}

/** 3 distinct word positions (0-based, sorted) to check a written-down phrase. */
export function pickVerifyIndices(random: Uint8Array, count = 3, total = PHRASE_WORDS): number[] {
  const picked = new Set<number>();
  for (let i = 0; picked.size < count && i < 512; i++) {
    picked.add((random[i % random.length] + i * 7) % total);
  }
  for (let k = 0; picked.size < count; k++) picked.add(k);
  return [...picked].sort((a, b) => a - b);
}

/** Stable pseudo key for demo authors (seed comments), so their profile opens. */
export function demoKey(name: string): string {
  return bytesToHex(blake2b(utf8ToBytes(`huwa/demo/${name}`), { dkLen: 32 }));
}

export const isPublicKey = (s: string) => /^[0-9a-f]{64}$/.test(s);
