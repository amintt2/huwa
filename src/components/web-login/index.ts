// Web login UI (docs/WEB_DOCKER_PLAN.md D6–D8): logged-out hub, QR link with the phone, recovery
// phrase, passkey, new account + phrase backup, unlock, session settings, storage warnings.
export { CreateAccount, type CreateAccountProps } from './create-account';
export { WebLoginHub, type WebLoginHubProps } from './hub';
export { LinkPhoneQR, type LinkPhoneQRProps } from './link-phone';
export { getLoginMode, setPublicComputer, useLoginMode, type LoginMode } from './login-mode';
export { LOGIN_WIDTH, LoginFrame, passkeyLoginAvailable } from './parts';
export { PasskeyLogin, type PasskeyLoginProps } from './passkey-login';
export { PhraseBackup, PhraseBackupHost, setPendingBackup, usePendingBackup, type PhraseBackupProps } from './phrase-backup';
export { RestorePhrase, type RestorePhraseProps } from './restore-phrase';
export { WebSessionCard } from './session-card';
export { StorageErrorBanner } from './storage-banner';
export { WebUnlockScreen, type WebUnlockScreenProps } from './unlock';
