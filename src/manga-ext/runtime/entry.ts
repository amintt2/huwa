// Entry of the sandbox bundle (built by scripts/build-paperback-runtime.mjs into runtime.bundle.js).
// It only exposes the runtime; the iframe's inline script wires it to `parent.postMessage`.
import * as cheerio from 'cheerio';

import { start } from './sandbox';

(globalThis as unknown as { HuwaPB: unknown }).HuwaPB = { start, cheerio };
