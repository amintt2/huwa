// Web calendar: the native screen in a centered column on wide screens (src/web/column.tsx), so
// its two-column grid keeps poster-sized cards instead of 600 px ones.
import { WideColumn } from '@/web/column';

import type Screen from './calendar';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Calendar: typeof Screen = require('./calendar.tsx').default;

export default function CalendarWeb() {
  return (
    <WideColumn max={980}>
      <Calendar />
    </WideColumn>
  );
}
