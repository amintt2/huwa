// Web: Extension packs: need an account to install into.
// See src/web/sign-in.tsx (gated) and the transparent presentation in src/app/_layout.web.tsx.
import { gated } from '@/web/sign-in';

import type Screen from './pack';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Pack: typeof Screen = require('./pack.tsx').default;

export default gated(Pack, 'addons');
