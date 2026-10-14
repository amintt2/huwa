// Web: Player: signed-out visitors get the « Connecte-toi pour lire » sheet over the page they came from.
// See src/web/sign-in.tsx (gated) and the transparent presentation in src/app/_layout.web.tsx.
import { gated } from '@/web/sign-in';

import type Screen from './[id]';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Watch: typeof Screen = require('./[id].tsx').default;

export { ErrorScreen as ErrorBoundary } from '@/components/error-screen';

export default gated(Watch, 'watch');
