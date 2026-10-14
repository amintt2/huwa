// Web: Install deep link: needs an account to install into.
// See src/web/sign-in.tsx (gated) and the transparent presentation in src/app/_layout.web.tsx.
import { gated } from '@/web/sign-in';

import type Screen from './install';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Install: typeof Screen = require('./install.tsx').default;

export default gated(Install, 'addons');
