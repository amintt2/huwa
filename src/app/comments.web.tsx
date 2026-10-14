// Web: Comments: signing in comes first (comments are signed with the account key).
// See src/web/sign-in.tsx (gated) and the transparent presentation in src/app/_layout.web.tsx.
import { gated } from '@/web/sign-in';

import type Screen from './comments';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Comments: typeof Screen = require('./comments.tsx').default;

export default gated(Comments, 'comment');
