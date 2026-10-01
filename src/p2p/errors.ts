// Typed errors crossing the worklet RPC (`{ ok: false, e, code }`, see src/p2p/worklet/rpc.js).

/** Restore from the recovery phrase: none of the account's devices answered, nothing was changed. */
export const RESTORE_NOT_FOUND = 'RESTORE_NOT_FOUND';

export class P2PError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'P2PError';
  }
}

export const errorCode = (e: unknown): string | undefined => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

/** The restore could not reach any device of the account: retry later, the account is intact. */
export const isRestoreNotFound = (e: unknown) => errorCode(e) === RESTORE_NOT_FOUND;
