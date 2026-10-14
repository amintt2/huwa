// Web: Extensions: signed-out visitors get the sign-in sheet (extensions belong to the account).
// See src/web/sign-in.tsx (gated) and the transparent presentation in src/app/_layout.web.tsx.
import { gated } from '@/web/sign-in';

import type Screen from './addons';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Addons: typeof Screen = require('./addons.tsx').default;

export default gated(Addons, 'addons');
