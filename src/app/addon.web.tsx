// Web: Addon deep link (huwa://addon?url=…): needs an account to install into.
// See src/web/sign-in.tsx (gated) and the transparent presentation in src/app/_layout.web.tsx.
import { gated } from '@/web/sign-in';

import type Screen from './addon';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Addon: typeof Screen = require('./addon.tsx').default;

export default gated(Addon, 'addons');
