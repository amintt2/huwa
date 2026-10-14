// Phone side of "Lier avec mon téléphone" (./link-web.ts): JS only, on top of the existing
// pairing invite. expo-crypto does the AES-GCM, @noble the X25519.
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto';

import { getP2P } from './index';
import { parseLinkUrl, postLinkFrame, sealLinkFrame, type Aead, type LinkWebRequest } from './link-web';
import { randomBytes } from './secure';

export { LinkWebError, parseLinkUrl, relayHost, type LinkWebRequest } from './link-web';

const aead: Aead = {
  async seal(key, nonce, plaintext, aad) {
    const k = await AESEncryptionKey.import(key);
    const sealed = await aesEncryptAsync(plaintext, k, { nonce: { bytes: nonce }, additionalData: aad });
    return sealed.ciphertext({ includeTag: true });
  },
  async open(key, nonce, sealed, aad) {
    const k = await AESEncryptionKey.import(key);
    return aesDecryptAsync(AESSealedData.fromParts(nonce, sealed, 16), k, { additionalData: aad });
  },
};

/** Builds the request from the deep link parameters (huwa://link-web?k=…&r=…&t=…&n=…). */
export function linkRequestFromParams(p: { k?: string; r?: string; t?: string; n?: string }): LinkWebRequest {
  const q = [`k=${p.k ?? ''}`, `r=${encodeURIComponent(p.r ?? '')}`, `t=${p.t ?? ''}`];
  if (p.n) q.push(`n=${encodeURIComponent(p.n)}`);
  return parseLinkUrl(`huwa://link-web?${q.join('&')}`);
}

/** Creates a pairing invite (10 min, single use) and hands it, sealed, to the waiting browser. */
export async function sendLinkInvite(req: LinkWebRequest, phoneName?: string): Promise<void> {
  const invite = await getP2P().pairingInvite();
  const frame = await sealLinkFrame({ invite, name: phoneName, ts: Date.now() }, req, { aead, random: randomBytes });
  await postLinkFrame(req, frame);
}
