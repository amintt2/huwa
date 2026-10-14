// Web: Reading sources: need an account.
// See src/web/sign-in.tsx (gated) and the transparent presentation in src/app/_layout.web.tsx.
import { gated } from '@/web/sign-in';

import type Screen from './manga-sources';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const MangaSources: typeof Screen = require('./manga-sources.tsx').default;

export default gated(MangaSources, 'addons');
