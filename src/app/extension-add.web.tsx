// Web: Add an extension by URL: needs an account.
// See src/web/sign-in.tsx (gated) and the transparent presentation in src/app/_layout.web.tsx.
import { gated } from '@/web/sign-in';

import type Screen from './extension-add';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ExtensionAdd: typeof Screen = require('./extension-add.tsx').default;

export default gated(ExtensionAdd, 'addons');
